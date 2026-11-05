import { sql as querySql } from '@scova/db';
import { migrateDatabase } from '@scova/db/migrate';
import { createDatabaseClient, connectDatabase, closeDatabase, and, eq, count } from '@scova/db';
import * as tables from '@scova/db';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Redis as RedisClient } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { createApiApp } from '../src/app/index.ts';
import { type CallContext, type StructuredInput, type ModelProvider } from '@scova/connectors';
import {
    createDefaultServices,
    type ApiServiceOverrides,
    type ApiServices,
} from '../src/app/services.ts';
import type { TaskConfig } from '@scova/models';
import { effectiveRunScopeHash } from '@scova/shared';
import { createReportQuestionService } from '../src/service/report-questions.ts';
import { comparisonScopeHash } from '../src/service/tasks.ts';
import { nodeScriptCommand } from '../../../scripts/process-runtime.mjs';
import { firstRow, requireRow } from '../src/utils/database.ts';

const baseUrl =
    process.env.SCOVA_TEST_DATABASE_URL ??
    process.env.RUNTIME_DATABASE_URL ??
    'postgresql://scova_test:scova_test@127.0.0.1:55432/scova_test';
const redisUrl =
    process.env.SCOVA_TEST_REDIS_URL ?? process.env.RUNTIME_REDIS_URL ?? 'redis://127.0.0.1:56379';
const schema = `scova_questions_${randomUUID().replaceAll('-', '')}`;
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
let app: ReturnType<typeof createApiApp>;
let services: ApiServices;
let now: Date;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const config: TaskConfig = {
    title: '官方资讯',
    topic: '来源证据',
    goal: '查阅官方原文',
    focusPoints: ['原文'],
    exclusions: [],
    sourcePreferences: { preferredUrls: [], excludedUrls: [], officialOnly: false },
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
};
type Auth = { cookie: string; csrf: string; userId: string };
const json = async (response: Response) => (await response.json()) as Record<string, any>;
const headers = (auth?: Auth) => ({
    origin,
    'content-type': 'application/json',
    ...(auth ? { cookie: auth.cookie, 'x-csrf-token': auth.csrf } : {}),
});
const request = (path: string, init: RequestInit = {}) =>
    app.handle(new Request(`${origin}/api/v1${path}`, init));
