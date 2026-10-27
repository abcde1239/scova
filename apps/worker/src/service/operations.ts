import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { constants } from 'node:fs';
import { open, stat, unlink, link } from 'node:fs/promises';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import type pg from 'pg';
import type { OperationConfig } from '@/app/operations.ts';
import { outboxJobId } from '@/utils/outbox.ts';
import { installedCheckpointVersion } from '@/utils/checkpoint-version.ts';
import { createOperationRepository } from '@/repo/operations.ts';
import { backupPath, type parseOperation } from '@/utils/operations.ts';

const exec = promisify(execFile);
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../../../', import.meta.url));
export function createOperationService(pool: pg.Pool, config: OperationConfig) {
    const repo = createOperationRepository(pool, config);
    const pgEnv = { ...process.env, ...config.pgEnv };
    async function redisReady() {
        if (!config.redisUrl) throw new Error('缺少 REDIS_URL');
        const redis = new Redis(config.redisUrl, {
            lazyConnect: true,
            enableOfflineQueue: false,
            maxRetriesPerRequest: 1,
            connectTimeout: 5000,
            commandTimeout: 5000,
            retryStrategy: () => null,
        });
        redis.on('error', () => undefined);
        try {
            await redis.connect();
            if ((await redis.ping()) !== 'PONG') throw new Error('Redis 未就绪');
        } finally {
            redis.disconnect();
        }
    }
    async function offline() {
        if (!config.offline)
            throw new Error('维护命令要求 SCOVA_MAINTENANCE=1，并先停止 API/Worker');
        const active =
            await pool.query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
      AND pid<>pg_backend_pid() AND application_name IN ('scova-api','scova-worker') LIMIT 1`);
        if (active.rowCount) throw new Error('API/Worker 仍连接数据库，请先停止并等待在途写入结束');
    }
    return {
        async execute(input: ReturnType<typeof parseOperation>) {
            if (input.command === 'ready') {
                await repo.readiness();
                await redisReady();
                if (input.role === 'worker') {
                    const info = await stat(config.heartbeatPath);
                    if (Date.now() - info.mtimeMs > 45_000) throw new Error('Worker 心跳已过期');
                }
                return { ready: true };
            }
            // Compose may revisit an exited migration service while healthy apps are already running.
            // A fully current schema is a read-only no-op; any DDL still requires an offline deployment.
            if (input.command === 'migrate' && config.offline) {
                try {
                    await repo.readiness();
                    return { migrated: false, current: true };
                } catch {
                    // Missing/incompatible schemas continue through the offline guard before migration.
                }
            }
            await offline();
            if (input.command === 'migrate') {
                await exec(
                    'node',
                    [
                        require.resolve('prisma/build/index.js'),
                        'migrate',
                        'deploy',
                        '--schema',
                        'packages/db/prisma/schema.prisma',
                    ],
                    {
                        cwd: root,
                        env: { ...process.env, DATABASE_URL: config.databaseUrl },
                        timeout: 120_000,
                        windowsHide: true,
                    },
                );
                const client = await pool.connect();
                try {
                    await client.query('SELECT pg_advisory_lock(hashtext($1))', [
                        'scova-agent-schema:' + config.checkpointSchema,
                    ]);
                    await new PostgresSaver(pool, undefined, {
                        schema: config.checkpointSchema,
                    }).setup();
                    await client.query(
                        `CREATE TABLE IF NOT EXISTS "${config.checkpointSchema}".scova_schema_version (id integer PRIMARY KEY CHECK(id=1), version text NOT NULL)`,
                    );
                    await client.query(
                        `INSERT INTO "${config.checkpointSchema}".scova_schema_version VALUES (1,$1) ON CONFLICT(id) DO UPDATE SET version=EXCLUDED.version`,
                        [installedCheckpointVersion()],
                    );
                } finally {
                    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [
                        'scova-agent-schema:' + config.checkpointSchema,
                    ]);
                    client.release();
                }
                await repo.readiness();
                return { migrated: true };
            }
            if (input.command === 'backup') {
                const path = backupPath(config.backupDirectory, input.name!);
                const temporary = path + '.partial';
                const handle = await open(
                    temporary,
                    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
                    0o600,
                );
                await handle.close();
                try {
                    await exec('pg_dump', ['--format=custom', '--no-owner', '--file', temporary], {
                        env: pgEnv,
                        timeout: 300_000,
                        windowsHide: true,
                    });
                    // Atomic publication never overwrites an existing backup, including symlinks.
                    await link(temporary, path);
                    await unlink(temporary);
                    return { backup: input.name };
                } catch (error) {
                    await unlink(temporary).catch(() => undefined);
                    throw error;
                }
            }
            if (input.command === 'restore') {
                if (!input.apply) return { restore: input.name, applied: false };
                const path = backupPath(config.backupDirectory, input.name!);
                const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
                try {
                    if (!(await handle.stat()).isFile()) throw new Error('备份必须是普通文件');
                } finally {
                    await handle.close();
                }
                await repo.assertEmptyDatabase();
                await exec(
                    'pg_restore',
                    [
                        '--no-owner',
                        '--no-privileges',
                        '--clean',
                        '--if-exists',
                        '--exit-on-error',
                        '--single-transaction',
                        '--dbname',
                        config.pgEnv.PGDATABASE,
                        path,
                    ],
                    { env: pgEnv, timeout: 300_000, windowsHide: true },
                );
                return { restored: input.name, applied: true };
            }
            await repo.readiness();
            if (input.command === 'retention') return repo.retention(input.apply);
            if (input.apply) {
                if (!config.redisUrl) throw new Error('账号删除需要 Redis，以先移除账号队列作业');
                const runs = await repo.accountRuns(input.userId!);
                const outbox = await repo.accountOutbox(input.userId!);
                const redis = new Redis(config.redisUrl, {
                    lazyConnect: true,
                    enableOfflineQueue: false,
                    retryStrategy: () => null,
                    maxRetriesPerRequest: 1,
                    connectTimeout: 5000,
                    commandTimeout: 5000,
                });
                redis.on('error', () => undefined);
                try {
                    await redis.connect();
                } catch (error) {
                    redis.disconnect();
                    throw error;
                }
                const queue = new Queue(config.queueName, {
                    connection: redis,
                });
                queue.on('error', () => undefined);
                try {
                    for (const item of outbox) {
                        const job = await queue.getJob(outboxJobId(item));
                        if (job) await job.remove();
                    }
                    for (const run of runs) {
                        const keys = [
                            `run-${run.id}`,
                            ...Array.from(
                                { length: run.lease_epoch + 1 },
                                (_, epoch) => `run-recover-${run.id}-${epoch}`,
                            ),
                        ];
                        for (const key of keys) {
                            const job = await queue.getJob(key);
                            if (job) await job.remove();
                        }
                    }
                } finally {
                    await queue.close();
                    redis.disconnect();
                }
            }
            // Queue cleanup precedes the transaction. A failed DB delete is recoverable from its retained Outbox.
            return repo.deleteAccount(input.userId!, input.apply);
        },
    };
}
