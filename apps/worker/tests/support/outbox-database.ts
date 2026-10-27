import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@scova/db';

const require = createRequire(import.meta.url);

/** 每个套件只拥有自己的随机 schema，不清空共享 Redis。 */
export function outboxDatabase() {
    const root = fileURLToPath(new URL('../../../../', import.meta.url));
    const baseUrl =
        process.env.SCOVA_TEST_DATABASE_URL ??
        process.env.RUNTIME_DATABASE_URL ??
        'postgresql://scova_test:scova_test@127.0.0.1:55432/scova_test';
    const redisUrl =
        process.env.SCOVA_TEST_REDIS_URL ??
        process.env.RUNTIME_REDIS_URL ??
        'redis://127.0.0.1:56379';
    const schema = `scova_worker_${randomUUID().replaceAll('-', '')}`;
    const checkpointSchema = `scova_agent_${randomUUID().replaceAll('-', '')}`;
    const scopedUrl = new URL(baseUrl);
    scopedUrl.searchParams.set('schema', schema);
    const databaseUrl = scopedUrl.toString();
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    const admin = new (require('pg').Client)({ connectionString: baseUrl });
    let created = false;
    return {
        db,
        databaseUrl,
        checkpointSchema,
        redisUrl,
        async setup() {
            await admin.connect();
            await admin.query(`CREATE SCHEMA "${schema}"`);
            created = true;
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
                    env: { ...process.env, DATABASE_URL: databaseUrl },
                    encoding: 'utf8',
                    windowsHide: true,
                    timeout: 60_000,
                },
            );
            await db.$connect();
        },
        async cleanup() {
            await db.$disconnect();
            if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
            if (created) await admin.query(`DROP SCHEMA IF EXISTS "${checkpointSchema}" CASCADE`);
            await admin.end();
        },
        async seed(now = new Date()) {
            const id = randomUUID();
            const user = await db.user.create({
                data: {
                    email: `${id}@example.test`,
                    normalizedEmail: `${id}@example.test`,
                    passwordHash: 'test',
                },
            });
            const task = await db.task.create({
                data: { userId: user.id, title: 'Worker 架构验证' },
            });
            const version = await db.taskVersion.create({
                data: {
                    userId: user.id,
                    taskId: task.id,
                    version: 1,
                    configJson: {},
                    comparisonScopeHash: 'a'.repeat(64),
                },
            });
            const run = await db.run.create({
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
            return db.outbox.create({
                data: {
                    userId: user.id,
                    aggregateId: run.id,
                    eventType: 'run.enqueue',
                    dedupeKey: `run-${run.id}`,
                    payload: { runId: run.id },
                    availableAt: now,
                },
            });
        },
    };
}
