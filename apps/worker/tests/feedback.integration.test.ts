import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import pg from 'pg';
import { beforeAll, afterAll, describe, it, expect } from 'vite-plus/test';
import { effectiveRunScopeHash } from '@scova/shared';
import { readFeedbackSnapshot, type Feedback, type FeedbackEffect } from '@scova/models';
import type { ConnectorBundle, ReadPage, StructuredInput, CallContext } from '@scova/connectors';
import type { Run } from '@scova/db';
import { createApiApp } from '../../server/src/app/index.ts';
import { createDefaultServices } from '../../server/src/app/context.ts';
import { createRunService } from '../../server/src/service/runs.ts';
import { csrfForSession, tokenHash } from '../../server/src/utils/security.ts';
import { createRunRepository } from '../src/repo/runs.ts';
import { createAgentRepository } from '../src/repo/agent.ts';
import { createSchedulerRepository } from '../src/repo/scheduler.ts';
import { createAgentSession, createAgentRuntime } from '../src/service/agent.ts';
import { RunService } from '../src/service/runs.ts';
import { createDeliveryService } from '../src/service/delivery.ts';
import { outboxDatabase } from './support/outbox-database.ts';
import { seedRun, emptyUsage } from './support/run-database.ts';

const fixture = outboxDatabase(),
    db = fixture.db;
const saver = new PostgresSaver(
    new pg.Pool({ connectionString: fixture.databaseUrl, max: 3 }),
    undefined,
    { schema: fixture.checkpointSchema },
);
const runs = createRunRepository(db),
    delivery = createDeliveryService(db, saver);
const services = createDefaultServices({
    db: () => db,
    origin: 'https://scova.test',
    close: async () => {},
});
const api = createApiApp('node', services),
    commands = createRunService(services);
const primary = 'https://example.com/notice',
    ignored = 'https://example.com/old-material',
    deeper = 'https://example.com/detail';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const bodyOld = '申请截止日期为2026-11-15。',
    bodyNew = '申请截止日期为2026-11-16。';
