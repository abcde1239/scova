import { createExecutionClient } from '../src/repo/execution.ts';
import { testWorkerExecution } from './support/worker-execution.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { createRunControl } from '../../server/src/app/run-control.ts';
import { readRunControlConfig } from '../../server/src/app/run-control-config.ts';
import { requiredDatabaseValue } from '../../server/src/utils/execution/database.ts';
import {
    outbox as dbOutbox,
    eq,
    runs as dbRuns,
    reports as dbReports,
    count as dbCount,
    inboxItems as dbInboxItems,
    sql,
    and,
} from '@scova/db';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { nodeScriptCommand } from '../../../scripts/process-runtime.mjs';
import { createOutboxQueue } from '../../server/src/repo/queue/outbox.ts';
import { outboxDatabase } from './support/outbox-database.ts';
import { seedRun } from './support/run-database.ts';
import { prepareTestCheckpointSchema } from './support/checkpoint-schema.ts';

const fixture = outboxDatabase();
const workerRoot = fileURLToPath(new URL('../', import.meta.url));
const bun =
    process.env.BUN_BIN ??
    join(homedir(), '.bun', 'bin', process.platform === 'win32' ? 'bun.exe' : 'bun');

function launch(runtime: 'bun' | 'node', env: NodeJS.ProcessEnv) {
    if (runtime === 'bun' && !existsSync(bun)) throw new Error('需独立 Bun 或配置 BUN_BIN');
    const command =
        runtime === 'bun'
            ? { executable: bun, args: ['run', 'src/main.ts'] }
            : nodeScriptCommand('src/node.ts');
    const workerEnv = { ...process.env, ...env };
    delete workerEnv.DATABASE_URL;
    delete workerEnv.AGENT_CREDENTIAL_KEY;
    delete workerEnv.SCOVA_SQLITE_STATE_PATH;
    const child = spawn(command.executable, command.args, {
        cwd: workerRoot,
        env: workerEnv,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        windowsHide: true,
    });
    let output = '';
    let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
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
    return {
        child,
        ended,
        get output() {
            return output;
        },
        get exit() {
            return exit;
        },
    };
}

async function waitUntil(check: () => Promise<boolean>, process: ReturnType<typeof launch>) {
    const deadline = Date.now() + 15_000;
    while (!(await check())) {
        if (process.exit) throw new Error(`Worker 提前退出：${process.output}`);
        if (Date.now() > deadline) throw new Error(`Worker 未按期投递：${process.output}`);
        await new Promise((resolve) => setTimeout(resolve, 30));
    }
}

