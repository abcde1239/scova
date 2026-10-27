import { Prisma, captureFeedbackSnapshot, type PrismaClient } from '@scova/models';
import { TaskConfigSchema, parseContract } from '@scova/contracts';
import { dueSchedule, effectiveRunScopeHash } from '@scova/utils';
import { SchedulerTaskError } from '@/utils/scheduler.ts';

export interface ScheduledTaskResult {
    taskId: string;
    status: 'created' | 'skipped_overlap' | 'reused';
}
export interface SchedulerRepository {
    scheduleNext(
        mode: 'demo' | 'live',
        excludedTaskIds: readonly string[],
        signal?: AbortSignal,
    ): Promise<ScheduledTaskResult | null>;
}

/** Task 锁协调手动命令与生命周期；不锁旧 Run，允许交付事务写 Task 外键。 */
export function createSchedulerRepository(database: PrismaClient): SchedulerRepository {
    return {
        async scheduleNext(mode, excludedTaskIds, signal) {
            if (signal?.aborted) return null;
            let taskId: string | undefined;
            try {
                return await database.$transaction(async (tx) => {
                    const excluded = excludedTaskIds.length
                        ? Prisma.sql`AND id NOT IN (${Prisma.join(excludedTaskIds.map((id) => Prisma.sql`${id}::uuid`))})`
                        : Prisma.empty;
                    const [locked] = await tx.$queryRaw<{ id: string }[]>`
            SELECT id FROM tasks
            WHERE status = 'active' AND next_run_at IS NOT NULL
              AND next_run_at <= statement_timestamp() ${excluded}
            ORDER BY next_run_at, id
            LIMIT 1 FOR NO KEY UPDATE SKIP LOCKED
          `;
                    if (!locked || signal?.aborted) return null;
                    taskId = locked.id;
                    const [clock] = await tx.$queryRaw<
                        { now: Date }[]
                    >`SELECT clock_timestamp() AS now`;
                    const now = clock!.now;
                    const task = await tx.task.findUniqueOrThrow({ where: { id: taskId } });
                    if (task.status !== 'active' || !task.nextRunAt || task.nextRunAt > now)
                        return null;
                    const version = await tx.taskVersion.findFirstOrThrow({
                        where: {
                            id: task.currentVersionId ?? '00000000-0000-0000-0000-000000000000',
                            userId: task.userId,
                            taskId,
                        },
                    });
                    const config = parseContract(TaskConfigSchema, version.configJson);
                    const due = dueSchedule(config, task.nextRunAt, now);
                    if (!due) throw new Error('到期任务缺少有效周期计划');
                    const existing = await tx.scheduleOccurrence.findUnique({
                        where: {
                            taskId_scheduleRevision_scheduledAt: {
                                taskId,
                                scheduleRevision: task.scheduleRevision,
                                scheduledAt: due.scheduledAt,
                            },
                        },
                    });
                    if (existing) {
                        await tx.task.update({
                            where: { id: taskId },
                            data: { nextRunAt: due.nextRunAt },
                        });
                        return { taskId, status: 'reused' };
                    }
                    const active = await tx.run.findFirst({
                        where: {
                            userId: task.userId,
                            taskId,
                            status: { in: ['queued', 'running', 'recovering', 'cancel_requested'] },
                        },
                        select: { id: true },
                    });
                    const occurrence = await tx.scheduleOccurrence.create({
                        data: {
                            userId: task.userId,
                            taskId,
                            scheduleRevision: task.scheduleRevision,
                            scheduledAt: due.scheduledAt,
                            missedCount: due.missedCount,
                            status: active ? 'skipped_overlap' : 'created',
                        },
                    });
                    if (!active) {
                        const run = await tx.run.create({
                            data: {
                                userId: task.userId,
                                taskId,
                                taskVersionId: version.id,
                                comparisonScopeHash: effectiveRunScopeHash(
                                    version.comparisonScopeHash,
                                    mode,
                                ),
                                mode,
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
                            },
                        });
                        await tx.scheduleOccurrence.update({
                            where: { id: occurrence.id },
                            data: { runId: run.id },
                        });
                        await tx.runEvent.create({
                            data: {
                                userId: task.userId,
                                runId: run.id,
                                seq: 1,
                                type: 'run.queued',
                                occurredAt: now,
                                payload: { status: 'queued', taskVersionId: version.id },
                            },
                        });
                        await tx.outbox.create({
                            data: {
                                userId: task.userId,
                                aggregateId: run.id,
                                eventType: 'run.enqueue',
                                dedupeKey: `run-${run.id}-enqueue`,
                                availableAt: now,
                                payload: { runId: run.id, taskId, taskVersionId: version.id, mode },
                            },
                        });
                    }
                    await tx.task.update({
                        where: { id: taskId },
                        data: { nextRunAt: due.nextRunAt },
                    });
                    return { taskId, status: active ? 'skipped_overlap' : 'created' };
                });
            } catch (error) {
                if (taskId) throw new SchedulerTaskError(taskId, error);
                throw error;
            }
        },
    };
}
