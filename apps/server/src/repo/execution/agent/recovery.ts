import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { AgentPage, AgentPageRef } from '@scova/agent-core';
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
    gt,
    or,
    type ToolCall,
    type DatabaseTransaction,
    type Run,
} from '@scova/db';
import { readFeedbackSnapshot } from '@scova/models';
import { withRunFence } from '../runs.ts';
import { loadBaseline } from '../comparison.ts';
import { normalizeUrl } from '@scova/connectors';
import { AgentPersistenceError, type AgentCheckpointRef } from '@scova/execution/agent';
import { executionPageBatchLimit, type ExecutionPageCursor } from '@scova/execution/protocol';
import { collectPageBatch } from '../../../utils/execution/page-batch.ts';
import { heldReservation, usage, completedOutput, checkpointRef } from './validation.ts';
import type { AgentRepositoryScope } from './scope.ts';

// Read only a few receipts ahead so a large batch does not materialize all page bodies.
const receiptChunkSize = 4;
function checkpointKey(ref: AgentPageRef) {
    if (!ref || !/^read-\d+$/.test(ref.id) || typeof ref.originalUrl !== 'string')
        throw new AgentPersistenceError('INVALID_CHECKPOINT');
    const hash = createHash('sha256').update(JSON.stringify(ref.originalUrl)).digest('hex');
    return `${ref.id}:${hash}`;
}

function restoreCheckpointPage(ref: AgentPageRef, call: ToolCall | undefined): AgentPage {
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
}

async function* checkpointPages(tx: DatabaseTransaction, run: Run, refs: AgentPageRef[]) {
    if (!Array.isArray(refs) || refs.length > executionPageBatchLimit)
        throw new AgentPersistenceError('INVALID_CHECKPOINT');
    for (let start = 0; start < refs.length; start += receiptChunkSize) {
        const chunk = refs.slice(start, start + receiptChunkSize);
        const keys = chunk.map(checkpointKey);
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
        for (const [index, ref] of chunk.entries()) {
            const call = calls.find((entry) => entry.operationKey === keys[index]);
            yield { page: restoreCheckpointPage(ref, call), cursor: start + index + 1 };
        }
    }
}

export function createRecoveryMethods({ db, token, fence }: AgentRepositoryScope) {
    return {
        comparison: (options: { allowDeadline?: boolean } = {}) =>
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

        readAuthorizedCheckpoint: (options: { allowDeadline?: boolean } = {}) =>
            withRunFence(
                db,
                token,
                options.allowDeadline ? 'deadline_delivery' : 'work',
                async (_tx, run) =>
                    run.checkpointRef === null
                        ? null
                        : checkpointRef(run.checkpointRef, run.id, token.leaseEpoch),
            ),

        readCheckpointPages: (refs: AgentPageRef[], options: { allowDeadline?: boolean } = {}) =>
            withRunFence(
                db,
                token,
                options.allowDeadline ? 'deadline_delivery' : 'work',
                async (tx, run) => {
                    const pages: AgentPage[] = [];
                    for await (const { page } of checkpointPages(tx, run, refs)) pages.push(page);
                    return pages;
                },
            ),

        readCheckpointPageBatch: (
            refs: AgentPageRef[],
            options: { allowDeadline?: boolean } = {},
        ) =>
            withRunFence(
                db,
                token,
                options.allowDeadline ? 'deadline_delivery' : 'work',
                (tx, run) => collectPageBatch(checkpointPages(tx, run, refs)),
            ),

        async promoteCheckpoint(ref: AgentCheckpointRef) {
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

        searchPage: (url: string) =>
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

        readPageBatch: (options: { allowDeadline?: boolean; cursor?: ExecutionPageCursor } = {}) =>
            withRunFence(
                db,
                token,
                options.allowDeadline ? 'deadline_delivery' : 'work',
                (tx, run) =>
                    collectPageBatch(
                        (async function* () {
                            let cursor = options.cursor;
                            for (;;) {
                                const calls = await tx.query.toolCalls.findMany({
                                    where: and(
                                        eq(dbToolCalls.userId, run.userId),
                                        eq(dbToolCalls.runId, run.id),
                                        eq(dbToolCalls.tool, 'read'),
                                        eq(dbToolCalls.status, 'succeeded'),
                                        lte(dbToolCalls.finishedAt, run.deadlineAt!),
                                        cursor &&
                                            or(
                                                gt(dbToolCalls.operationKey, cursor.operationKey),
                                                and(
                                                    eq(
                                                        dbToolCalls.operationKey,
                                                        cursor.operationKey,
                                                    ),
                                                    gt(dbToolCalls.attemptNo, cursor.attemptNo),
                                                ),
                                            ),
                                    ),
                                    orderBy: [
                                        asc(dbToolCalls.operationKey),
                                        asc(dbToolCalls.attemptNo),
                                    ],
                                    limit: receiptChunkSize,
                                });
                                for (const call of calls) {
                                    cursor = {
                                        operationKey: call.operationKey,
                                        attemptNo: call.attemptNo,
                                    };
                                    yield { page: completedOutput(call), cursor };
                                }
                                if (calls.length < receiptChunkSize) return;
                            }
                        })(),
                    ),
            ),
        readPages: (options: { allowDeadline?: boolean; offset?: number } = {}) =>
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
