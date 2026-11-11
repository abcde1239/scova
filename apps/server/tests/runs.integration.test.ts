import { migrateDatabase } from '@scova/db/migrate';
import {
    createDatabaseClient,
    connectDatabase,
    closeDatabase,
    and,
    eq,
    inArray,
    count,
} from '@scova/db';
import * as tables from '@scova/db';
import { randomUUID } from 'node:crypto';
import { effectiveRunScopeHash } from '@scova/shared';

import { Redis as RedisClient } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { createApiApp } from '../src/app/index.ts';
import { createDefaultServices, type ApiServices } from '../src/app/services.ts';
import { firstRow, requireRow } from '../src/utils/database.ts';

const baseUrl =
    process.env.SCOVA_TEST_DATABASE_URL ??
    process.env.RUNTIME_DATABASE_URL ??
    'postgresql://scova_test:scova_test@127.0.0.1:55432/scova_test';
const redisUrl =
    process.env.SCOVA_TEST_REDIS_URL ?? process.env.RUNTIME_REDIS_URL ?? 'redis://127.0.0.1:56379';
const schema = `scova_runs_${randomUUID().replaceAll('-', '')}`;
const scopedUrl = new URL(baseUrl);
scopedUrl.searchParams.set('schema', schema);
const db = createDatabaseClient({ connectionString: scopedUrl.toString() });
const admin = new (require('pg').Client)({ connectionString: baseUrl });
const redis = new RedisClient(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
});
const origin = 'https://scova.test';
let schemaCreated = false;
let services: ApiServices;
let app: ReturnType<typeof createApiApp>;

const config = () => ({
    title: '英语听力',
    topic: 'B1 英语材料',
    goal: '找到带字幕的免费材料',
    focusPoints: ['字幕'],
    exclusions: [],
    sourcePreferences: {
        preferredUrls: ['https://www.example.com'],
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
        maxInputTokens: 40000,
        maxOutputTokens: 8000,
    },
    notificationPreference: { mode: 'summary', runIssues: true },
});
const headers = (extra: Record<string, string> = {}) => ({
    origin,
    'content-type': 'application/json',
    ...extra,
});
const cookie = (response: Response) => response.headers.get('set-cookie')?.split(';')[0] ?? '';
const json = async (response: Response) => (await response.json()) as Record<string, any>;
async function request(path: string, init: RequestInit = {}) {
    return app.handle(new Request(`${origin}${path}`, init));
}
async function register() {
    const response = await request('/api/v1/auth/register', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
            email: `${randomUUID()}@example.test`,
            password: 'correct horse battery staple',
            defaultTimezone: 'UTC',
        }),
    });
    expect(response.status).toBe(201);
    return { cookie: cookie(response), csrf: (await json(response)).csrfToken as string };
}
const authHeaders = (auth: { cookie: string; csrf: string }, extra: Record<string, string> = {}) =>
    headers({ cookie: auth.cookie, 'x-csrf-token': auth.csrf, ...extra });

