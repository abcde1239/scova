import { and, eq, exists, count } from '@scova/db';
import * as tables from '@scova/db';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { parseContract, ReportSchema } from '@scova/models';
import { nodeScriptCommand } from '../../../scripts/process-runtime.mjs';
import { outboxDatabase } from '../../worker/tests/support/outbox-database.ts';
import { requireRow } from '../src/utils/database.ts';

const fixture = outboxDatabase();
const bun =
    process.env.BUN_BIN ??
    join(homedir(), '.bun', 'bin', process.platform === 'win32' ? 'bun.exe' : 'bun');
type Runtime = 'bun' | 'node';
type Session = { cookie: string; csrf: string; userId: string };
type RunCommand = { reused: boolean; run: { id: string; taskVersionId: string; status: string } };

function launch(app: 'server' | 'worker', runtime: Runtime, env: NodeJS.ProcessEnv) {
    if (runtime === 'bun' && !existsSync(bun)) throw new Error('配置 BUN_BIN 为独立 Bun 路径');
    const command =
        runtime === 'bun'
            ? { executable: bun, args: ['run', 'src/main.ts'] }
            : nodeScriptCommand('src/node.ts');
    const child = spawn(command.executable, command.args, {
        cwd: fileURLToPath(new URL(`../../${app}/`, import.meta.url)),
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        windowsHide: true,
    });
    let output = '';
    let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    child.stdout!.on('data', (data) => {
        output += String(data);
    });
    child.stderr!.on('data', (data) => {
        output += String(data);
    });
    const ended = new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => {
            exit = { code, signal };
            resolve();
        });
    });
    // 启动错误仍由 waitUntil/stop 上报；先注册观察者避免后台 Promise 无处理。
    void ended.catch(() => undefined);
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
type Running = ReturnType<typeof launch>;

async function waitUntil(check: () => Promise<boolean>, running: Running) {
    const deadline = Date.now() + 15_000;
    while (!(await check())) {
        if (running.exit) throw new Error(`进程提前退出：${running.output}`);
        if (Date.now() > deadline) throw new Error(`整体后端验证等待超时：${running.output}`);
        await new Promise((resolve) => setTimeout(resolve, 30));
    }
}

async function stop(running: Running) {
    if (!running.exit && running.child.connected) running.child.send('scova:shutdown');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        await Promise.race([
            running.ended,
            new Promise((_, reject) => {
                timer = setTimeout(
                    () => reject(new Error(`进程未优雅退出：${running.output}`)),
                    10_000,
                );
            }),
        ]);
        expect(running.exit?.code, running.output).toBe(0);
    } finally {
        clearTimeout(timer);
        if (!running.exit) running.child.kill();
    }
}

async function unusedPort() {
    const server = createServer().listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('无法获取测试端口');
    await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
    );
    return address.port;
}

const taskConfig = () => ({
    title: '整体后端验证英语材料',
    topic: 'B1 英语听力材料',
    goal: '寻找带字幕的免费材料',
    focusPoints: ['字幕'],
    exclusions: [],
    sourcePreferences: {
        preferredUrls: ['https://www.example.com/english'],
        excludedUrls: [],
        officialOnly: false,
    },
    timeRange: { kind: 'rolling', days: 7 },
    timezone: 'UTC',
    schedule: { frequency: 'manual' },
    outputFormat: 'brief',
    budget: {
        maxSearches: 10,
        maxPages: 20,
        maxDurationSeconds: 300,
        maxInputTokens: 40_000,
        maxOutputTokens: 8_000,
    },
    notificationPreference: { mode: 'summary', runIssues: true },
});

