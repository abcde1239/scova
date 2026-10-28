import { migrateDatabase } from '@scova/db/migrate';
import { requiredDatabaseValue } from '@/utils/database.ts';
import {
    createDatabaseClient,
    connectDatabase,
    closeDatabase,
    users as dbUsers,
    tasks as dbTasks,
    taskVersions as dbTaskVersions,
    eq,
    runs as dbRuns,
    outbox as dbOutbox,
} from '@scova/db';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

import { Redis as RedisClient } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { OutboxDispatcher } from '../src/outbox.ts';

const require = createRequire(import.meta.url);
const baseUrl =
    process.env.SCOVA_TEST_DATABASE_URL ??
    process.env.RUNTIME_DATABASE_URL ??
    'postgresql://scova_test:scova_test@127.0.0.1:55432/scova_test';
const redisUrl =
    process.env.SCOVA_TEST_REDIS_URL ?? process.env.RUNTIME_REDIS_URL ?? 'redis://127.0.0.1:56379';
const schema = `scova_outbox_${randomUUID().replaceAll('-', '')}`;
const scopedUrl = new URL(baseUrl);
scopedUrl.searchParams.set('schema', schema);
const db = createDatabaseClient({ connectionString: scopedUrl.toString() });
const admin = new (require('pg').Client)({ connectionString: baseUrl });
const redis = new RedisClient(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
});
const queueName = `scova-test-${randomUUID()}`;
let schemaCreated = false;

describe('BullMQ 事务 Outbox 投递器', () => {
    beforeAll(async () => {
        await admin.connect();
        await admin.query(`CREATE SCHEMA "${schema}"`);
        schemaCreated = true;
        await migrateDatabase({ connectionString: scopedUrl.toString() });
        await connectDatabase(db);
        await redis.connect();
        await redis.flushdb();
    }, 120000);
    afterAll(async () => {
        await closeDatabase(db);
        if (redis.status === 'ready') await redis.quit();
        else redis.disconnect();
        if (schemaCreated) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.end();
    });

    it('领取租约后写入 BullMQ，成功标记 sentAt，重复扫描不重复投递', async () => {
        const user = await db
            .insert(dbUsers)
            .values({
                email: `${randomUUID()}@example.test`,
                normalizedEmail: `${randomUUID()}@example.test`,
                passwordHash: 'test',
            })
            .returning()
            .then((rows) => requiredDatabaseValue(rows[0]));
        const task = await db
            .insert(dbTasks)
            .values({ userId: user.id, title: 'Outbox 测试' })
            .returning()
            .then((rows) => requiredDatabaseValue(rows[0]));
        const version = await db
            .insert(dbTaskVersions)
            .values({
                userId: user.id,
                taskId: task.id,
                version: 1,
                configJson: { topic: 'test' },
                comparisonScopeHash: 'a'.repeat(64),
            })
            .returning()
            .then((rows) => requiredDatabaseValue(rows[0]));
        await db
            .update(dbTasks)
            .set({ currentVersionId: version.id })
            .where(eq(dbTasks.id, task.id))
            .returning()
            .then((rows) => requiredDatabaseValue(rows[0]));
        const run = await db
            .insert(dbRuns)
            .values({
                userId: user.id,
                taskId: task.id,
                taskVersionId: version.id,
                comparisonScopeHash: 'a'.repeat(64),
                mode: 'demo',
                trigger: 'manual',
                budgetJson: {},
                usageJson: {},
            })
            .returning()
            .then((rows) => requiredDatabaseValue(rows[0]));
        const outbox = await db
            .insert(dbOutbox)
            .values({
                userId: user.id,
                aggregateId: run.id,
                eventType: 'run.enqueue',
                dedupeKey: `test-${run.id}`,
                payload: { runId: run.id },
            })
            .returning()
            .then((rows) => requiredDatabaseValue(rows[0]));
        const dispatcher = new OutboxDispatcher({ db: db, redis, queueName });
        try {
            expect(await dispatcher.dispatchOnce()).toBe(1);
            const stored = await db.query.outbox
                .findFirst({ where: eq(dbOutbox.id, outbox.id) })
                .then((row) => requiredDatabaseValue(row));
            expect(stored.sentAt).not.toBeNull();
            expect(stored.leaseExpiresAt).toBeNull();
            expect(stored.attempts).toBe(1);
            const job = await dispatcher.queue.getJob(`run-${run.id}`);
            expect(job?.data).toEqual({ runId: run.id });
            expect(await dispatcher.dispatchOnce()).toBe(0);
        } finally {
            await dispatcher.close();
        }
    });
});
