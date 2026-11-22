import { createRunControl } from '../../server/src/app/run-control.ts';
import { readRunControlConfig } from '../../server/src/app/run-control-config.ts';
import { requiredDatabaseValue } from '../../server/src/utils/execution/database.ts';
import {
    runs as dbRuns,
    eq,
    runEvents as dbRunEvents,
    asc,
    outbox as dbOutbox,
    inArray,
    sql,
    reports as dbReports,
    count as dbCount,
    queryRows,
    and,
    tasks as dbTasks,
} from '@scova/db';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createServer as createTcpServer, connect as connectTcp, type Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { createDefaultServices } from '../../server/src/app/services.ts';
import { createRunService as createCommandService } from '../../server/src/service/runs.ts';
import { eventMessage } from '../../server/src/service/run-events.ts';
import { nodeScriptCommand } from '../../../scripts/process-runtime.mjs';
import {
    createRunRepository,
    withRunFence,
    type ClaimedRun,
} from '../../server/src/repo/execution/runs.ts';
import { RunService, type RunExecutionContext } from '../src/service/runs.ts';
import { createRunHandler } from '../src/handler/runs.ts';
import { createRunConsumer } from '../src/app/queue/runs.ts';
import { enqueueRecoverableRuns } from '../../server/src/repo/queue/recoverable-runs.ts';
import { createOutboxQueue } from '../../server/src/repo/queue/outbox.ts';
import { createOutboxRepository } from '../../server/src/repo/outbox.ts';
import { OutboxService } from '../../server/src/service/outbox.ts';
import { outboxDatabase } from './support/outbox-database.ts';
import { emptyUsage, seedRun } from './support/run-database.ts';

