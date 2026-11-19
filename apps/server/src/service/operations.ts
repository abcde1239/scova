import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { migrateDatabase } from '@scova/db/migrate';

import { constants } from 'node:fs';
import { open, unlink, link } from 'node:fs/promises';
import type pg from 'pg';
import type { OperationConfig } from '@/app/operations.ts';
import { provisionAgentCheckpointSchema } from '@/service/agent-checkpoint-schema.ts';
import { createOperationRepository } from '@/repo/operations.ts';
import { removeAccountJobs } from '@/repo/queue/maintenance.ts';
import { assertRedisReady } from '@/repo/redis.ts';
import { backupPath, type parseOperation } from '@/utils/operations.ts';

const exec = promisify(execFile);
export function createOperationService(pool: pg.Pool, config: OperationConfig) {
    const repo = createOperationRepository(pool, config);
    const pgEnv = { ...process.env, ...config.pgEnv };
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
                if (!config.redisUrl) throw new Error('缺少 REDIS_URL');
                await assertRedisReady(config.redisUrl);
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
                await migrateDatabase({ connectionString: config.databaseUrl });
                await provisionAgentCheckpointSchema(pool, config.checkpointSchema);
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
                await removeAccountJobs(config.redisUrl, config.queueName, runs, outbox);
            }
            // Queue cleanup precedes the transaction. A failed DB delete is recoverable from its retained Outbox.
            return repo.deleteAccount(input.userId!, input.apply);
        },
    };
}
