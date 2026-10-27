import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@scova/models';
import { Redis as RedisClient } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { createApiApp } from '../src/app/index.ts';
import { type CallContext, type StructuredInput, type ModelProvider } from '@scova/connectors';
import {
    createDefaultServices,
    type ApiServiceOverrides,
    type ApiServices,
} from '../src/app/context.ts';
import type { TaskConfig } from '@scova/contracts';
import { effectiveRunScopeHash } from '@scova/shared';
import { createReportQuestionService } from '../src/service/report-questions.ts';
import { comparisonScopeHash } from '../src/service/tasks.ts';
import { nodeScriptCommand } from '../../../scripts/process-runtime.mjs';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../../', import.meta.url));
const baseUrl =
    process.env.SCOVA_TEST_DATABASE_URL ??
    process.env.RUNTIME_DATABASE_URL ??
    'postgresql://scova_test:scova_test@127.0.0.1:55432/scova_test';
const redisUrl =
    process.env.SCOVA_TEST_REDIS_URL ?? process.env.RUNTIME_REDIS_URL ?? 'redis://127.0.0.1:56379';
const schema = `scova_questions_${randomUUID().replaceAll('-', '')}`;
const scopedUrl = new URL(baseUrl);
scopedUrl.searchParams.set('schema', schema);
const prisma = new PrismaClient({ datasources: { db: { url: scopedUrl.toString() } } });
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
    const run = await prisma.run.create({
        data: {
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
        },
    });
    const url = `https://example.com/${randomUUID()}`;
    const text = '这是完整采集正文。活动日期尚需确认。';
    const quote = text.slice(0, 9);
    const source = await prisma.source.create({
        data: { userId: auth.userId, canonicalUrl: url, canonicalUrlHash: sha(url) },
    });
    const snapshot = await prisma.sourceSnapshot.create({
        data: {
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
        },
    });
    await prisma.runSource.create({
        data: {
            userId: auth.userId,
            runId: run.id,
            sourceId: source.id,
            snapshotId: snapshot.id,
            requestedUrl: `${url}?original=1`,
            fetchedUrl: url,
            observedAt: now,
            fetchStatus: 'succeeded',
            metadataJson: { mode: 'demo', truncated: false },
        },
    });
    const evidence = await prisma.evidence.create({
        data: {
            userId: auth.userId,
            runId: run.id,
            snapshotId: snapshot.id,
            quote,
            quoteHash: sha(quote),
            selectorJson: {
                type: 'text_offset',
                start: 0,
                end: quote.length,
                extractorVersion: 'reader-v1',
            },
        },
    });
    const report = await prisma.report.create({
        data: {
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
        },
    });
    const claim = await prisma.claim.create({
        data: {
            userId: auth.userId,
            taskId: ownedTask.id,
            reportId: report.id,
            kind: 'fact',
            text: quote,
            confidenceLabel: '来自原文',
            order: 0,
        },
    });
    const citation = await prisma.claimEvidence.create({
        data: {
            userId: auth.userId,
            claimId: claim.id,
            evidenceId: evidence.id,
            relation: 'supports',
        },
    });
    const inbox = await prisma.inboxItem.create({
        data: { userId: auth.userId, reportId: report.id, createdAt: report.publishedAt },
    });
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
        db: () => prisma,
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
    await prisma.taskVersion.update({
        where: { id: f.task.currentVersionId },
        data: { configJson: original, comparisonScopeHash: semanticScope },
    });
    const coverage = {
        completeness: complete ? 'complete' : 'partial',
        searchedQueries: [goal],
        gaps: complete ? [] : ['测试样例'],
        exhausted: [],
    };
    await prisma.run.update({
        where: { id: f.run.id },
        data: {
            mode: 'live',
            comparisonScopeHash: scope,
            status: complete ? 'succeeded' : 'partial',
            outcome: complete ? 'baseline' : 'inconclusive',
            coverageJson: coverage,
        },
    });
    await prisma.runSource.updateMany({
        where: { runId: f.run.id },
        data: { metadataJson: { mode: 'live', truncated: false } },
    });
    await prisma.report.update({
        where: { id: f.report.id },
        data: {
            completeness: complete ? 'complete' : 'partial',
            limitationsJson: complete ? [] : ['测试样例'],
        },
    });
    return { ...f, config: original, scope };
}
describe('报告证据问答与明确确认后续研究', () => {
    beforeAll(async () => {
        await admin.connect();
        await admin.query(`CREATE SCHEMA "${schema}"`);
        schemaCreated = true;
        execFileSync(
            process.execPath,
            [
                require.resolve('prisma/build/index.js'),
                'migrate',
                'deploy',
                '--schema',
                'packages/models/prisma/schema.prisma',
            ],
            {
                cwd: root,
                env: { ...process.env, DATABASE_URL: scopedUrl.toString() },
                encoding: 'utf8',
                windowsHide: true,
                timeout: 60000,
            },
        );
        await prisma.$connect();
        await redis.connect();
    }, 120000);
    beforeEach(() => {
        now = new Date('2026-10-26T00:00:00Z');
        calls = 0;
        model = null;
        configure();
    });
    afterAll(async () => {
        await prisma.$disconnect();
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
        expect(await prisma.questionEvidence.count({ where: { questionId: q.id } })).toBe(1);
        expect(await prisma.run.count({ where: { taskId: f.task.id } })).toBe(1);
        expect(await prisma.outbox.count({ where: { userId: a.userId } })).toBe(0);
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
        expect(await prisma.run.count({ where: { taskId: f.task.id } })).toBe(1);
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
            expect(await prisma.questionEvidence.count({ where: { questionId: q.id } })).toBe(0);
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
        expect(await prisma.questionEvidence.count({ where: { userId: a.userId } })).toBe(0);
    });
    it('confirm=false不启动；确认后固定问题配置、mode和预算且不覆盖原报告/TaskVersion', async () => {
        const a = await register(),
            f = await fixture(a);
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
        const stored = await prisma.run.findUniqueOrThrow({ where: { id: result.run.id } });
        expect(stored.followupConfigJson).toMatchObject({
            goal: q.question,
            schedule: { frequency: 'manual' },
            budget: config.budget,
        });
        expect(stored.comparisonScopeHash).not.toBe(f.run.comparisonScopeHash);
        expect(
            (await prisma.reportQuestion.findUniqueOrThrow({ where: { id: q.id } })).followupRunId,
        ).toBe(stored.id);
        expect(await prisma.runEvent.count({ where: { runId: stored.id } })).toBe(1);
        expect(await prisma.outbox.count({ where: { aggregateId: stored.id } })).toBe(1);
        const replay = await json(await follow(a, f.report.id, q.id, key));
        const fresh = await json(await follow(a, f.report.id, q.id));
        expect(replay.run.id).toBe(stored.id);
        expect(fresh.run.id).toBe(stored.id);
        expect(await prisma.report.findUniqueOrThrow({ where: { id: f.report.id } })).toEqual(
            f.report,
        );
        expect(
            (await prisma.task.findUniqueOrThrow({ where: { id: f.task.id } })).currentVersionId,
        ).toBe(f.task.currentVersionId);
    });
    it('活动Run互斥与归档规则，失败不留关联Run或Outbox', async () => {
        const a = await register(),
            f = await fixture(a);
        const q = await json(await ask(a, f.report.id));
        const active = await request(`/tasks/${f.task.id}/runs`, {
            method: 'POST',
            headers: { ...headers(a), 'idempotency-key': randomUUID() },
            body: '{}',
        });
        expect(active.status).toBe(202);
        expect((await follow(a, f.report.id, q.id)).status).toBe(409);
        expect(
            (await prisma.reportQuestion.findUniqueOrThrow({ where: { id: q.id } })).followupRunId,
        ).toBeNull();
        await prisma.run.updateMany({
            where: { taskId: f.task.id, status: 'queued' },
            data: { status: 'canceled' },
        });
        await prisma.task.update({ where: { id: f.task.id }, data: { status: 'archived' } });
        expect((await follow(a, f.report.id, q.id)).status).toBe(409);
    });
    it('Outbox写失败时回滚Run/首事件/问题链接/幂等，重试可成功', async () => {
        const a = await register(),
            f = await fixture(a);
        const q = await json(await ask(a, f.report.id));
        const key = randomUUID();
        await prisma.$executeRawUnsafe(
            `ALTER TABLE outbox ADD CONSTRAINT question_test_failure CHECK (event_type <> 'run.enqueue') NOT VALID`,
        );
        try {
            expect((await follow(a, f.report.id, q.id, key)).status).toBe(500);
            expect(
                (await prisma.reportQuestion.findUniqueOrThrow({ where: { id: q.id } }))
                    .followupRunId,
            ).toBeNull();
            expect(await prisma.run.count({ where: { taskId: f.task.id } })).toBe(1);
        } finally {
            await prisma.$executeRawUnsafe(
                'ALTER TABLE outbox DROP CONSTRAINT question_test_failure',
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
        expect(await prisma.questionEvidence.count({ where: { questionId: question.id } })).toBe(0);
        expect(
            (await prisma.reportQuestion.findUniqueOrThrow({ where: { id: question.id } }))
                .answerJson,
        ).toMatchObject({ reason: 'aborted', statements: [] });
    });
    it('相同goal且空focus的followup真实执行不读取或推进普通基线', async () => {
        const a = await register(),
            f = await liveFixture(a, '核对公告申请截止日期', true);
        const ordinary = await prisma.baseline.create({
            data: {
                userId: a.userId,
                taskId: f.task.id,
                comparisonScopeHash: f.scope,
                completeRunId: f.run.id,
            },
        });
        const originalReport = await prisma.report.findUniqueOrThrow({
            where: { id: f.report.id },
        });
        const q = await json(await ask(a, f.report.id, f.config.goal));
        const response = await follow(a, f.report.id, q.id);
        expect(response.status).toBe(202);
        const result = await json(response);
        const created = await prisma.run.findUniqueOrThrow({ where: { id: result.run.id } });
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
            await prisma.baseline.findUniqueOrThrow({ where: { id: ordinary.id } }),
        ).toMatchObject({
            completeRunId: f.run.id,
        });
        expect(
            await prisma.baseline.findUniqueOrThrow({
                where: {
                    userId_taskId_comparisonScopeHash: {
                        userId: a.userId,
                        taskId: f.task.id,
                        comparisonScopeHash: created.comparisonScopeHash,
                    },
                },
            }),
        ).toMatchObject({ completeRunId: created.id });
        expect(await prisma.report.findUniqueOrThrow({ where: { id: f.report.id } })).toEqual(
            originalReport,
        );
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
        const frozen = await prisma.run.findUniqueOrThrow({ where: { id: first.id } });
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
        const stored = await prisma.run.findUniqueOrThrow({ where: { id: retried.id } });
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
        expect(await prisma.report.count({ where: { runId: first.id } })).toBe(0);
        expect(await prisma.report.count({ where: { runId: stored.id } })).toBe(1);
        expect(await prisma.report.findUniqueOrThrow({ where: { id: f.report.id } })).toMatchObject(
            {
                runId: f.run.id,
            },
        );
    }, 90_000);
});