async function register(): Promise<Auth> {
    const response = await request('/auth/register', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
            email: `${randomUUID()}@example.test`,
            password: 'correct horse battery staple',
            defaultTimezone: 'UTC',
        }),
    });
    expect(response.status).toBe(201);
    const body = await json(response);
    return {
        cookie: response.headers.get('set-cookie')!.split(';')[0]!,
        csrf: body.csrfToken,
        userId: body.user.id,
    };
}
async function task(auth: Auth) {
    const response = await request('/tasks', {
        method: 'POST',
        headers: headers(auth),
        body: JSON.stringify({ config }),
    });
    expect(response.status).toBe(201);
    return (await json(response)).task as { id: string; currentVersionId: string };
}
async function fixture(
    auth: Auth,
    existingTask?: { id: string; currentVersionId: string },
    index = 0,
) {
    const ownedTask = existingTask ?? (await task(auth));
    const coverage = {
        completeness: 'partial',
        searchedQueries: ['官方资讯'],
        gaps: ['发布时间尚未核验'],
        exhausted: [],
    };
    const run = await db
        .insert(tables.runs)
        .values({
            userId: auth.userId,
            taskId: ownedTask.id,
            taskVersionId: ownedTask.currentVersionId,
            comparisonScopeHash: sha('scope'),
            mode: 'demo',
            trigger: 'manual',
            status: 'partial',
            budgetJson: config.budget,
            usageJson: {},
            outcome: 'inconclusive',
            coverageJson: coverage,
        })
        .returning()
        .then(firstRow);
    const url = `https://example.com/${randomUUID()}`;
    const text = '这是完整采集正文。活动日期尚需确认。';
    const quote = text.slice(0, 9);
    const source = await db
        .insert(tables.sources)
        .values({ userId: auth.userId, canonicalUrl: url, canonicalUrlHash: sha(url) })
        .returning()
        .then(firstRow);
    const snapshot = await db
        .insert(tables.sourceSnapshots)
        .values({
            userId: auth.userId,
            sourceId: source.id,
            title: '来源页面',
            contentHash: sha(text),
            extractorVersion: 'reader-v1',
            textBody: text,
            textExpiresAt: new Date('2026-10-27T00:00:00Z'),
            metadataJson: {
                mode: 'demo',
                originalUrl: url,
                fetchedUrl: url,
                collectedAt: now.toISOString(),
                truncated: false,
                untrusted: true,
            },
        })
        .returning()
        .then(firstRow);
    await db
        .insert(tables.runSources)
        .values({
            userId: auth.userId,
            runId: run.id,
            sourceId: source.id,
            snapshotId: snapshot.id,
            requestedUrl: `${url}?original=1`,
            fetchedUrl: url,
            observedAt: now,
            fetchStatus: 'succeeded',
            metadataJson: { mode: 'demo', truncated: false },
        })
        .returning()
        .then(firstRow);
    const evidence = await db
        .insert(tables.evidence)
        .values({
            userId: auth.userId,
            runId: run.id,
            snapshotId: snapshot.id,
            quote: quote,
            quoteHash: sha(quote),
            selectorJson: {
                type: 'text_offset',
                start: 0,
                end: quote.length,
                extractorVersion: 'reader-v1',
            },
        })
        .returning()
        .then(firstRow);
    const report = await db
        .insert(tables.reports)
        .values({
            userId: auth.userId,
            runId: run.id,
            taskId: ownedTask.id,
            taskVersionId: ownedTask.currentVersionId,
            title: '原文简报',
            summary: '已经采集来源，仍存在核验缺口',
            format: 'brief',
            completeness: 'partial',
            limitationsJson: ['演示资料', '发布时间尚未核验'],
            publishedAt: new Date(now.getTime() + index * 1000),
        })
        .returning()
        .then(firstRow);
    const claim = await db
        .insert(tables.claims)
        .values({
            userId: auth.userId,
            taskId: ownedTask.id,
            reportId: report.id,
            kind: 'fact',
            text: quote,
            confidenceLabel: '来自原文',
            order: 0,
        })
        .returning()
        .then(firstRow);
    const citation = await db
        .insert(tables.claimEvidence)
        .values({
            userId: auth.userId,
            claimId: claim.id,
            evidenceId: evidence.id,
            relation: 'supports',
        })
        .returning()
        .then(firstRow);
    const inbox = await db
        .insert(tables.inboxItems)
        .values({ userId: auth.userId, reportId: report.id, createdAt: report.publishedAt })
        .returning()
        .then(firstRow);
    return {
        task: ownedTask,
        run,
        source,
        snapshot,
        evidence,
        report,
        claim,
        citation,
        inbox,
        quote,
        url,
    };
}

let calls = 0;
let model: ModelProvider | null = null;
function configure(overrides: ApiServiceOverrides = {}) {
    services = createDefaultServices({
        db: () => db,
        redis: () => redis,
        origin,
        production: false,
        clock: () => now,
        reportQuestionModel: () => model,
        rateLimit: {
            keyPrefix: 'questions:auth:' + randomUUID() + ':',
            globalAttempts: 1000,
            registerAttempts: 100,
            loginAttempts: 100,
        },
        ...overrides,
        reportQuestionPolicy: {
            keyPrefix: 'questions:budget:' + randomUUID() + ':',
            ...overrides.reportQuestionPolicy,
        },
    });
    app = createApiApp('node', services);
}
function modelFixture(data: unknown): ModelProvider {
    return {
        async generateStructured<T>(input: StructuredInput, context: CallContext = {}) {
            await context.beforeAttempt?.('model');
            calls++;
            const output = typeof data === 'function' ? await data(input) : data;
            return {
                data: output as T,
                mode: 'live',
                usage: { inputTokens: 50, outputTokens: 50, estimated: false },
            };
        },
    };
}
const ask = (
    auth: Auth,
    reportId: string,
    question = '活动日期是什么？',
    key = randomUUID(),
    signal?: AbortSignal,
) =>
    request(`/reports/${reportId}/questions`, {
        method: 'POST',
        headers: { ...headers(auth), 'idempotency-key': key },
        body: JSON.stringify({ question }),
        signal,
    });