describe('Run API、事务 Outbox 与事件回放', () => {
    beforeAll(async () => {
        await admin.connect();
        await admin.query(`CREATE SCHEMA "${schema}"`);
        schemaCreated = true;
        await migrateDatabase({ connectionString: scopedUrl.toString() });
        await connectDatabase(db);
        await redis.connect();
    }, 120000);
    beforeEach(async () => {
        services = createDefaultServices({
            origin,
            production: false,
            registrationEnabled: true,
            sessionTtlSeconds: 3600,
            clock: () => new Date('2026-10-24T12:00:00.000Z'),
            db: () => db,
            redis: () => redis,
            rateLimit: {
                windowSeconds: 60,
                loginAttempts: 50,
                registerAttempts: 50,
                globalAttempts: 100,
                keyPrefix: `scova:runs:${randomUUID()}:`,
            },
        });
        app = createApiApp('node', services);
        await redis.flushdb();
    });
    afterAll(async () => {
        await closeDatabase(db);
        await redis.quit();
        if (schemaCreated) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.end();
    });

    async function createTask(auth: { cookie: string; csrf: string }) {
        const response = await request('/api/v1/tasks', {
            method: 'POST',
            headers: authHeaders(auth),
            body: JSON.stringify({ config: config() }),
        });
        expect(response.status).toBe(201);
        return (await json(response)).task as { id: string; currentVersionId: string };
    }

    it('创建执行固定任务版本，在同一事务写入事件与 Outbox，幂等重放复用', async () => {
        const auth = await register();
        const task = await createTask(auth);
        const key = 'run-key-1234567890';
        const first = await request(`/api/v1/tasks/${task.id}/runs`, {
            method: 'POST',
            headers: authHeaders(auth, { 'idempotency-key': key }),
            body: JSON.stringify({}),
        });
        expect(first.status).toBe(202);
        const firstBody = await json(first);
        expect(firstBody.reused).toBe(false);
        expect(firstBody.run.mode).toBe('live');
        expect(firstBody.run.taskVersionId).toBe(task.currentVersionId);
        const second = await request(`/api/v1/tasks/${task.id}/runs`, {
            method: 'POST',
            headers: authHeaders(auth, { 'idempotency-key': key }),
            body: JSON.stringify({ mode: 'live' }),
        });
        expect(second.status).toBe(202);
        expect((await json(second)).reused).toBe(true);
        expect(
            await db
                .select({ count: count() })
                .from(tables.runs)
                .then(([row]) => row!.count),
        ).toBe(1);
        expect(
            await db
                .select({ count: count() })
                .from(tables.runEvents)
                .then(([row]) => row!.count),
        ).toBe(1);
        expect(
            await db
                .select({ count: count() })
                .from(tables.outbox)
                .then(([row]) => row!.count),
        ).toBe(1);
        expect(
            await db
                .select({ count: count() })
                .from(tables.idempotencyRecords)
                .then(([row]) => row!.count),
        ).toBe(1);
        const events = await request(`/api/v1/runs/${firstBody.run.id}/events`, {
            headers: { cookie: auth.cookie },
        });
        expect(events.status).toBe(200);
        expect(events.headers.get('content-type')).toContain('text/event-stream');
        const reader = events.body!.getReader();
        expect(new TextDecoder().decode((await reader.read()).value)).toContain('run.queued');
        await reader.cancel();
    });

    it('拒绝 demo 创建与重试，不写入新执行或 Outbox', async () => {
        const auth = await register();
        const task = await createTask(auth);
        const rejected = await request(`/api/v1/tasks/${task.id}/runs`, {
            method: 'POST',
            headers: authHeaders(auth, { 'idempotency-key': randomUUID() }),
            body: JSON.stringify({ mode: 'demo' }),
        });
        expect(rejected.status).toBe(422);
        expect(
            await db.select().from(tables.runs).where(eq(tables.runs.taskId, task.id)),
        ).toHaveLength(0);
        expect(
            await db
                .select()
                .from(tables.outbox)
                .where(
                    eq(
                        tables.outbox.userId,
                        (await db.query.tasks.findFirst({ where: eq(tables.tasks.id, task.id) }))!
                            .userId,
                    ),
                ),
        ).toHaveLength(0);
        const accepted = await json(
            await request(`/api/v1/tasks/${task.id}/runs`, {
                method: 'POST',
                headers: authHeaders(auth, { 'idempotency-key': randomUUID() }),
                body: '{}',
            }),
        );
        await db
            .update(tables.runs)
            .set({ status: 'failed', mode: 'demo' })
            .where(eq(tables.runs.id, accepted.run.id));
        const retry = await request(`/api/v1/runs/${accepted.run.id}/retry`, {
            method: 'POST',
            headers: authHeaders(auth, { 'idempotency-key': randomUUID() }),
            body: JSON.stringify({ mode: 'demo' }),
        });
        expect(retry.status).toBe(422);
        expect(
            await db.select().from(tables.runs).where(eq(tables.runs.taskId, task.id)),
        ).toHaveLength(1);
        const liveRetry = await json(
            await request(`/api/v1/runs/${accepted.run.id}/retry`, {
                method: 'POST',
                headers: authHeaders(auth, { 'idempotency-key': randomUUID() }),
                body: '{}',
            }),
        );
        expect(liveRetry.run).toMatchObject({
            mode: 'live',
            parentRunId: accepted.run.id,
            taskVersionId: accepted.run.taskVersionId,
            budget: accepted.run.budget,
        });
    });

    it('活动执行互斥、幂等 payload 冲突和跨账号访问隔离', async () => {
        const auth = await register();
        const other = await register();
        const task = await createTask(auth);
        const first = await request(`/api/v1/tasks/${task.id}/runs`, {
            method: 'POST',
            headers: authHeaders(auth, { 'idempotency-key': 'run-key-abcdefghijk' }),
            body: JSON.stringify({ mode: 'live' }),
        });
        const run = await json(first);
        // 模拟升级前同一个 key 已记录不同命令的历史幂等冲突。
        await db
            .update(tables.idempotencyRecords)
            .set({ payloadHash: 'f'.repeat(64) })
            .where(eq(tables.idempotencyRecords.resourceId, run.run.id));
        const mismatch = await request(`/api/v1/tasks/${task.id}/runs`, {
            method: 'POST',
            headers: authHeaders(auth, { 'idempotency-key': 'run-key-abcdefghijk' }),
            body: JSON.stringify({ mode: 'live' }),
        });
        expect(mismatch.status).toBe(409);
        const otherKey = await request(`/api/v1/tasks/${task.id}/runs`, {
            method: 'POST',
            headers: authHeaders(auth, { 'idempotency-key': 'run-key-different1' }),
            body: JSON.stringify({ mode: 'live' }),
        });
        expect(otherKey.status).toBe(202);
        expect(await json(otherKey)).toMatchObject({ reused: true, run: { id: run.run.id } });
        const denied = await request(`/api/v1/runs/${run.run.id}`, {
            headers: { cookie: other.cookie },
        });
        expect(denied.status).toBe(404);
        const missingKey = await request(`/api/v1/tasks/${task.id}/runs`, {
            method: 'POST',
            headers: authHeaders(auth),
            body: JSON.stringify({}),
        });
        expect(missingKey.status).toBe(428);
    });

    it('并发启动复用唯一活动执行，重复取消只写入一个取消命令', async () => {
        const auth = await register();
        const task = await createTask(auth);
        const start = (key: string) =>
            request(`/api/v1/tasks/${task.id}/runs`, {
                method: 'POST',
                headers: authHeaders(auth, { 'idempotency-key': key }),
                body: JSON.stringify({ mode: 'live' }),
            });
        const started = await Promise.all([
            start('concurrent-start-one'),
            start('concurrent-start-two'),
        ]);
        expect(started.map((response) => response.status)).toEqual([202, 202]);
        const bodies = await Promise.all(started.map(json));
        expect(bodies[0]!.run.id).toBe(bodies[1]!.run.id);
        const runId = bodies[0]!.run.id as string;
        expect(
            await db
                .select({ count: count() })
                .from(tables.runs)
                .where(and(eq(tables.runs.taskId, task.id)))
                .then(([row]) => row!.count),
        ).toBe(1);
        expect(
            await db
                .select({ count: count() })
                .from(tables.outbox)
                .where(and(eq(tables.outbox.aggregateId, runId)))
                .then(([row]) => row!.count),
        ).toBe(1);
        expect(
            await db
                .select({ count: count() })
                .from(tables.runEvents)
                .where(and(eq(tables.runEvents.runId, runId)))
                .then(([row]) => row!.count),
        ).toBe(1);

        const cancel = () =>
            request(`/api/v1/runs/${runId}/cancel`, {
                method: 'POST',
                headers: authHeaders(auth),
            });
        const canceled = await Promise.all([cancel(), cancel()]);
        expect(canceled.map((response) => response.status)).toEqual([200, 200]);
        expect(
            (await Promise.all(canceled.map(json)))
                .map((body) => body.reused)
                .sort((a, b) => Number(a) - Number(b)),
        ).toEqual([false, true]);
        const repeated = await cancel();
        expect(repeated.status).toBe(200);
        expect((await json(repeated)).reused).toBe(true);
        expect(
            await db
                .select({ count: count() })
                .from(tables.outbox)
                .where(
                    and(
                        eq(tables.outbox.aggregateId, runId),
                        eq(tables.outbox.eventType, 'run.cancel_requested'),
                    ),
                )
                .then(([row]) => row!.count),
        ).toBe(1);
        await db
            .update(tables.runs)
            .set({ status: 'canceled' })
            .where(and(eq(tables.runs.id, runId)))
            .returning()
            .then(firstRow);
        expect((await json(await start('concurrent-start-two'))).run.id).toBe(runId);
        expect(
            await db
                .select({ count: count() })
                .from(tables.runs)
                .where(and(eq(tables.runs.taskId, task.id)))
                .then(([row]) => row!.count),
        ).toBe(1);
        expect((await json(await cancel())).run.status).toBe('canceled');
    });

    it('配置修改后重试仍固定原版本、预算和比较范围，并可幂等重放', async () => {
        const auth = await register();
        const task = await createTask(auth);
        const created = await request(`/api/v1/tasks/${task.id}/runs`, {
            method: 'POST',
            headers: authHeaders(auth, { 'idempotency-key': 'run-original-version' }),
            body: JSON.stringify({ mode: 'live' }),
        });
        expect(created.status).toBe(202);
        const original = (await json(created)).run;
        const storedOriginal = await db.query.runs
            .findFirst({ where: and(eq(tables.runs.id, original.id)) })
            .then(requireRow);
        const editedConfig = config();
        editedConfig.topic = '官方招生通知';
        editedConfig.budget.maxSearches = 2;
        const edited = await request(`/api/v1/tasks/${task.id}`, {
            method: 'PATCH',
            headers: authHeaders(auth, { 'if-match': '"1"' }),
            body: JSON.stringify({ config: editedConfig }),
        });
        expect(edited.status).toBe(200);
        const latest = await json(edited);
        expect(latest.task.currentVersionId).not.toBe(original.taskVersionId);
        await db
            .update(tables.runs)
            .set({ status: 'failed' })
            .where(and(eq(tables.runs.id, original.id)))
            .returning()
            .then(firstRow);

        const retry = () =>
            request(`/api/v1/runs/${original.id}/retry`, {
                method: 'POST',
                headers: authHeaders(auth, { 'idempotency-key': 'run-retry-pinned-version' }),
                body: JSON.stringify({ mode: 'live' }),
            });
        const retried = await retry();
        expect(retried.status).toBe(202);
        const body = await json(retried);
        expect(body.run).toMatchObject({
            taskVersionId: original.taskVersionId,
            parentRunId: original.id,
            budget: original.budget,
        });
        const storedRetry = await db.query.runs
            .findFirst({ where: and(eq(tables.runs.id, body.run.id)) })
            .then(requireRow);
        expect(storedRetry.comparisonScopeHash).toBe(storedOriginal.comparisonScopeHash);
        expect(
            (
                await db.query.outbox
                    .findFirst({ where: and(eq(tables.outbox.aggregateId, body.run.id)) })
                    .then(requireRow)
            ).payload,
        ).toMatchObject({ taskVersionId: original.taskVersionId });
        expect(
            (
                await db.query.runEvents
                    .findFirst({ where: and(eq(tables.runEvents.runId, body.run.id)) })
                    .then(requireRow)
            ).payload,
        ).toMatchObject({ taskVersionId: original.taskVersionId });
        const replayed = await retry();
        expect(replayed.status).toBe(202);
        expect(await json(replayed)).toMatchObject({ reused: true, run: { id: body.run.id } });
        expect(
            await db
                .select({ count: count() })
                .from(tables.outbox)
                .where(and(eq(tables.outbox.aggregateId, body.run.id)))
                .then(([row]) => row!.count),
        ).toBe(1);

        await db
            .update(tables.runs)
            .set({ status: 'failed' })
            .where(and(eq(tables.runs.id, body.run.id)))
            .returning()
            .then(firstRow);
        const fresh = await request(`/api/v1/tasks/${task.id}/runs`, {
            method: 'POST',
            headers: authHeaders(auth, { 'idempotency-key': 'run-current-version' }),
            body: JSON.stringify({ mode: 'live' }),
        });
        expect(fresh.status).toBe(202);
        expect((await json(fresh)).run).toMatchObject({
            taskVersionId: latest.task.currentVersionId,
            budget: editedConfig.budget,
        });
    });

    it('取消活动执行并可从失败执行创建 parentRun 重试', async () => {
        const auth = await register();
        const task = await createTask(auth);
        const created = await request(`/api/v1/tasks/${task.id}/runs`, {
            method: 'POST',
            headers: authHeaders(auth, { 'idempotency-key': 'run-key-cancel123' }),
            body: JSON.stringify({}),
        });
        const original = await json(created);
        const canceled = await request(`/api/v1/runs/${original.run.id}/cancel`, {
            method: 'POST',
            headers: authHeaders(auth),
        });
        expect(canceled.status).toBe(200);
        expect((await json(canceled)).run.status).toBe('cancel_requested');
        const repeatedCancel = await request(`/api/v1/runs/${original.run.id}/cancel`, {
            method: 'POST',
            headers: authHeaders(auth),
        });
        expect(repeatedCancel.status).toBe(200);
        expect((await json(repeatedCancel)).reused).toBe(true);
        await db
            .update(tables.runs)
            .set({ status: 'failed', failureCode: 'TEST_FAILURE' })
            .where(and(eq(tables.runs.id, original.run.id)))
            .returning()
            .then(firstRow);
        const retried = await request(`/api/v1/runs/${original.run.id}/retry`, {
            method: 'POST',
            headers: authHeaders(auth, { 'idempotency-key': 'run-key-retry1234' }),
            body: JSON.stringify({}),
        });
        expect(retried.status).toBe(202);
        const body = await json(retried);
        expect(body.run.parentRunId).toBe(original.run.id);
        expect(
            await db
                .select({ count: count() })
                .from(tables.outbox)
                .where(and(inArray(tables.outbox.aggregateId, [original.run.id, body.run.id])))
                .then(([row]) => row!.count),
        ).toBe(3);
    });

    it('历史演示仍可读取且与新真实执行范围隔离，重试保持真实范围', async () => {
        const auth = await register();
        const task = await createTask(auth);
        const start = async (mode: 'demo' | 'live', key: string) => {
            const response = await request(`/api/v1/tasks/${task.id}/runs`, {
                method: 'POST',
                headers: authHeaders(auth, { 'idempotency-key': key }),
                body: JSON.stringify({ mode }),
            });
            expect(response.status).toBe(202);
            return (await json(response)).run;
        };
        const demo = await start('live', 'mode-scope-demo-key');
        const version = await db.query.taskVersions
            .findFirst({ where: eq(tables.taskVersions.id, task.currentVersionId) })
            .then(requireRow);
        await db
            .update(tables.runs)
            .set({
                mode: 'demo',
                comparisonScopeHash: effectiveRunScopeHash(version.comparisonScopeHash, 'demo'),
            })
            .where(eq(tables.runs.id, demo.id));
        const history = await json(
            await request(`/api/v1/runs/${demo.id}`, { headers: { cookie: auth.cookie } }),
        );
        expect(history.mode).toBe('demo');
        const demoStored = await db.query.runs
            .findFirst({ where: and(eq(tables.runs.id, demo.id)) })
            .then(requireRow);
        await db
            .update(tables.runs)
            .set({ status: 'failed' })
            .where(and(eq(tables.runs.id, demo.id)))
            .returning()
            .then(firstRow);
        const live = await start('live', 'mode-scope-live-key');
        const liveStored = await db.query.runs
            .findFirst({ where: and(eq(tables.runs.id, live.id)) })
            .then(requireRow);
        expect(live.taskVersionId).toBe(demo.taskVersionId);
        expect(liveStored.comparisonScopeHash).not.toBe(demoStored.comparisonScopeHash);
        await db
            .update(tables.runs)
            .set({ status: 'failed' })
            .where(and(eq(tables.runs.id, live.id)))
            .returning()
            .then(firstRow);
        const retry = await request(`/api/v1/runs/${live.id}/retry`, {
            method: 'POST',
            headers: authHeaders(auth, { 'idempotency-key': 'mode-scope-retry-key' }),
            body: JSON.stringify({ mode: 'live' }),
        });
        expect(retry.status).toBe(202);
        const retried = (await json(retry)).run;
        expect(
            (
                await db.query.runs
                    .findFirst({ where: and(eq(tables.runs.id, retried.id)) })
                    .then(requireRow)
            ).comparisonScopeHash,
        ).toBe(liveStored.comparisonScopeHash);
    });
    it.each([false, true])(
        'freezes selected formats without editing the task; replay, mismatch and retry preserve semantics (multiple=%s)',
        async (multiple) => {
            const auth = await register();
            const task = await createTask(auth);
            const key = 'format-freeze-123456789';
            const start = (body: unknown, commandKey = key) =>
                request(`/api/v1/tasks/${task.id}/runs`, {
                    method: 'POST',
                    headers: authHeaders(auth, { 'idempotency-key': commandKey }),
                    body: JSON.stringify(body),
                });
            const command = multiple
                ? { outputFormats: ['comparison', 'list'] }
                : { outputFormat: 'comparison' };
            const expectedConfig = multiple
                ? { outputFormat: 'comparison', outputFormats: ['comparison', 'list'] }
                : { outputFormat: 'comparison' };
            const first = await start(command);
            expect(first.status).toBe(202);
            const original = (await json(first)).run;
            const stored = await db.query.runs.findFirst({
                where: eq(tables.runs.id, original.id),
            });
            expect(stored?.followupConfigJson).toMatchObject(expectedConfig);
            const version = await db.query.taskVersions.findFirst({
                where: eq(tables.taskVersions.id, task.currentVersionId),
            });
            expect(version?.configJson).toMatchObject({ outputFormat: 'brief' });
            expect(
                (version?.configJson as Record<string, unknown> | undefined)?.outputFormats,
            ).toBeUndefined();
            expect((await json(await start(command))).run.id).toBe(original.id);
            expect((await start({ outputFormat: 'list' })).status).toBe(409);
            if (multiple)
                expect((await start({ outputFormats: ['list', 'comparison'] })).status).toBe(409);
            const active = await json(
                await start({ outputFormat: 'list' }, 'format-active-123456789'),
            );
            expect(active.reused).toBe(true);
            expect(active.run.id).toBe(original.id);
            await db
                .update(tables.runs)
                .set({
                    status: 'failed',
                    finishedAt: services.clock(),
                    failureCode: 'EXECUTOR_FAILED',
                })
                .where(eq(tables.runs.id, original.id));
            const retried = await request(`/api/v1/runs/${original.id}/retry`, {
                method: 'POST',
                headers: authHeaders(auth, { 'idempotency-key': 'format-retry-123456789' }),
                body: '{}',
            });
            expect(retried.status).toBe(202);
            const retry = (await json(retried)).run;
            expect(retry.taskVersionId).toBe(task.currentVersionId);
            expect(retry.budget).toEqual(original.budget);
            const retryStored = await db.query.runs.findFirst({
                where: eq(tables.runs.id, retry.id),
            });
            expect(retryStored?.followupConfigJson).toMatchObject(expectedConfig);
            expect(retryStored?.comparisonScopeHash).toBe(stored?.comparisonScopeHash);
        },
    );
});
