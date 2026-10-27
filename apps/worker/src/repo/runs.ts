import { randomUUID } from 'node:crypto';
import { createTerminalNotifications } from '@/repo/notifications.ts';
import {
    BudgetSchema,
    RunEventSchema,
    TaskConfigSchema,
    UsageSchema,
    parseContract,
    type Budget,
    type TaskConfig,
    type Usage,
} from '@scova/contracts';
import type { Prisma, PrismaClient, Run } from '@scova/models';
import {
    RUN_ACTIVE_STATUSES,
    RUN_FAILURE_MESSAGES,
    RunFenceError,
    type RunEventInput,
    type RunLeaseToken,
    type RunProgressEvent,
} from '@/utils/runs.ts';

export type RunFencePurpose = 'work' | 'control' | 'deadline_delivery';
export interface ClaimedRun {
    kind: 'claimed';
    token: RunLeaseToken;
    run: Run;
    config: TaskConfig;
    budget: Budget;
    usage: Usage;
    now: Date;
}
export type RunClaim = ClaimedRun | { kind: 'ignored' | 'busy' };
export interface RunRepository {
    claim(
        runId: string,
        leaseOwner: string,
        leaseMs?: number,
        options?: { allowDeadlineRecovery?: boolean },
    ): Promise<RunClaim>;
    renew(
        token: RunLeaseToken,
        leaseMs: number,
    ): Promise<'renewed' | 'canceled' | 'deadline' | 'lost'>;
    finish(token: RunLeaseToken, failure: { code: string }): Promise<boolean>;
    emit(token: RunLeaseToken, event: RunProgressEvent): Promise<void>;
    assertActive(token: RunLeaseToken): Promise<void>;
    listRecoverable(limit: number): Promise<{ id: string; leaseEpoch: number }[]>;
}

async function lockRun(tx: Prisma.TransactionClient, runId: string) {
    await tx.$queryRaw`SELECT id FROM runs WHERE id = ${runId}::uuid FOR UPDATE`;
    return tx.run.findUnique({ where: { id: runId } });
}

async function databaseNow(tx: Prisma.TransactionClient): Promise<Date> {
    const [row] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
    return row!.now;
}

function active(run: Run) {
    return RUN_ACTIVE_STATUSES.includes(run.status as (typeof RUN_ACTIVE_STATUSES)[number]);
}

function validLease(run: Run | null, token: RunLeaseToken, now: Date): run is Run {
    return !!(
        run &&
        run.userId === token.userId &&
        run.leaseOwner === token.leaseOwner &&
        run.leaseEpoch === token.leaseEpoch &&
        run.leaseExpiresAt &&
        run.leaseExpiresAt > now &&
        active(run)
    );
}

/**
 * 只供受信领域 repository 组合数据库写入；callback 与检查在同一行锁事务中。
 * 不传给 Agent，不在 callback 内请求网络、调用模型或等待外部任务。
 * control 仅供失败/取消终结；deadline_delivery 留给已存证据的确定性部分交付。
 */
export function withRunFence<T>(
    db: PrismaClient,
    token: RunLeaseToken,
    purpose: RunFencePurpose,
    operation: (tx: Prisma.TransactionClient, run: Run, now: Date) => Promise<T>,
): Promise<T> {
    return db.$transaction(async (tx) => {
        const run = await lockRun(tx, token.runId);
        const now = await databaseNow(tx);
        if (!validLease(run, token, now)) throw new RunFenceError('LEASE_LOST');
        if (purpose !== 'control' && (run.cancelRequestedAt || run.status === 'cancel_requested'))
            throw new RunFenceError('RUN_CANCELED');
        if (purpose === 'work' && (!run.deadlineAt || run.deadlineAt <= now))
            throw new RunFenceError('DEADLINE_EXCEEDED');
        const result = await operation(tx, run, now);
        // callback 可能执行多条 SQL；事务变长不能把已过期权限带到提交点。
        // 用加锁时的租约核验，允许 callback 自己原子终结 Run 或续期。
        const finishingAt = await databaseNow(tx);
        if (run.leaseExpiresAt! <= finishingAt) throw new RunFenceError('LEASE_LOST');
        if (purpose === 'work' && run.deadlineAt! <= finishingAt)
            throw new RunFenceError('DEADLINE_EXCEEDED');
        return result;
    });
}