const follow = (auth: Auth, reportId: string, id: string, key = randomUUID(), confirm = true) =>
    request(`/reports/${reportId}/questions/${id}/followup`, {
        method: 'POST',
        headers: { ...headers(auth), 'idempotency-key': key },
        body: JSON.stringify({ confirm }),
    });
function answer(evidenceId: string, quote: string) {
    return {
        statements: [{ text: quote, citations: [{ evidenceId, quote }] }],
        needsResearch: false,
    };
}
function executeQuestionRun(runId: string, phase: 'complete' | 'fail' = 'complete') {
    const command = nodeScriptCommand('tests/support/question-followup-process.ts', [runId, phase]);
    const stdout = execFileSync(command.executable, command.args, {
        cwd: fileURLToPath(new URL('../../worker/', import.meta.url)),
        env: { ...process.env, DATABASE_URL: scopedUrl.toString() },
        encoding: 'utf8',
        windowsHide: true,
        timeout: 40_000,
    });
    return JSON.parse(stdout.trim().split(/\r?\n/).at(-1)!) as {
        pid: number;
        result: string;
        observed: { config: TaskConfig; budget: TaskConfig['budget']; taskVersionId: string };
        queries: string[];
        prompts: string[];
        run: {
            id: string;
            status: string;
            failureCode: string | null;
            baselineRunId: string | null;
            comparisonScopeHash: string;
        };
        reportId: string | null;
    };
}
async function liveFixture(auth: Auth, goal: string, complete = false) {
    const f = await fixture(auth);
    const original = { ...config, focusPoints: [], goal };
    const semanticScope = comparisonScopeHash(original);
    const scope = effectiveRunScopeHash(semanticScope, 'live');
    await db
        .update(tables.taskVersions)
        .set({ configJson: original, comparisonScopeHash: semanticScope })
        .where(and(eq(tables.taskVersions.id, f.task.currentVersionId)))
        .returning()
        .then(firstRow);
    const coverage = {
        completeness: complete ? 'complete' : 'partial',
        searchedQueries: [goal],
        gaps: complete ? [] : ['测试样例'],
        exhausted: [],
    };
    const liveRun = await db
        .update(tables.runs)
        .set({
            mode: 'live',
            comparisonScopeHash: scope,
            status: complete ? 'succeeded' : 'partial',
            outcome: complete ? 'baseline' : 'inconclusive',
            coverageJson: coverage,
        })
        .where(and(eq(tables.runs.id, f.run.id)))
        .returning()
        .then(firstRow);
    await db
        .update(tables.runSources)
        .set({ metadataJson: { mode: 'live', truncated: false } })
        .where(and(eq(tables.runSources.runId, f.run.id)))
        .returning()
        .then((rows) => ({ count: rows.length }));
    const liveReport = await db
        .update(tables.reports)
        .set({
            completeness: complete ? 'complete' : 'partial',
            limitationsJson: complete ? [] : ['测试样例'],
        })
        .where(and(eq(tables.reports.id, f.report.id)))
        .returning()
        .then(firstRow);
    return { ...f, run: liveRun, report: liveReport, config: original, scope };
}
describe('报告证据问答与明确确认后续研究', () => {
    beforeAll(async () => {
        await admin.connect();
        await admin.query(`CREATE SCHEMA "${schema}"`);
        schemaCreated = true;
        await migrateDatabase({ connectionString: scopedUrl.toString() });
        await connectDatabase(db);
        await redis.connect();
    }, 120000);
    beforeEach(() => {
        now = new Date('2026-10-26T00:00:00Z');
        calls = 0;
        model = null;
        configure();
    });
    afterAll(async () => {
        await closeDatabase(db);
        if (redis.status === 'wait' || redis.status === 'end') redis.disconnect();
        else await redis.quit();
        if (schemaCreated) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.end();
    });
    it('引用授权报告原文，GET与幂等重放均不再调用模型或创建执行', async () => {
        const a = await register(),
            f = await fixture(a);
        model = modelFixture(answer(f.evidence.id, f.quote));
        const key = randomUUID();
        const response = await ask(a, f.report.id, '原文说了什么？', key);
        expect(response.status).toBe(201);
        const q = await json(response);
        expect(q.answer.status).toBe('answered');
        expect(q.answer.statements[0].citations).toEqual([
            { evidenceId: f.evidence.id, quote: f.quote },
        ]);
        expect(q.answer.usage).toMatchObject({
            attempts: 1,
            inputTokens: 50,
            outputTokens: 50,
            estimated: false,
        });
        expect((await ask(a, f.report.id, '原文说了什么？', key)).status).toBe(201);
        expect(
            (await request(`/reports/${f.report.id}/questions/${q.id}`, { headers: headers(a) }))
                .status,
        ).toBe(200);
        expect(calls).toBe(1);
        expect(
            await db
                .select({ count: count() })
                .from(tables.questionEvidence)
                .where(and(eq(tables.questionEvidence.questionId, q.id)))
                .then(([row]) => row!.count),
        ).toBe(1);
        expect(
            await db
                .select({ count: count() })
                .from(tables.runs)
                .where(and(eq(tables.runs.taskId, f.task.id)))
                .then(([row]) => row!.count),
        ).toBe(1);
        expect(
            await db
                .select({ count: count() })
                .from(tables.outbox)
                .where(and(eq(tables.outbox.userId, a.userId)))
                .then(([row]) => row!.count),
        ).toBe(0);
    });
    it('缺模型或现有证据无法回答时明确不足，无搜索或Run副作用', async () => {
        const a = await register(),
            f = await fixture(a);
        expect((await json(await ask(a, f.report.id))).answer).toMatchObject({
            status: 'insufficient',
            reason: 'model_unavailable',
            usage: { attempts: 0 },
        });
        model = modelFixture({ statements: [], needsResearch: true });
        const response = await ask(a, f.report.id, '原文没有记载的活动奖励是什么？');
        expect(response.status).toBe(201);
        expect((await json(response)).answer).toMatchObject({
            reason: 'insufficient_evidence',
            statements: [],
            needsResearch: true,
            usage: { attempts: 1 },
        });
        expect(calls).toBe(1);
        expect(
            await db
                .select({ count: count() })
                .from(tables.runs)
                .where(and(eq(tables.runs.taskId, f.task.id)))
                .then(([row]) => row!.count),
        ).toBe(1);
    });
    it('他人报告/问题及同账号不同报告路径都404，不消耗模型', async () => {
        const a = await register(),
            b = await register(),
            f = await fixture(a),
            other = await fixture(a);
        const q = await json(await ask(a, f.report.id));
        expect((await ask(b, f.report.id)).status).toBe(404);
        expect(
            (
                await request(`/reports/${other.report.id}/questions/${q.id}`, {
                    headers: headers(a),
                })
            ).status,
        ).toBe(404);
        expect((await follow(b, f.report.id, q.id)).status).toBe(404);
        expect(calls).toBe(0);
    });
    it('同owner其它报告引用、外人引用或伪造原文不能进入回答或QuestionEvidence', async () => {
        const a = await register(),
            b = await register(),
            f = await fixture(a),
            same = await fixture(a),
            foreign = await fixture(b);
        for (const data of [
            answer(same.evidence.id, same.quote),
            answer(foreign.evidence.id, foreign.quote),
            answer(f.evidence.id, '不存在的免费奖励'),
        ]) {
            model = modelFixture(data);
            const q = await json(await ask(a, f.report.id));
            expect(q.answer).toMatchObject({
                status: 'insufficient',
                reason: 'invalid_output',
                statements: [],
            });
            expect(
                await db
                    .select({ count: count() })
                    .from(tables.questionEvidence)
                    .where(and(eq(tables.questionEvidence.questionId, q.id)))
                    .then(([row]) => row!.count),
            ).toBe(0);
        }
    });
    it('必须会话/CSRF/稳定key，问题不接受额外目标或空白', async () => {
        const a = await register(),
            f = await fixture(a);
        const path = `/reports/${f.report.id}/questions`;
        expect(
            (
                await request(path, {
                    method: 'POST',
                    headers: headers(),
                    body: JSON.stringify({ question: '问' }),
                })
            ).status,
        ).toBe(401);
        expect(
            (
                await request(path, {
                    method: 'POST',
                    headers: { ...headers(), cookie: a.cookie },
                    body: JSON.stringify({ question: '问' }),
                })
            ).status,
        ).toBe(403);
        expect(
            (
                await request(path, {
                    method: 'POST',
                    headers: headers(a),
                    body: JSON.stringify({ question: '问' }),
                })
            ).status,
        ).toBe(428);
        expect((await ask(a, f.report.id, '   ')).status).toBe(422);
        expect(
            (
                await request(path, {
                    method: 'POST',
                    headers: { ...headers(a), 'idempotency-key': randomUUID() },
                    body: JSON.stringify({ question: '问', sourceId: randomUUID() }),
                })
            ).status,
        ).toBe(422);
    });
    it('相同key不同问题409；并发相同key至多一次供应商调用', async () => {
        const a = await register(),
            f = await fixture(a);
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        let entered!: () => void;
        const ready = new Promise<void>((resolve) => (entered = resolve));
        model = modelFixture(async () => {
            entered();
            await gate;
            return answer(f.evidence.id, f.quote);
        });
        const key = randomUUID();
        const first = ask(a, f.report.id, '问题A', key);
        await ready;
        expect((await ask(a, f.report.id, '问题A', key)).status).toBe(409);
        expect((await ask(a, f.report.id, '问题B', key)).status).toBe(409);
        release();
        expect((await first).status).toBe(201);
        expect(calls).toBe(1);
    });
    it('独立用户请求额度429，草稿预算与其他owner不受影响', async () => {
        configure({ reportQuestionPolicy: { userRequests: 1 } });
        const a = await register(),
            b = await register(),
            f = await fixture(a),
            other = await fixture(b);
        expect((await ask(a, f.report.id)).status).toBe(201);
        const limited = await ask(a, f.report.id);
        expect(limited.status).toBe(429);
        expect(limited.headers.get('retry-after')).toBeTruthy();
        expect((await ask(b, other.report.id)).status).toBe(201);
        expect(
            (
                await request('/task-drafts', {
                    method: 'POST',
                    headers: headers(a),
                    body: JSON.stringify({ inputText: '关注新闻' }),
                })
            ).status,
        ).toBe(200);
    });
    it('attempt限额在模型出站前预留，失败保留预算且不自动重试', async () => {
        configure({ reportQuestionPolicy: { userAttempts: 1 } });
        const a = await register(),
            f = await fixture(a);
        model = modelFixture(() => {
            throw new Error('private provider credential');
        });
        const first = await json(await ask(a, f.report.id));
        expect(first.answer).toMatchObject({
            reason: 'model_failed',
            usage: { attempts: 1, estimated: true },
        });
        expect(JSON.stringify(first)).not.toContain('credential');
        expect((await ask(a, f.report.id)).status).toBe(429);
        expect(calls).toBe(1);
    });
    it('取消或撤销会话的晚返回不保存事实回答', async () => {
        const a = await register(),
            f = await fixture(a);
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        let entered!: () => void;
        const ready = new Promise<void>((resolve) => (entered = resolve));
        model = modelFixture(async () => {
            entered();
            await gate;
            return answer(f.evidence.id, f.quote);
        });
        const controller = new AbortController();
        const pending = ask(a, f.report.id, '问题', randomUUID(), controller.signal);
        await ready;
        controller.abort();
        release();
        const response = await pending;
        expect(response.status).toBe(201);
        expect((await json(response)).answer).toMatchObject({ reason: 'aborted', statements: [] });
        expect(
            await db
                .select({ count: count() })
                .from(tables.questionEvidence)
                .where(and(eq(tables.questionEvidence.userId, a.userId)))
                .then(([row]) => row!.count),
        ).toBe(0);
    });
    it('历史演示报告可读取，但后续研究返回409且不写Outbox', async () => {
        const a = await register(),
            f = await fixture(a);
        const q = await json(await ask(a, f.report.id));
        const response = await follow(a, f.report.id, q.id);
        expect(response.status).toBe(409);
        expect((await json(response)).code).toBe('LEGACY_DEMO_RUN');
        expect((await request(`/reports/${f.report.id}`, { headers: headers(a) })).status).toBe(
            200,
        );
        expect(
            await db.select().from(tables.outbox).where(eq(tables.outbox.userId, a.userId)),
        ).toHaveLength(0);
    });
    it('confirm=false不启动；确认后固定问题配置、mode和预算且不覆盖原报告/TaskVersion', async () => {
        const a = await register(),
            f = await liveFixture(a, '核对活动日期');
        const q = await json(await ask(a, f.report.id, '请进一步核对活动日期'));
        expect((await follow(a, f.report.id, q.id, randomUUID(), false)).status).toBe(422);
        const key = randomUUID(),
            response = await follow(a, f.report.id, q.id, key);
        expect(response.status).toBe(202);
        const result = await json(response);
        expect(result.run).toMatchObject({
            trigger: 'followup',
            parentRunId: f.run.id,
            mode: f.run.mode,
            budget: config.budget,
        });
        const stored = await db.query.runs
            .findFirst({ where: and(eq(tables.runs.id, result.run.id)) })
            .then(requireRow);
        expect(stored.followupConfigJson).toMatchObject({
            goal: q.question,
            schedule: { frequency: 'manual' },
            budget: config.budget,
        });
        expect(stored.comparisonScopeHash).not.toBe(f.run.comparisonScopeHash);
        expect(
            (
                await db.query.reportQuestions
                    .findFirst({ where: and(eq(tables.reportQuestions.id, q.id)) })
                    .then(requireRow)
            ).followupRunId,
        ).toBe(stored.id);
        expect(
            await db
                .select({ count: count() })
                .from(tables.runEvents)
                .where(and(eq(tables.runEvents.runId, stored.id)))
                .then(([row]) => row!.count),
        ).toBe(1);
        expect(
            await db
                .select({ count: count() })
                .from(tables.outbox)
                .where(and(eq(tables.outbox.aggregateId, stored.id)))
                .then(([row]) => row!.count),
        ).toBe(1);
        const replay = await json(await follow(a, f.report.id, q.id, key));
        const fresh = await json(await follow(a, f.report.id, q.id));
        expect(replay.run.id).toBe(stored.id);
        expect(fresh.run.id).toBe(stored.id);
        expect(
            await db.query.reports
                .findFirst({ where: and(eq(tables.reports.id, f.report.id)) })
                .then(requireRow),
        ).toEqual(f.report);
        expect(
            (
                await db.query.tasks
                    .findFirst({ where: and(eq(tables.tasks.id, f.task.id)) })
                    .then(requireRow)
            ).currentVersionId,
        ).toBe(f.task.currentVersionId);
    });
    it('活动Run互斥与归档规则，失败不留关联Run或Outbox', async () => {
        const a = await register(),
            f = await liveFixture(a, '核对活动日期');
        const q = await json(await ask(a, f.report.id));
        const active = await request(`/tasks/${f.task.id}/runs`, {
            method: 'POST',
            headers: { ...headers(a), 'idempotency-key': randomUUID() },
            body: '{}',
        });
        expect(active.status).toBe(202);
        expect((await follow(a, f.report.id, q.id)).status).toBe(409);
        expect(
            (
                await db.query.reportQuestions
                    .findFirst({ where: and(eq(tables.reportQuestions.id, q.id)) })
                    .then(requireRow)
            ).followupRunId,
        ).toBeNull();
        await db
            .update(tables.runs)
            .set({ status: 'canceled' })
            .where(and(eq(tables.runs.taskId, f.task.id), eq(tables.runs.status, 'queued')))
            .returning()
            .then((rows) => ({ count: rows.length }));
        await db
            .update(tables.tasks)
            .set({ status: 'archived' })
            .where(and(eq(tables.tasks.id, f.task.id)))
            .returning()
            .then(firstRow);
        expect((await follow(a, f.report.id, q.id)).status).toBe(409);
    });
    it('Outbox写失败时回滚Run/首事件/问题链接/幂等，重试可成功', async () => {
        const a = await register(),
            f = await liveFixture(a, '核对活动日期');
        const q = await json(await ask(a, f.report.id));
        const key = randomUUID();
        await db.execute(
            querySql.raw(
                `ALTER TABLE outbox ADD CONSTRAINT question_test_failure CHECK (event_type <> 'run.enqueue') NOT VALID`,
            ),
        );
        try {
            expect((await follow(a, f.report.id, q.id, key)).status).toBe(500);
            expect(
                (
                    await db.query.reportQuestions
                        .findFirst({ where: and(eq(tables.reportQuestions.id, q.id)) })
                        .then(requireRow)
                ).followupRunId,
            ).toBeNull();
            expect(
                await db
                    .select({ count: count() })
                    .from(tables.runs)
                    .where(and(eq(tables.runs.taskId, f.task.id)))
                    .then(([row]) => row!.count),
            ).toBe(1);
        } finally {
            await db.execute(
                querySql.raw('ALTER TABLE outbox DROP CONSTRAINT question_test_failure'),
            );
        }
        expect((await follow(a, f.report.id, q.id, key)).status).toBe(202);
    });
    it('重新授权等待期间取消也只保存aborted，不保存事实或引用', async () => {
        const a = await register(),
            f = await fixture(a);
        model = modelFixture(answer(f.evidence.id, f.quote));
        let entered!: () => void, release!: () => void;
        const ready = new Promise<void>((resolve) => {
            entered = resolve;
        });
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const controller = new AbortController();
        const pending = createReportQuestionService(services).create(
            a.userId,
            f.report.id,
            { question: '原文说了什么？' },
            randomUUID(),
            controller.signal,
            async () => {
                entered();
                await gate;
            },
        );
        await ready;
        controller.abort();
        release();
        const question = await pending;
        expect(question.answer).toMatchObject({
            reason: 'aborted',
            statements: [],
            usage: { attempts: 1 },
        });
        expect(calls).toBe(1);
        expect(
            await db
                .select({ count: count() })
                .from(tables.questionEvidence)
                .where(and(eq(tables.questionEvidence.questionId, question.id)))
                .then(([row]) => row!.count),
        ).toBe(0);
        expect(
            (
                await db.query.reportQuestions
                    .findFirst({ where: and(eq(tables.reportQuestions.id, question.id)) })
                    .then(requireRow)
            ).answerJson,
        ).toMatchObject({ reason: 'aborted', statements: [] });
    });
    it('相同goal且空focus的followup真实执行不读取或推进普通基线', async () => {
        const a = await register(),
            f = await liveFixture(a, '核对公告申请截止日期', true);
        const ordinary = await db
            .insert(tables.baselines)
            .values({
                userId: a.userId,
                taskId: f.task.id,
                comparisonScopeHash: f.scope,
                completeRunId: f.run.id,
            })
            .returning()
            .then(firstRow);
        const originalReport = await db.query.reports
            .findFirst({ where: and(eq(tables.reports.id, f.report.id)) })
            .then(requireRow);
        const q = await json(await ask(a, f.report.id, f.config.goal));
        const response = await follow(a, f.report.id, q.id);
        expect(response.status).toBe(202);
        const result = await json(response);
        const created = await db.query.runs
            .findFirst({ where: and(eq(tables.runs.id, result.run.id)) })
            .then(requireRow);
        expect(created.comparisonScopeHash).not.toBe(f.scope);
        expect(created.followupConfigJson).toMatchObject({ goal: f.config.goal, focusPoints: [] });
        const execution = executeQuestionRun(created.id);
        expect(execution.pid).not.toBe(process.pid);
        expect(execution.result).toBe('processed');
        expect(execution.observed.config).toMatchObject({ goal: f.config.goal, focusPoints: [] });
        expect(execution.queries).toEqual([f.config.goal]);
        expect(execution.run).toMatchObject({
            status: 'succeeded',
            baselineRunId: null,
            comparisonScopeHash: created.comparisonScopeHash,
        });
        expect(execution.reportId).toBeTruthy();
        expect(
            await db.query.baselines
                .findFirst({ where: and(eq(tables.baselines.id, ordinary.id)) })
                .then(requireRow),
        ).toMatchObject({
            completeRunId: f.run.id,
        });
        expect(
            await db.query.baselines
                .findFirst({
                    where: and(
                        and(
                            eq(tables.baselines.userId, a.userId),
                            eq(tables.baselines.taskId, f.task.id),
                            eq(tables.baselines.comparisonScopeHash, created.comparisonScopeHash),
                        ),
                    ),
                })
                .then(requireRow),
        ).toMatchObject({ completeRunId: created.id });
        expect(
            await db.query.reports
                .findFirst({ where: and(eq(tables.reports.id, f.report.id)) })
                .then(requireRow),
        ).toEqual(originalReport);
        const delivered = await request(`/reports/${execution.reportId}`, { headers: headers(a) });
        expect(delivered.status).toBe(200);
        expect((await json(delivered)).evidence[0].quote).toContain('十一月十五日');
    }, 60_000);
    it('Task改版后followup失败重试仍以原问题config/预算/scope真实完成交付', async () => {
        const a = await register(),
            f = await liveFixture(a, '原任务目标');
        const questionText = '进一步核对申请日期 question-followup-regression';
        const q = await json(await ask(a, f.report.id, questionText));
        const followed = await follow(a, f.report.id, q.id);
        expect(followed.status).toBe(202);
        const first = (await json(followed)).run;
        const frozen = await db.query.runs
            .findFirst({ where: and(eq(tables.runs.id, first.id)) })
            .then(requireRow);
        const edited = await request(`/tasks/${f.task.id}`, {
            method: 'PATCH',
            headers: { ...headers(a), 'if-match': '"1"' },
            body: JSON.stringify({
                config: {
                    ...f.config,
                    goal: '已改版且不应执行的目标',
                    budget: { ...f.config.budget, maxSearches: 1 },
                },
            }),
        });
        expect(edited.status).toBe(200);
        const failed = executeQuestionRun(first.id, 'fail');
        expect(failed.run).toMatchObject({ status: 'failed', failureCode: 'NO_EVIDENCE' });
        expect(failed.reportId).toBeNull();
        expect(failed.observed.config.goal).toBe(questionText);
        const response = await request(`/runs/${first.id}/retry`, {
            method: 'POST',
            headers: { ...headers(a), 'idempotency-key': randomUUID() },
            body: JSON.stringify({ mode: 'live' }),
        });
        expect(response.status).toBe(202);
        const retried = (await json(response)).run;
        const stored = await db.query.runs
            .findFirst({ where: and(eq(tables.runs.id, retried.id)) })
            .then(requireRow);
        expect(stored).toMatchObject({
            taskVersionId: f.task.currentVersionId,
            parentRunId: first.id,
            trigger: 'retry',
            comparisonScopeHash: frozen.comparisonScopeHash,
            followupConfigJson: frozen.followupConfigJson,
            budgetJson: frozen.budgetJson,
        });
        const execution = executeQuestionRun(stored.id);
        expect(execution.pid).not.toBe(process.pid);
        expect(execution.observed).toMatchObject({
            config: { goal: questionText, focusPoints: [] },
            budget: f.config.budget,
            taskVersionId: f.task.currentVersionId,
        });
        expect(execution.queries).toEqual([questionText]);
        expect(execution.prompts.some((prompt) => prompt.includes(questionText))).toBe(true);
        expect(execution.prompts.some((prompt) => prompt.includes('已改版且不应执行的目标'))).toBe(
            false,
        );
        expect(execution.run).toMatchObject({
            status: 'succeeded',
            baselineRunId: null,
            comparisonScopeHash: frozen.comparisonScopeHash,
        });
        expect(
            await db
                .select({ count: count() })
                .from(tables.reports)
                .where(and(eq(tables.reports.runId, first.id)))
                .then(([row]) => row!.count),
        ).toBe(0);
        expect(
            await db
                .select({ count: count() })
                .from(tables.reports)
                .where(and(eq(tables.reports.runId, stored.id)))
                .then(([row]) => row!.count),
        ).toBe(1);
        expect(
            await db.query.reports
                .findFirst({ where: and(eq(tables.reports.id, f.report.id)) })
                .then(requireRow),
        ).toMatchObject({
            runId: f.run.id,
        });
    }, 90_000);
});