const published = new Date(Date.now() - 86400000).toISOString();
beforeAll(async () => {
    await fixture.setup();
    await saver.setup();
}, 120000);
afterAll(async () => {
    await services.close();
    await saver.end();
    await fixture.cleanup();
});
type Seed = Awaited<ReturnType<typeof seedRun>>;
async function auth(userId: string) {
    const token = randomBytes(32).toString('base64url'),
        csrf = csrfForSession(token);
    await db.session.create({
        data: {
            userId,
            tokenHash: tokenHash(token),
            csrfTokenHash: tokenHash(csrf),
            expiresAt: new Date(Date.now() + 3600000),
        },
    });
    return {
        cookie: `scova_session=${token}`,
        'x-csrf-token': csrf,
        origin: 'https://scova.test',
        'content-type': 'application/json',
    };
}
async function request(
    path: string,
    headers: Record<string, string>,
    method = 'GET',
    body?: unknown,
) {
    return api.handle(
        new Request(`https://scova.test/api/v1${path}`, {
            method,
            headers: { 'content-type': 'application/json', ...headers },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
    );
}
async function mark(seed: Seed, sourceId: string, kind: Feedback['kind']) {
    const response = await request('/feedback', await auth(seed.user.id), 'POST', {
        taskId: seed.task.id,
        sourceId,
        kind,
    });
    expect(response.status).toBe(200);
    return (await response.json()) as Feedback;
}
function bundle(
    options: { urls?: string[]; body?: string; reads?: string[]; queries?: string[] } = {},
): ConnectorBundle {
    const resultUrls = options.urls ?? [primary];
    return {
        mode: 'live',
        search: {
            async search(query, context) {
                await context?.beforeAttempt?.('search');
                options.queries?.push(query);
                return {
                    kind: 'search_results',
                    mode: 'live',
                    provider: 'searxng',
                    query,
                    searchedAt: new Date().toISOString(),
                    results: resultUrls.map((url) => ({
                        kind: 'search_snippet',
                        originalUrl: url,
                        url,
                        title: '公告',
                        snippet: '待验证摘要',
                    })),
                    coverage: {
                        complete: true,
                        gaps: [],
                        unresponsiveEngines: [],
                        receivedResults: resultUrls.length,
                        returnedResults: resultUrls.length,
                        discardedResults: 0,
                        totalResults: resultUrls.length,
                        truncated: false,
                    },
                };
            },
        },
        reader: {
            async read(url, context) {
                await context?.beforeAttempt?.('read');
                options.reads?.push(url);
                const text = url === primary ? (options.body ?? bodyOld) : `${url} 的补充原文。`;
                return {
                    kind: 'read_page',
                    mode: 'live',
                    originalUrl: url,
                    fetchedUrl: url,
                    url,
                    title: '公告',
                    text,
                    contentHash: sha(text),
                    extractionVersion: 'feedback-fixture-v1',
                    collectedAt: new Date().toISOString(),
                    truncated: false,
                    untrusted: true,
                    publication: {
                        parserVersion: 'scova-publication-v1',
                        status: 'known',
                        instant: published,
                        observations: [
                            {
                                field: 'article:published_time',
                                rawValue: published,
                                locator: 'meta[0]',
                            },
                        ],
                    },
                } as ReadPage;
            },
        },
        model: {
            async generateStructured<T>(input: StructuredInput, context?: CallContext) {
                await context?.beforeAttempt?.('model');
                const sources = input.untrustedSources as
                    | { pageId: string; text: string }[]
                    | undefined;
                const data = Object.hasOwn(input.schema.properties ?? {}, 'pages')
                    ? {
                          pages: sources!.map((page) => ({
                              pageId: page.pageId,
                              facts: [
                                  {
                                      subject: '公告',
                                      predicate: '截止日期',
                                      value: page.text,
                                      quote: page.text,
                                      relevance: 'relevant',
                                      importance: 'important',
                                  },
                              ],
                          })),
                      }
                    : sources
                      ? {
                            claims: sources.map((page) => ({
                                kind: 'fact',
                                text: page.text,
                                questionIds: ['q0', 'q1'],
                                citations: [{ pageId: page.pageId, quote: page.text }],
                            })),
                        }
                      : { queries: [{ query: '公开公告', questionIds: ['q0', 'q1'] }] };
                return {
                    mode: 'live',
                    usage: { inputTokens: 1, outputTokens: 1, estimated: false },
                    data: data as T,
                };
            },
        },
    };
}
async function execute(run: Run, options: Parameters<typeof bundle>[0] = {}) {
    const claimed = await runs.claim(run.id, 'feedback-test', 60000);
    if (claimed.kind !== 'claimed') throw new Error('expected claimed');
    const context = {
        runId: run.id,
        userId: run.userId,
        taskId: run.taskId,
        taskVersionId: run.taskVersionId,
        mode: run.mode,
        config: claimed.config,
        budget: claimed.budget,
        usage: claimed.usage,
        startedAt: claimed.run.startedAt!,
        deadlineAt: claimed.run.deadlineAt!,
        signal: new AbortController().signal,
        assertActive: () => runs.assertActive(claimed.token),
        emit: (event: Parameters<typeof runs.emit>[1]) => runs.emit(claimed.token, event),
    };
    const session = createAgentSession({
        repository: createAgentRepository(db, claimed.token),
        saver,
        token: claimed.token,
        context,
        bundle: bundle(options),
    });
    return { candidate: await session.execute(), claimed, session };
}
async function initial(options: { scheduled?: boolean; searchBudget?: number } = {}) {
    const seed = await seedRun(db, { mode: 'live' });
    if (options.scheduled) seed.config.schedule = { frequency: 'daily', localTime: '00:00' };
    if (options.searchBudget) seed.config.budget.maxSearches = options.searchBudget;
    await db.taskVersion.update({
        where: { id: seed.version.id },
        data: { configJson: seed.config },
    });
    seed.run = await db.run.update({
        where: { id: seed.run.id },
        data: {
            comparisonScopeHash: effectiveRunScopeHash(seed.version.comparisonScopeHash, 'live'),
            budgetJson: seed.config.budget,
        },
    });
    const result = await execute(seed.run);
    const delivered = await delivery.deliver(result.claimed.token, result.candidate);
    const source = await db.source.findFirstOrThrow({
        where: { userId: seed.user.id, canonicalUrl: primary },
    });
    const claim = await db.claim.findFirstOrThrow({ where: { reportId: delivered.reportId } });
    return { ...seed, source, claim, reportId: delivered.reportId };
}
async function queued(seed: Seed) {
    const result = await commands.create(
        seed.user.id,
        seed.task.id,
        { mode: 'live' },
        randomUUID(),
    );
    return db.run.findUniqueOrThrow({ where: { id: result.run.id } });
}
async function observed(seed: Seed, url: string) {
    const run = await db.run.create({
        data: {
            userId: seed.user.id,
            taskId: seed.task.id,
            taskVersionId: seed.version.id,
            mode: 'live',
            trigger: 'manual',
            status: 'failed',
            finishedAt: new Date(),
            failureCode: 'FIXTURE',
            comparisonScopeHash: seed.run.comparisonScopeHash,
            budgetJson: seed.config.budget,
            usageJson: emptyUsage(),
        },
    });
    const source = await db.source.create({
        data: { userId: seed.user.id, canonicalUrl: url, canonicalUrlHash: sha(url) },
    });
    await db.runSource.create({
        data: {
            userId: seed.user.id,
            runId: run.id,
            sourceId: source.id,
            requestedUrl: url,
            fetchStatus: 'failed',
        },
    });
    return source;
}
const snapshot = (run: Run) =>
    readFeedbackSnapshot(run.feedbackSnapshotJson, run.userId, run.taskId);

describe('可撤销资料反馈与实际后续执行（真实PG/checkpoint）', () => {
    it('API验证owner/task/CSRF与唯一目标；切换、撤销、重激活和并发设置幂等', async () => {
        const seed = await initial(),
            headers = await auth(seed.user.id),
            input = { taskId: seed.task.id, sourceId: seed.source.id, kind: 'known' };
        expect((await request('/feedback', {}, 'POST', input)).status).toBe(401);
        expect(
            (await request('/feedback', { ...headers, 'x-csrf-token': 'invalid' }, 'POST', input))
                .status,
        ).toBe(403);
        expect(
            (await request('/feedback', headers, 'POST', { ...input, claimId: seed.claim.id }))
                .status,
        ).toBe(422);
        const other = await seedRun(db, { mode: 'live' });
        expect((await request('/feedback', await auth(other.user.id), 'POST', input)).status).toBe(
            404,
        );
        const otherTask = await db.task.create({
            data: { userId: seed.user.id, title: '另一个任务' },
        });
        expect(
            (await request('/feedback', headers, 'POST', { ...input, taskId: otherTask.id }))
                .status,
        ).toBe(404);
        expect(
            (
                await request('/feedback', headers, 'POST', {
                    taskId: otherTask.id,
                    claimId: seed.claim.id,
                    kind: 'known',
                })
            ).status,
        ).toBe(404);
        const responses = await Promise.all(
            Array.from({ length: 6 }, () => request('/feedback', headers, 'POST', input)),
        );
        const rows = await Promise.all(
            responses.map(async (response) => {
                expect(response.status).toBe(200);
                return (await response.json()) as Feedback;
            }),
        );
        expect(new Set(rows.map((row) => row.id)).size).toBe(1);
        expect(new Set(rows.map((row) => row.updatedAt)).size).toBe(1);
        const changed = await mark(seed, seed.source.id, 'deeper');
        expect(changed.id).toBe(rows[0]!.id);
        const revoked = await request(`/feedback/${changed.id}`, headers, 'DELETE');
        expect(((await revoked.json()) as Feedback).active).toBe(false);
        expect((await request(`/feedback/${changed.id}`, headers, 'DELETE')).status).toBe(200);
        expect((await request(`/tasks/${seed.task.id}/feedback`, headers)).status).toBe(200);
        expect((await mark(seed, seed.source.id, 'known')).id).toBe(changed.id);
        expect(
            await db.feedback.count({ where: { userId: seed.user.id, taskId: seed.task.id } }),
        ).toBe(1);
    });
    it('排队时冻结含空快照；切换、撤销与租约恢复不改旧Run，retry捕获当前反馈', async () => {
        const seed = await initial();
        const feedback = await mark(seed, seed.source.id, 'known');
        const run = await queued(seed),
            frozen = structuredClone(run.feedbackSnapshotJson);
        expect(snapshot(run).items[0]?.kind).toBe('known');
        await mark(seed, seed.source.id, 'deeper');
        const first = await runs.claim(run.id, 'first', 60000);
        if (first.kind !== 'claimed') throw new Error('claim');
        await db.run.update({ where: { id: run.id }, data: { leaseExpiresAt: new Date(0) } });
        const recovered = await runs.claim(run.id, 'second', 60000);
        if (recovered.kind !== 'claimed') throw new Error('recover');
        expect((await createAgentRepository(db, recovered.token).comparison()).feedback).toEqual(
            snapshot(run),
        );
        expect(
            (await db.run.findUniqueOrThrow({ where: { id: run.id } })).feedbackSnapshotJson,
        ).toEqual(frozen);
        await runs.finish(recovered.token, { code: 'FIXTURE' });
        await request(`/feedback/${feedback.id}`, await auth(seed.user.id), 'DELETE');
        const retried = await commands.retry(seed.user.id, run.id, { mode: 'live' }, randomUUID());
        const retry = await db.run.findUniqueOrThrow({ where: { id: retried.run.id } });
        expect(snapshot(retry).items).toEqual([]);
        await mark(seed, seed.source.id, 'known');
        expect(
            (await db.run.findUniqueOrThrow({ where: { id: retry.id } })).feedbackSnapshotJson,
        ).toEqual(retry.feedbackSnapshotJson);
    });
    it.each(['known', 'irrelevant', 'deeper'] as const)(
        '带%s反馈的Run截止后接管：固定反馈与已存正文交付partial，不调用供应商或推进基线',
        async (kind) => {
            const seed = await initial();
            const feedback = await mark(seed, seed.source.id, kind);
            const run = await queued(seed);
            const frozen = structuredClone(run.feedbackSnapshotJson);
            const first = await execute(run);
            await first.session.drain();
            const savedCalls = await db.toolCall.findMany({
                where: { runId: run.id },
                orderBy: { id: 'asc' },
            });
            expect(
                savedCalls.some((call) => call.tool === 'read' && call.status === 'succeeded'),
            ).toBe(true);
            // 模拟成功正文已提交后进程退出，待原截止时间已过再由新runtime接管。
            await db.$executeRaw`
        UPDATE runs SET deadline_at=clock_timestamp(),
          lease_expires_at=clock_timestamp()-interval '1 second'
        WHERE id=${run.id}::uuid
      `;
            expect(
                (await request(`/feedback/${feedback.id}`, await auth(seed.user.id), 'DELETE'))
                    .status,
            ).toBe(200);
            const runtime = createAgentRuntime({
                database: db,
                databaseUrl: fixture.databaseUrl,
                checkpointSchema: fixture.checkpointSchema,
                env: {},
                enableDelivery: true,
            });
            let executeCalls = 0;
            try {
                await runtime.connect();
                const service = new RunService({
                    repository: runs,
                    executorFactory: (token) => {
                        const executor = runtime.executorFactory(token);
                        return {
                            ...executor,
                            async execute(context) {
                                executeCalls++;
                                return executor.execute(context);
                            },
                        };
                    },
                });
                expect(await service.execute(run.id)).toBe('processed');
                expect(executeCalls).toBe(0);
                const recovered = await db.run.findUniqueOrThrow({ where: { id: run.id } });
                expect(recovered).toMatchObject({
                    status: 'partial',
                    outcome: 'inconclusive',
                    failureCode: null,
                    leaseEpoch: first.claimed.token.leaseEpoch + 1,
                    recoveryCount: 1,
                    feedbackSnapshotJson: frozen,
                });
                const report = await db.report.findFirstOrThrow({ where: { runId: run.id } });
                expect(report.feedbackEffectsJson).toContainEqual(
                    expect.objectContaining({ feedbackId: feedback.id, kind }),
                );
                expect(
                    await db.toolCall.findMany({
                        where: { runId: run.id },
                        orderBy: { id: 'asc' },
                    }),
                ).toEqual(savedCalls);
                expect(await db.inboxItem.count({ where: { reportId: report.id } })).toBe(1);
                expect(
                    await db.runEvent.count({ where: { runId: run.id, type: 'report.published' } }),
                ).toBe(1);
                expect(
                    await db.baseline.findFirstOrThrow({ where: { taskId: seed.task.id } }),
                ).toMatchObject({
                    completeRunId: seed.run.id,
                });
                expect(await service.execute(run.id)).toBe('ignored');
                expect(await db.report.count({ where: { runId: run.id } })).toBe(1);
            } finally {
                await runtime.close();
            }
        },
    );
    it('200条生效上限允许切换，撤销释放名额，重新激活仍受同一上限约束', async () => {
        const seed = await initial(),
            headers = await auth(seed.user.id),
            ids = Array.from({ length: 201 }, () => randomUUID());
        await db.claim.createMany({
            data: ids.map((id, order) => ({
                id,
                userId: seed.user.id,
                taskId: seed.task.id,
                reportId: seed.reportId,
                kind: 'fact' as const,
                text: `容量验证结论${order}`,
                confidenceLabel: '直接原文',
                order: order + 100,
            })),
        });
        await db.feedback.createMany({
            data: ids.slice(0, 200).map((claimId) => ({
                userId: seed.user.id,
                taskId: seed.task.id,
                claimId,
                kind: 'known' as const,
            })),
        });
        const set = (claimId: string, kind = 'known') =>
            request('/feedback', headers, 'POST', { taskId: seed.task.id, claimId, kind });
        expect((await set(ids[200]!)).status).toBe(409);
        const switched = await set(ids[0]!, 'deeper');
        expect(switched.status).toBe(200);
        const first = (await switched.json()) as Feedback;
        expect((await request(`/feedback/${first.id}`, headers, 'DELETE')).status).toBe(200);
        const added = await set(ids[200]!);
        expect(added.status).toBe(200);
        expect((await set(ids[0]!)).status).toBe(409);
        const replacement = (await added.json()) as Feedback;
        await request(`/feedback/${replacement.id}`, headers, 'DELETE');
        const reactivated = await set(ids[0]!);
        expect(reactivated.status).toBe(200);
        expect(((await reactivated.json()) as Feedback).id).toBe(first.id);
        const listed = await request(`/tasks/${seed.task.id}/feedback`, headers);
        expect(((await listed.json()) as { items: Feedback[] }).items).toHaveLength(200);
        expect(snapshot(await queued(seed)).items).toHaveLength(200);
    });
    it('周期Run也在Task锁内复制反馈；不新建版本或清空基线', async () => {
        const seed = await initial({ scheduled: true }),
            feedback = await mark(seed, seed.source.id, 'deeper');
        const baseline = await db.baseline.findFirstOrThrow({ where: { taskId: seed.task.id } });
        const firstDue = new Date(Date.now() - 86400000);
        firstDue.setUTCHours(0, 0, 0, 0);
        await db.task.update({
            where: { id: seed.task.id },
            data: { nextRunAt: firstDue },
        });
        expect(await createSchedulerRepository(db).scheduleNext('live', [])).toMatchObject({
            taskId: seed.task.id,
            status: 'created',
        });
        const scheduled = await db.run.findFirstOrThrow({
            where: { taskId: seed.task.id, trigger: 'scheduled' },
        });
        expect(snapshot(scheduled).items[0]?.id).toBe(feedback.id);
        expect(await db.baseline.findUniqueOrThrow({ where: { id: baseline.id } })).toEqual(
            baseline,
        );
        expect(await db.taskVersion.count({ where: { taskId: seed.task.id } })).toBe(1);
        await db.task.update({ where: { id: seed.task.id }, data: { nextRunAt: null } });
    });
    it('真实工具账本体现新发现排除/深入查询和读取，解释可读且旧报告不变', async () => {
        const seed = await initial(),
            oldReport = await db.report.findUniqueOrThrow({ where: { id: seed.reportId } });
        const excluded = await observed(seed, ignored),
            detail = await observed(seed, deeper);
        const excludedFeedback = await mark(seed, excluded.id, 'irrelevant');
        await mark(seed, detail.id, 'deeper');
        const reads: string[] = [],
            queries: string[] = [],
            run = await queued(seed);
        const result = await execute(run, { urls: [primary, ignored, deeper], reads, queries });
        expect(reads).toEqual([primary, deeper]);
        expect(queries.some((query) => query.includes('详细条件'))).toBe(true);
        const forged = { ...result.candidate, feedbackEffects: [] };
        await expect(delivery.deliver(result.claimed.token, forged)).rejects.toMatchObject({
            code: 'INVALID_DELIVERY_EVIDENCE',
        });
        const delivered = await delivery.deliver(result.claimed.token, result.candidate);
        const report = await db.report.findUniqueOrThrow({ where: { id: delivered.reportId } });
        const effects = report.feedbackEffectsJson as FeedbackEffect[];
        expect(effects.map((effect) => effect.effect)).toEqual(
            expect.arrayContaining(['excluded', 'expanded_query', 'promoted']),
        );
        const response = await request(`/reports/${report.id}`, await auth(seed.user.id));
        expect(response.status).toBe(200);
        expect(
            ((await response.json()) as { feedbackEffects: FeedbackEffect[] }).feedbackEffects,
        ).toEqual(effects);
        expect(await db.report.findUniqueOrThrow({ where: { id: seed.reportId } })).toEqual(
            oldReport,
        );
        await request(`/feedback/${excludedFeedback.id}`, await auth(seed.user.id), 'DELETE');
        const nextReads: string[] = [],
            next = await execute(await queued(seed), {
                urls: [primary, ignored, deeper],
                reads: nextReads,
            });
        expect(nextReads).toContain(ignored);
        expect(
            next.candidate.feedbackEffects?.some(
                (effect) => effect.feedbackId === excludedFeedback.id,
            ),
        ).toBe(false);
        await delivery.deliver(next.claimed.token, next.candidate);
    });
    it.each(['known', 'irrelevant'] as const)(
        '%s不跳过冻结基线复读，重要日期新值仍交付双方证据',
        async (kind) => {
            const seed = await initial(),
                oldReport = await db.report.findUniqueOrThrow({ where: { id: seed.reportId } });
            await mark(seed, seed.source.id, kind);
            const run = await queued(seed),
                reads: string[] = [];
            const result = await execute(run, { body: bodyNew, reads });
            const delivered = await delivery.deliver(result.claimed.token, result.candidate);
            expect(reads).toContain(primary);
            expect(await db.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
                outcome: 'important_change',
            });
            const change = await db.changeRecord.findFirstOrThrow({
                where: { reportId: delivered.reportId, kind: 'changed' },
                include: { citations: true },
            });
            expect(change).toMatchObject({
                oldValue: bodyOld,
                newValue: bodyNew,
                importance: 'important',
            });
            expect(new Set(change.citations.map((citation) => citation.side))).toEqual(
                new Set(['old', 'new']),
            );
            expect(result.candidate.feedbackEffects).toContainEqual(
                expect.objectContaining({ effect: 'baseline_protected' }),
            );
            expect(
                result.candidate.feedbackEffects?.some(
                    (effect) => effect.effect === 'deprioritized',
                ),
            ).toBe(false);
            expect(await db.report.findUniqueOrThrow({ where: { id: seed.reportId } })).toEqual(
                oldReport,
            );
            if (kind === 'known') {
                const third = await queued(seed);
                expect(snapshot(third).items[0]?.sources[0]?.contentHash).toBe(sha(bodyOld));
            }
        },
    );
    it('深入搜索预算不足有明确解释；不捏造已执行子查询', async () => {
        const seed = await initial({ searchBudget: 1 }),
            target = await observed(seed, deeper);
        const feedback = await mark(seed, target.id, 'deeper'),
            run = await queued(seed),
            queries: string[] = [];
        const result = await execute(run, { queries });
        expect(queries).toEqual(['公开公告']);
        expect(result.candidate.feedbackEffects).toContainEqual(
            expect.objectContaining({ feedbackId: feedback.id, effect: 'not_applied_budget' }),
        );
        expect(
            result.candidate.feedbackEffects?.some((effect) => effect.effect === 'expanded_query'),
        ).toBe(false);
        await delivery.deliver(result.claimed.token, result.candidate);
    });
    it('合法结论反馈生效、跨账号结论及撤销被拒绝', async () => {
        const seed = await initial(),
            headers = await auth(seed.user.id);
        const input = { taskId: seed.task.id, claimId: seed.claim.id, kind: 'known' };
        const response = await request('/feedback', headers, 'POST', input);
        expect(response.status).toBe(200);
        const feedback = (await response.json()) as Feedback;
        const other = await seedRun(db),
            foreign = await auth(other.user.id);
        expect((await request('/feedback', foreign, 'POST', input)).status).toBe(404);
        expect((await request(`/feedback/${feedback.id}`, foreign, 'DELETE')).status).toBe(404);
        expect((await request(`/tasks/${seed.task.id}/feedback`, foreign)).status).toBe(404);
        const run = await queued(seed);
        expect(snapshot(run).items[0]).toMatchObject({
            claimId: seed.claim.id,
            text: seed.claim.text,
        });
        expect(snapshot(run).items[0]!.sources[0]!.quote).toBe(bodyOld);
    });
    it('畸形或跨owner快照拒绝进入Agent；不借用其他账号目标', async () => {
        const seed = await initial();
        await mark(seed, seed.source.id, 'known');
        const run = await queued(seed);
        const raw = { ...snapshot(run), userId: randomUUID() };
        await expect(
            db.run.update({ where: { id: run.id }, data: { feedbackSnapshotJson: raw } }),
        ).rejects.toThrow();
        await db.run.update({
            where: { id: run.id },
            data: {
                feedbackSnapshotJson: {
                    ...snapshot(run),
                    items: snapshot(run).items.map((item) => ({
                        ...item,
                        sourceId: null,
                        claimId: null,
                    })),
                },
            },
        });
        const claimed = await runs.claim(run.id, 'bad-feedback', 60000);
        if (claimed.kind !== 'claimed') throw new Error('claim');
        await expect(createAgentRepository(db, claimed.token).comparison()).rejects.toThrow();
    });
    it('长合法自动解释结论被标记后仍能创建Run，并保持完整文本', async () => {
        const seed = await initial(),
            text = '次级来源解释' + '旧值'.repeat(1000) + '；关联原文' + '新值'.repeat(1000);
        const claim = await db.claim.create({
            data: {
                userId: seed.user.id,
                taskId: seed.task.id,
                reportId: seed.reportId,
                kind: 'inference',
                text,
                confidenceLabel: '自动关系解释',
                order: 100,
            },
        });
        const response = await request('/feedback', await auth(seed.user.id), 'POST', {
            taskId: seed.task.id,
            claimId: claim.id,
            kind: 'deeper',
        });
        expect(response.status).toBe(200);
        expect(snapshot(await queued(seed)).items[0]!.text).toBe(text);
    });
});