const fixture = outboxDatabase();
const repository = createRunRepository(fixture.db);
const redis = new Redis(fixture.redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
});
redis.on('error', () => undefined);
const commands = createCommandService(
    createDefaultServices({ db: () => fixture.db, redis: () => redis }),
);
const activeStatuses = ['queued', 'running', 'recovering', 'cancel_requested'] as const;
const progress = { type: 'step.started' as const, payload: { step: 'plan' as const } };
const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
};
async function waitUntil(check: () => Promise<boolean>, description: string, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
        if (Date.now() >= deadline) throw new Error(`等待超时：${description}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}
async function claimed(runId: string, owner = 'worker-A', leaseMs = 10_000): Promise<ClaimedRun> {
    const result = await repository.claim(runId, owner, leaseMs);
    if (result.kind !== 'claimed') throw new Error(`expected claimed, received ${result.kind}`);
    return result;
}
const stored = (runId: string) =>
    fixture.db.query.runs
        .findFirst({ where: eq(dbRuns.id, runId) })
        .then((row) => requiredDatabaseValue(row));
const events = (runId: string) =>
    fixture.db.query.runEvents.findMany({
        where: eq(dbRunEvents.runId, runId),
        orderBy: [asc(dbRunEvents.seq)],
    });
async function expire(runId: string) {
    await fixture.db
        .update(dbRuns)
        .set({ leaseExpiresAt: new Date(0) })
        .where(eq(dbRuns.id, runId))
        .returning()
        .then((rows) => requiredDatabaseValue(rows[0]));
}
async function queueFixture(handler: Parameters<typeof createRunConsumer>[2]) {
    const queueName = `scova-pipeline-${randomUUID()}`;
    const queue = new Queue(queueName, { connection: redis });
    const consumer = createRunConsumer(fixture.redisUrl, queueName, handler);
    await consumer.start();
    return {
        queue,
        consumer,
        async close() {
            await consumer.stop();
            await queue.obliterate({ force: true });
            await queue.close();
        },
    };
}

beforeAll(async () => {
    await fixture.setup();
    await redis.connect();
}, 120_000);
afterAll(async () => {
    redis.disconnect();
    await fixture.cleanup();
});
beforeEach(async () => {
    // Only this suite's isolated schema is touched; shared Redis is never flushed.
    await fixture.db
        .delete(dbOutbox)
        .returning({ id: dbOutbox.id })
        .then((rows) => ({ count: rows.length }));
    await fixture.db
        .update(dbRuns)
        .set({ status: 'failed', finishedAt: new Date(), leaseOwner: null, leaseExpiresAt: null })
        .where(inArray(dbRuns.status, [...activeStatuses]))
        .returning({ id: dbRuns.id })
        .then((rows) => ({ count: rows.length }));
});

describe('生产 Run 租约、消费与恢复（真实 PG/Redis，串行）', () => {
    it('C12-08 active deadline独立中断，不等待慢续期SQL返回', async () => {
        const seed = await seedRun(fixture.db);
        await fixture.db.execute(
            sql`UPDATE runs SET deadline_at = clock_timestamp() + interval '800 milliseconds' WHERE id = ${seed.run.id}::uuid`,
        );
        const entered = deferred();
        const renewing = deferred();
        const releaseRenew = deferred();
        let context!: RunExecutionContext;
        let renewalReleased = false;
        const slowRepository = {
            ...repository,
            async renew(...args: Parameters<typeof repository.renew>) {
                renewing.resolve();
                await releaseRenew.promise;
                renewalReleased = true;
                return repository.renew(...args);
            },
        };
        const pending = new RunService({
            repository: slowRepository,
            leaseMs: 5_000,
            renewIntervalMs: 30,
            executor: {
                async execute(value) {
                    context = value;
                    entered.resolve();
                    await new Promise(() => {});
                },
            },
        }).execute(seed.run.id);
        try {
            await entered.promise;
            await renewing.promise;
            await waitUntil(
                async () => context.signal.aborted,
                '慢续期未返回时deadline独立abort',
                2_000,
            );
            expect(renewalReleased).toBe(false);
        } finally {
            releaseRenew.resolve();
        }
        expect(await pending).toBe('processed');
        expect(await stored(seed.run.id)).toMatchObject({
            status: 'failed',
            failureCode: 'DEADLINE_EXCEEDED',
        });
        expect(
            await fixture.db
                .select({ count: dbCount() })
                .from(dbReports)
                .where(eq(dbReports.runId, seed.run.id))
                .then((rows) => rows[0]!.count),
        ).toBe(0);
        expect(
            (await events(seed.run.id)).filter((event) => event.type === 'run.failed'),
        ).toHaveLength(1);
    });
    it('C12-10 仅切断consumer的TCP代理，Redis失联时仍可停止并保留Run恢复事实', async () => {
        const upstream = new URL(fixture.redisUrl);
        const sockets = new Set<Socket>();
        let severed = false;
        const proxy = createTcpServer((client) => {
            if (severed) {
                client.destroy();
                return;
            }
            const target = connectTcp(Number(upstream.port || 6379), upstream.hostname);
            sockets.add(client);
            sockets.add(target);
            client.on('error', () => undefined);
            target.on('error', () => undefined);
            client.on('close', () => {
                sockets.delete(client);
                target.destroy();
            });
            target.on('close', () => {
                sockets.delete(target);
                client.destroy();
            });
            client.pipe(target);
            target.pipe(client);
        });
        await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
        const address = proxy.address();
        if (!address || typeof address === 'string') throw new Error('TCP代理无端口');
        const proxyUrl = new URL(fixture.redisUrl);
        proxyUrl.hostname = '127.0.0.1';
        proxyUrl.port = String(address.port);
        const seed = await seedRun(fixture.db);
        const queueName = `scova-stop-disconnected-${randomUUID()}`;
        const queue = new Queue(queueName, { connection: redis });
        const entered = deferred();
        let context!: RunExecutionContext;
        const service = new RunService({
            repository,
            executor: {
                async execute(value) {
                    context = value;
                    entered.resolve();
                    await new Promise(() => {});
                },
            },
        });
        const consumer = createRunConsumer(
            proxyUrl.toString(),
            queueName,
            createRunHandler(service),
        );
        try {
            await consumer.start();
            await queue.add('run.enqueue', { runId: seed.run.id });
            await entered.promise;
            severed = true;
            for (const socket of sockets) socket.destroy();
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                await Promise.race([
                    consumer.stop(),
                    new Promise((_, reject) => {
                        timer = setTimeout(
                            () => reject(new Error('Redis断连后consumer停止超时')),
                            7_000,
                        );
                    }),
                ]);
            } finally {
                clearTimeout(timer);
            }
            expect(context.signal.aborted).toBe(true);
            expect((await stored(seed.run.id)).status).toBe('queued');
            expect((await stored(seed.run.id)).cancelRequestedAt).toBeNull();
            expect(await redis.ping()).toBe('PONG');
        } finally {
            await consumer.stop();
            for (const socket of sockets) socket.destroy();
            await new Promise<void>((resolve) => proxy.close(() => resolve()));
            await queue.obliterate({ force: true });
            await queue.close();
        }
    });
    it('C12-08 fenced事务跨deadline提交前拒绝并回滚，租约仍有效', async () => {
        const seed = await seedRun(fixture.db);
        const lease = await claimed(seed.run.id);
        await fixture.db.execute(
            sql`UPDATE runs SET deadline_at = clock_timestamp() + interval '150 milliseconds' WHERE id = ${seed.run.id}::uuid`,
        );
        await expect(
            withRunFence(fixture.db, lease.token, 'work', async (tx) => {
                await tx
                    .update(dbRuns)
                    .set({ usageJson: { ...emptyUsage(), pages: 9 } })
                    .where(eq(dbRuns.id, seed.run.id))
                    .returning()
                    .then((rows) => requiredDatabaseValue(rows[0]));
                await queryRows<Record<string, unknown>>(
                    tx,
                    sql`SELECT 1 AS waited FROM pg_sleep(0.2)`,
                );
            }),
        ).rejects.toMatchObject({ code: 'DEADLINE_EXCEEDED' });
        expect((await stored(seed.run.id)).usageJson).toEqual(emptyUsage());
    });
    it('C12-04 等待Run行锁期间租约过期，锁后DB时钟拒绝旧权限', async () => {
        const seed = await seedRun(fixture.db);
        const lease = await claimed(seed.run.id, 'lock-wait-owner', 200);
        const locked = deferred();
        const release = deferred();
        const blocker = fixture.db.transaction(async (tx) => {
            await queryRows<Record<string, unknown>>(
                tx,
                sql`SELECT id FROM runs WHERE id = ${seed.run.id}::uuid FOR UPDATE`,
            );
            locked.resolve();
            await release.promise;
        });
        await locked.promise;
        const operation = vi.fn(async () => undefined);
        const pending = withRunFence(fixture.db, lease.token, 'work', operation);
        const assertion = expect(pending).rejects.toMatchObject({ code: 'LEASE_LOST' });
        try {
            await waitUntil(async () => {
                const [now] = await queryRows<{ now: Date }>(
                    fixture.db,
                    sql`SELECT clock_timestamp() AS now`,
                );
                return now.now > lease.run.leaseExpiresAt!;
            }, '持锁跨租约期限');
        } finally {
            release.resolve();
        }
        await blocker;
        await assertion;
        expect(operation).not.toHaveBeenCalled();
    });

    it('C12-10 stop等待已开始的fenced事件事务收敛，停止后拒绝新写', async () => {
        const seed = await seedRun(fixture.db);
        const entered = deferred();
        const requested = deferred();
        const locked = deferred();
        const release = deferred();
        let context!: RunExecutionContext;
        const controller = new AbortController();
        const pending = new RunService({
            repository,
            leaseMs: 10_000,
            renewIntervalMs: 1_000,
            executor: {
                async execute(value) {
                    context = value;
                    entered.resolve();
                    await requested.promise;
                    await context.emit(progress);
                    await new Promise(() => {});
                },
            },
        }).execute(seed.run.id, controller.signal);
        await entered.promise;
        const blocker = fixture.db.transaction(async (tx) => {
            await queryRows<Record<string, unknown>>(
                tx,
                sql`SELECT id FROM runs WHERE id = ${seed.run.id}::uuid FOR UPDATE`,
            );
            locked.resolve();
            await release.promise;
        });
        await locked.promise;
        let transactionStarted = false;
        const originalEmit = repository.emit.bind(repository);
        repository.emit = async (...args) => {
            transactionStarted = true;
            return originalEmit(...args);
        };
        let serviceSettled = false;
        void pending.then(() => {
            serviceSettled = true;
        });
        try {
            requested.resolve();
            await waitUntil(async () => transactionStarted, 'fenced事件已发起');
            controller.abort();
            await Promise.resolve();
            expect(serviceSettled).toBe(false);
            await expect(context.emit(progress)).rejects.toThrow();
        } finally {
            release.resolve();
            repository.emit = originalEmit;
        }
        await blocker;
        expect(await pending).toBe('stopped');
        expect(
            (await events(seed.run.id)).filter((event) => event.type === 'step.started'),
        ).toHaveLength(1);
        expect((await stored(seed.run.id)).status).toBe('queued');
    });
    it('C12-04 fenced事务跨租约到期在提交前拒绝并回滚已写业务数据', async () => {
        const seed = await seedRun(fixture.db);
        const lease = await claimed(seed.run.id, 'short-lease', 150);
        await expect(
            withRunFence(fixture.db, lease.token, 'work', async (tx) => {
                await tx
                    .update(dbRuns)
                    .set({ usageJson: { ...emptyUsage(), searches: 9 } })
                    .where(eq(dbRuns.id, seed.run.id))
                    .returning()
                    .then((rows) => requiredDatabaseValue(rows[0]));
                await queryRows<Record<string, unknown>>(
                    tx,
                    sql`SELECT 1 AS waited FROM pg_sleep(0.2)`,
                );
            }),
        ).rejects.toMatchObject({ code: 'LEASE_LOST' });
        expect((await stored(seed.run.id)).usageJson).toEqual(emptyUsage());
    });
    it('C12-01 并发命令只建一活动 Run/事件/Outbox，owner隔离且终态幂等重放', async () => {
        const seed = await seedRun(fixture.db);
        await fixture.db
            .update(dbRuns)
            .set({ status: 'failed', finishedAt: new Date() })
            .where(eq(dbRuns.id, seed.run.id))
            .returning()
            .then((rows) => requiredDatabaseValue(rows[0]));
        const key = randomUUID();
        const requests = await Promise.all(
            Array.from({ length: 6 }, (_, index) =>
                commands.create(seed.user.id, seed.task.id, {}, index ? randomUUID() : key),
            ),
        );
        const id = requests[0].run.id;
        expect(new Set(requests.map((result) => result.run.id)).size).toBe(1);
        expect(
            await fixture.db
                .select({ count: dbCount() })
                .from(dbRuns)
                .where(
                    and(
                        eq(dbRuns.taskId, seed.task.id),
                        inArray(dbRuns.status, [...activeStatuses]),
                    ),
                )
                .then((rows) => rows[0]!.count),
        ).toBe(1);
        expect(await events(id)).toHaveLength(1);
        expect(
            await fixture.db
                .select({ count: dbCount() })
                .from(dbOutbox)
                .where(and(eq(dbOutbox.aggregateId, id), eq(dbOutbox.eventType, 'run.enqueue')))
                .then((rows) => rows[0]!.count),
        ).toBe(1);
        const other = await seedRun(fixture.db);
        await expect(commands.get(other.user.id, id)).rejects.toMatchObject({ status: 404 });
        expect(
            (await commands.create(seed.user.id, seed.task.id, { mode: 'live' }, key)).run.id,
        ).toBe(id);
        const lease = await claimed(id);
        await repository.finish(lease.token, { code: 'EXECUTOR_NOT_CONFIGURED' });
        expect((await commands.create(seed.user.id, seed.task.id, {}, key)).run.id).toBe(id);
        expect(
            await fixture.db
                .select({ count: dbCount() })
                .from(dbRuns)
                .where(eq(dbRuns.taskId, seed.task.id))
                .then((rows) => rows[0]!.count),
        ).toBe(2);
    });

    it('C12-03 两领取者仅一胜，首次deadline固定，暂停Task不取消已有Run', async () => {
        const seed = await seedRun(fixture.db);
        await fixture.db
            .update(dbTasks)
            .set({ status: 'paused' })
            .where(eq(dbTasks.id, seed.task.id))
            .returning()
            .then((rows) => requiredDatabaseValue(rows[0]));
        const attempts = await Promise.all([
            repository.claim(seed.run.id, 'A'),
            repository.claim(seed.run.id, 'B'),
        ]);
        expect(attempts.map((value) => value.kind).sort()).toEqual(['busy', 'claimed']);
        const winner = attempts.find((value) => value.kind === 'claimed') as ClaimedRun;
        expect(winner.run.leaseEpoch).toBe(1);
        expect(winner.run.deadlineAt!.getTime() - winner.run.startedAt!.getTime()).toBe(
            seed.config.budget.maxDurationSeconds * 1000,
        );
        await repository.emit(winner.token, progress);
        expect((await stored(seed.run.id)).status).toBe('running');
        expect((await stored(seed.run.id)).cancelRequestedAt).toBeNull();
    });

    it('C12-04 通用业务门、事件与终结拒绝错误owner/epoch/用户和过期token', async () => {
        const seed = await seedRun(fixture.db);
        const first = await claimed(seed.run.id);
        for (const token of [
            { ...first.token, userId: randomUUID() },
            { ...first.token, leaseOwner: 'forged-worker' },
            { ...first.token, leaseEpoch: first.token.leaseEpoch + 1 },
        ]) {
            const write = vi.fn(async () => undefined);
            await expect(withRunFence(fixture.db, token, 'work', write)).rejects.toMatchObject({
                code: 'LEASE_LOST',
            });
            expect(write).not.toHaveBeenCalled();
            await expect(repository.emit(token, progress)).rejects.toMatchObject({
                code: 'LEASE_LOST',
            });
            expect(await repository.finish(token, { code: 'EXECUTOR_FAILED' })).toBe(false);
        }
        await expire(seed.run.id);
        expect(await repository.renew(first.token, 10_000)).toBe('lost');
        await expect(repository.assertActive(first.token)).rejects.toMatchObject({
            code: 'LEASE_LOST',
        });
        expect(await repository.finish(first.token, { code: 'EXECUTOR_FAILED' })).toBe(false);
        const next = await claimed(seed.run.id, 'replacement');
        expect(next.run.leaseEpoch).toBe(first.run.leaseEpoch + 1);
        expect(next.run.recoveryCount).toBe(1);
        expect(next.run.startedAt).toEqual(first.run.startedAt);
        expect(next.run.deadlineAt).toEqual(first.run.deadlineAt);
        expect(next.run.budgetJson).toEqual(first.run.budgetJson);
        await expect(
            withRunFence(fixture.db, first.token, 'control', async (tx) =>
                tx
                    .update(dbRuns)
                    .set({ usageJson: { ...emptyUsage(), searches: 999 } })
                    .where(eq(dbRuns.id, seed.run.id))
                    .returning()
                    .then((rows) => requiredDatabaseValue(rows[0])),
            ),
        ).rejects.toMatchObject({ code: 'LEASE_LOST' });
        expect((await stored(seed.run.id)).usageJson).toEqual(emptyUsage());
    });

    it('C12-04 阻塞executor通过真实续期超越初始租约，stop中断后保留可恢复事实', async () => {
        const seed = await seedRun(fixture.db);
        const entered = deferred();
        let context!: RunExecutionContext;
        const service = new RunService({
            repository,
            leaseMs: 600,
            renewIntervalMs: 70,
            executor: {
                async execute(value) {
                    context = value;
                    entered.resolve();
                    await new Promise(() => {});
                },
            },
        });
        const controller = new AbortController();
        const pending = service.execute(seed.run.id, controller.signal);
        try {
            await entered.promise;
            const initial = await stored(seed.run.id);
            await waitUntil(async () => {
                const [now] = await queryRows<{ now: Date }>(
                    fixture.db,
                    sql`SELECT clock_timestamp() AS now`,
                );
                return now.now > initial.leaseExpiresAt!;
            }, '超过初始Run租约');
            const renewed = await stored(seed.run.id);
            expect(renewed.leaseExpiresAt!.getTime()).toBeGreaterThan(
                initial.leaseExpiresAt!.getTime(),
            );
            expect(renewed.leaseEpoch).toBe(initial.leaseEpoch);
            expect(context).not.toHaveProperty('db');
            expect(context).not.toHaveProperty('token');
        } finally {
            controller.abort();
        }
        expect(await pending).toBe('stopped');
        expect(context.signal.aborted).toBe(true);
        expect((await stored(seed.run.id)).status).toBe('queued');
        expect((await events(seed.run.id)).some((event) => event.type === 'run.canceled')).toBe(
            false,
        );
    });

    it('C12-04 续期失租立即abort，旧executor迟到回调不能污染接管者', async () => {
        const seed = await seedRun(fixture.db);
        const entered = deferred();
        let context!: RunExecutionContext;
        const service = new RunService({
            repository,
            leaseMs: 2_000,
            renewIntervalMs: 60,
            executor: {
                async execute(value) {
                    context = value;
                    entered.resolve();
                    await new Promise(() => {});
                },
            },
        });
        const pending = service.execute(seed.run.id);
        await entered.promise;
        await expire(seed.run.id);
        const next = await claimed(seed.run.id, 'new-owner');
        expect(await pending).toBe('ignored');
        expect(context.signal.aborted).toBe(true);
        await expect(context.emit(progress)).rejects.toThrow();
        expect((await stored(seed.run.id)).leaseOwner).toBe(next.token.leaseOwner);
        expect((await stored(seed.run.id)).status).toBe('running');
    });

    it('C12-07 queued/running/recovering取消最终canceled，且不依赖cancel消息', async () => {
        for (const phase of ['queued', 'running', 'recovering'] as const) {
            const seed = await seedRun(fixture.db);
            if (phase === 'recovering') {
                await fixture.db
                    .update(dbRuns)
                    .set({
                        status: 'recovering',
                        leaseEpoch: 1,
                        recoveryCount: 1,
                        startedAt: new Date(),
                        deadlineAt: new Date(Date.now() + 120_000),
                    })
                    .where(eq(dbRuns.id, seed.run.id))
                    .returning()
                    .then((rows) => requiredDatabaseValue(rows[0]));
            }
            if (phase !== 'running') {
                await commands.cancel(seed.user.id, seed.run.id);
                await new RunService({ repository }).execute(seed.run.id);
            } else {
                const entered = deferred();
                let context!: RunExecutionContext;
                const pending = new RunService({
                    repository,
                    leaseMs: 2_000,
                    renewIntervalMs: 30,
                    executor: {
                        async execute(value) {
                            context = value;
                            entered.resolve();
                            await new Promise(() => {});
                        },
                    },
                }).execute(seed.run.id);
                await entered.promise;
                await commands.cancel(seed.user.id, seed.run.id);
                await pending;
                expect(context.signal.aborted).toBe(true);
                await expect(context.emit(progress)).rejects.toThrow();
            }
            const result = await stored(seed.run.id);
            expect(result.status).toBe('canceled');
            expect(result.finishedAt).not.toBeNull();
            expect(
                await fixture.db
                    .select({ count: dbCount() })
                    .from(dbReports)
                    .where(eq(dbReports.runId, seed.run.id))
                    .then((rows) => rows[0]!.count),
            ).toBe(0);
            expect(
                (await events(seed.run.id)).filter((event) => event.type === 'run.canceled'),
            ).toHaveLength(1);
            expect((await commands.cancel(seed.user.id, seed.run.id)).reused).toBe(true);
        }
    });

    it('C12-07 取消先获锁拒绝业务回调，终结先提交则取消复用终态', async () => {
        const seed = await seedRun(fixture.db);
        const first = await claimed(seed.run.id);
        await commands.cancel(seed.user.id, seed.run.id);
        const deliver = vi.fn(async () => undefined);
        await expect(
            withRunFence(fixture.db, first.token, 'deadline_delivery', deliver),
        ).rejects.toMatchObject({ code: 'RUN_CANCELED' });
        expect(deliver).not.toHaveBeenCalled();
        expect(await repository.finish(first.token, { code: 'EXECUTOR_FAILED' })).toBe(true);
        const other = await seedRun(fixture.db);
        const second = await claimed(other.run.id);
        expect(await repository.finish(second.token, { code: 'EXECUTOR_NOT_CONFIGURED' })).toBe(
            true,
        );
        expect((await commands.cancel(other.user.id, other.run.id)).run.status).toBe('failed');
        expect((await events(other.run.id)).some((event) => event.type === 'run.canceled')).toBe(
            false,
        );
    });

    it('C12-08 到期恢复/超过恢复上限不执行，公共原因可读且不暴露内部字段', async () => {
        for (const reason of ['deadline', 'recoveries'] as const) {
            const seed = await seedRun(fixture.db);
            await fixture.db
                .update(dbRuns)
                .set({
                    status: 'recovering',
                    leaseEpoch: 1,
                    recoveryCount: reason === 'recoveries' ? 3 : 1,
                    startedAt: new Date(Date.now() - 600_000),
                    deadlineAt: new Date(Date.now() + (reason === 'deadline' ? -1_000 : 120_000)),
                    checkpointRef: { private: 'must-not-leak' },
                })
                .where(eq(dbRuns.id, seed.run.id))
                .returning()
                .then((rows) => requiredDatabaseValue(rows[0]));
            const execute = vi.fn(async () => undefined);
            await new RunService({ repository, executor: { execute } }).execute(seed.run.id);
            expect(execute).not.toHaveBeenCalled();
            const result = await commands.get(seed.user.id, seed.run.id);
            expect(result).toMatchObject({
                status: 'failed',
                failureCode:
                    reason === 'deadline' ? 'DEADLINE_EXCEEDED' : 'RECOVERY_LIMIT_EXCEEDED',
            });
            expect(result).not.toHaveProperty('checkpointRef');
            expect(result).not.toHaveProperty('leaseOwner');
            const publicEvents = (await events(seed.run.id)).map(eventMessage);
            expect(publicEvents.at(-1)?.type).toBe('run.failed');
            expect(JSON.stringify(publicEvents)).not.toContain('must-not-leak');
        }
    });

    it('C12-08 超期禁止普通写，但有效租约可做受限失败终结', async () => {
        const seed = await seedRun(fixture.db);
        const lease = await claimed(seed.run.id);
        await fixture.db
            .update(dbRuns)
            .set({ deadlineAt: new Date(0) })
            .where(eq(dbRuns.id, seed.run.id))
            .returning()
            .then((rows) => requiredDatabaseValue(rows[0]));
        await expect(
            withRunFence(fixture.db, lease.token, 'work', async () => undefined),
        ).rejects.toMatchObject({ code: 'DEADLINE_EXCEEDED' });
        expect(await repository.renew(lease.token, 10_000)).toBe('deadline');
        expect(await repository.finish(lease.token, { code: 'EXECUTOR_FAILED' })).toBe(true);
        expect((await stored(seed.run.id)).failureCode).toBe('DEADLINE_EXCEEDED');
    });

    it('C12-09 无executor/void/抛错均明确失败且不创建假报告，终态重投不执行', async () => {
        for (const kind of ['missing', 'void', 'throws'] as const) {
            const seed = await seedRun(fixture.db);
            const execute = vi.fn(async () => {
                if (kind === 'throws') throw new Error('secret-error-never-persisted');
            });
            const service = new RunService({
                repository,
                executor: kind === 'missing' ? undefined : { execute },
            });
            expect(await service.execute(seed.run.id)).toBe('processed');
            const result = await stored(seed.run.id);
            expect(result).toMatchObject({
                status: 'failed',
                failureCode:
                    kind === 'missing'
                        ? 'EXECUTOR_NOT_CONFIGURED'
                        : kind === 'void'
                          ? 'EXECUTOR_RETURNED_WITHOUT_DELIVERY'
                          : 'EXECUTOR_FAILED',
            });
            const count = execute.mock.calls.length;
            expect(await service.execute(seed.run.id)).toBe('ignored');
            expect(execute).toHaveBeenCalledTimes(count);
            expect(
                (await events(seed.run.id)).filter((event) => event.type === 'run.failed'),
            ).toHaveLength(1);
            expect(JSON.stringify(await events(seed.run.id))).not.toContain(
                'secret-error-never-persisted',
            );
            expect(
                await fixture.db
                    .select({ count: dbCount() })
                    .from(dbReports)
                    .where(eq(dbReports.runId, seed.run.id))
                    .then((rows) => rows[0]!.count),
            ).toBe(0);
        }
    });

    it('C12-09 并发进度写连续唯一序号，重复finish只一个终态事件', async () => {
        const seed = await seedRun(fixture.db);
        const lease = await claimed(seed.run.id);
        await Promise.all(Array.from({ length: 8 }, () => repository.emit(lease.token, progress)));
        await repository.emit(lease.token, {
            ...progress,
            seq: 999,
            runId: randomUUID(),
            eventId: randomUUID(),
        } as typeof progress);
        await expect(
            repository.emit(lease.token, {
                type: 'run.failed',
                payload: { status: 'failed', code: 'FORGED', message: 'forged terminal' },
            } as unknown as typeof progress),
        ).rejects.toThrow();
        const finished = await Promise.all([
            repository.finish(lease.token, { code: 'EXECUTOR_FAILED' }),
            repository.finish(lease.token, { code: 'EXECUTOR_FAILED' }),
        ]);
        expect(finished.sort()).toEqual([false, true]);
        const rows = await events(seed.run.id);
        expect(rows.map((event) => event.seq)).toEqual(
            Array.from({ length: rows.length }, (_, index) => index + 1),
        );
        expect(rows.filter((event) => event.type === 'run.failed')).toHaveLength(1);
    });

    it('C12-02 真实Outbox到consumer执行；Redis断开保留PG事实，恢复重投不重复终结', async () => {
        const seed = await seedRun(fixture.db);
        const queueName = `scova-outbox-consumer-${randomUUID()}`;
        const connection = new Redis(fixture.redisUrl, {
            lazyConnect: true,
            maxRetriesPerRequest: 1,
            enableOfflineQueue: false,
            retryStrategy: () => null,
        });
        connection.on('error', () => undefined);
        await connection.connect();
        const publisher = createOutboxQueue(connection, queueName);
        const consumer = createRunConsumer(
            fixture.redisUrl,
            queueName,
            createRunHandler(new RunService({ repository })),
        );
        const dispatcher = new OutboxService({
            repository: createOutboxRepository(fixture.db),
            publisher,
        });
        try {
            await publisher.queue.waitUntilReady();
            connection.disconnect();
            await expect(dispatcher.dispatchOnce()).rejects.toThrow();
            expect(
                (
                    await fixture.db.query.outbox
                        .findFirst({ where: eq(dbOutbox.id, seed.outbox.id) })
                        .then((row) => requiredDatabaseValue(row))
                ).sentAt,
            ).toBeNull();
            expect((await stored(seed.run.id)).status).toBe('queued');
            await connection.connect();
            await fixture.db
                .update(dbOutbox)
                .set({ availableAt: new Date(0) })
                .where(eq(dbOutbox.id, seed.outbox.id))
                .returning()
                .then((rows) => requiredDatabaseValue(rows[0]));
            await consumer.start();
            expect(await dispatcher.dispatchOnce()).toBe(1);
            await waitUntil(
                async () => (await stored(seed.run.id)).status === 'failed',
                '真实consumer终结Run',
            );
            await publisher.queue.add(
                'run.enqueue',
                { runId: seed.run.id },
                { jobId: `replay-${seed.run.id}` },
            );
            await waitUntil(
                async () =>
                    (await publisher.queue.getJob(`replay-${seed.run.id}`))
                        ?.getState()
                        .then((state) => state === 'completed') ?? false,
                '终态重投完成',
            );
            expect(
                (await events(seed.run.id)).filter((event) => event.type === 'run.failed'),
            ).toHaveLength(1);
        } finally {
            await consumer.stop();
            await publisher.queue.obliterate({ force: true });
            await publisher.close();
            connection.disconnect();
        }
    });

    it.each(['completed', 'failed'] as const)(
        'C12-06 保留%s恢复job仍可重排，数据库缺消息Run得到真实执行',
        async (state) => {
            const seed = await seedRun(fixture.db);
            const first = await claimed(seed.run.id);
            await expire(seed.run.id);
            const worker = await queueFixture(async () => {
                if (state === 'failed') throw new Error('test retained failed job');
            });
            const id = `run-recover-${seed.run.id}-${first.run.leaseEpoch}`;
            try {
                await worker.queue.add('run.enqueue', { runId: seed.run.id }, { jobId: id });
                await waitUntil(
                    async () =>
                        (await worker.queue.getJob(id))
                            ?.getState()
                            .then((actual) => actual === state) ?? false,
                    '保留completed恢复job',
                );
                await worker.consumer.stop();
                expect(
                    await enqueueRecoverableRuns(worker.queue, [
                        { id: seed.run.id, leaseEpoch: first.run.leaseEpoch },
                    ]),
                ).toBe(1);
                const consumer = createRunConsumer(
                    fixture.redisUrl,
                    worker.queue.name,
                    createRunHandler(new RunService({ repository })),
                );
                try {
                    await consumer.start();
                    await waitUntil(
                        async () => (await stored(seed.run.id)).status === 'failed',
                        '重排真实执行',
                    );
                    expect((await stored(seed.run.id)).leaseEpoch).toBe(first.run.leaseEpoch + 1);
                    expect((await stored(seed.run.id)).recoveryCount).toBe(1);
                } finally {
                    await consumer.stop();
                }
            } finally {
                await worker.close();
            }
        },
    );

    it('C12-11 固化mode决定有效比较范围，队列伪造owner/mode/version不会改数据库事实', async () => {
        const seed = await seedRun(fixture.db);
        await fixture.db
            .update(dbRuns)
            .set({ status: 'failed', finishedAt: new Date() })
            .where(eq(dbRuns.id, seed.run.id))
            .returning()
            .then((rows) => requiredDatabaseValue(rows[0]));
        const live = await commands.create(
            seed.user.id,
            seed.task.id,
            { mode: 'live' },
            randomUUID(),
        );
        let observed: RunExecutionContext | undefined;
        const execute = vi.fn(async (context: RunExecutionContext) => {
            observed = context;
        });
        const handler = createRunHandler(new RunService({ repository, executor: { execute } }));
        await handler('run.enqueue', {
            runId: live.run.id,
            userId: randomUUID(),
            mode: 'demo',
            taskVersionId: randomUUID(),
        });
        expect(observed).toMatchObject({
            userId: seed.user.id,
            mode: 'live',
            taskVersionId: seed.version.id,
            budget: seed.config.budget,
        });
        expect((await stored(live.run.id)).mode).toBe('live');
        expect((await stored(live.run.id)).failureCode).toBe('EXECUTOR_RETURNED_WITHOUT_DELIVERY');
        await handler('unknown.tool', { runId: live.run.id });
        await handler('run.enqueue', { runId: 'invalid' });
        expect(execute).toHaveBeenCalledTimes(1);
    });
});

type Runtime = 'bun' | 'node';
function launch(runtime: Runtime, queueName: string) {
    const bun =
        process.env.BUN_BIN ??
        join(homedir(), '.bun', 'bin', process.platform === 'win32' ? 'bun.exe' : 'bun');
    if (runtime === 'bun' && !existsSync(bun)) throw new Error('需配置独立Bun运行时');
    const script = 'tests/support/run-process.ts';
    const command =
        runtime === 'bun' ? { executable: bun, args: ['run', script] } : nodeScriptCommand(script);
    const child = spawn(command.executable, command.args, {
        cwd: fileURLToPath(new URL('../', import.meta.url)),
        env: {
            ...process.env,
            DATABASE_URL: fixture.databaseUrl,
            REDIS_URL: fixture.redisUrl,
            WORKER_QUEUE_NAME: queueName,
            WORKER_POLL_INTERVAL_MS: '20',
            WORKER_RUN_LEASE_SECONDS: '1',
            WORKER_RUN_CONCURRENCY: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        windowsHide: true,
    });
    const messages: unknown[] = [];
    let output = '';
    let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    child.on('message', (message) => messages.push(message));
    child.stdout!.on('data', (chunk) => {
        output += String(chunk);
    });
    child.stderr!.on('data', (chunk) => {
        output += String(chunk);
    });
    const ended = new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => {
            exit = { code, signal };
            resolve();
        });
    });
    void ended.catch(() => undefined);
    return {
        child,
        messages,
        ended,
        get output() {
            return output;
        },
        get exit() {
            return exit;
        },
    };
}
async function waitMessage(running: ReturnType<typeof launch>, type: string) {
    await waitUntil(async () => {
        if (running.exit) throw new Error(`测试Worker提前退出：${running.output}`);
        return running.messages.some(
            (message) =>
                typeof message === 'object' &&
                message !== null &&
                'type' in message &&
                message.type === type,
        );
    }, `进程消息 ${type}`);
}
async function endProcess(running: ReturnType<typeof launch>, graceful = true) {
    if (!running.exit) {
        if (graceful && running.child.connected) running.child.send('scova:shutdown');
        else running.child.kill('SIGKILL');
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        await Promise.race([
            running.ended,
            new Promise((_, reject) => {
                timer = setTimeout(() => {
                    running.child.kill('SIGKILL');
                    reject(new Error(`进程未结束：${running.output}`));
                }, 8_000);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

describe('真实进程崩溃与IPC停止', () => {
    it.each(['node', 'bun'] as const)(
        'C12-05/10 %s A崩溃后B接管，固定deadline/mode/usage；停止B不伪装取消',
        async (runtime) => {
            const seed = await seedRun(fixture.db, { mode: 'live' });
            const queueName = `scova-crash-${runtime}-${randomUUID()}`;
            const queue = new Queue(queueName, { connection: redis });
            const control = createRunControl(
                readRunControlConfig({
                    DATABASE_URL: fixture.databaseUrl,
                    REDIS_URL: fixture.redisUrl,
                    WORKER_QUEUE_NAME: queueName,
                    WORKER_POLL_INTERVAL_MS: '20',
                    WORKER_FAILURE_DELAY_MS: '50',
                }),
            );
            control.start();
            const first = launch(runtime, queueName);
            let second: ReturnType<typeof launch> | undefined;
            try {
                await waitMessage(first, 'executing');
                const initial = await stored(seed.run.id);
                await endProcess(first, false);
                await expire(seed.run.id);
                second = launch(runtime, queueName);
                await waitMessage(second, 'executing');
                const recovered = await stored(seed.run.id);
                expect(recovered.leaseEpoch).toBe(initial.leaseEpoch + 1);
                expect(recovered.recoveryCount).toBe(initial.recoveryCount + 1);
                expect(recovered.startedAt).toEqual(initial.startedAt);
                expect(recovered.deadlineAt).toEqual(initial.deadlineAt);
                expect(recovered.budgetJson).toEqual(initial.budgetJson);
                expect(recovered.usageJson).toEqual(initial.usageJson);
                expect(recovered.mode).toBe('live');
                await expect(
                    repository.emit(
                        {
                            runId: initial.id,
                            userId: initial.userId,
                            leaseOwner: initial.leaseOwner!,
                            leaseEpoch: initial.leaseEpoch,
                        },
                        progress,
                    ),
                ).rejects.toMatchObject({ code: 'LEASE_LOST' });
                await endProcess(second);
                expect(second.exit?.code, second.output).toBe(0);
                const stopped = await stored(seed.run.id);
                expect(stopped.status).toBe('queued');
                expect(stopped.cancelRequestedAt).toBeNull();
                expect(stopped.finishedAt).toBeNull();
                expect(
                    (await events(seed.run.id)).some((event) => event.type === 'run.canceled'),
                ).toBe(false);
                expect(
                    await fixture.db
                        .select({ count: dbCount() })
                        .from(dbReports)
                        .where(eq(dbReports.runId, seed.run.id))
                        .then((rows) => rows[0]!.count),
                ).toBe(0);
            } finally {
                if (!first.exit) await endProcess(first, false);
                if (second && !second.exit) await endProcess(second, false);
                await control.stop();
                await queue.obliterate({ force: true });
                await queue.close();
            }
        },
    );
});
