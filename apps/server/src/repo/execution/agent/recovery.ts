import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { AgentPage } from '@scova/agent-core';
import { requiredDatabaseValue } from '../../../utils/execution/database.ts';
import {
    toolCalls as dbToolCalls,
    eq,
    and,
    desc,
    runs as dbRuns,
    inArray,
    lte,
    asc,
} from '@scova/db';
import { readFeedbackSnapshot } from '@scova/models';
import { withRunFence } from '../runs.ts';
import { loadBaseline } from '../comparison.ts';
import { normalizeUrl } from '@scova/connectors';
import { type AgentRepository, AgentPersistenceError } from '@scova/shared/execution/agent';
import { heldReservation, usage, completedOutput, checkpointRef } from './validation.ts';
import type { AgentRepositoryScope } from './scope.ts';

export function createRecoveryMethods({
    db,
    token,
    fence,
}: AgentRepositoryScope): Pick<
    AgentRepository,
    | 'comparison'
    | 'markInterruptedUnknown'
    | 'usage'
    | 'readAuthorizedCheckpoint'
    | 'promoteCheckpoint'
    | 'searchPage'
    | 'readPages'
    | 'readCheckpointPages'
> {
    return {
        comparison: (options = {}) =>
            withRunFence(
                db,
                token,
                options.allowDeadline ? 'deadline_delivery' : 'work',
                async (tx, run) => ({
                    comparisonScopeHash: run.comparisonScopeHash,
                    baselineRunId: run.baselineRunId,
                    baseline: await loadBaseline(tx, run),
                    feedback: readFeedbackSnapshot(
                        run.feedbackSnapshotJson,
                        run.userId,
                        run.taskId,
                    ),
                }),
            ),

        markInterruptedUnknown() {
            return fence(async (tx, run, now) => {
                const calls = await tx.query.toolCalls.findMany({
                    where: and(
                        eq(dbToolCalls.userId, run.userId),
                        eq(dbToolCalls.runId, run.id),
                        inArray(dbToolCalls.status, ['reserved', 'running']),
                    ),
                });
                let count = 0;
                for (const call of calls) {
                    if (heldReservation(call).leaseEpoch === token.leaseEpoch) continue;
                    await tx
                        .update(dbToolCalls)
                        .set({ status: 'unknown', finishedAt: now })
                        .where(eq(dbToolCalls.id, call.id))
                        .returning()
                        .then((rows) => requiredDatabaseValue(rows[0]));
                    count += 1;
                }
                return count;
            });
        },

        usage: () => fence(async (_tx, run) => usage(run.usageJson)),

        readAuthorizedCheckpoint: (options = {}) =>
            withRunFence(
                db,
                token,
                options.allowDeadline ? 'deadline_delivery' : 'work',
                async (_tx, run) =>
                    run.checkpointRef === null
                        ? null
                        : checkpointRef(run.checkpointRef, run.id, token.leaseEpoch),
            ),

        readCheckpointPages: (refs, options = {}) =>
            withRunFence(
                db,
                token,
                options.allowDeadline ? 'deadline_delivery' : 'work',
                async (tx, run) => {
                    if (!Array.isArray(refs) || refs.length > 20)
                        throw new AgentPersistenceError('INVALID_CHECKPOINT');
                    if (!refs.length) return [];
                    const keys = refs.map((ref) => {
                        if (
                            !ref ||
                            !/^read-\d+$/.test(ref.id) ||
                            typeof ref.originalUrl !== 'string'
                        )
                            throw new AgentPersistenceError('INVALID_CHECKPOINT');
                        const hash = createHash('sha256')
                            .update(JSON.stringify(ref.originalUrl))
                            .digest('hex');
                        return `${ref.id}:${hash}`;
                    });
                    const calls = await tx.query.toolCalls.findMany({
                        where: and(
                            eq(dbToolCalls.userId, run.userId),
                            eq(dbToolCalls.runId, run.id),
                            eq(dbToolCalls.tool, 'read'),
                            inArray(dbToolCalls.operationKey, keys),
                            eq(dbToolCalls.status, 'succeeded'),
                            lte(dbToolCalls.finishedAt, run.deadlineAt!),
                        ),
                    });
                    return refs.map((ref, index) => {
                        const call = calls.find((entry) => entry.operationKey === keys[index]);
                        if (!call) throw new AgentPersistenceError('INVALID_CHECKPOINT');
                        const output = completedOutput(call) as unknown as AgentPage;
                        const { text, ...metadata } = output;
                        const { id, questionIds, ...savedMetadata } = ref;
                        if (
                            typeof text !== 'string' ||
                            !isDeepStrictEqual(metadata, savedMetadata) ||
                            createHash('sha256').update(text).digest('hex') !== ref.contentHash
                        )
                            throw new AgentPersistenceError('INVALID_CHECKPOINT');
                        return { ...output, id, questionIds: structuredClone(questionIds) };
                    });
                },
            ),

        async promoteCheckpoint(ref) {
            const checked = checkpointRef(ref, token.runId, token.leaseEpoch);
            if (checked.leaseEpoch !== token.leaseEpoch)
                throw new AgentPersistenceError('INVALID_CHECKPOINT');
            return fence(async (tx, run) => {
                await tx
                    .update(dbRuns)
                    .set({ checkpointRef: { ...checked } })
                    .where(eq(dbRuns.id, run.id))
                    .returning()
                    .then((rows) => requiredDatabaseValue(rows[0]));
            });
        },

        searchPage: (url) =>
            fence(async (tx, run) => {
                const wanted = normalizeUrl(url);
                const calls = await tx.query.toolCalls.findMany({
                    where: and(
                        eq(dbToolCalls.userId, run.userId),
                        eq(dbToolCalls.runId, run.id),
                        eq(dbToolCalls.tool, 'search'),
                        eq(dbToolCalls.status, 'succeeded'),
                        lte(dbToolCalls.finishedAt, run.deadlineAt!),
                    ),
                    orderBy: [desc(dbToolCalls.finishedAt), desc(dbToolCalls.attemptNo)],
                });
                for (const call of calls) {
                    const output = completedOutput(call);
                    if (
                        !output ||
                        typeof output !== 'object' ||
                        Array.isArray(output) ||
                        !Array.isArray(output.results)
                    )
                        continue;
                    for (const result of output.results) {
                        if (
                            !result ||
                            typeof result !== 'object' ||
                            Array.isArray(result) ||
                            typeof result.url !== 'string' ||
                            !result.page
                        )
                            continue;
                        try {
                            if (normalizeUrl(result.url) === wanted) return result.page;
                        } catch {
                            /* Ignore malformed old results. */
                        }
                    }
                }
                return null;
            }),

        readPages: (options = {}) =>
            withRunFence(
                db,
                token,
                options.allowDeadline ? 'deadline_delivery' : 'work',
                async (tx, run) => {
                    const calls = await tx.query.toolCalls.findMany({
                        where: and(
                            eq(dbToolCalls.userId, run.userId),
                            eq(dbToolCalls.runId, run.id),
                            eq(dbToolCalls.tool, 'read'),
                            eq(dbToolCalls.status, 'succeeded'),
                            lte(dbToolCalls.finishedAt, run.deadlineAt!),
                        ),
                        orderBy: [asc(dbToolCalls.operationKey), asc(dbToolCalls.attemptNo)],
                        limit: options.offset === undefined ? undefined : 1,
                        offset: options.offset,
                    });
                    return calls.map(completedOutput);
                },
            ),
    };
}