async function ended(process: ReturnType<typeof launch>) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        await Promise.race([
            process.ended,
            new Promise((_, reject) => {
                timer = setTimeout(
                    () => reject(new Error(`Worker 未优雅退出：${process.output}`)),
                    10_000,
                );
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

describe('Worker Bun/Node 真实进程', () => {
    beforeAll(async () => {
        await fixture.setup();
        await prepareTestCheckpointSchema(fixture.databaseUrl, fixture.checkpointSchema);
    }, 120_000);
    afterAll(() => fixture.cleanup());
    beforeEach(() =>
        fixture.db
            .delete(dbOutbox)
            .returning({ id: dbOutbox.id })
            .then((rows) => ({ count: rows.length })),
    );

    it.each(['bun', 'node'] as const)(
        '%s 只消费 Server 投递，拒绝未配置演示执行并正常关闭',
        async (runtime) => {
            const { outbox: item } = await seedRun(fixture.db);
            const queueName = `scova-runtime-${runtime}-${randomUUID()}`;
            const connection = new Redis(fixture.redisUrl, {
                lazyConnect: true,
                enableOfflineQueue: false,
                maxRetriesPerRequest: 1,
            });
            connection.on('error', () => undefined);
            await connection.connect();
            const publisher = createOutboxQueue(connection, queueName);
            const control = createRunControl(
                readRunControlConfig({
                    DATABASE_URL: fixture.databaseUrl,
                    REDIS_URL: fixture.redisUrl,
                    WORKER_QUEUE_NAME: queueName,
                    WORKER_POLL_INTERVAL_MS: '20',
                }),
            );
            const execution = await testWorkerExecution(fixture.db, {
                DATABASE_URL: fixture.databaseUrl,
                AGENT_CHECKPOINT_SCHEMA: fixture.checkpointSchema,
                WORKER_QUEUE_NAME: queueName,
            });
            const process = launch(runtime, {
                WORKER_EXECUTION_URL: execution.url,
                WORKER_EXECUTION_TOKEN: execution.token,
                REDIS_URL: fixture.redisUrl,
                WORKER_QUEUE_NAME: queueName,
                WORKER_POLL_INTERVAL_MS: '20',
            });
            try {
                await waitUntil(
                    async () => process.output.includes('Run consumer running'),
                    process,
                );
                await delay(100);
                expect(
                    (await fixture.db.query.outbox.findFirst({ where: eq(dbOutbox.id, item.id) }))
                        ?.sentAt,
                ).toBeNull();
                expect(await publisher.queue.getJob(`run-${item.aggregateId}`)).toBeUndefined();
                control.start();
                await waitUntil(
                    async () =>
                        (
                            await fixture.db.query.outbox
                                .findFirst({ where: eq(dbOutbox.id, item.id) })
                                .then((row) => requiredDatabaseValue(row))
                        ).sentAt !== null,
                    process,
                );
                expect((await publisher.queue.getJob(`run-${item.aggregateId}`))?.data).toEqual({
                    runId: item.aggregateId,
                });
                await waitUntil(async () => {
                    const run = await fixture.db.query.runs
                        .findFirst({ where: eq(dbRuns.id, item.aggregateId) })
                        .then((row) => requiredDatabaseValue(row));
                    return run.status === 'failed';
                }, process);
                expect(
                    await fixture.db.query.runs
                        .findFirst({ where: eq(dbRuns.id, item.aggregateId) })
                        .then((row) => requiredDatabaseValue(row)),
                ).toMatchObject({
                    status: 'failed',
                    failureCode: 'AGENT_CONFIGURATION_INVALID',
                });
                expect(
                    await fixture.db
                        .select({ count: dbCount() })
                        .from(dbReports)
                        .where(eq(dbReports.runId, item.aggregateId))
                        .then((rows) => rows[0]!.count),
                ).toBe(0);
                expect(
                    await fixture.db
                        .select({ count: dbCount() })
                        .from(dbInboxItems)
                        .where(
                            sql`EXISTS (SELECT 1 FROM ${dbReports} WHERE ${and(eq(dbInboxItems.userId, dbReports.userId), eq(dbInboxItems.reportId, dbReports.id), eq(dbReports.runId, item.aggregateId))})`,
                        )
                        .then((rows) => rows[0]!.count),
                ).toBe(0);
                process.child.send('scova:shutdown');
                await ended(process);
                expect(process.exit?.code).toBe(0);
            } finally {
                if (!process.exit) {
                    if (process.child.connected) process.child.send('scova:shutdown');
                    try {
                        await ended(process);
                    } catch {
                        process.child.kill();
                    }
                }
                await control.stop();
                await execution.stop();
                await publisher.queue.obliterate({ force: true });
                await publisher.close();
                connection.disconnect();
            }
        },
    );

    it.each(['bun', 'node'] as const)('%s 缺少配置明确失败且不输出凭据', async (runtime) => {
        const process = launch(runtime, {
            WORKER_EXECUTION_TOKEN: 'credential-must-not-be-logged',
            REDIS_URL: fixture.redisUrl,
        });
        try {
            await ended(process);
            expect(process.exit?.code).toBe(1);
            expect(process.output).toContain('Worker 启动或运行失败');
            expect(process.output).not.toContain('credential-must-not-be-logged');
            expect(process.output).not.toContain('Run consumer running');
        } finally {
            if (!process.exit) process.child.kill();
        }
    });

    it('Redis 初始化失败时 Worker 退出，Server 执行入口保持可用', async () => {
        const execution = await testWorkerExecution(fixture.db, {
            DATABASE_URL: fixture.databaseUrl,
            AGENT_CHECKPOINT_SCHEMA: fixture.checkpointSchema,
        });
        const process = launch('node', {
            WORKER_EXECUTION_URL: execution.url,
            WORKER_EXECUTION_TOKEN: execution.token,
            REDIS_URL: 'redis://127.0.0.1:1',
        });
        try {
            await ended(process);
            expect(process.exit?.code).toBe(1);
            expect(process.output).toContain('Worker 启动或运行失败');
            expect(process.output).not.toContain('Run consumer running');
            await expect(
                createExecutionClient(execution.url, execution.token).ready(),
            ).resolves.toMatchObject({ queue: 'bullmq' });
        } finally {
            if (!process.exit) process.child.kill();
            await execution.stop();
        }
    });
});
