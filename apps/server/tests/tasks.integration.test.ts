import { migrateDatabase } from '@scova/db/migrate';
import {
    createDatabaseClient,
    connectDatabase,
    closeDatabase,
    queryRows,
    sql as querySql,
    and,
    eq,
    asc,
    count,
} from '@scova/db';
import * as tables from '@scova/db';
import { randomUUID } from 'node:crypto';

import { Redis as RedisClient } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { createApiApp } from '../src/app/index.ts';
import { createDefaultServices, type ApiServices } from '../src/app/services.ts';
import { comparisonScopeHash } from '../src/service/tasks.ts';
import type { TaskConfig } from '@scova/models';
import { nextScheduledAt } from '@scova/shared';
import { firstRow, requireRow } from '../src/utils/database.ts';

const baseUrl =
    process.env.SCOVA_TEST_DATABASE_URL ??
    process.env.RUNTIME_DATABASE_URL ??
    'postgresql://scova_test:scova_test@127.0.0.1:55432/scova_test';
const redisUrl =
    process.env.SCOVA_TEST_REDIS_URL ?? process.env.RUNTIME_REDIS_URL ?? 'redis://127.0.0.1:56379';
const schema = `scova_tasks_${randomUUID().replaceAll('-', '')}`;
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
let now = new Date('2026-10-24T12:00:00.000Z');
let services: ApiServices;
let app: ReturnType<typeof createApiApp>;

const config = (overrides: Record<string, unknown> = {}) => ({
    title: '每周英语听力',
    topic: 'B1 英语听力材料',
    goal: '寻找带字幕的免费材料',
    focusPoints: ['字幕', '免费'],
    exclusions: ['付费课程'],
    sourcePreferences: {
        preferredUrls: ['https://www.example.com/english'],
        excludedUrls: ['https://ads.example.com'],
        officialOnly: false,
    },
    timeRange: { kind: 'rolling', days: 7 },
    timezone: 'Asia/Shanghai',
    schedule: { frequency: 'weekly', localTime: '20:00', weekday: 1 },
    outputFormat: 'brief',
    budget: {
        maxSearches: 10,
        maxPages: 20,
        maxDurationSeconds: 300,
        maxInputTokens: 40_000,
        maxOutputTokens: 8_000,
    },
    notificationPreference: { mode: 'summary', runIssues: true },
    ...overrides,
});
const headers = (extra: Record<string, string> = {}) => ({
    origin,
    'content-type': 'application/json',
    ...extra,
});
const cookieHeader = (response: Response) =>
    response.headers.get('set-cookie')?.split(';')[0] ?? '';
const json = async (response: Response) => (await response.json()) as Record<string, any>;
const registerBody = (email: string) => ({
    email,
    password: 'correct horse battery staple',
    defaultTimezone: 'Asia/Shanghai',
});
async function request(path: string, init: RequestInit = {}) {
    return app.handle(new Request(`${origin}${path}`, init));
}
async function register(email = `${randomUUID()}@example.test`) {
    const response = await request('/api/v1/auth/register', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(registerBody(email)),
    });
    expect(response.status).toBe(201);
    return { cookie: cookieHeader(response), csrf: (await json(response)).csrfToken as string };
}
function authHeaders(auth: { cookie: string; csrf: string }, extra: Record<string, string> = {}) {
    return headers({ cookie: auth.cookie, 'x-csrf-token': auth.csrf, ...extra });
}