/** 真实 API/worker 进程完成演示查阅与原子交付；不依赖远程供应商。 */
describe('整体后端：真实 HTTP → PostgreSQL Outbox → BullMQ → Run consumer', () => {
    beforeAll(() => fixture.setup(), 120_000);
    afterAll(() => fixture.cleanup());

    it.each([
        ['bun', 'bun'],
        ['bun', 'node'],
        ['node', 'bun'],
        ['node', 'node'],
    ] as const)(
        'API=%s / Worker=%s：证据交付、账号隔离与重启不重复报告',
        async (apiRuntime, workerRuntime) => {
            const queueName = `scova-flow-${randomUUID()}`;
            const redis = new Redis(fixture.redisUrl, {
                lazyConnect: true,
                enableOfflineQueue: false,
                maxRetriesPerRequest: 1,
            });
            redis.on('error', () => undefined);
            await redis.connect();
            const queue = new Queue(queueName, { connection: redis });
            queue.on('error', () => undefined);
            const port = await unusedPort();
            const origin = `http://127.0.0.1:${port}`;
            const env = {
                DATABASE_URL: fixture.databaseUrl,
                AGENT_CHECKPOINT_SCHEMA: fixture.checkpointSchema,
                REDIS_URL: fixture.redisUrl,
                NODE_ENV: 'test',
                REGISTRATION_ENABLED: 'true',
                APP_ORIGIN: origin,
                PORT: String(port),
                AUTH_GLOBAL_LIMIT: '10000',
                WORKER_QUEUE_NAME: queueName,
                WORKER_POLL_INTERVAL_MS: '20',
            };
            const api = launch('server', apiRuntime, env);
            let worker: Running | undefined;
            async function request(
                path: string,
                method = 'GET',
                body?: unknown,
                session?: Session,
                extra: Record<string, string> = {},
            ) {
                return fetch(`${origin}${path}`, {
                    method,
                    headers: {
                        origin,
                        'content-type': 'application/json',
                        ...(session
                            ? { cookie: session.cookie, 'x-csrf-token': session.csrf }
                            : {}),
                        ...extra,
                    },
                    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                    signal: AbortSignal.timeout(5000),
                });
            }
            async function account() {
                const credentials = {
                    email: `${randomUUID()}@example.test`,
                    password: 'correct horse battery staple',
                };
                const registered = await request('/api/v1/auth/register', 'POST', {
                    ...credentials,
                    defaultTimezone: 'UTC',
                });
                expect(registered.status).toBe(201);
                const registeredBody = (await registered.json()) as { user: { id: string } };
                const login = await request('/api/v1/auth/login', 'POST', credentials);
                expect(login.status).toBe(200);
                const body = (await login.json()) as { user: { id: string }; csrfToken: string };
                expect(body.user.id).toBe(registeredBody.user.id);
                const cookie = login.headers.get('set-cookie')?.split(';')[0];
                expect(cookie).toMatch(/^scova_session=/);
                return { cookie: cookie!, csrf: body.csrfToken, userId: body.user.id };
            }
            async function createTask(session: Session) {
                const response = await request(
                    '/api/v1/tasks',
                    'POST',
                    { config: taskConfig() },
                    session,
                );
                expect(response.status).toBe(201);
                return (
                    (await response.json()) as { task: { id: string; currentVersionId: string } }
                ).task;
            }
            async function startRun(taskId: string, session: Session, key: string) {
                const response = await request(
                    `/api/v1/tasks/${taskId}/runs`,
                    'POST',
                    { mode: 'demo' },
                    session,
                    { 'idempotency-key': key },
                );
                expect(response.status).toBe(202);
                return (await response.json()) as RunCommand;
            }
            try {
                await waitUntil(async () => {
                    try {
                        return (await request('/health')).ok;
                    } catch {
                        return false;
                    }
                }, api);
                const owner = await account();
                const other = await account();
                const task = await createTask(owner);
                const key = `flow-${randomUUID()}`;
                const first = await startRun(task.id, owner, key);
                expect(first.reused).toBe(false);
                expect(first.run.taskVersionId).toBe(task.currentVersionId);
                expect(await startRun(task.id, owner, key)).toMatchObject({
                    reused: true,
                    run: { id: first.run.id },
                });
                expect(
                    (await request(`/api/v1/tasks/${task.id}`, 'GET', undefined, other)).status,
                ).toBe(404);
                expect(
                    (await request(`/api/v1/runs/${first.run.id}`, 'GET', undefined, other)).status,
                ).toBe(404);
                const denied = await request(
                    `/api/v1/tasks/${task.id}/runs`,
                    'POST',
                    { mode: 'demo' },
                    other,
                    { 'idempotency-key': `denied-${randomUUID()}` },
                );
                expect(denied.status).toBe(404);
                expect(
                    await fixture.db
                        .select({ count: count() })
                        .from(tables.runs)
                        .where(and(eq(tables.runs.taskId, task.id)))
                        .then(([row]) => row!.count),
                ).toBe(1);
                expect(
                    await fixture.db
                        .select({ count: count() })
                        .from(tables.runEvents)
                        .where(and(eq(tables.runEvents.runId, first.run.id)))
                        .then(([row]) => row!.count),
                ).toBe(1);
                expect(
                    await fixture.db
                        .select({ count: count() })
                        .from(tables.outbox)
                        .where(and(eq(tables.outbox.aggregateId, first.run.id)))
                        .then(([row]) => row!.count),
                ).toBe(1);
                const initial = await fixture.db.query.outbox
                    .findFirst({ where: and(eq(tables.outbox.aggregateId, first.run.id)) })
                    .then(requireRow);
                expect(initial.userId).toBe(owner.userId);
                expect(initial.sentAt).toBeNull();
                worker = launch('worker', workerRuntime, env);
                await waitUntil(
                    async () =>
                        (
                            await fixture.db.query.outbox
                                .findFirst({ where: and(eq(tables.outbox.id, initial.id)) })
                                .then(requireRow)
                        ).sentAt !== null,
                    worker,
                );
                const delivered = await fixture.db.query.outbox
                    .findFirst({ where: and(eq(tables.outbox.id, initial.id)) })
                    .then(requireRow);
                expect(delivered.attempts).toBe(1);
                expect(delivered.leaseExpiresAt).toBeNull();
                const job = await queue.getJob(`run-${first.run.id}`);
                expect(job?.name).toBe('run.enqueue');
                expect(job?.data).toMatchObject({
                    runId: first.run.id,
                    taskVersionId: task.currentVersionId,
                });
                await waitUntil(
                    async () =>
                        (
                            await fixture.db.query.runs
                                .findFirst({ where: and(eq(tables.runs.id, first.run.id)) })
                                .then(requireRow)
                        ).status === 'partial',
                    worker,
                );
                expect(
                    (
                        await fixture.db.query.runs
                            .findFirst({ where: and(eq(tables.runs.id, first.run.id)) })
                            .then(requireRow)
                    ).failureCode,
                ).toBeNull();
                await stop(worker);
                worker = undefined;
                // 新的待投递行作为重启扫描的同步屏障，避免用固定 sleep 猜测已执行一轮。
                const secondTask = await createTask(owner);
                const second = await startRun(secondTask.id, owner, `restart-${randomUUID()}`);
                worker = launch('worker', workerRuntime, env);
                await waitUntil(
                    async () =>
                        (
                            await fixture.db.query.outbox
                                .findFirst({
                                    where: and(eq(tables.outbox.aggregateId, second.run.id)),
                                })
                                .then(requireRow)
                        ).sentAt !== null,
                    worker,
                );
                await waitUntil(
                    async () =>
                        (
                            await fixture.db.query.runs
                                .findFirst({ where: and(eq(tables.runs.id, second.run.id)) })
                                .then(requireRow)
                        ).status === 'partial',
                    worker,
                );
                await stop(worker);
                worker = undefined;
                const unchanged = await fixture.db.query.outbox
                    .findFirst({ where: and(eq(tables.outbox.id, initial.id)) })
                    .then(requireRow);
                expect(unchanged.attempts).toBe(delivered.attempts);
                expect(unchanged.sentAt).toEqual(delivered.sentAt);
                expect(await startRun(task.id, owner, key)).toMatchObject({
                    reused: true,
                    run: { id: first.run.id },
                });
                expect(
                    await fixture.db
                        .select({ count: count() })
                        .from(tables.outbox)
                        .where(and(eq(tables.outbox.aggregateId, first.run.id)))
                        .then(([row]) => row!.count),
                ).toBe(1);
                const jobs = await queue.getJobs([
                    'wait',
                    'active',
                    'completed',
                    'failed',
                    'delayed',
                ]);
                expect(jobs.map((item) => item.id)).toEqual(
                    expect.arrayContaining([`run-${first.run.id}`, `run-${second.run.id}`]),
                );
                // 恢复扫描可以投递重复消息，但生产执行与终态事件只能推进一次。
                expect(
                    jobs.every((item) => [first.run.id, second.run.id].includes(item.data.runId)),
                ).toBe(true);
                expect(
                    await fixture.db
                        .select({ count: count() })
                        .from(tables.runEvents)
                        .where(
                            and(
                                eq(tables.runEvents.runId, first.run.id),
                                eq(tables.runEvents.type, 'run.completed'),
                            ),
                        )
                        .then(([row]) => row!.count),
                ).toBe(1);
                expect(
                    (
                        await fixture.db.query.runs
                            .findFirst({ where: and(eq(tables.runs.id, first.run.id)) })
                            .then(requireRow)
                    ).leaseEpoch,
                ).toBe(1);
                const final = await request(
                    `/api/v1/runs/${first.run.id}`,
                    'GET',
                    undefined,
                    owner,
                );
                expect(final.status).toBe(200);
                const result = (await final.json()) as {
                    status: string;
                    failureCode: string | null;
                };
                expect(result.status).toBe('partial');
                expect(result.failureCode).toBeNull();
                expect(
                    await fixture.db
                        .select({ count: count() })
                        .from(tables.reports)
                        .where(and(eq(tables.reports.runId, first.run.id)))
                        .then(([row]) => row!.count),
                ).toBe(1);
                expect(
                    await fixture.db
                        .select({ count: count() })
                        .from(tables.inboxItems)
                        .where(
                            and(
                                exists(
                                    fixture.db
                                        .select({ id: tables.reports.id })
                                        .from(tables.reports)
                                        .where(
                                            and(
                                                eq(tables.inboxItems.userId, tables.reports.userId),
                                                eq(tables.inboxItems.reportId, tables.reports.id),
                                                and(eq(tables.reports.runId, first.run.id)),
                                            ),
                                        ),
                                ),
                            ),
                        )
                        .then(([row]) => row!.count),
                ).toBe(1);
                expect(
                    await fixture.db
                        .select({ count: count() })
                        .from(tables.baselines)
                        .where(and(eq(tables.baselines.taskId, task.id)))
                        .then(([row]) => row!.count),
                ).toBe(0);
                const reportRow = await fixture.db.query.reports
                    .findFirst({ where: and(eq(tables.reports.runId, first.run.id)) })
                    .then(requireRow);
                const reportResponse = await request(
                    `/api/v1/reports/${reportRow.id}`,
                    'GET',
                    undefined,
                    owner,
                );
                expect(reportResponse.status).toBe(200);
                const report = parseContract(ReportSchema, await reportResponse.json());
                expect(report).toMatchObject({
                    runId: first.run.id,
                    mode: 'demo',
                    coverage: { completeness: 'partial' },
                });
                expect(report.evidence.length).toBeGreaterThan(0);
                const evidenceIds = new Set(report.evidence.map((evidence) => evidence.id));
                for (const claim of report.claims) {
                    for (const id of claim.evidenceIds) expect(evidenceIds.has(id)).toBe(true);
                }
                expect(report.limitations.length).toBeGreaterThan(0);
                expect(
                    (await request(`/api/v1/reports/${report.id}`, 'GET', undefined, other)).status,
                ).toBe(404);
                expect(
                    await fixture.db
                        .select({ count: count() })
                        .from(tables.runEvents)
                        .where(
                            and(
                                eq(tables.runEvents.runId, first.run.id),
                                eq(tables.runEvents.type, 'report.published'),
                            ),
                        )
                        .then(([row]) => row!.count),
                ).toBe(1);
            } finally {
                try {
                    if (worker) await stop(worker);
                } finally {
                    try {
                        await stop(api);
                    } finally {
                        try {
                            await queue.obliterate({ force: true });
                            await queue.close();
                        } finally {
                            redis.disconnect();
                        }
                    }
                }
            }
        },
        60_000,
    );
});
