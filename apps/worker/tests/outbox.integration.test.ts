import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@scova/db';
import { Redis as RedisClient } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { OutboxDispatcher } from '../src/outbox.ts';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../../', import.meta.url));
const baseUrl =
    process.env.SCOVA_TEST_DATABASE_URL ??
    process.env.RUNTIME_DATABASE_URL ??
    'postgresql://scova_test:scova_test@127.0.0.1:55432/scova_test';
const redisUrl =
    process.env.SCOVA_TEST_REDIS_URL ?? process.env.RUNTIME_REDIS_URL ?? 'redis://127.0.0.1:56379';
const schema = `scova_outbox_${randomUUID().replaceAll('-', '')}`;
const scopedUrl = new URL(baseUrl);
scopedUrl.searchParams.set('schema', schema);
const prisma = new PrismaClient({ datasources: { db: { url: scopedUrl.toString() } } });
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
        const migrate = () =>
            execFileSync(
                process.execPath,
                [
                    require.resolve('prisma/build/index.js'),
                    'migrate',
                    'deploy',
                    '--schema',
                    'packages/db/prisma/schema.prisma',
                ],
                {
                    cwd: root,
                    env: { ...process.env, DATABASE_URL: scopedUrl.toString() },
                    encoding: 'utf8',
                    windowsHide: true,
                    timeout: 60000,
                },
            );
        migrate();
        await prisma.$connect();
        await redis.connect();
        await redis.flushdb();
    }, 120000);
    afterAll(async () => {
        await prisma.$disconnect();
        await redis.quit();
        if (schemaCreated) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.end();
    });

    it('领取租约后写入 BullMQ，成功标记 sentAt，重复扫描不重复投递', async () => {
        const user = await prisma.user.create({
            data: {
                email: `${randomUUID()}@example.test`,
                normalizedEmail: `${randomUUID()}@example.test`,
                passwordHash: 'test',
            },
        });
        const task = await prisma.task.create({ data: { userId: user.id, title: 'Outbox 测试' } });
        const version = await prisma.taskVersion.create({
            data: {
                userId: user.id,
                taskId: task.id,
                version: 1,
                configJson: { topic: 'test' },
                comparisonScopeHash: 'a'.repeat(64),
            },
        });
        await prisma.task.update({
            where: { id: task.id },
            data: { currentVersionId: version.id },
        });
        const run = await prisma.run.create({
            data: {
                userId: user.id,
                taskId: task.id,
                taskVersionId: version.id,
                comparisonScopeHash: 'a'.repeat(64),
                mode: 'demo',
                trigger: 'manual',
                budgetJson: {},
                usageJson: {},
            },
        });
        const outbox = await prisma.outbox.create({
            data: {
                userId: user.id,
                aggregateId: run.id,
                eventType: 'run.enqueue',
                dedupeKey: `test-${run.id}`,
                payload: { runId: run.id },
            },
        });
        const dispatcher = new OutboxDispatcher({ db: prisma, redis, queueName });
        try {
            expect(await dispatcher.dispatchOnce()).toBe(1);
            const stored = await prisma.outbox.findUniqueOrThrow({ where: { id: outbox.id } });
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
