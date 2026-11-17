import { requiredDatabaseValue } from '@/utils/database.ts';
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
import { withRunFence } from '@/repo/runs.ts';
import { loadBaseline } from '@/repo/comparison.ts';
import { normalizeUrl } from '@scova/connectors';
import { type AgentRepository, AgentPersistenceError } from './types.ts';
import { heldReservation, usage, completedOutput, checkpointRef } from './validation.ts';
import type { AgentRepositoryScope } from '@/repo/agent/scope.ts';

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

        readAuthorizedCheckpoint: () =>
            fence(async (_tx, run) =>
                run.checkpointRef === null
                    ? null
                    : checkpointRef(run.checkpointRef, run.id, token.leaseEpoch),
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
                    });
                    return calls.map(completedOutput);
                },
            ),
    };
}
