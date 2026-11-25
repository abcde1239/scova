import { requireRow } from '../utils/database.ts';
import {
    type DatabaseClient,
    sql,
    queryRows,
    tasks as dbTasks,
    eq,
    taskVersions as dbTaskVersions,
    and,
    scheduleOccurrences as dbScheduleOccurrences,
    runs as dbRuns,
    inArray,
    runEvents as dbRunEvents,
    outbox as dbOutbox,
    persistRunGraphEvent,
} from '@scova/db';

import { captureFeedbackSnapshot } from '@scova/db/feedback';
import { TaskConfigSchema, RunEventSchema, parseContract } from '@scova/models';
import { dueSchedule } from '@scova/shared';
import { effectiveRunScopeHash, researchComparisonScopeHash } from '@/utils/research-scope.ts';
import { SchedulerTaskError } from '../utils/scheduler.ts';

export interface ScheduledTaskResult {
    taskId: string;
    status: 'created' | 'skipped_overlap' | 'reused';
}
export interface SchedulerRepository {
    scheduleNext(
        excludedTaskIds: readonly string[],
        signal?: AbortSignal,
    ): Promise<ScheduledTaskResult | null>;
}

/** Task 锁协调手动命令与生命周期；不锁旧 Run，允许交付事务写 Task 外键。 */
export function createSchedulerRepository(database: DatabaseClient): SchedulerRepository {
    return {
        async scheduleNext(excludedTaskIds, signal) {
            const mode = 'live' as const;
            if (signal?.aborted) return null;
            let taskId: string | undefined;
            try {
                return await database.transaction(async (tx) => {
                    const excluded = excludedTaskIds.length
                        ? sql`AND id NOT IN (${sql.join(
                              excludedTaskIds.map((id) => sql`${id}::uuid`),
                              sql`, `,
                          )})`
                        : sql``;
                    const [locked] = await queryRows<{ id: string }>(
                        tx,
                        sql`
            SELECT id FROM tasks
            WHERE status = 'active' AND next_run_at IS NOT NULL
              AND next_run_at <= statement_timestamp() ${excluded}
            ORDER BY next_run_at, id
            LIMIT 1 FOR NO KEY UPDATE SKIP LOCKED
          `,
                    );
                    if (!locked || signal?.aborted) return null;
                    taskId = locked.id;
                    const [clock] = await queryRows<{ now: Date }>(
                        tx,
                        sql`SELECT clock_timestamp() AS now`,
                    );
                    const now = clock!.now;
                    const task = await tx.query.tasks
                        .findFirst({ where: eq(dbTasks.id, taskId) })
                        .then((row) => requireRow(row));
                    if (task.status !== 'active' || !task.nextRunAt || task.nextRunAt > now)
                        return null;
                    const version = await tx.query.taskVersions
                        .findFirst({
                            where: and(
                                eq(
                                    dbTaskVersions.id,
                                    task.currentVersionId ?? '00000000-0000-0000-0000-000000000000',
                                ),
                                eq(dbTaskVersions.userId, task.userId),
                                eq(dbTaskVersions.taskId, taskId),
                            ),
                        })
                        .then((row) => requireRow(row));
                    const config = parseContract(TaskConfigSchema, version.configJson);
                    const due = dueSchedule(config, task.nextRunAt, now);
                    if (!due) throw new Error('到期任务缺少有效周期计划');
                    const existing = await tx.query.scheduleOccurrences.findFirst({
                        where: and(
                            eq(dbScheduleOccurrences.taskId, taskId),
                            eq(dbScheduleOccurrences.scheduleRevision, task.scheduleRevision),
                            eq(dbScheduleOccurrences.scheduledAt, due.scheduledAt),
                        ),
                    });
                    if (existing) {
                        await tx
                            .update(dbTasks)
                            .set({ nextRunAt: due.nextRunAt })
                            .where(eq(dbTasks.id, taskId))
                            .returning()
                            .then((rows) => requireRow(rows[0]));
                        return { taskId, status: 'reused' };
                    }
                    const active = await tx.query.runs.findFirst({
                        where: and(
                            eq(dbRuns.userId, task.userId),
                            eq(dbRuns.taskId, taskId),
                            inArray(dbRuns.status, [
                                'queued',
                                'running',
                                'recovering',
                                'cancel_requested',
                            ]),
                        ),
                        columns: { id: true },
                    });
                    const occurrence = await tx
                        .insert(dbScheduleOccurrences)
                        .values({
                            userId: task.userId,
                            taskId: taskId,
                            scheduleRevision: task.scheduleRevision,
                            scheduledAt: due.scheduledAt,
                            missedCount: due.missedCount,
                            status: active ? 'skipped_overlap' : 'created',
                        })
                        .returning()
                        .then((rows) => requireRow(rows[0]));
                    if (!active) {
                        const run = await tx
                            .insert(dbRuns)
                            .values({
                                userId: task.userId,
                                taskId: taskId,
                                taskVersionId: version.id,
                                comparisonScopeHash: effectiveRunScopeHash(
                                    researchComparisonScopeHash(config),
                                    mode,
                                ),
                                mode: mode,
                                trigger: 'scheduled',
                                occurrenceId: occurrence.id,
                                queuedAt: now,
                                budgetJson: config.budget,
                                feedbackSnapshotJson: await captureFeedbackSnapshot(
                                    tx,
                                    task.userId,
                                    taskId,
                                ),
                                usageJson: {
                                    searches: 0,
                                    pages: 0,
                                    inputTokens: 0,
                                    outputTokens: 0,
                                    estimated: true,
                                },
                            })
                            .returning()
                            .then((rows) => requireRow(rows[0]));
                        await tx
                            .update(dbScheduleOccurrences)
                            .set({ runId: run.id })
                            .where(eq(dbScheduleOccurrences.id, occurrence.id))
                            .returning()
                            .then((rows) => requireRow(rows[0]));
                        const queued = await tx
                            .insert(dbRunEvents)
                            .values({
                                userId: task.userId,
                                runId: run.id,
                                seq: 1,
                                type: 'run.queued',
                                occurredAt: now,
                                payload: { status: 'queued', taskVersionId: version.id },
                            })
                            .returning()
                            .then((rows) => requireRow(rows[0]));
                        await persistRunGraphEvent(
                            tx,
                            run.userId,
                            parseContract(RunEventSchema, {
                                schemaVersion: queued.schemaVersion,
                                eventId: queued.id,
                                runId: queued.runId,
                                seq: queued.seq,
                                occurredAt: queued.occurredAt.toISOString(),
                                type: queued.type,
                                payload: queued.payload,
                            }),
                        );
                        await tx
                            .insert(dbOutbox)
                            .values({
                                userId: task.userId,
                                aggregateId: run.id,
                                eventType: 'run.enqueue',
                                dedupeKey: `run-${run.id}-enqueue`,
                                availableAt: now,
                                payload: { runId: run.id, taskId, taskVersionId: version.id, mode },
                            })
                            .returning()
                            .then((rows) => requireRow(rows[0]));
                    }
                    await tx
                        .update(dbTasks)
                        .set({ nextRunAt: due.nextRunAt })
                        .where(eq(dbTasks.id, taskId))
                        .returning()
                        .then((rows) => requireRow(rows[0]));
                    return { taskId, status: active ? 'skipped_overlap' : 'created' };
                });
            } catch (error) {
                if (taskId) throw new SchedulerTaskError(taskId, error);
                throw error;
            }
        },
    };
}
