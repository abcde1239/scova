import { requiredDatabaseValue } from '@/utils/database.ts';
import { outbox as dbOutbox, eq } from '@scova/db';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { createOutboxRepository } from '../src/repo/outbox.ts';
import { createOutboxQueue } from '../src/queue/outbox.ts';
import { OutboxService } from '../src/service/outbox.ts';
import { outboxDatabase } from './support/outbox-database.ts';

const fixture = outboxDatabase();
const repository = createOutboxRepository(fixture.db);
let now: Date;
const later = (seconds: number) => new Date(now.getTime() + seconds * 1000);

describe('Outbox 分层的真实持久化和故障边界', () => {
    beforeAll(() => fixture.setup(), 120_000);
    afterAll(() => fixture.cleanup());
    beforeEach(async () => {
        await fixture.db
            .delete(dbOutbox)
            .returning({ id: dbOutbox.id })
            .then((rows) => ({ count: rows.length }));
        now = new Date();
    });

    it('同一记录并发领取只有一胜，旧 ack/retry 不覆盖接管者', async () => {
        const item = await fixture.seed(now);
        const claims = await Promise.all([
            repository.claim(now, later(10)),
            repository.claim(now, later(10)),
        ]);
        const claimed = claims.filter((claim) => claim !== null);
        expect(claimed).toHaveLength(1);
        const old = claimed[0]!;
        now = later(10); // 租约边界恰好到期也允许接管。
        const replacement = await repository.claim(now, later(10));
        expect(replacement?.attempts).toBe(2);
        expect(await repository.ack(old, now)).toBe(false);
        expect(await repository.retry(old, now, later(100))).toBe(false);
        const untouched = await fixture.db.query.outbox
            .findFirst({ where: eq(dbOutbox.id, item.id) })
            .then((row) => requiredDatabaseValue(row));
        expect(untouched.leaseExpiresAt).toEqual(replacement!.leaseExpiresAt);
        expect(untouched.availableAt).toEqual(item.availableAt);
        expect(untouched.sentAt).toBeNull();
        expect(await repository.ack(replacement!, now)).toBe(true);
    });

    it('取消信号只阻止下一次领取，当前投递完成确认', async () => {
        const item = await fixture.seed(now);
        const controller = new AbortController();
        let published = 0;
        const service = new OutboxService({
            repository,
            clock: () => now,
            publisher: {
                async publish() {
                    published++;
                    controller.abort();
                },
            },
        });
        expect(await service.dispatchOnce(50, controller.signal)).toBe(1);
        expect(published).toBe(1);
        expect(
            (
                await fixture.db.query.outbox
                    .findFirst({ where: eq(dbOutbox.id, item.id) })
                    .then((row) => requiredDatabaseValue(row))
            ).sentAt,
        ).not.toBeNull();
        const next = await fixture.seed(now);
        expect(await service.dispatchOnce(50, controller.signal)).toBe(0);
        expect(
            (
                await fixture.db.query.outbox
                    .findFirst({ where: eq(dbOutbox.id, next.id) })
                    .then((row) => requiredDatabaseValue(row))
            ).attempts,
        ).toBe(0);
    });

    it('跳过未到期/持租约/已发送记录，限制单批数量并拒绝非法上限', async () => {
        const future = await fixture.seed(later(60));
        const leased = await fixture.seed(now);
        const sent = await fixture.seed(now);
        await fixture.db
            .update(dbOutbox)
            .set({ leaseExpiresAt: later(60) })
            .where(eq(dbOutbox.id, leased.id))
            .returning()
            .then((rows) => requiredDatabaseValue(rows[0]));
        await fixture.db
            .update(dbOutbox)
            .set({ sentAt: now })
            .where(eq(dbOutbox.id, sent.id))
            .returning()
            .then((rows) => requiredDatabaseValue(rows[0]));
        let calls = 0;
        const service = new OutboxService({
            repository,
            clock: () => now,
            publisher: {
                async publish() {
                    calls++;
                },
            },
        });
        expect(await service.dispatchOnce()).toBe(0);
        await fixture.seed(now);
        await fixture.seed(now);
        expect(await service.dispatchOnce(1)).toBe(1);
        expect(calls).toBe(1);
        await expect(service.dispatchOnce(0)).rejects.toThrow('投递上限');
        await expect(service.dispatchOnce(1.5)).rejects.toThrow('投递上限');
        expect(
            (
                await fixture.db.query.outbox
                    .findFirst({ where: eq(dbOutbox.id, future.id) })
                    .then((row) => requiredDatabaseValue(row))
            ).attempts,
        ).toBe(0);
        expect(
            (
                await fixture.db.query.outbox
                    .findFirst({ where: eq(dbOutbox.id, leased.id) })
                    .then((row) => requiredDatabaseValue(row))
            ).attempts,
        ).toBe(0);
    });

    it('旧投递者发送完成后失租，不将其计为已确认投递', async () => {
        const item = await fixture.seed(now);
        let replacement: Awaited<ReturnType<typeof repository.claim>>;
        const service = new OutboxService({
            repository,
            clock: () => now,
            leaseSeconds: 1,
            publisher: {
                async publish() {
                    now = later(2);
                    replacement = await repository.claim(now, later(10));
                },
            },
        });
        await expect(service.dispatchOnce()).rejects.toMatchObject({
            code: 'OUTBOX_LEASE_LOST',
            operation: 'ack',
        });
        const stored = await fixture.db.query.outbox
            .findFirst({ where: eq(dbOutbox.id, item.id) })
            .then((row) => requiredDatabaseValue(row));
        expect(stored.sentAt).toBeNull();
        expect(stored.attempts).toBe(2);
        expect(stored.leaseExpiresAt).toEqual(replacement!.leaseExpiresAt);
        await repository.ack(replacement!, now);
    });

    it('Redis 连接中断保留未发送记录，恢复后重投成功', async () => {
        const item = await fixture.seed(now);
        const queueName = `scova-architecture-${randomUUID()}`;
        const connection = new Redis(fixture.redisUrl, {
            lazyConnect: true,
            enableOfflineQueue: false,
            maxRetriesPerRequest: 1,
            retryStrategy: () => null,
        });
        connection.on('error', () => undefined);
        await connection.connect();
        const publisher = createOutboxQueue(connection, queueName);
        try {
            await publisher.queue.waitUntilReady();
            connection.disconnect();
            const service = new OutboxService({ repository, publisher, clock: () => now });
            await expect(service.dispatchOnce()).rejects.toBeInstanceOf(Error);
            const failed = await fixture.db.query.outbox
                .findFirst({ where: eq(dbOutbox.id, item.id) })
                .then((row) => requiredDatabaseValue(row));
            expect(failed.sentAt).toBeNull();
            expect(failed.leaseExpiresAt).toBeNull();
            expect(failed.availableAt.getTime()).toBeGreaterThan(now.getTime());
            await connection.connect();
            now = failed.availableAt;
            expect(await service.dispatchOnce()).toBe(1);
            const job = await publisher.queue.getJob(`run-${item.aggregateId}`);
            expect(job?.name).toBe('run.enqueue');
            expect(job?.data).toEqual({ runId: item.aggregateId });
            await publisher.queue.obliterate({ force: true });
        } finally {
            await publisher.close();
            connection.disconnect();
        }
    });

    it('发送后确认失败保留租约，到期重投仍只有一个稳定 job', async () => {
        const item = await fixture.seed(now);
        const connection = new Redis(fixture.redisUrl, {
            lazyConnect: true,
            enableOfflineQueue: false,
            maxRetriesPerRequest: 1,
        });
        connection.on('error', () => undefined);
        await connection.connect();
        const publisher = createOutboxQueue(connection, `scova-ack-${randomUUID()}`);
        try {
            const faulty = new OutboxService({
                repository: {
                    ...repository,
                    async ack() {
                        throw new Error('模拟确认前宕机');
                    },
                },
                publisher,
                clock: () => now,
                leaseSeconds: 1,
            });
            await expect(faulty.dispatchOnce()).rejects.toThrow('模拟确认前宕机');
            const pending = await fixture.db.query.outbox
                .findFirst({ where: eq(dbOutbox.id, item.id) })
                .then((row) => requiredDatabaseValue(row));
            expect(pending.sentAt).toBeNull();
            expect(pending.leaseExpiresAt).not.toBeNull();
            now = later(2);
            const recovered = new OutboxService({ repository, publisher, clock: () => now });
            expect(await recovered.dispatchOnce()).toBe(1);
            expect(await publisher.queue.getJobCounts('wait')).toMatchObject({ wait: 1 });
            expect((await publisher.queue.getJob(`run-${item.aggregateId}`))?.data).toEqual({
                runId: item.aggregateId,
            });
            await publisher.queue.obliterate({ force: true });
        } finally {
            await publisher.close();
            connection.disconnect();
        }
    });
});