describe('长期任务、不可变版本与并发编辑', () => {
    beforeAll(async () => {
        await admin.connect();
        await admin.query(`CREATE SCHEMA "${schema}"`);
        schemaCreated = true;
        await migrateDatabase({ connectionString: scopedUrl.toString() });
        await connectDatabase(db);
        await redis.connect();
    }, 120_000);

    beforeEach(async () => {
        now = new Date('2026-10-24T12:00:00.000Z');
        services = createDefaultServices({
            origin,
            production: false,
            registrationEnabled: true,
            sessionTtlSeconds: 3600,
            clock: () => now,
            db: () => db,
            redis: () => redis,
            rateLimit: {
                windowSeconds: 60,
                loginAttempts: 50,
                registerAttempts: 50,
                globalAttempts: 100,
                keyPrefix: `scova:tasks:${randomUUID()}:`,
            },
        });
        app = createApiApp('node', services);
        await redis.flushdb();
    });

    afterAll(async () => {
        await closeDatabase(db);
        await redis.quit();
        if (schemaCreated && /^scova_tasks_[0-9a-f]{32}$/.test(schema))
            await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.end();
    });

    it('创建、分页和详情只返回当前账号任务，并计算时区计划', async () => {
        const owner = await register();
        const other = await register();
        const created = await request('/api/v1/tasks', {
            method: 'POST',
            headers: authHeaders(owner),
            body: JSON.stringify({ inputText: '每周找材料', config: config() }),
        });
        expect(created.status).toBe(201);
        const body = await json(created);
        expect(body.task.revision).toBe(1);
        expect(body.version.version).toBe(1);
        expect(body.task.nextRunAt).toBe('2026-10-26T12:00:00.000Z');
        expect(created.headers.get('etag')).toBe('"1"');
        const list = await request('/api/v1/tasks', { headers: { cookie: owner.cookie } });
        expect(list.status).toBe(200);
        expect((await json(list)).items).toHaveLength(1);
        const cross = await request(`/api/v1/tasks/${body.task.id}`, {
            headers: { cookie: other.cookie },
        });
        expect(cross.status).toBe(404);
    });

    it('HTTP 分页 limit 可解析、游标无重复且不泄露其他账号任务', async () => {
        const owner = await register();
        const other = await register();
        for (const auth of [owner, owner, other]) {
            const created = await request('/api/v1/tasks', {
                method: 'POST',
                headers: authHeaders(auth),
                body: JSON.stringify({ config: config() }),
            });
            expect(created.status).toBe(201);
        }
        const first = await request('/api/v1/tasks?limit=1', { headers: { cookie: owner.cookie } });
        expect(first.status).toBe(200);
        const page = await json(first);
        expect(page.items).toHaveLength(1);
        expect(page.nextCursor).toEqual(expect.any(String));
        const next = await request(
            `/api/v1/tasks?limit=1&cursor=${encodeURIComponent(page.nextCursor)}`,
            {
                headers: { cookie: owner.cookie },
            },
        );
        expect(next.status).toBe(200);
        const nextPage = await json(next);
        expect(nextPage.items).toHaveLength(1);
        expect(nextPage.items[0].id).not.toBe(page.items[0].id);
        expect(nextPage.nextCursor).toBeNull();
        for (const limit of ['0', '-1', '1.5', 'abc', '9007199254740992']) {
            const invalid = await request(`/api/v1/tasks?limit=${limit}`, {
                headers: { cookie: owner.cookie },
            });
            expect(invalid.status, limit).toBe(422);
        }
    });

    it('保留旧版本；标题、形式打开顺序和提醒不重置基线，语义变更会提示', async () => {
        const owner = await register();
        const created = await request('/api/v1/tasks', {
            method: 'POST',
            headers: authHeaders(owner),
            body: JSON.stringify({
                inputText: '原始自然语言需求',
                config: config({ outputFormats: ['brief', 'comparison'] }),
            }),
        });
        const first = await json(created);
        const titleEdit = config({
            title: '更新标题',
            outputFormat: 'comparison',
            outputFormats: ['comparison', 'brief'],
            notificationPreference: { mode: 'important_change', runIssues: false },
        });
        const secondResponse = await request(`/api/v1/tasks/${first.task.id}`, {
            method: 'PATCH',
            headers: authHeaders(owner, { 'if-match': '"1"' }),
            body: JSON.stringify({ config: titleEdit }),
        });
        expect(secondResponse.status).toBe(200);
        const second = await json(secondResponse);
        expect(second.task.revision).toBe(2);
        expect(second.baselineResetRequired).toBe(false);
        expect(second.version.config.title).toBe('更新标题');
        expect(
            await db.query.taskVersions
                .findFirst({ where: and(eq(tables.taskVersions.id, second.version.id)) })
                .then(requireRow),
        ).toMatchObject({ inputText: '原始自然语言需求' });
        const semantic = await request(`/api/v1/tasks/${first.task.id}`, {
            method: 'PATCH',
            headers: authHeaders(owner, { 'if-match': '"2"' }),
            body: JSON.stringify({
                config: config({
                    topic: '官方招生通知',
                    outputFormats: ['brief', 'comparison'],
                }),
            }),
        });
        expect(semantic.status).toBe(200);
        expect((await json(semantic)).baselineResetRequired).toBe(true);
        const versions = await db.query.taskVersions.findMany({
            where: and(eq(tables.taskVersions.taskId, first.task.id)),
            orderBy: [asc(tables.taskVersions.version)],
        });
        expect(versions).toHaveLength(3);
        expect((versions[0]!.configJson as Record<string, unknown>).title).toBe('每周英语听力');
        expect(
            (
                await db.query.tasks
                    .findFirst({ where: and(eq(tables.tasks.id, first.task.id)) })
                    .then(requireRow)
            ).scheduleRevision,
        ).toBe(1);
    });

    it('调度语义变更递增 scheduleRevision，缺失或冲突 If-Match 被拒绝', async () => {
        const owner = await register();
        const created = await request('/api/v1/tasks', {
            method: 'POST',
            headers: authHeaders(owner),
            body: JSON.stringify({ config: config({ schedule: { frequency: 'manual' } }) }),
        });
        const first = await json(created);
        const missing = await request(`/api/v1/tasks/${first.task.id}`, {
            method: 'PATCH',
            headers: authHeaders(owner),
            body: JSON.stringify({ config: config() }),
        });
        expect(missing.status).toBe(428);
        const changed = await request(`/api/v1/tasks/${first.task.id}`, {
            method: 'PATCH',
            headers: authHeaders(owner, { 'if-match': '"1"' }),
            body: JSON.stringify({ config: config() }),
        });
        expect(changed.status).toBe(200);
        expect(
            (
                await db.query.tasks
                    .findFirst({ where: and(eq(tables.tasks.id, first.task.id)) })
                    .then(requireRow)
            ).scheduleRevision,
        ).toBe(2);
        const conflict = await request(`/api/v1/tasks/${first.task.id}`, {
            method: 'PATCH',
            headers: authHeaders(owner, { 'if-match': '"1"' }),
            body: JSON.stringify({ config: config({ title: '过期编辑' }) }),
        });
        expect(conflict.status).toBe(409);
        expect(
            await db
                .select({ count: count() })
                .from(tables.taskVersions)
                .where(and(eq(tables.taskVersions.taskId, first.task.id)))
                .then(([row]) => row!.count),
        ).toBe(2);
    });

    it('两个并发编辑只有一个成功，失败请求不产生重复版本', async () => {
        const owner = await register();
        const created = await request('/api/v1/tasks', {
            method: 'POST',
            headers: authHeaders(owner),
            body: JSON.stringify({ config: config() }),
        });
        const first = await json(created);
        const init = (title: string) => ({
            method: 'PATCH',
            headers: authHeaders(owner, { 'if-match': '"1"' }),
            body: JSON.stringify({ config: config({ title }) }),
        });
        const responses = await Promise.all([
            request(`/api/v1/tasks/${first.task.id}`, init('并发 A')),
            request(`/api/v1/tasks/${first.task.id}`, init('并发 B')),
        ]);
        expect(responses.map((response) => response.status).sort((a, b) => a - b)).toEqual([
            200, 409,
        ]);
        expect(
            await db
                .select({ count: count() })
                .from(tables.taskVersions)
                .where(and(eq(tables.taskVersions.taskId, first.task.id)))
                .then(([row]) => row!.count),
        ).toBe(2);
        expect(
            (
                await db.query.tasks
                    .findFirst({ where: and(eq(tables.tasks.id, first.task.id)) })
                    .then(requireRow)
            ).revision,
        ).toBe(2);
    });

    it('拒绝非法时区、非 HTTP 来源和超过部署预算的配置', async () => {
        const owner = await register();
        for (const invalid of [
            config({ timezone: 'Mars/Olympus' }),
            config({
                sourcePreferences: {
                    preferredUrls: ['ftp://example.com'],
                    excludedUrls: [],
                    officialOnly: false,
                },
            }),
            config({ budget: { ...config().budget, maxSearches: 11 } }),
            config({ budget: { ...config().budget, maxDurationSeconds: 1801 } }),
            config({ budget: { ...config().budget, maxInputTokens: 2000001 } }),
            config({ budget: { ...config().budget, maxOutputTokens: 512001 } }),
        ]) {
            const response = await request('/api/v1/tasks', {
                method: 'POST',
                headers: authHeaders(owner),
                body: JSON.stringify({ config: invalid }),
            });
            expect(response.status).toBe(422);
            expect((await json(response)).fieldErrors.length).toBeGreaterThan(0);
        }
    });

    it('比较哈希排除时区但包含检索策略版本', () => {
        const a = config();
        const b = config({ timezone: 'UTC' });
        expect(comparisonScopeHash(a as TaskConfig)).toBe(comparisonScopeHash(b as TaskConfig));
    });

    it('接受提高后的累计预算并保留准确快照', async () => {
        const owner = await register();
        const budget = {
            ...config().budget,
            maxDurationSeconds: 1800,
            maxInputTokens: 2000000,
            maxOutputTokens: 512000,
        };
        const response = await request('/api/v1/tasks', {
            method: 'POST',
            headers: authHeaders(owner),
            body: JSON.stringify({ config: config({ budget }) }),
        });
        expect(response.status).toBe(201);
        expect((await json(response)).version.config.budget).toEqual(budget);
    });

    it('比较范围保留预算调整，关键来源和时间窗口改变则隔离', () => {
        const original = config();
        const baselineScope = comparisonScopeHash(original as TaskConfig);
        expect(comparisonScopeHash({ ...original, researchMode: 'analysis' } as TaskConfig)).toBe(
            baselineScope,
        );
        expect(
            comparisonScopeHash({ ...original, researchMode: 'collection' } as TaskConfig),
        ).not.toBe(baselineScope);
        expect(
            comparisonScopeHash(
                config({ budget: { ...original.budget, maxSearches: 2 } }) as TaskConfig,
            ),
        ).toBe(baselineScope);
        expect(
            comparisonScopeHash(
                config({
                    sourcePreferences: {
                        ...original.sourcePreferences,
                        preferredUrls: ['https://example.org/admission'],
                    },
                }) as TaskConfig,
            ),
        ).not.toBe(baselineScope);
        expect(
            comparisonScopeHash(config({ timeRange: { kind: 'rolling', days: 30 } }) as TaskConfig),
        ).not.toBe(baselineScope);
    });

    it('暂停保留当前执行并仍允许显式手动运行，恢复只安排数据库时间之后的计划', async () => {
        const owner = await register();
        const created = await json(
            await request('/api/v1/tasks', {
                method: 'POST',
                headers: authHeaders(owner),
                body: JSON.stringify({ config: config() }),
            }),
        );
        const start = (key: string) =>
            request(`/api/v1/tasks/${created.task.id}/runs`, {
                method: 'POST',
                headers: authHeaders(owner, { 'idempotency-key': key }),
                body: JSON.stringify({ mode: 'live' }),
            });
        const firstResponse = await start('paused-current-run-key');
        expect(firstResponse.status).toBe(202);
        const first = await json(firstResponse);
        const paused = await request(`/api/v1/tasks/${created.task.id}/pause`, {
            method: 'POST',
            headers: authHeaders(owner, { 'if-match': '"1"' }),
        });
        expect(paused.status).toBe(200);
        expect(paused.headers.get('etag')).toBe('"2"');
        expect((await json(paused)).task).toMatchObject({
            status: 'paused',
            nextRunAt: null,
            currentVersionId: created.task.currentVersionId,
        });
        expect(
            (
                await db.query.runs
                    .findFirst({ where: and(eq(tables.runs.id, first.run.id)) })
                    .then(requireRow)
            ).status,
        ).toBe('queued');
        expect(await json(await start('paused-reuse-active-key'))).toMatchObject({
            reused: true,
            run: { id: first.run.id },
        });
        await db
            .update(tables.runs)
            .set({ status: 'failed' })
            .where(and(eq(tables.runs.id, first.run.id)))
            .returning()
            .then(firstRow);
        const explicit = await start('paused-explicit-new-key');
        expect(explicit.status).toBe(202);
        expect((await json(explicit)).reused).toBe(false);
        const [before] = await queryRows<{ now: Date }>(
            db,
            querySql`SELECT clock_timestamp() AS now`,
        );
        const resumed = await request(`/api/v1/tasks/${created.task.id}/resume`, {
            method: 'POST',
            headers: authHeaders(owner, { 'if-match': '"2"' }),
        });
        expect(resumed.status).toBe(200);
        const body = await json(resumed);
        expect(body.task).toMatchObject({ status: 'active', revision: 3 });
        expect(new Date(body.task.nextRunAt).getTime()).toBeGreaterThan(before!.now.getTime());
        const [after] = await queryRows<{ now: Date }>(
            db,
            querySql`SELECT clock_timestamp() AS now`,
        );
        expect([
            nextScheduledAt(config() as TaskConfig, before!.now)!.toISOString(),
            nextScheduledAt(config() as TaskConfig, after!.now)!.toISOString(),
        ]).toContain(body.task.nextRunAt);
        expect(
            await db
                .select({ count: count() })
                .from(tables.taskVersions)
                .where(and(eq(tables.taskVersions.taskId, created.task.id)))
                .then(([row]) => row!.count),
        ).toBe(1);
        expect(
            (
                await db.query.tasks
                    .findFirst({ where: and(eq(tables.tasks.id, created.task.id)) })
                    .then(requireRow)
            ).scheduleRevision,
        ).toBe(3);
    });

    it('归档与单独取消竞争保持唯一取消投递，并拒绝新执行而保留历史', async () => {
        const owner = await register();
        const created = await json(
            await request('/api/v1/tasks', {
                method: 'POST',
                headers: authHeaders(owner),
                body: JSON.stringify({ config: config() }),
            }),
        );
        const run = (
            await json(
                await request(`/api/v1/tasks/${created.task.id}/runs`, {
                    method: 'POST',
                    headers: authHeaders(owner, { 'idempotency-key': 'archive-current-run-key' }),
                    body: JSON.stringify({}),
                }),
            )
        ).run;
        const responses = await Promise.all([
            request(`/api/v1/tasks/${created.task.id}/archive`, {
                method: 'POST',
                headers: authHeaders(owner, { 'if-match': '"1"' }),
            }),
            request(`/api/v1/runs/${run.id}/cancel`, {
                method: 'POST',
                headers: authHeaders(owner),
            }),
        ]);
        expect(responses.map((response) => response.status)).toEqual([200, 200]);
        expect((await json(responses[0]!)).task).toMatchObject({
            status: 'archived',
            nextRunAt: null,
            revision: 2,
        });
        expect(
            await db
                .select({ count: count() })
                .from(tables.outbox)
                .where(
                    and(
                        eq(tables.outbox.aggregateId, run.id),
                        eq(tables.outbox.eventType, 'run.cancel_requested'),
                    ),
                )
                .then(([row]) => row!.count),
        ).toBe(1);
        expect(
            (
                await db.query.runs
                    .findFirst({ where: and(eq(tables.runs.id, run.id)) })
                    .then(requireRow)
            ).status,
        ).toBe('cancel_requested');
        expect(
            (
                await db.query.tasks
                    .findFirst({ where: and(eq(tables.tasks.id, created.task.id)) })
                    .then(requireRow)
            ).archivedAt,
        ).not.toBeNull();
        const repeated = await request(`/api/v1/tasks/${created.task.id}/archive`, {
            method: 'POST',
            headers: authHeaders(owner, { 'if-match': '"2"' }),
        });
        expect(repeated.status).toBe(200);
        expect((await json(repeated)).task.revision).toBe(2);
        for (const action of ['pause', 'resume'])
            expect(
                (
                    await request(`/api/v1/tasks/${created.task.id}/${action}`, {
                        method: 'POST',
                        headers: authHeaders(owner, { 'if-match': '"2"' }),
                    })
                ).status,
            ).toBe(409);
        expect(
            (
                await request(`/api/v1/tasks/${created.task.id}/runs`, {
                    method: 'POST',
                    headers: authHeaders(owner, { 'idempotency-key': 'archived-reject-new-key' }),
                    body: JSON.stringify({}),
                })
            ).status,
        ).toBe(409);
        const replay = await request(`/api/v1/tasks/${created.task.id}/runs`, {
            method: 'POST',
            headers: authHeaders(owner, { 'idempotency-key': 'archive-current-run-key' }),
            body: JSON.stringify({}),
        });
        expect(replay.status).toBe(202);
        expect(await json(replay)).toMatchObject({
            reused: true,
            run: { id: run.id, status: 'cancel_requested' },
        });
        await db
            .update(tables.runs)
            .set({ status: 'canceled' })
            .where(and(eq(tables.runs.id, run.id)))
            .returning()
            .then(firstRow);
        expect(
            (
                await request(`/api/v1/runs/${run.id}/retry`, {
                    method: 'POST',
                    headers: authHeaders(owner, { 'idempotency-key': 'archived-reject-retry-key' }),
                    body: JSON.stringify({}),
                })
            ).status,
        ).toBe(409);
        expect(
            (await request(`/api/v1/tasks/${created.task.id}`, { headers: authHeaders(owner) }))
                .status,
        ).toBe(200);
        expect(
            await db
                .select({ count: count() })
                .from(tables.taskVersions)
                .where(and(eq(tables.taskVersions.taskId, created.task.id)))
                .then(([row]) => row!.count),
        ).toBe(1);
        expect(
            await db
                .select({ count: count() })
                .from(tables.runs)
                .where(and(eq(tables.runs.taskId, created.task.id)))
                .then(([row]) => row!.count),
        ).toBe(1);
        expect(
            await db
                .select({ count: count() })
                .from(tables.outbox)
                .where(
                    and(
                        eq(tables.outbox.aggregateId, run.id),
                        eq(tables.outbox.eventType, 'run.enqueue'),
                    ),
                )
                .then(([row]) => row!.count),
        ).toBe(1);
    });

    it('控制接口统一校验 owner、CSRF、If-Match，重复状态幂等且修订冲突不写入', async () => {
        const owner = await register(),
            other = await register();
        const created = await json(
            await request('/api/v1/tasks', {
                method: 'POST',
                headers: authHeaders(owner),
                body: JSON.stringify({ config: config() }),
            }),
        );
        const path = `/api/v1/tasks/${created.task.id}/pause`;
        expect((await request(path, { method: 'POST', headers: authHeaders(owner) })).status).toBe(
            428,
        );
        expect(
            (
                await request(path, {
                    method: 'POST',
                    headers: headers({ cookie: owner.cookie, 'if-match': '"1"' }),
                })
            ).status,
        ).toBe(403);
        expect(
            (
                await request(path, {
                    method: 'POST',
                    headers: authHeaders(other, { 'if-match': '"1"' }),
                })
            ).status,
        ).toBe(404);
        const response = await request(path, {
            method: 'POST',
            headers: authHeaders(owner, { 'if-match': '"1"' }),
        });
        expect(response.status).toBe(200);
        expect(
            (
                await request(path, {
                    method: 'POST',
                    headers: authHeaders(owner, { 'if-match': '"1"' }),
                })
            ).status,
        ).toBe(409);
        const repeated = await request(path, {
            method: 'POST',
            headers: authHeaders(owner, { 'if-match': '"2"' }),
        });
        expect((await json(repeated)).task.revision).toBe(2);
        expect(
            await db
                .select({ count: count() })
                .from(tables.taskVersions)
                .where(and(eq(tables.taskVersions.taskId, created.task.id)))
                .then(([row]) => row!.count),
        ).toBe(1);
    });

    it('非计划编辑保留到期时点，暂停后的计划编辑不重新启用触发', async () => {
        const owner = await register();
        const created = await json(
            await request('/api/v1/tasks', {
                method: 'POST',
                headers: authHeaders(owner),
                body: JSON.stringify({ config: config() }),
            }),
        );
        const due = new Date('2026-10-19T12:00:00Z');
        await db
            .update(tables.tasks)
            .set({ nextRunAt: due })
            .where(and(eq(tables.tasks.id, created.task.id)))
            .returning()
            .then(firstRow);
        const edited = await request(`/api/v1/tasks/${created.task.id}`, {
            method: 'PATCH',
            headers: authHeaders(owner, { 'if-match': '"1"' }),
            body: JSON.stringify({ config: config({ title: '只改标题' }) }),
        });
        expect(edited.status).toBe(200);
        expect((await json(edited)).task.nextRunAt).toBe(due.toISOString());
        await request(`/api/v1/tasks/${created.task.id}/pause`, {
            method: 'POST',
            headers: authHeaders(owner, { 'if-match': '"2"' }),
        });
        const whilePaused = await request(`/api/v1/tasks/${created.task.id}`, {
            method: 'PATCH',
            headers: authHeaders(owner, { 'if-match': '"3"' }),
            body: JSON.stringify({
                config: config({ schedule: { frequency: 'daily', localTime: '09:00' } }),
            }),
        });
        expect(whilePaused.status).toBe(200);
        expect((await json(whilePaused)).task).toMatchObject({
            status: 'paused',
            nextRunAt: null,
            revision: 4,
        });
        expect(
            (
                await db.query.tasks
                    .findFirst({ where: and(eq(tables.tasks.id, created.task.id)) })
                    .then(requireRow)
            ).scheduleRevision,
        ).toBe(3);
    });

    it('清除任务校验归属、CSRF、修订和活动执行，原子清理报告及历史并保留共享来源', async () => {
        const owner = await register(),
            other = await register();
        const user = await json(await request('/api/v1/me', { headers: { cookie: owner.cookie } }));
        const userId = user.user.id;
        const created = await json(
            await request('/api/v1/tasks', {
                method: 'POST',
                headers: authHeaders(owner),
                body: JSON.stringify({ config: config() }),
            }),
        );
        const path = `/api/v1/tasks/${created.task.id}`;
        const remove = (who = owner, revision = '"1"') =>
            request(path, {
                method: 'DELETE',
                headers: authHeaders(who, { 'if-match': revision }),
            });
        expect((await request(path, { method: 'DELETE' })).status).toBe(401);
        expect(
            (
                await request(path, {
                    method: 'DELETE',
                    headers: { cookie: owner.cookie, origin, 'if-match': '"1"' },
                })
            ).status,
        ).toBe(403);
        expect(
            (await request(path, { method: 'DELETE', headers: authHeaders(owner) })).status,
        ).toBe(428);
        expect((await remove(other)).status).toBe(404);
        expect((await remove(owner, '"99"')).status).toBe(409);
        const started = await request(`${path}/runs`, {
            method: 'POST',
            headers: authHeaders(owner, { 'idempotency-key': 'delete-test-run-0001' }),
            body: '{}',
        });
        expect(started.status).toBe(202);
        const run = (await json(started)).run;
        const active = await remove();
        expect(active.status).toBe(409);
        expect((await json(active)).code).toBe('TASK_RUN_ACTIVE');
        await db
            .update(tables.runs)
            .set({
                status: 'partial',
                finishedAt: now,
                coverageJson: {
                    completeness: 'partial',
                    searchedQueries: [],
                    gaps: ['fixture'],
                    exhausted: [],
                },
            })
            .where(eq(tables.runs.id, run.id));
        const [report] = await db
            .insert(tables.reports)
            .values({
                userId,
                runId: run.id,
                taskId: created.task.id,
                taskVersionId: created.version.id,
                title: '删除范围样本',
                summary: '测试',
                format: 'brief',
                completeness: 'partial',
            })
            .returning();
        const [source] = await db
            .insert(tables.sources)
            .values({
                userId,
                canonicalUrl: 'https://example.test/delete-scope',
                canonicalUrlHash: 'a'.repeat(64),
            })
            .returning();
        await db.insert(tables.bookmarks).values({ userId, sourceId: source!.id });
        const [snapshot] = await db
            .insert(tables.sourceSnapshots)
            .values({
                userId,
                sourceId: source!.id,
                contentHash: 'b'.repeat(64),
                extractorVersion: 'fixture',
                title: '共享快照',
                textBody: '保留正文',
            })
            .returning();
        await db.insert(tables.runSources).values({
            userId,
            runId: run.id,
            sourceId: source!.id,
            snapshotId: snapshot!.id,
            requestedUrl: source!.canonicalUrl,
            fetchStatus: 'succeeded',
        });
        const [evidence] = await db
            .insert(tables.evidence)
            .values({
                userId,
                runId: run.id,
                snapshotId: snapshot!.id,
                quote: '保留正文',
                quoteHash: 'c'.repeat(64),
                selectorJson: { start: 0, end: 4 },
            })
            .returning();
        const [claim] = await db
            .insert(tables.claims)
            .values({
                userId,
                taskId: created.task.id,
                reportId: report!.id,
                kind: 'fact',
                text: '样本结论',
                confidenceLabel: '来源陈述',
                order: 0,
            })
            .returning();
        await db
            .insert(tables.claimEvidence)
            .values({ userId, claimId: claim!.id, evidenceId: evidence!.id, relation: 'supports' });
        const [change] = await db
            .insert(tables.changeRecords)
            .values({
                userId,
                reportId: report!.id,
                sourceId: source!.id,
                kind: 'new',
                newSnapshotId: snapshot!.id,
                factKey: 'fixture',
                newValue: '样本',
                importance: 'normal',
                reason: '测试',
            })
            .returning();
        await db
            .insert(tables.changeEvidence)
            .values({ userId, changeRecordId: change!.id, evidenceId: evidence!.id, side: 'new' });
        await db
            .insert(tables.feedback)
            .values({ userId, taskId: created.task.id, claimId: claim!.id, kind: 'known' });
        const storedRun = (await db.query.runs.findFirst({ where: eq(tables.runs.id, run.id) }))!;
        await db.insert(tables.baselines).values({
            userId,
            taskId: created.task.id,
            completeRunId: run.id,
            comparisonScopeHash: storedRun.comparisonScopeHash,
        });
        const [occurrence] = await db
            .insert(tables.scheduleOccurrences)
            .values({
                userId,
                taskId: created.task.id,
                scheduleRevision: 1,
                scheduledAt: now,
                runId: run.id,
            })
            .returning();
        await db
            .update(tables.runs)
            .set({ occurrenceId: occurrence!.id })
            .where(eq(tables.runs.id, run.id));
        await db.insert(tables.runs).values({
            userId,
            taskId: created.task.id,
            taskVersionId: created.version.id,
            comparisonScopeHash: storedRun.comparisonScopeHash,
            mode: 'live',
            trigger: 'retry',
            status: 'failed',
            parentRunId: run.id,
            baselineRunId: run.id,
            budgetJson: config().budget,
        });
        await db.insert(tables.toolCalls).values({
            userId,
            runId: run.id,
            operationKey: 'fixture',
            tool: 'read',
            attemptNo: 1,
            inputSummary: 'fixture',
            reservedBudget: {},
        });
        await db.insert(tables.notes).values([
            { userId, reportId: report!.id, body: '报告笔记' },
            { userId, sourceId: source!.id, body: '来源笔记' },
        ]);
        await db.insert(tables.inboxItems).values({ userId, reportId: report!.id });
        await db
            .insert(tables.notifications)
            .values({ userId, runId: run.id, reportId: report!.id, kind: 'summary' });
        const [question] = await db
            .insert(tables.reportQuestions)
            .values({ userId, reportId: report!.id, question: '问题', followupRunId: run.id })
            .returning();
        await db
            .insert(tables.questionEvidence)
            .values({ userId, questionId: question!.id, evidenceId: evidence!.id });
        const keep = await json(
            await request('/api/v1/tasks', {
                method: 'POST',
                headers: authHeaders(owner),
                body: JSON.stringify({ config: config({ title: '保留任务' }) }),
            }),
        );
        const result = await remove();
        expect(result.status).toBe(204);
        expect(await result.text()).toBe('');
        expect((await request(path, { headers: { cookie: owner.cookie } })).status).toBe(404);
        expect(
            (await request(`/api/v1/tasks/${keep.task.id}`, { headers: { cookie: owner.cookie } }))
                .status,
        ).toBe(200);
        for (const table of [
            tables.runs,
            tables.reports,
            tables.notifications,
            tables.inboxItems,
            tables.reportQuestions,
            tables.outbox,
            tables.idempotencyRecords,
            tables.claims,
            tables.claimEvidence,
            tables.changeRecords,
            tables.changeEvidence,
            tables.evidence,
            tables.questionEvidence,
            tables.runSources,
            tables.toolCalls,
            tables.scheduleOccurrences,
            tables.baselines,
            tables.feedback,
        ])
            expect(await db.select().from(table).where(eq(table.userId, userId))).toHaveLength(0);
        expect(
            await db.select().from(tables.notes).where(eq(tables.notes.userId, userId)),
        ).toMatchObject([{ body: '来源笔记' }]);
        expect(
            await db.select().from(tables.sources).where(eq(tables.sources.userId, userId)),
        ).toHaveLength(1);
        expect(
            await db
                .select()
                .from(tables.sourceSnapshots)
                .where(eq(tables.sourceSnapshots.userId, userId)),
        ).toHaveLength(1);
        expect(
            await db.select().from(tables.bookmarks).where(eq(tables.bookmarks.userId, userId)),
        ).toHaveLength(1);
    });

    it('任务和单次执行选择本人Agent，覆盖冻结、不改变账号默认，重发参数不可变化', async () => {
        const owner = await register(),
            other = await register();
        const getId = async (who: typeof owner) =>
            (await json(await request('/api/v1/me', { headers: { cookie: who.cookie } }))).user
                .id as string;
        const userId = await getId(owner),
            otherId = await getId(other);
        const makeProvider = async (uid: string, name: string, active = false) =>
            (
                await db
                    .insert(tables.agentProviders)
                    .values({
                        userId: uid,
                        name,
                        protocol: 'openai_json',
                        baseUrl: 'https://example.test/v1',
                        model: name,
                        encryptedApiKey: 'fixture-encrypted',
                        active,
                    })
                    .returning()
            )[0]!;
        const a = await makeProvider(userId, 'A', true),
            b = await makeProvider(userId, 'B'),
            foreign = await makeProvider(otherId, 'C');
        const create = (agentProviderId: string) =>
            request('/api/v1/tasks', {
                method: 'POST',
                headers: authHeaders(owner),
                body: JSON.stringify({ config: config({ agentProviderId }) }),
            });
        expect((await create(foreign.id)).status).toBe(422);
        const created = await json(await create(b.id));
        expect(created.version.config.agentProviderId).toBe(b.id);
        const path = `/api/v1/tasks/${created.task.id}/runs`;
        const start = (body: unknown, key: string) =>
            request(path, {
                method: 'POST',
                headers: authHeaders(owner, { 'idempotency-key': `${key}-test-0001` }),
                body: JSON.stringify(body),
            });
        expect((await start({ agentProviderId: foreign.id }, 'foreign-agent')).status).toBe(422);
        const selected = await json(await start({ agentProviderId: a.id }, 'selected-agent'));
        expect(selected.run.status).toBe('queued');
        const row = await db.query.runs.findFirst({ where: eq(tables.runs.id, selected.run.id) });
        expect(row!.followupConfigJson).toMatchObject({ agentProviderId: a.id });
        expect((await start({ agentProviderId: b.id }, 'selected-agent')).status).toBe(409);
        expect((await json(await start({ agentProviderId: a.id }, 'selected-agent'))).run.id).toBe(
            selected.run.id,
        );
        await db
            .update(tables.runs)
            .set({ status: 'failed' })
            .where(eq(tables.runs.id, selected.run.id));
        const defaultRun = await json(await start({ agentProviderId: null }, 'default-agent'));
        const defaultRow = await db.query.runs.findFirst({
            where: eq(tables.runs.id, defaultRun.run.id),
        });
        expect(defaultRow!.followupConfigJson).not.toHaveProperty('agentProviderId');
        expect(
            (await db.query.agentProviders.findFirst({
                where: eq(tables.agentProviders.id, a.id),
            }))!.active,
        ).toBe(true);
        expect(
            (await db.query.taskVersions.findFirst({
                where: eq(tables.taskVersions.id, created.version.id),
            }))!.configJson,
        ).toMatchObject({ agentProviderId: b.id });
        const { activeAgentProvider } = await import('../src/repo/execution/agent-providers.ts');
        expect((await activeAgentProvider(db, userId, b.id))?.id).toBe(b.id);
        expect(await activeAgentProvider(db, userId, foreign.id)).toBeNull();
    });

    it('清除与启动并发由同一任务锁串行，不留下孤立Run', async () => {
        const owner = await register();
        const created = await json(
            await request('/api/v1/tasks', {
                method: 'POST',
                headers: authHeaders(owner),
                body: JSON.stringify({ config: config() }),
            }),
        );
        const path = `/api/v1/tasks/${created.task.id}`;
        const [removed, started] = await Promise.all([
            request(path, { method: 'DELETE', headers: authHeaders(owner, { 'if-match': '"1"' }) }),
            request(`${path}/runs`, {
                method: 'POST',
                headers: authHeaders(owner, { 'idempotency-key': 'delete-start-race' }),
                body: '{}',
            }),
        ]);
        expect([
            [204, 404],
            [409, 202],
        ]).toContainEqual([removed.status, started.status]);
        const task = await db.query.tasks.findFirst({
            where: eq(tables.tasks.id, created.task.id),
        });
        const runs = await db
            .select()
            .from(tables.runs)
            .where(eq(tables.runs.taskId, created.task.id));
        expect(runs).toHaveLength(task ? 1 : 0);
    });

    it('并发计划控制与编辑共享修订互斥，只有一方生效', async () => {
        const owner = await register();
        const created = await json(
            await request('/api/v1/tasks', {
                method: 'POST',
                headers: authHeaders(owner),
                body: JSON.stringify({ config: config() }),
            }),
        );
        const responses = await Promise.all([
            request(`/api/v1/tasks/${created.task.id}/pause`, {
                method: 'POST',
                headers: authHeaders(owner, { 'if-match': '"1"' }),
            }),
            request(`/api/v1/tasks/${created.task.id}`, {
                method: 'PATCH',
                headers: authHeaders(owner, { 'if-match': '"1"' }),
                body: JSON.stringify({ config: config({ title: '并发修改' }) }),
            }),
        ]);
        expect(responses.map((response) => response.status).sort((a, b) => a - b)).toEqual([
            200, 409,
        ]);
        expect(
            (
                await db.query.tasks
                    .findFirst({ where: and(eq(tables.tasks.id, created.task.id)) })
                    .then(requireRow)
            ).revision,
        ).toBe(2);
    });
});
