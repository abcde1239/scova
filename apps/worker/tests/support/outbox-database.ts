import { migrateDatabase } from '@scova/db/migrate';
import { requiredDatabaseValue } from '@/utils/database.ts';
import {
    createDatabaseClient,
    connectDatabase,
    closeDatabase,
    users as dbUsers,
    tasks as dbTasks,
    taskVersions as dbTaskVersions,
    runs as dbRuns,
    outbox as dbOutbox,
} from '@scova/db';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);

/** 每个套件只拥有自己的随机 schema，不清空共享 Redis。 */
export function outboxDatabase() {
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
    const db = createDatabaseClient({ connectionString: databaseUrl });
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
            await migrateDatabase({ connectionString: databaseUrl });
            await connectDatabase(db);
        },
        async cleanup() {
            await closeDatabase(db);
            if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
            if (created) await admin.query(`DROP SCHEMA IF EXISTS "${checkpointSchema}" CASCADE`);
            await admin.end();
        },
        async seed(now = new Date()) {
            const id = randomUUID();
            const user = await db
                .insert(dbUsers)
                .values({
                    email: `${id}@example.test`,
                    normalizedEmail: `${id}@example.test`,
                    passwordHash: 'test',
                })
                .returning()
                .then((rows) => requiredDatabaseValue(rows[0]));
            const task = await db
                .insert(dbTasks)
                .values({ userId: user.id, title: 'Worker 架构验证' })
                .returning()
                .then((rows) => requiredDatabaseValue(rows[0]));
            const version = await db
                .insert(dbTaskVersions)
                .values({
                    userId: user.id,
                    taskId: task.id,
                    version: 1,
                    configJson: {},
                    comparisonScopeHash: 'a'.repeat(64),
                })
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
            return db
                .insert(dbOutbox)
                .values({
                    userId: user.id,
                    aggregateId: run.id,
                    eventType: 'run.enqueue',
                    dedupeKey: `run-${run.id}`,
                    payload: { runId: run.id },
                    availableAt: now,
                })
                .returning()
                .then((rows) => requiredDatabaseValue(rows[0]));
        },
    };
}