/** 调用者已持有 Run 行锁，序号分配与业务状态写入在同一事务内。 */
export async function appendEvent(
    tx: Prisma.TransactionClient,
    run: Run,
    now: Date,
    event: RunEventInput,
) {
    const last = await tx.runEvent.aggregate({ where: { runId: run.id }, _max: { seq: true } });
    const record = parseContract(RunEventSchema, {
        schemaVersion: 1,
        eventId: randomUUID(),
        runId: run.id,
        seq: (last._max.seq ?? 0) + 1,
        occurredAt: now.toISOString(),
        type: event.type,
        payload: event.payload,
    });
    await tx.runEvent.create({
        data: {
            id: record.eventId,
            userId: run.userId,
            runId: run.id,
            seq: record.seq,
            schemaVersion: record.schemaVersion,
            type: record.type,
            payload: record.payload as Prisma.InputJsonValue,
            occurredAt: now,
        },
    });
}

async function finishLocked(tx: Prisma.TransactionClient, run: Run, now: Date, code: string) {
    const canceled = !!run.cancelRequestedAt || run.status === 'cancel_requested';
    const safeCode = Object.hasOwn(RUN_FAILURE_MESSAGES, code) ? code : 'EXECUTOR_FAILED';
    const status = canceled ? 'canceled' : 'failed';
    if (!canceled) await createTerminalNotifications(tx, run, { status: 'failed' });
    // A terminal Run cannot later settle an in-flight supplier call; preserve its reservation as unknown.
    await tx.toolCall.updateMany({
        where: { userId: run.userId, runId: run.id, status: { in: ['reserved', 'running'] } },
        data: { status: 'unknown', finishedAt: now },
    });
    await tx.run.update({
        where: { id: run.id },
        data: {
            status,
            finishedAt: now,
            failureCode: canceled ? null : safeCode,
            leaseOwner: null,
            leaseExpiresAt: null,
        },
    });
    await appendEvent(
        tx,
        run,
        now,
        canceled
            ? { type: 'run.canceled', payload: { status: 'canceled', message: '执行已取消' } }
            : {
                  type: 'run.failed',
                  payload: {
                      status: 'failed',
                      code: safeCode,
                      message: RUN_FAILURE_MESSAGES[safeCode]!,
                  },
              },
    );
}

function leaseExpiry(now: Date, leaseMs: number) {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 3_600_000)
        throw new Error('Run 租约毫秒数必须为 1 至 3600000 的整数');
    return new Date(now.getTime() + leaseMs);
}

/** PostgreSQL 是执行事实源；BullMQ 的锁与 payload 不授予任何业务写权限。 */
export function createRunRepository(db: PrismaClient): RunRepository {
    return {
        claim(runId, leaseOwner, leaseMs = 30_000, options = {}) {
            if (!leaseOwner || leaseOwner.length > 200) throw new Error('Run worker 标识无效');
            return db.$transaction(async (tx): Promise<RunClaim> => {
                const run = await lockRun(tx, runId);
                const now = await databaseNow(tx);
                if (!run || !active(run)) return { kind: 'ignored' };
                if (run.leaseExpiresAt && run.leaseExpiresAt > now) return { kind: 'busy' };
                const recovering = run.leaseEpoch > 0 || run.startedAt !== null;
                const recoveryCount = run.recoveryCount + (recovering ? 1 : 0);
                if (run.cancelRequestedAt || run.status === 'cancel_requested') {
                    await finishLocked(tx, run, now, 'EXECUTOR_FAILED');
                    return { kind: 'ignored' };
                }
                if (recoveryCount > 3) {
                    await finishLocked(tx, run, now, 'RECOVERY_LIMIT_EXCEEDED');
                    return { kind: 'ignored' };
                }
                let config: TaskConfig;
                let budget: Budget;
                let usage: Usage;
                try {
                    const version = await tx.taskVersion.findUnique({
                        where: { id: run.taskVersionId },
                    });
                    if (!version || version.userId !== run.userId || version.taskId !== run.taskId)
                        throw new Error('执行版本不存在');
                    config = parseContract(
                        TaskConfigSchema,
                        run.followupConfigJson ?? version.configJson,
                    );
                    budget = parseContract(BudgetSchema, run.budgetJson);
                    usage = parseContract(UsageSchema, run.usageJson);
                } catch {
                    await finishLocked(tx, run, now, 'INVALID_RUN_CONFIGURATION');
                    return { kind: 'ignored' };
                }
                const startedAt = run.startedAt ?? now;
                // Freeze once, including null. Recovery must never silently choose a newer baseline.
                let baselineRunId = run.baselineRunId;
                if (run.startedAt === null) {
                    const baseline = await tx.baseline.findUnique({
                        where: {
                            userId_taskId_comparisonScopeHash: {
                                userId: run.userId,
                                taskId: run.taskId,
                                comparisonScopeHash: run.comparisonScopeHash,
                            },
                        },
                        include: { completeRun: { include: { reports: true } } },
                    });
                    const prior = baseline?.completeRun;
                    baselineRunId =
                        prior &&
                        prior.id !== run.id &&
                        prior.userId === run.userId &&
                        prior.taskId === run.taskId &&
                        prior.comparisonScopeHash === run.comparisonScopeHash &&
                        prior.mode === run.mode &&
                        prior.status === 'succeeded' &&
                        (prior.coverageJson as { completeness?: string } | null)?.completeness ===
                            'complete' &&
                        prior.reports.some((report) => report.completeness === 'complete')
                            ? prior.id
                            : null;
                }
                const deadlineAt =
                    run.deadlineAt ??
                    new Date(startedAt.getTime() + budget.maxDurationSeconds * 1000);
                if (
                    !Number.isFinite(deadlineAt.getTime()) ||
                    (deadlineAt <= now && !options.allowDeadlineRecovery)
                ) {
                    await finishLocked(tx, run, now, 'DEADLINE_EXCEEDED');
                    return { kind: 'ignored' };
                }
                const updated = await tx.run.update({
                    where: { id: run.id },
                    data: {
                        status: 'running',
                        startedAt,
                        deadlineAt,
                        baselineRunId,
                        leaseOwner,
                        leaseEpoch: { increment: 1 },
                        leaseExpiresAt: leaseExpiry(now, leaseMs),
                        recoveryCount,
                    },
                });
                if (recovering)
                    await appendEvent(tx, updated, now, {
                        type: 'run.recovering',
                        payload: { status: 'recovering', recoveryCount },
                    });
                await appendEvent(tx, updated, now, {
                    type: 'run.started',
                    payload: { status: 'running', startedAt: startedAt.toISOString() },
                });
                return {
                    kind: 'claimed',
                    run: updated,
                    config,
                    budget,
                    usage,
                    now,
                    token: {
                        runId,
                        userId: run.userId,
                        leaseOwner,
                        leaseEpoch: updated.leaseEpoch,
                    },
                };
            });
        },
        async renew(token, leaseMs) {
            try {
                return await withRunFence(db, token, 'control', async (tx, run, now) => {
                    if (run.cancelRequestedAt || run.status === 'cancel_requested')
                        return 'canceled' as const;
                    if (!run.deadlineAt || run.deadlineAt <= now) return 'deadline' as const;
                    await tx.run.update({
                        where: { id: run.id },
                        data: { leaseExpiresAt: leaseExpiry(now, leaseMs) },
                    });
                    return 'renewed' as const;
                });
            } catch (error) {
                if (error instanceof RunFenceError) return 'lost';
                throw error;
            }
        },
        async finish(token, failure) {
            try {
                await withRunFence(db, token, 'control', async (tx, run, now) => {
                    const code =
                        run.deadlineAt && run.deadlineAt <= now
                            ? 'DEADLINE_EXCEEDED'
                            : failure.code;
                    await finishLocked(tx, run, now, code);
                });
                return true;
            } catch (error) {
                if (error instanceof RunFenceError) return false;
                throw error;
            }
        },
        emit: (token, event) =>
            withRunFence(db, token, 'work', async (tx, run, now) => {
                if (!/^(?:step\.|tool\.|budget\.updated$|coverage\.updated$)/.test(event.type))
                    throw new Error('执行器只能写入进度事件');
                await appendEvent(tx, run, now, event);
            }),
        assertActive: (token) => withRunFence(db, token, 'work', async () => undefined),
        async listRecoverable(limit) {
            if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
                throw new Error('Run 恢复扫描上限必须为 1 至 1000 的整数');
            const rows = await db.$queryRaw<{ id: string; lease_epoch: number }[]>`
        SELECT id, lease_epoch FROM runs
        WHERE status IN ('queued', 'running', 'recovering', 'cancel_requested')
          AND (lease_expires_at IS NULL OR lease_expires_at <= clock_timestamp())
        ORDER BY queued_at, id LIMIT ${limit}
      `;
            return rows.map((row) => ({ id: row.id, leaseEpoch: row.lease_epoch }));
        },
    };
}
