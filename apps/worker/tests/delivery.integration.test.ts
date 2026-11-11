import { requiredDatabaseValue } from '@/utils/database.ts';
import {
    reports as dbReports,
    eq,
    count as dbCount,
    evidence as dbEvidence,
    runSources as dbRunSources,
    taskVersions as dbTaskVersions,
    tasks as dbTasks,
    runs as dbRuns,
    notifications as dbNotifications,
    inboxItems as dbInboxItems,
    sql,
    baselines as dbBaselines,
    changeRecords as dbChangeRecords,
    toolCalls as dbToolCalls,
    claims as dbClaims,
    sources as dbSources,
    and,
    runEvents as dbRunEvents,
    asc,
    queryRows,
    sourceSnapshots as dbSourceSnapshots,
} from '@scova/db';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { nodeScriptCommand } from '../../../scripts/process-runtime.mjs';
import type { NotificationPreference, Report, TaskConfig } from '@scova/models';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import {
    candidateFromCheckpoint,
    type AgentCandidate,
    type ComparisonExtraction,
} from '@scova/agent-core';
import {
    createConnectorBundle,
    createHttpPageReader as createPageReader,
    ConnectorError,
    type ConnectorBundle,
    type StructuredInput,
    type CallContext,
    type ReadPage,
} from '@scova/connectors';
import { createAgentRepository } from '../src/repo/agent.ts';
import { createRunRepository } from '../src/repo/runs.ts';
import { createAgentSession, createAgentRuntime } from '../src/service/agent.ts';
import { createDeliveryService } from '../src/service/delivery.ts';
import { RunService } from '../src/service/runs.ts';
import { outboxDatabase } from './support/outbox-database.ts';
import { seedRun } from './support/run-database.ts';

const fixture = outboxDatabase();
const runs = createRunRepository(fixture.db);
const schema = new URL(fixture.databaseUrl).searchParams.get('schema')!;
const saver = new PostgresSaver(
    new pg.Pool({ connectionString: fixture.databaseUrl, max: 3 }),
    undefined,
    { schema },
);
const delivery = createDeliveryService(fixture.db, saver);
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

beforeAll(async () => {
    await fixture.setup();
    await saver.setup();
}, 120_000);
afterAll(async () => {
    await saver.end();
    await fixture.cleanup();
});

async function research() {
    const seed = await seedRun(fixture.db);
    const claimed = await runs.claim(seed.run.id, 'delivery-test', 60_000);
    if (claimed.kind !== 'claimed') throw new Error('Expected claimed Run');
    const context = {
        runId: seed.run.id,
        userId: seed.user.id,
        taskId: seed.task.id,
        taskVersionId: seed.version.id,
        mode: seed.run.mode,
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
        repository: createAgentRepository(fixture.db, claimed.token),
        saver,
        token: claimed.token,
        context,
        bundle: createConnectorBundle(),
    });
    const candidate = await session.execute();
    return { ...seed, claimed, context, session, candidate };
}
async function assertEmpty(runId: string) {
    expect(
        await fixture.db
            .select({ count: dbCount() })
            .from(dbReports)
            .where(eq(dbReports.runId, runId))
            .then((rows) => rows[0]!.count),
    ).toBe(0);
    expect(
        await fixture.db
            .select({ count: dbCount() })
            .from(dbEvidence)
            .where(eq(dbEvidence.runId, runId))
            .then((rows) => rows[0]!.count),
    ).toBe(0);
    expect(
        await fixture.db
            .select({ count: dbCount() })
            .from(dbRunSources)
            .where(eq(dbRunSources.runId, runId))
            .then((rows) => rows[0]!.count),
    ).toBe(0);
}

async function liveResearch(
    options: {
        previous?: Pick<
            Awaited<ReturnType<typeof seedRun>>,
            'user' | 'task' | 'version' | 'config' | 'run'
        >;
        body?: string;
        bodyByUrl?: Record<string, string>;
        extractionVersion?: string;
        maxTextChars?: number;
        claimKind?: 'fact' | 'inference' | 'insufficient' | 'conflict';
        importance?: 'important' | 'non_material' | 'unknown';
        factValue?: string;
        pageUrl?: string;
        failUrls?: string[];
        skipExecute?: boolean;
        notificationPreference?: NotificationPreference;
        nullableRelation?: boolean;
        truncatedComparison?: boolean;
        badComparisonQuote?: boolean;
        badClaimQuote?: boolean;
        pageCount?: number;
        publication?: string | null;
        modified?: string;
        retryRead?: boolean;
        officialOnly?: boolean;
        condition?: string;
        outputFormats?: TaskConfig['outputFormats'];
        collection?: ReadPage['collection'];
        structuredArtifacts?: boolean;
    } = {},
) {
    const initial = options.previous ?? (await seedRun(fixture.db, { mode: 'live' }));
    if (options.notificationPreference || options.officialOnly || options.outputFormats) {
        if (options.outputFormats) {
            initial.config.outputFormats = options.outputFormats;
            initial.config.outputFormat = options.outputFormats[0]!;
        }
        if (options.notificationPreference)
            initial.config.notificationPreference = options.notificationPreference;
        if (options.officialOnly)
            initial.config.sourcePreferences = {
                preferredUrls: [options.pageUrl ?? 'https://example.com/publication'],
                excludedUrls: [],
                officialOnly: true,
            };
        await fixture.db
            .update(dbTaskVersions)
            .set({ configJson: initial.config })
            .where(eq(dbTaskVersions.id, initial.version.id))
            .returning()
            .then((rows) => requiredDatabaseValue(rows[0]));
    }
    const run = options.previous
        ? await fixture.db
              .insert(dbRuns)
              .values({
                  userId: initial.user.id,
                  taskId: initial.task.id,
                  taskVersionId: initial.version.id,
                  mode: 'live',
                  trigger: 'manual',
                  comparisonScopeHash: initial.run.comparisonScopeHash,
                  budgetJson: initial.config.budget,
                  usageJson: {
                      searches: 0,
                      pages: 0,
                      inputTokens: 0,
                      outputTokens: 0,
                      estimated: false,
                  },
              })
              .returning()
              .then((rows) => requiredDatabaseValue(rows[0]))
        : initial.run;
    const claimed = await runs.claim(run.id, 'delivery-live', 60_000);
    if (claimed.kind !== 'claimed') throw new Error('Expected claimed live Run');
    const url = options.pageUrl ?? 'https://example.com/publication';
    const publication =
        options.publication === undefined
            ? new Date(Date.now() - 60_000).toISOString()
            : options.publication;
    let readRequests = 0;
    const formats = options.outputFormats ?? [initial.config.outputFormat];
    const requirements = formats.flatMap((format) =>
        ['q0', 'q1'].map((id) => ({
            id: `${format}-${id}`,
            format,
            questionIds: [id],
            object: '',
            field: id,
            required: true,
        })),
    );
    const reader = createPageReader({
        maxTextChars: options.maxTextChars,
        http: {
            async request(requestedUrl) {
                if (options.retryRead && readRequests++ === 0)
                    return {
                        url: requestedUrl,
                        status: 503,
                        headers: { 'content-type': 'text/html' },
                        body: '',
                    };
                if (options.failUrls?.includes(requestedUrl))
                    throw new Error('Injected missing source');
                return {
                    url: requestedUrl,
                    status: 200,
                    headers: { 'content-type': 'text/html; charset=utf-8' },
                    body: `<html><head><title>采集公告</title>${publication === null ? '' : `<meta property="article:published_time" content="${publication}">`}${options.modified ? `<meta property="article:modified_time" content="${options.modified}">` : ''}</head><body><article><p>${options.bodyByUrl?.[requestedUrl] ?? options.body ?? (requestedUrl.endsWith('alternate') ? '第二来源称申请截止日期为十一月十六日。' : '这是已发布的公共公告，申请截止日期为十一月十五日。')}</p></article></body></html>`,
                };
            },
        },
    });
    const base = createConnectorBundle();
    let comparisonAttempts = 0;
    const bundle: ConnectorBundle = {
        mode: 'live',
        reader: {
            async read(url, context) {
                const page = await reader.read(url, context);
                return {
                    ...page,
                    ...(options.extractionVersion
                        ? { extractionVersion: options.extractionVersion }
                        : {}),
                    ...(options.collection
                        ? { collection: structuredClone(options.collection) }
                        : {}),
                };
            },
        },
        search: {
            async search(query, context) {
                const result = await base.search.search(query, context);
                return {
                    ...result,
                    mode: 'live',
                    provider: 'searxng',
                    results: [
                        url,
                        ...Array.from(
                            { length: (options.pageCount ?? 1) - 1 },
                            (_, i) => `${url}/source-${i}`,
                        ),
                        ...(options.claimKind === 'conflict' ? [url + '/alternate'] : []),
                    ].map((pageUrl) => ({
                        kind: 'search_snippet' as const,
                        originalUrl: pageUrl,
                        url: pageUrl,
                        title: '采集公告',
                        snippet: '未经正文验证的搜索摘要',
                        engines: ['fixture'],
                    })),
                };
            },
        },
        model: {
            async generateStructured<T>(input: StructuredInput, context?: CallContext) {
                await context?.beforeAttempt?.('model');
                const source = input.untrustedSources?.[0] as
                    | { pageId: string; text: string }
                    | undefined;
                const sources = input.untrustedSources as
                    | { pageId: string; text: string }[]
                    | undefined;
                const claimKind = options.claimKind ?? 'fact';
                if (Object.hasOwn((input.schema.properties ?? {}) as object, 'pages')) {
                    if (options.truncatedComparison && comparisonAttempts++ === 0)
                        throw new ConnectorError('output_truncated', 'DO_NOT_RENDER');
                    return {
                        mode: 'live',
                        usage: { inputTokens: 1, outputTokens: 1, estimated: false },
                        data: {
                            pages: sources!.map((page) => ({
                                pageId: page.pageId,
                                facts:
                                    claimKind === 'insufficient'
                                        ? []
                                        : [
                                              {
                                                  subject: '公开公告',
                                                  predicate: '公告内容',
                                                  value: options.factValue ?? page.text,
                                                  quote: options.badComparisonQuote
                                                      ? 'UNLOCATABLE_MODEL_QUOTE'
                                                      : page.text,
                                                  relevance: 'relevant',
                                                  importance: options.importance ?? 'important',
                                                  ...(options.nullableRelation
                                                      ? { relation: null }
                                                      : {}),
                                              },
                                          ],
                            })),
                        } as T,
                    };
                }
                return {
                    mode: 'live',
                    usage: { inputTokens: 1, outputTokens: 1, estimated: false },
                    data: (source
                        ? {
                              ...(options.structuredArtifacts === false
                                  ? {}
                                  : {
                                        artifacts: formats.map((format) => ({
                                            format,
                                            requirements: requirements
                                                .filter((r) => r.format === format)
                                                .map((r) => ({
                                                    id: r.id,
                                                    text: options.outputFormats
                                                        ? `${format}独立归纳：申请期限需要结合原公告确认。`
                                                        : claimKind === 'fact'
                                                          ? source.text
                                                          : {
                                                                inference:
                                                                    '基于原文推断还需继续查证',
                                                                conflict:
                                                                    '两处来源的截止日期存在冲突',
                                                                insufficient: '当前结论证据不足',
                                                            }[claimKind],
                                                    claimIndexes: [
                                                        options.outputFormats
                                                            ? [...options.outputFormats]
                                                                  .reverse()
                                                                  .indexOf(format)
                                                            : 0,
                                                    ],
                                                })),
                                        })),
                                    }),
                              claims: (options.outputFormats
                                  ? [...options.outputFormats].reverse()
                                  : [undefined]
                              ).map((format) => ({
                                  ...(format ? { outputFormat: format } : {}),
                                  kind: claimKind,
                                  assessment: {
                                      relevance: 'direct',
                                      support: 'direct',
                                      role: 'answer',
                                      sourceRelation: 'unknown',
                                      reason: '受控原文直接回答测试问题',
                                      conditions: options.condition ?? '',
                                      gap: '',
                                  },
                                  text: format
                                      ? `${format}独立归纳：申请期限需要结合原公告确认。`
                                      : claimKind === 'fact'
                                        ? source.text
                                        : {
                                              inference: '基于原文推断还需继续查证',
                                              conflict: '两处来源的截止日期存在冲突',
                                              insufficient: '当前结论证据不足',
                                          }[claimKind],
                                  questionIds: ['q0', 'q1'],
                                  citations:
                                      claimKind === 'insufficient'
                                          ? []
                                          : (claimKind === 'conflict' ? sources! : [source]).map(
                                                (entry) => ({
                                                    pageId: entry.pageId,
                                                    quote: options.badClaimQuote
                                                        ? 'UNLOCATABLE_CLAIM_QUOTE'
                                                        : entry.text,
                                                }),
                                            ),
                              })),
                          }
                        : {
                              queries: [{ query: '公共公告', questionIds: ['q0', 'q1'] }],
                              ...(options.structuredArtifacts === false ? {} : { requirements }),
                          }) as T,
                };
            },
        },
    };
    const context = {
        runId: run.id,
        userId: initial.user.id,
        taskId: initial.task.id,
        taskVersionId: initial.version.id,
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
        repository: createAgentRepository(fixture.db, claimed.token),
        saver,
        token: claimed.token,
        context,
        bundle,
    });
    const candidate = options.skipExecute ? undefined : await session.execute();
    return {
        user: initial.user,
        task: initial.task,
        version: initial.version,
        config: initial.config,
        run,
        claimed,
        context,
        session,
        bundle,
        candidate: candidate!,
    };
}

describe('原子证据与报告交付（真实 PostgreSQL，不使用 Redis）', () => {
    it('persists independent artifact indexes and the primary summary without rewriting saved output after task edits', async () => {
        const seed = await liveResearch({
            outputFormats: ['list', 'brief'],
            claimKind: 'inference',
        });
        const artifacts = seed.candidate.coverage.artifacts!;
        expect(artifacts.map((artifact) => artifact.format)).toEqual(['list', 'brief']);
        expect(artifacts[0].claimIndexes.map((index) => seed.candidate.claims[index].text)).toEqual(
            ['list独立归纳：申请期限需要结合原公告确认。'],
        );
        expect(artifacts[1].claimIndexes.map((index) => seed.candidate.claims[index].text)).toEqual(
            ['brief独立归纳：申请期限需要结合原公告确认。'],
        );
        const result = await delivery.deliver(seed.claimed.token, seed.candidate);
        const saved = await fixture.db.query.reports.findFirst({
            where: eq(dbReports.id, result.reportId),
        });
        expect(saved?.format).toBe('list');
        expect(saved?.summary).toContain('list独立归纳');
        expect(saved?.summary).not.toContain('brief独立归纳');
        const storedRun = await fixture.db.query.runs
            .findFirst({
                where: eq(dbRuns.id, seed.run.id),
            })
            .then((row) => requiredDatabaseValue(row));
        expect((storedRun.coverageJson as Report['coverage']).artifacts).toEqual(artifacts);
        const storedClaims = await fixture.db.query.claims.findMany({
            where: eq(dbClaims.reportId, result.reportId),
        });
        expect(storedClaims.map((entry) => entry.text).sort()).toEqual(
            seed.candidate.claims.map((entry) => entry.text).sort(),
        );
        const nextVersion = await fixture.db
            .insert(dbTaskVersions)
            .values({
                userId: seed.user.id,
                taskId: seed.task.id,
                version: seed.version.version + 1,
                configJson: {
                    ...seed.config,
                    outputFormat: 'research_report',
                    outputFormats: ['research_report'],
                },
                comparisonScopeHash: seed.version.comparisonScopeHash,
            })
            .returning()
            .then((rows) => requiredDatabaseValue(rows[0]));
        await fixture.db
            .update(dbTasks)
            .set({ currentVersionId: nextVersion.id })
            .where(eq(dbTasks.id, seed.task.id));
        const unchanged = await fixture.db.query.reports.findFirst({
            where: eq(dbReports.id, result.reportId),
        });
        expect(unchanged).toEqual(saved);
        expect(unchanged?.taskVersionId).toBe(seed.version.id);
        expect(await delivery.deliver(seed.claimed.token, seed.candidate)).toEqual({
            reportId: result.reportId,
            reused: true,
        });
    });
    it.each([false, true])(
        'persists question answers and authenticates synthesis assessments (tampered=%s)',
        async (tampered) => {
            const seed = await liveResearch();
            expect(seed.candidate.coverage.reportValue?.questions.map((q) => q.status)).toEqual([
                'supported',
                'supported',
            ]);
            const call = await fixture.db.query.toolCalls.findFirst({
                where: and(
                    eq(dbToolCalls.runId, seed.run.id),
                    sql`${dbToolCalls.operationKey} LIKE 'synthesize-0:%'`,
                ),
            });
            expect(call?.status).toBe('succeeded');
            if (tampered) {
                await fixture.db
                    .update(dbToolCalls)
                    .set({ status: 'unknown' })
                    .where(eq(dbToolCalls.id, call!.id));
                await expect(
                    delivery.deliver(seed.claimed.token, seed.candidate),
                ).rejects.toMatchObject({ code: 'INVALID_DELIVERY_EVIDENCE' });
                await assertEmpty(seed.run.id);
            } else {
                const result = await delivery.deliver(seed.claimed.token, seed.candidate);
                const row = await fixture.db.query.runs.findFirst({
                    where: eq(dbRuns.id, seed.run.id),
                });
                expect((row!.coverageJson as Report['coverage']).reportValue).toEqual(
                    seed.candidate.coverage.reportValue,
                );
                const report = await fixture.db.query.reports.findFirst({
                    where: eq(dbReports.id, result.reportId),
                });
                expect(report?.summary).toContain('查找可追溯资料');
            }
        },
    );
    it.each(['valid', 'ledger_unknown', 'strip_plan', 'alter_required', 'forge_content'] as const)(
        'authenticates frozen artifact requirements independently of checkpoint (%s)',
        async (attack) => {
            const seed = await liveResearch();
            expect(seed.candidate.coverage.artifacts?.[0]?.coverage?.requirements).toHaveLength(2);
            const call = await fixture.db.query.toolCalls.findFirst({
                where: and(
                    eq(dbToolCalls.runId, seed.run.id),
                    sql`${dbToolCalls.operationKey} LIKE 'plan-0:%'`,
                ),
            });
            expect(call?.status).toBe('succeeded');
            if (attack === 'valid') {
                const result = await delivery.deliver(seed.claimed.token, seed.candidate);
                const saved = await fixture.db.query.runs.findFirst({
                    where: eq(dbRuns.id, seed.run.id),
                });
                expect((saved!.coverageJson as Report['coverage']).artifacts).toEqual(
                    seed.candidate.coverage.artifacts,
                );
                expect(result.reportId).toBeTruthy();
                return;
            }
            let candidate = seed.candidate;
            if (attack === 'ledger_unknown') {
                await fixture.db
                    .update(dbToolCalls)
                    .set({ status: 'unknown' })
                    .where(eq(dbToolCalls.id, call!.id));
            } else if (attack === 'forge_content') {
                candidate = structuredClone(candidate);
                candidate.coverage.artifacts![0]!.coverage!.requirements[0]!.required = false;
            } else {
                const run = (await fixture.db.query.runs.findFirst({
                    where: eq(dbRuns.id, seed.run.id),
                }))!;
                const ref = run.checkpointRef as {
                    threadId: string;
                    namespace: '';
                    checkpointId: string;
                    leaseEpoch: number;
                };
                const config = {
                    configurable: {
                        thread_id: ref.threadId,
                        checkpoint_ns: '',
                        checkpoint_id: ref.checkpointId,
                    },
                };
                const tuple = (await saver.getTuple(config))!;
                const checkpoint = structuredClone(tuple.checkpoint);
                const state = checkpoint.channel_values.research as {
                    artifactPolicy?: number;
                    planningExtraction?: {
                        response: { data: { requirements: { required: boolean }[] } };
                    };
                };
                const repository = createAgentRepository(fixture.db, seed.claimed.token);
                const context = {
                    ...seed.context,
                    ...(await repository.comparison()),
                    usage: await repository.usage(),
                };
                expect(candidateFromCheckpoint(context, state)).toEqual(seed.candidate);
                if (attack === 'strip_plan') {
                    delete state.artifactPolicy;
                    delete state.planningExtraction;
                } else state.planningExtraction!.response.data.requirements[0]!.required = false;
                checkpoint.id = crypto.randomUUID();
                const saved = await saver.put(
                    config,
                    checkpoint,
                    tuple.metadata!,
                    checkpoint.channel_versions,
                );
                await repository.promoteCheckpoint({
                    ...ref,
                    checkpointId: saved.configurable!.checkpoint_id as string,
                });
                candidate = candidateFromCheckpoint(context, state);
            }
            await expect(delivery.deliver(seed.claimed.token, candidate)).rejects.toMatchObject({
                code: 'INVALID_DELIVERY_EVIDENCE',
            });
            await assertEmpty(seed.run.id);
        },
    );
    it('delivers uncertain claims and comparison values without promoting fabricated quotes or baselines', async () => {
        const seed = await liveResearch({ badComparisonQuote: true, badClaimQuote: true });
        expect(seed.candidate.claims[0]).toMatchObject({
            kind: 'insufficient',
            citations: [],
            uncertainty: expect.arrayContaining(['quote_unmatched']),
        });
        expect(seed.candidate.changes).toContainEqual(
            expect.objectContaining({ kind: 'uncertain', newCitations: [], important: false }),
        );
        const result = await delivery.deliver(seed.claimed.token, seed.candidate);
        const report = await fixture.db.query.reports.findFirst({
            where: eq(dbReports.id, result.reportId),
        });
        const claims = await fixture.db.query.claims.findMany({
            where: eq(dbClaims.reportId, result.reportId),
        });
        const evidence = await fixture.db.query.evidence.findMany({
            where: eq(dbEvidence.runId, seed.run.id),
        });
        const baseline = await fixture.db.query.baselines.findFirst({
            where: eq(dbBaselines.taskId, seed.task.id),
        });
        expect(report?.completeness).toBe('partial');
        expect(report?.summary).toContain('暂无直接回答');
        expect(claims[0]?.confidenceLabel).toContain('引用未能定位');
        expect(evidence).toHaveLength(1);
        expect(evidence[0]!.quote).not.toContain('UNLOCATABLE');
        expect(baseline).toBeUndefined();
    });
    it.each([false, true])(
        'rebuilds every comparison batch from its successful ledger (tampered=%s)',
        async (tampered) => {
            const seed = await liveResearch({ pageCount: 4 });
            expect(seed.candidate.manifest!.pages).toHaveLength(4);
            const batch = await fixture.db.query.toolCalls.findFirst({
                where: and(
                    eq(dbToolCalls.runId, seed.run.id),
                    sql`${dbToolCalls.operationKey} LIKE 'compare-facts-batch-1-v2:%'`,
                ),
            });
            expect(batch?.status).toBe('succeeded');
            if (tampered) {
                await fixture.db
                    .update(dbToolCalls)
                    .set({ status: 'unknown' })
                    .where(eq(dbToolCalls.id, batch!.id));
                await expect(
                    delivery.deliver(seed.claimed.token, seed.candidate),
                ).rejects.toMatchObject({ code: 'INVALID_DELIVERY_EVIDENCE' });
                await assertEmpty(seed.run.id);
            } else {
                const result = await delivery.deliver(seed.claimed.token, seed.candidate);
                const report = await fixture.db.query.reports.findFirst({
                    where: eq(dbReports.id, result.reportId),
                });
                expect(report?.comparisonJson).toEqual(seed.candidate.manifest);
            }
        },
    );
    it.each([false, true])(
        'comparison repair delivery requires its own successful ledger (tampered=%s)',
        async (tampered) => {
            const seed = await liveResearch({ truncatedComparison: true });
            expect(seed.candidate.comparison).toBe('completed');
            const repair = await fixture.db.query.toolCalls.findFirst({
                where: and(
                    eq(dbToolCalls.runId, seed.run.id),
                    sql`${dbToolCalls.operationKey} LIKE 'compare-facts-repair-v1:%'`,
                ),
            });
            expect(repair?.status).toBe('succeeded');
            if (tampered) {
                await fixture.db
                    .update(dbToolCalls)
                    .set({ status: 'unknown' })
                    .where(eq(dbToolCalls.id, repair!.id));
                await expect(
                    delivery.deliver(seed.claimed.token, seed.candidate),
                ).rejects.toMatchObject({ code: 'INVALID_DELIVERY_EVIDENCE' });
                await assertEmpty(seed.run.id);
            } else {
                const result = await delivery.deliver(seed.claimed.token, seed.candidate);
                const report = await fixture.db.query.reports.findFirst({
                    where: eq(dbReports.id, result.reportId),
                });
                expect(report?.comparisonJson).toEqual(seed.candidate.manifest);
                expect(report?.completeness).toBe('partial');
                expect(await delivery.deliver(seed.claimed.token, seed.candidate)).toEqual({
                    reportId: result.reportId,
                    reused: true,
                });
            }
        },
    );
    for (const mode of ['summary', 'important_change', 'off'] as const)
        for (const runIssues of [true, false])
            it(`通知${mode}/${runIssues}经真实完整/重要变化/partial交付，重放保留已读`, async () => {
                const first = await liveResearch({
                    notificationPreference: { mode, runIssues },
                    body: '申请截止日期为十一月十五日。',
                });
                const firstDelivery = await delivery.deliver(first.claimed.token, first.candidate);
                const firstRows = await fixture.db.query.notifications.findMany({
                    where: eq(dbNotifications.runId, first.run.id),
                });
                expect(firstRows.map((row) => row.kind)).toEqual(
                    mode === 'summary' ? ['summary'] : [],
                );
                expect(
                    await fixture.db
                        .select({ count: dbCount() })
                        .from(dbInboxItems)
                        .where(eq(dbInboxItems.reportId, firstDelivery.reportId))
                        .then((rows) => rows[0]!.count),
                ).toBe(1);
                const second = await liveResearch({
                    previous: first,
                    body: '申请截止日期为十一月二十日。',
                });
                const delivered = await delivery.deliver(second.claimed.token, second.candidate);
                expect(
                    (
                        await fixture.db.query.runs
                            .findFirst({ where: eq(dbRuns.id, second.run.id) })
                            .then((row) => requiredDatabaseValue(row))
                    ).outcome,
                ).toBe('important_change');
                const rows = await fixture.db.query.notifications.findMany({
                    where: eq(dbNotifications.runId, second.run.id),
                });
                expect(rows.map((row) => row.kind)).toEqual(mode === 'off' ? [] : [mode]);
                const readAt = new Date('2026-01-01T00:00:00Z');
                if (rows[0])
                    await fixture.db
                        .update(dbNotifications)
                        .set({ readAt: readAt })
                        .where(eq(dbNotifications.id, rows[0].id))
                        .returning()
                        .then((rows) => requiredDatabaseValue(rows[0]));
                expect(
                    await delivery.deliver(second.claimed.token, second.candidate),
                ).toMatchObject({
                    reportId: delivered.reportId,
                    reused: true,
                });
                if (rows[0])
                    expect(
                        (
                            await fixture.db.query.notifications
                                .findFirst({ where: eq(dbNotifications.id, rows[0].id) })
                                .then((row) => requiredDatabaseValue(row))
                        ).readAt,
                    ).toEqual(readAt);
                const third = await liveResearch({
                    previous: first,
                    importance: 'unknown',
                    body: '申请截止日期尚未确定。',
                });
                const partial = await delivery.deliver(third.claimed.token, third.candidate);
                expect(
                    (
                        await fixture.db.query.runs
                            .findFirst({ where: eq(dbRuns.id, third.run.id) })
                            .then((row) => requiredDatabaseValue(row))
                    ).status,
                ).toBe('partial');
                expect(
                    (
                        await fixture.db.query.notifications.findMany({
                            where: eq(dbNotifications.runId, third.run.id),
                        })
                    ).map((row) => row.kind),
                ).toEqual(runIssues ? ['run_issue'] : []);
                expect(
                    await fixture.db
                        .select({ count: dbCount() })
                        .from(dbInboxItems)
                        .where(eq(dbInboxItems.reportId, partial.reportId))
                        .then((rows) => rows[0]!.count),
                ).toBe(1);
            });

    it('通知SQL失败使报告/Inbox/基线/终态一起回滚，修复后可重试', async () => {
        const researched = await liveResearch();
        await fixture.db.execute(
            sql.raw(
                `CREATE FUNCTION notification_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected notification failure'; END $$`,
            ),
        );
        await fixture.db.execute(
            sql.raw(
                'CREATE TRIGGER notification_fail BEFORE INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION notification_fail()',
            ),
        );
        try {
            await expect(
                delivery.deliver(researched.claimed.token, researched.candidate),
            ).rejects.toThrow();
            await assertEmpty(researched.run.id);
            expect(
                await fixture.db
                    .select({ count: dbCount() })
                    .from(dbNotifications)
                    .where(eq(dbNotifications.runId, researched.run.id))
                    .then((rows) => rows[0]!.count),
            ).toBe(0);
            expect(
                await fixture.db
                    .select({ count: dbCount() })
                    .from(dbBaselines)
                    .where(eq(dbBaselines.taskId, researched.task.id))
                    .then((rows) => rows[0]!.count),
            ).toBe(0);
            expect(
                (
                    await fixture.db.query.runs
                        .findFirst({ where: eq(dbRuns.id, researched.run.id) })
                        .then((row) => requiredDatabaseValue(row))
                ).status,
            ).toBe('running');
        } finally {
            await fixture.db.execute(sql.raw('DROP TRIGGER notification_fail ON notifications'));
            await fixture.db.execute(sql.raw('DROP FUNCTION notification_fail()'));
        }
        await delivery.deliver(researched.claimed.token, researched.candidate);
        expect(
            await fixture.db
                .select({ count: dbCount() })
                .from(dbNotifications)
                .where(eq(dbNotifications.runId, researched.run.id))
                .then((rows) => rows[0]!.count),
        ).toBe(1);
    });
    it.each(['new', 'repost'] as const)('新增URL按%s分类，不把转载当独立新增', async (kind) => {
        const first = await liveResearch();
        await delivery.deliver(first.claimed.token, first.candidate);
        const addedUrl = 'https://example.com/new-material?programme=ai';
        const second = await liveResearch({
            previous: first,
            pageUrl: addedUrl,
            bodyByUrl:
                kind === 'new'
                    ? { [addedUrl]: '新增公开课程，报名截止日期为十二月一日。' }
                    : undefined,
        });
        const result = await delivery.deliver(second.claimed.token, second.candidate);
        const changes = await fixture.db.query.changeRecords.findMany({
            where: eq(dbChangeRecords.reportId, result.reportId),
            with: { source: true },
        });
        expect(changes.find((change) => change.source.canonicalUrl === addedUrl)).toMatchObject({
            kind: kind === 'new' ? 'new' : 'duplicate_candidate',
            importance: 'normal',
        });
        expect(
            await fixture.db.query.runs
                .findFirst({ where: eq(dbRuns.id, second.run.id) })
                .then((row) => requiredDatabaseValue(row)),
        ).toMatchObject({
            status: 'succeeded',
            outcome: kind === 'new' ? 'new_findings' : 'no_important_change',
        });
    });

    it('提取版本变化保守partial而非完整重复，旧完整基线不变', async () => {
        const first = await liveResearch();
        await delivery.deliver(first.claimed.token, first.candidate);
        const second = await liveResearch({
            previous: first,
            extractionVersion: 'readability/future-v2',
        });
        const result = await delivery.deliver(second.claimed.token, second.candidate);
        expect(
            await fixture.db.query.reports
                .findFirst({ where: eq(dbReports.id, result.reportId) })
                .then((row) => requiredDatabaseValue(row)),
        ).toMatchObject({ completeness: 'partial' });
        expect(
            await fixture.db.query.runs
                .findFirst({ where: eq(dbRuns.id, second.run.id) })
                .then((row) => requiredDatabaseValue(row)),
        ).toMatchObject({
            outcome: 'inconclusive',
        });
        expect(
            await fixture.db.query.baselines
                .findFirst({ where: eq(dbBaselines.taskId, first.task.id) })
                .then((row) => requiredDatabaseValue(row)),
        ).toMatchObject({ completeRunId: first.run.id });
    });

    it.each(['foreign-page', 'missing-quote'] as const)(
        '基线manifest %s损坏不借用别人的snapshot或无引用事实',
        async (kind) => {
            const first = await liveResearch();
            await delivery.deliver(first.claimed.token, first.candidate);
            const manifest = structuredClone(first.candidate.manifest!);
            if (kind === 'foreign-page') manifest.pages[0].url = 'https://foreign.example/source';
            else {
                manifest.pages[0].facts[0].quote = '没有保留引用的旧事实';
                manifest.pages[0].facts[0].value = '旧事实';
            }
            await fixture.db
                .update(dbReports)
                .set({ comparisonJson: JSON.parse(JSON.stringify(manifest)) })
                .where(eq(dbReports.runId, first.run.id))
                .returning({ id: dbReports.id })
                .then((rows) => ({ count: rows.length }));
            const second = await liveResearch({ previous: first });
            expect(
                await createAgentRepository(fixture.db, second.claimed.token).comparison(),
            ).toMatchObject({ baselineRunId: first.run.id, baseline: { status: 'unavailable' } });
            await delivery.deliver(second.claimed.token, second.candidate);
            expect(
                await fixture.db.query.runs
                    .findFirst({ where: eq(dbRuns.id, second.run.id) })
                    .then((row) => requiredDatabaseValue(row)),
            ).toMatchObject({ status: 'partial', outcome: 'inconclusive' });
            expect(
                await fixture.db.query.baselines
                    .findFirst({ where: eq(dbBaselines.taskId, first.task.id) })
                    .then((row) => requiredDatabaseValue(row)),
            ).toMatchObject({ completeRunId: first.run.id });
        },
    );

    it('首次冻结null后即使出现新指针，恢复仍保持null；模式不匹配的基线不采用', async () => {
        const initial = await liveResearch({ skipExecute: true });
        expect(initial.claimed.run.baselineRunId).toBeNull();
        const history = await fixture.db
            .insert(dbRuns)
            .values({
                userId: initial.user.id,
                taskId: initial.task.id,
                taskVersionId: initial.version.id,
                comparisonScopeHash: initial.run.comparisonScopeHash,
                mode: 'live',
                trigger: 'manual',
                status: 'succeeded',
                outcome: 'baseline',
                budgetJson: initial.config.budget,
                coverageJson: {
                    completeness: 'complete',
                    gaps: [],
                    searchedQueries: [],
                    exhausted: [],
                },
            })
            .returning()
            .then((rows) => requiredDatabaseValue(rows[0]));
        await fixture.db
            .insert(dbReports)
            .values({
                userId: initial.user.id,
                taskId: initial.task.id,
                taskVersionId: initial.version.id,
                runId: history.id,
                title: '历史报告',
                summary: '历史完整来源',
                format: 'brief',
                completeness: 'complete',
            })
            .returning()
            .then((rows) => requiredDatabaseValue(rows[0]));
        await fixture.db
            .insert(dbBaselines)
            .values({
                userId: initial.user.id,
                taskId: initial.task.id,
                comparisonScopeHash: initial.run.comparisonScopeHash,
                completeRunId: history.id,
            })
            .returning()
            .then((rows) => requiredDatabaseValue(rows[0]));
        await fixture.db
            .update(dbRuns)
            .set({ leaseExpiresAt: new Date(0) })
            .where(eq(dbRuns.id, initial.run.id))
            .returning()
            .then((rows) => requiredDatabaseValue(rows[0]));
        const recovered = await runs.claim(initial.run.id, 'null-recovery', 60_000);
        if (recovered.kind !== 'claimed') throw new Error('Expected recovery');
        expect(recovered.run.baselineRunId).toBeNull();
        expect(await createAgentRepository(fixture.db, recovered.token).comparison()).toMatchObject(
            {
                baselineRunId: null,
                baseline: null,
            },
        );
        await runs.finish(recovered.token, { code: 'EXECUTOR_FAILED' });
        const demo = await fixture.db
            .insert(dbRuns)
            .values({
                userId: initial.user.id,
                taskId: initial.task.id,
                taskVersionId: initial.version.id,
                comparisonScopeHash: initial.run.comparisonScopeHash,
                mode: 'demo',
                trigger: 'manual',
                budgetJson: initial.config.budget,
                usageJson: {
                    searches: 0,
                    pages: 0,
                    inputTokens: 0,
                    outputTokens: 0,
                    estimated: false,
                },
            })
            .returning()
            .then((rows) => requiredDatabaseValue(rows[0]));
        const demoClaim = await runs.claim(demo.id, 'demo-isolation');
        if (demoClaim.kind !== 'claimed') throw new Error('Expected demo claim');
        expect(demoClaim.run.baselineRunId).toBeNull();
    });

    it('同URL关键事实变化保存双方真实证据，完整重要变化推进基线；第三次不完整不推进', async () => {
        const first = await liveResearch({ body: '申请截止日期为十一月十五日。' });
        const firstDelivery = await delivery.deliver(first.claimed.token, first.candidate);
        const second = await liveResearch({
            previous: first,
            body: '申请截止日期为十一月二十日。',
        });
        expect(second.claimed.run.baselineRunId).toBe(first.run.id);
        const result = await delivery.deliver(second.claimed.token, second.candidate);
        const report = await fixture.db.query.reports
            .findFirst({
                where: eq(dbReports.id, result.reportId),
                with: { changes: { with: { citations: { with: { evidence: true } } } } },
            })
            .then((row) => requiredDatabaseValue(row));
        expect(report).toMatchObject({ baselineRunId: first.run.id, completeness: 'complete' });
        expect(
            await fixture.db.query.runs
                .findFirst({ where: eq(dbRuns.id, second.run.id) })
                .then((row) => requiredDatabaseValue(row)),
        ).toMatchObject({
            status: 'succeeded',
            outcome: 'important_change',
        });
        const change = report.changes.find((entry) => entry.kind === 'changed')!;
        expect(change).toMatchObject({
            oldValue: '申请截止日期为十一月十五日。',
            newValue: '申请截止日期为十一月二十日。',
            importance: 'important',
        });
        const old = change.citations.find((entry) => entry.side === 'old')!.evidence;
        const current = change.citations.find((entry) => entry.side === 'new')!.evidence;
        expect(old).toMatchObject({
            runId: first.run.id,
            quote: change.oldValue,
            snapshotId: change.oldSnapshotId,
        });
        expect(current).toMatchObject({
            runId: second.run.id,
            quote: change.newValue,
            snapshotId: change.newSnapshotId,
        });
        expect(change.oldSourceId).toBe(change.sourceId);
        const probe = nodeScriptCommand('tests/support/read-delivered-report.ts');
        const readReport = JSON.parse(
            execFileSync(probe.executable, probe.args, {
                cwd: fileURLToPath(new URL('../../server/', import.meta.url)),
                env: {
                    ...process.env,
                    SCOVA_REPORT_PROBE_DATABASE_URL: fixture.databaseUrl,
                    SCOVA_REPORT_PROBE_USER_ID: first.user.id,
                    SCOVA_REPORT_PROBE_REPORT_ID: result.reportId,
                    SCOVA_REPORT_PROBE_NOTIFICATION_KIND: 'summary',
                },
                encoding: 'utf8',
                windowsHide: true,
                timeout: 20_000,
            }),
        ) as Report;
        expect(readReport).toMatchObject({
            baselineRunId: first.run.id,
            outcome: 'important_change',
            coverage: { completeness: 'complete' },
        });
        const readChange = readReport.changes.find((entry) => entry.kind === 'changed')!;
        expect(readChange.oldEvidenceIds).toContain(old.id);
        expect(readChange.newEvidenceIds).toContain(current.id);
        expect(readReport.evidence.find((entry) => entry.id === old.id)?.quote).toBe(old.quote);
        expect(readReport.evidence.find((entry) => entry.id === current.id)?.quote).toBe(
            current.quote,
        );
        const third = await liveResearch({
            previous: second,
            body: '申请截止日期为十一月二十一日。额外未采集内容',
            maxTextChars: 14,
        });
        await delivery.deliver(third.claimed.token, third.candidate);
        expect(
            await fixture.db.query.runs
                .findFirst({ where: eq(dbRuns.id, third.run.id) })
                .then((row) => requiredDatabaseValue(row)),
        ).toMatchObject({
            status: 'partial',
            outcome: 'inconclusive',
        });
        expect(
            await fixture.db.query.baselines
                .findFirst({ where: eq(dbBaselines.taskId, first.task.id) })
                .then((row) => requiredDatabaseValue(row)),
        ).toMatchObject({ completeRunId: second.run.id });
        expect(await delivery.deliver(second.claimed.token, second.candidate)).toMatchObject({
            reportId: result.reportId,
            reused: true,
        });
        expect(
            await fixture.db
                .select({ count: dbCount() })
                .from(dbReports)
                .where(eq(dbReports.runId, first.run.id))
                .then((rows) => rows[0]!.count),
        ).toBe(1);
        const immutableFirst = await fixture.db.query.reports
            .findFirst({ where: eq(dbReports.id, firstDelivery.reportId) })
            .then((row) => requiredDatabaseValue(row));
        expect(immutableFirst.comparisonJson).toEqual(first.candidate.manifest);
        expect(JSON.stringify(immutableFirst.comparisonJson)).not.toContain('"text":');
    });

    it('strict模型的null关系经账本校验后交付且保留原始输出，重放不重复报告', async () => {
        const seed = await liveResearch({ nullableRelation: true });
        const extraction = await fixture.db.query.toolCalls.findFirst({
            where: and(
                eq(dbToolCalls.runId, seed.run.id),
                sql`${dbToolCalls.operationKey} LIKE 'compare-facts-v1:%'`,
            ),
        });
        expect(extraction?.outputRef).toMatchObject({
            result: { data: { pages: [{ facts: [{ relation: null }] }] } },
        });
        expect(seed.candidate.manifest!.pages[0]!.facts[0]).not.toHaveProperty('relation');
        const result = await delivery.deliver(seed.claimed.token, seed.candidate);
        const report = await fixture.db.query.reports.findFirst({
            where: eq(dbReports.id, result.reportId),
        });
        expect(report?.comparisonJson).toEqual(seed.candidate.manifest);
        expect(await delivery.deliver(seed.claimed.token, seed.candidate)).toEqual({
            reportId: result.reportId,
            reused: true,
        });
        expect(
            await fixture.db.query.reports.findMany({ where: eq(dbReports.runId, seed.run.id) }),
        ).toHaveLength(1);
        expect(
            await fixture.db.query.inboxItems.findMany({
                where: eq(dbInboxItems.reportId, result.reportId),
            }),
        ).toHaveLength(1);
        expect(
            await fixture.db.query.toolCalls.findFirst({
                where: eq(dbToolCalls.id, extraction!.id),
            }),
        ).toEqual(extraction);
    });

    it('正文噪声变化但稳定事实未变为non_material，完整无重要变化', async () => {
        const first = await liveResearch({
            body: 'Deadline: 15 November. Navigation: v1.',
            factValue: '15 November',
        });
        await delivery.deliver(first.claimed.token, first.candidate);
        const second = await liveResearch({
            previous: first,
            body: 'Deadline: 15 November. Navigation: v2.',
            factValue: '15 November',
        });
        const result = await delivery.deliver(second.claimed.token, second.candidate);
        expect(
            await fixture.db.query.changeRecords.findMany({
                where: eq(dbChangeRecords.reportId, result.reportId),
            }),
        ).toMatchObject([{ kind: 'non_material', importance: 'normal' }]);
        expect(
            await fixture.db.query.runs
                .findFirst({ where: eq(dbRuns.id, second.run.id) })
                .then((row) => requiredDatabaseValue(row)),
        ).toMatchObject({
            outcome: 'no_important_change',
            status: 'succeeded',
        });
    });

    it('缺旧来源或未知重要性均partial，不推断撤回/无变化或覆盖既有基线', async () => {
        const first = await liveResearch();
        await delivery.deliver(first.claimed.token, first.candidate);
        const second = await liveResearch({
            previous: first,
            pageUrl: 'https://example.com/new',
            failUrls: ['https://example.com/publication'],
            importance: 'unknown',
        });
        const result = await delivery.deliver(second.claimed.token, second.candidate);
        const report = await fixture.db.query.reports
            .findFirst({ where: eq(dbReports.id, result.reportId), with: { changes: true } })
            .then((row) => requiredDatabaseValue(row));
        expect(report).toMatchObject({ completeness: 'partial', baselineRunId: first.run.id });
        expect(report.changes.every((entry) => entry.importance !== 'important')).toBe(true);
        expect(
            await fixture.db.query.runs
                .findFirst({ where: eq(dbRuns.id, second.run.id) })
                .then((row) => requiredDatabaseValue(row)),
        ).toMatchObject({
            outcome: 'inconclusive',
        });
        expect(
            await fixture.db.query.baselines
                .findFirst({ where: eq(dbBaselines.taskId, first.task.id) })
                .then((row) => requiredDatabaseValue(row)),
        ).toMatchObject({ completeRunId: first.run.id });
    });

    it('冻结基线在恢复时不追随当前指针；promoted比较状态恢复复用账本结果', async () => {
        const first = await liveResearch();
        await delivery.deliver(first.claimed.token, first.candidate);
        const prior = await liveResearch({ previous: first });
        await delivery.deliver(prior.claimed.token, prior.candidate);
        const current = await liveResearch({ previous: prior });
        expect(current.claimed.run.baselineRunId).toBe(prior.run.id);
        await fixture.db
            .update(dbBaselines)
            .set({ completeRunId: first.run.id })
            .where(eq(dbBaselines.taskId, first.task.id))
            .returning({ id: dbBaselines.id })
            .then((rows) => ({ count: rows.length }));
        const count = await fixture.db
            .select({ count: dbCount() })
            .from(dbToolCalls)
            .where(eq(dbToolCalls.runId, current.run.id))
            .then((rows) => rows[0]!.count);
        await fixture.db
            .update(dbRuns)
            .set({ leaseExpiresAt: new Date(0) })
            .where(eq(dbRuns.id, current.run.id))
            .returning()
            .then((rows) => requiredDatabaseValue(rows[0]));
        const next = await runs.claim(current.run.id, 'comparison-recovery', 60_000);
        if (next.kind !== 'claimed') throw new Error('Expected recovered claim');
        expect(next.run.baselineRunId).toBe(prior.run.id);
        const repo = createAgentRepository(fixture.db, next.token);
        expect(await repo.comparison()).toMatchObject({
            baselineRunId: prior.run.id,
            baseline: { status: 'ready', runId: prior.run.id },
        });
        const session = createAgentSession({
            repository: repo,
            saver,
            token: next.token,
            bundle: current.bundle,
            context: {
                ...current.context,
                usage: next.usage,
                assertActive: () => runs.assertActive(next.token),
                emit: (event) => runs.emit(next.token, event),
            },
        });
        const candidate = await session.execute();
        expect(
            await fixture.db
                .select({ count: dbCount() })
                .from(dbToolCalls)
                .where(eq(dbToolCalls.runId, current.run.id))
                .then((rows) => rows[0]!.count),
        ).toBe(count);
        expect(candidate).toEqual(current.candidate);
        await expect(
            delivery.deliver(current.claimed.token, current.candidate),
        ).rejects.toMatchObject({
            code: 'INVALID_DELIVERY_EVIDENCE',
        });
        await delivery.deliver(next.token, candidate);
    });

    it('历史无manifest的合法基线保留冻结指针但比较保守partial，不当首次建基线', async () => {
        const first = await liveResearch();
        await delivery.deliver(first.claimed.token, first.candidate);
        await fixture.db.execute(
            sql`UPDATE reports SET comparison_json=NULL WHERE run_id=${first.run.id}::uuid`,
        );
        const second = await liveResearch({ previous: first });
        expect(second.claimed.run.baselineRunId).toBe(first.run.id);
        expect(
            await createAgentRepository(fixture.db, second.claimed.token).comparison(),
        ).toMatchObject({ baseline: { status: 'unavailable' } });
        await delivery.deliver(second.claimed.token, second.candidate);
        expect(
            await fixture.db.query.runs
                .findFirst({ where: eq(dbRuns.id, second.run.id) })
                .then((row) => requiredDatabaseValue(row)),
        ).toMatchObject({
            status: 'partial',
            outcome: 'inconclusive',
        });
        expect(
            await fixture.db.query.baselines
                .findFirst({ where: eq(dbBaselines.taskId, first.task.id) })
                .then((row) => requiredDatabaseValue(row)),
        ).toMatchObject({ completeRunId: first.run.id });
    });

    it('篡改已提升manifest重要性或候选oldEvidenceIds无法绕过成功模型账本/冻结证据授权', async () => {
        const first = await liveResearch();
        await delivery.deliver(first.claimed.token, first.candidate);
        const second = await liveResearch({
            previous: first,
            body: '内容已变化。',
            importance: 'non_material',
        });
        const other = await liveResearch();
        await delivery.deliver(other.claimed.token, other.candidate);
        const foreign = await fixture.db.query.evidence
            .findFirst({ where: eq(dbEvidence.runId, other.run.id) })
            .then((row) => requiredDatabaseValue(row));
        const forged = structuredClone(second.candidate);
        forged.changes![0].oldEvidenceIds = [foreign.id];
        await expect(delivery.deliver(second.claimed.token, forged)).rejects.toMatchObject({
            code: 'INVALID_DELIVERY_EVIDENCE',
        });
        const row = await fixture.db.query.runs
            .findFirst({ where: eq(dbRuns.id, second.run.id) })
            .then((row) => requiredDatabaseValue(row));
        const ref = row.checkpointRef as {
            threadId: string;
            namespace: '';
            checkpointId: string;
            leaseEpoch: number;
        };
        const config = {
            configurable: {
                thread_id: ref.threadId,
                checkpoint_ns: '',
                checkpoint_id: ref.checkpointId,
            },
        };
        const tuple = (await saver.getTuple(config))!;
        const checkpoint = structuredClone(tuple.checkpoint);
        const state = checkpoint.channel_values.research as {
            manifest: AgentCandidate['manifest'];
            comparisonExtractions: ComparisonExtraction[];
        };
        state.manifest!.pages[0].facts[0].importance = 'important';
        const comparisonBefore = await createAgentRepository(
            fixture.db,
            second.claimed.token,
        ).comparison();
        expect(() =>
            candidateFromCheckpoint({ ...second.context, ...comparisonBefore }, state),
        ).toThrow();
        // Even forging both projections cannot bypass the independent committed tool result.
        (
            state.comparisonExtractions[0]!.response.data as {
                pages: { facts: { importance: string }[] }[];
            }
        ).pages[0]!.facts[0]!.importance = 'important';
        checkpoint.id = crypto.randomUUID();
        const saved = await saver.put(
            config,
            checkpoint,
            tuple.metadata!,
            checkpoint.channel_versions,
        );
        await createAgentRepository(fixture.db, second.claimed.token).promoteCheckpoint({
            ...ref,
            checkpointId: saved.configurable!.checkpoint_id as string,
        });
        const comparison = await createAgentRepository(
            fixture.db,
            second.claimed.token,
        ).comparison();
        const promotedForgery = candidateFromCheckpoint(
            { ...second.context, ...comparison },
            state,
        );
        await expect(delivery.deliver(second.claimed.token, promotedForgery)).rejects.toMatchObject(
            {
                code: 'INVALID_DELIVERY_EVIDENCE',
            },
        );
        await assertEmpty(second.run.id);
    });
    it.each(['clipped', 'removed'] as const)(
        '比较覆盖元数据须与不可变模型账本一致，checkpoint不能篡改或剥离 (%s)',
        async (tampering) => {
            const seed = await liveResearch();
            const row = requiredDatabaseValue(
                await fixture.db.query.runs.findFirst({ where: eq(dbRuns.id, seed.run.id) }),
            );
            const ref = row.checkpointRef as {
                threadId: string;
                namespace: '';
                checkpointId: string;
                leaseEpoch: number;
            };
            const config = {
                configurable: {
                    thread_id: ref.threadId,
                    checkpoint_ns: '',
                    checkpoint_id: ref.checkpointId,
                },
            };
            const tuple = (await saver.getTuple(config))!;
            const checkpoint = structuredClone(tuple.checkpoint);
            const state = checkpoint.channel_values.research as {
                comparisonExtractions: ComparisonExtraction[];
            };
            expect(state.comparisonExtractions[0]!.sourceCoverage).toMatchObject({
                version: 1,
                pages: [{ clipped: false }],
            });
            const receipt = state.comparisonExtractions[0]!;
            const call = requiredDatabaseValue(
                await fixture.db.query.toolCalls.findFirst({
                    where: and(
                        eq(dbToolCalls.runId, seed.run.id),
                        sql`${dbToolCalls.operationKey} LIKE 'compare-facts-v1:%'`,
                    ),
                }),
            );
            expect(
                (call.outputRef as { result: { sourceCoverage: unknown } }).result.sourceCoverage,
            ).toEqual(receipt.sourceCoverage);
            if (tampering === 'clipped') receipt.sourceCoverage!.pages[0]!.clipped = true;
            else delete receipt.sourceCoverage;
            checkpoint.id = crypto.randomUUID();
            const saved = await saver.put(
                config,
                checkpoint,
                tuple.metadata!,
                checkpoint.channel_versions,
            );
            await createAgentRepository(fixture.db, seed.claimed.token).promoteCheckpoint({
                ...ref,
                checkpointId: saved.configurable!.checkpoint_id as string,
            });
            const comparison = await createAgentRepository(
                fixture.db,
                seed.claimed.token,
            ).comparison();
            const forged = candidateFromCheckpoint({ ...seed.context, ...comparison }, state);
            if (tampering === 'clipped')
                expect(forged.coverage.gaps.join(' ')).toContain('比较输入受预算限制');
            await expect(delivery.deliver(seed.claimed.token, forged)).rejects.toMatchObject({
                code: 'INVALID_DELIVERY_EVIDENCE',
            });
            await assertEmpty(seed.run.id);
        },
    );
    it.each(['inference', 'conflict'] as const)(
        '%s以明确标签和真实引用保存，冲突保留双方引用',
        async (kind) => {
            const seed = await liveResearch({ claimKind: kind });
            const result = await delivery.deliver(seed.claimed.token, seed.candidate);
            const claims = await fixture.db.query.claims.findMany({
                where: eq(dbClaims.reportId, result.reportId),
                with: { citations: true },
            });
            expect(claims).toHaveLength(1);
            expect(claims[0]).toMatchObject({
                kind,
                confidenceLabel:
                    kind === 'inference'
                        ? '模型归纳与推断，引用不代表推理已经独立核实'
                        : '来源存在冲突，待核验',
            });
            const report = await fixture.db.query.reports.findFirst({
                where: eq(dbReports.id, result.reportId),
            });
            const status = kind === 'conflict' ? '不同来源' : '已回答';
            const gap = kind === 'conflict' ? ' 补充说明：来源说法存在差异，尚未解决分歧。' : '';
            expect(report!.summary).toBe(
                `查找可追溯资料 · ${status}：${claims[0].text}${gap}` +
                    `\n\n来源 · ${status}：相关回答已在前文列出，详情见正文。`,
            );
            expect(report!.summary.length).toBeLessThanOrEqual(600);
            expect(claims[0].citations).toHaveLength(kind === 'conflict' ? 2 : 1);
            if (kind === 'conflict') {
                expect(new Set(claims[0].citations.map((citation) => citation.relation))).toEqual(
                    new Set(['supports', 'contradicts']),
                );
                expect(
                    await fixture.db.query.runs
                        .findFirst({ where: eq(dbRuns.id, seed.run.id) })
                        .then((row) => requiredDatabaseValue(row)),
                ).toMatchObject({ status: 'partial', outcome: 'inconclusive' });
            }
        },
    );

    it('only uncertain claims still deliver with an unlinked real source excerpt and no complete baseline', async () => {
        const seed = await liveResearch({ claimKind: 'insufficient' });
        expect(seed.candidate.claims[0]).toMatchObject({ kind: 'insufficient', citations: [] });
        const { reportId } = await delivery.deliver(seed.claimed.token, seed.candidate);
        const report = await fixture.db.query.reports.findFirst({
            where: eq(dbReports.id, reportId),
        });
        expect(report?.completeness).toBe('partial');
        expect(report?.summary).toContain('暂无直接回答');
        const claims = await fixture.db.query.claims.findMany({
            where: eq(dbClaims.reportId, reportId),
            with: { citations: true },
        });
        expect(
            claims.every((claim) => claim.kind === 'insufficient' && claim.citations.length === 0),
        ).toBe(true);
        expect(
            await fixture.db.query.evidence.findMany({ where: eq(dbEvidence.runId, seed.run.id) }),
        ).toHaveLength(1);
        expect(
            await fixture.db
                .select({ count: dbCount() })
                .from(dbSources)
                .where(eq(dbSources.userId, seed.user.id))
                .then((rows) => rows[0]!.count),
        ).toBe(1);
        expect(
            await fixture.db.query.baselines.findFirst({
                where: eq(dbBaselines.taskId, seed.task.id),
            }),
        ).toBeUndefined();
    });

    it.each(['unknown', 'failed'] as const)('%s的read结果不可升级成报告证据', async (status) => {
        const seed = await research();
        await fixture.db
            .update(dbToolCalls)
            .set({ status: status })
            .where(and(eq(dbToolCalls.runId, seed.run.id), eq(dbToolCalls.tool, 'read')))
            .returning({ id: dbToolCalls.id })
            .then((rows) => ({ count: rows.length }));
        await expect(delivery.deliver(seed.claimed.token, seed.candidate)).rejects.toMatchObject({
            code: 'INVALID_DELIVERY_EVIDENCE',
        });
        await assertEmpty(seed.run.id);
    });

    it('未知时间和适用条件不妨碍交付核心答案，但仍保留严格比较范围且不推进基线', async () => {
        const seed = await liveResearch({ publication: null, condition: '仅适用于本轮申请' });
        expect(seed.candidate.coverage.delivery).toMatchObject({
            status: 'answered',
            answeredCoreQuestions: 1,
        });
        expect(seed.candidate.coverage.completeness).toBe('partial');
        const { reportId } = await delivery.deliver(seed.claimed.token, seed.candidate);
        const saved = await fixture.db.query.runs.findFirst({ where: eq(dbRuns.id, seed.run.id) });
        expect(saved).toMatchObject({
            status: 'partial',
            outcome: 'inconclusive',
            coverageJson: { delivery: { status: 'answered' } },
        });
        expect(
            await fixture.db.query.reports.findFirst({ where: eq(dbReports.id, reportId) }),
        ).toBeDefined();
        expect(
            await fixture.db.query.baselines.findFirst({
                where: eq(dbBaselines.taskId, seed.task.id),
            }),
        ).toBeUndefined();
        // A separate Run is needed to test validation, since replay legitimately reuses an already committed report.
        const other = await liveResearch({ publication: null });
        other.candidate.coverage.delivery!.status = 'sources_only';
        await expect(delivery.deliver(other.claimed.token, other.candidate)).rejects.toMatchObject({
            code: 'INVALID_DELIVERY_EVIDENCE',
        });
        await assertEmpty(other.run.id);
    });

    it('同一正文读取重试恢复后不因旧失败降级，来源范围匹配不强加官方认证缺口', async () => {
        const seed = await liveResearch({ retryRead: true, officialOnly: true });
        expect(seed.candidate.coverage.completeness).toBe('complete');
        await delivery.deliver(seed.claimed.token, seed.candidate);
        const saved = await fixture.db.query.runs.findFirst({ where: eq(dbRuns.id, seed.run.id) });
        expect(saved).toMatchObject({
            status: 'succeeded',
            outcome: 'baseline',
            coverageJson: { delivery: { status: 'answered' }, completeness: 'complete', gaps: [] },
        });
        const calls = await fixture.db.query.toolCalls.findMany({
            where: and(eq(dbToolCalls.runId, seed.run.id), eq(dbToolCalls.tool, 'read')),
            orderBy: [asc(dbToolCalls.attemptNo)],
        });
        // A transport failure retains its conservative unknown settlement and reserved usage.
        expect(calls.map((call) => call.status)).toEqual(['unknown', 'succeeded']);
        expect(calls[0].operationKey).toBe(calls[1].operationKey);
        expect(saved!.usageJson).toMatchObject({ pages: 2 });
        expect((saved!.coverageJson as { notes: string[] }).notes.join(' ')).toContain('重试恢复');
    });

    it('日期精度和修改时间独立保存，不将未知时区日期写成午夜UTC', async () => {
        const day = new Date(Date.now() - 3 * 86400_000).toISOString().slice(0, 10);
        const seed = await liveResearch({ publication: day, modified: new Date().toISOString() });
        await delivery.deliver(seed.claimed.token, seed.candidate);
        const observation = await fixture.db.query.runSources.findFirst({
            where: eq(dbRunSources.runId, seed.run.id),
            with: { snapshot: true },
        });
        expect(observation!.snapshot!.publishedAt).toBeNull();
        expect(observation!.metadataJson).toMatchObject({
            publication: {
                parserVersion: 'scova-publication-v2',
                status: 'known',
                instant: null,
                observations: expect.arrayContaining([
                    expect.objectContaining({ rawValue: day }),
                    expect.objectContaining({ field: 'meta:modified' }),
                ]),
            },
        });
    });

    it('HTML来源声明日期经Reader→Agent→账本验证后首次完整交付建立基线', async () => {
        const seed = await liveResearch();
        expect(seed.candidate.coverage).toMatchObject({ completeness: 'complete', gaps: [] });
        const { reportId } = await delivery.deliver(seed.claimed.token, seed.candidate);
        expect(
            await fixture.db.query.reports
                .findFirst({ where: eq(dbReports.id, reportId) })
                .then((row) => requiredDatabaseValue(row)),
        ).toMatchObject({
            completeness: 'complete',
        });
        expect(
            await fixture.db.query.runs
                .findFirst({ where: eq(dbRuns.id, seed.run.id) })
                .then((row) => requiredDatabaseValue(row)),
        ).toMatchObject({
            status: 'succeeded',
            outcome: 'baseline',
        });
        expect(
            await fixture.db.query.baselines
                .findFirst({ where: eq(dbBaselines.taskId, seed.task.id) })
                .then((row) => requiredDatabaseValue(row)),
        ).toMatchObject({ completeRunId: seed.run.id });
        const observation = await fixture.db.query.runSources
            .findFirst({ where: eq(dbRunSources.runId, seed.run.id), with: { snapshot: true } })
            .then((row) => requiredDatabaseValue(row));
        expect(observation.snapshot!.publishedAt).not.toBeNull();
        expect(observation.metadataJson).toMatchObject({
            publication: { status: 'known' },
            truncated: false,
        });
    });

    it('首次完整基线后，第二轮完成比较的重复资料可声明无重要变化并推进基线', async () => {
        const first = await liveResearch();
        expect(first.candidate.coverage.completeness).toBe('complete');
        await delivery.deliver(first.claimed.token, first.candidate);
        const second = await liveResearch({ previous: first });
        expect(second.candidate).toMatchObject({
            comparison: 'completed',
            coverage: { completeness: 'complete', gaps: [] },
        });
        const result = await delivery.deliver(second.claimed.token, second.candidate);
        const report = await fixture.db.query.reports
            .findFirst({ where: eq(dbReports.id, result.reportId) })
            .then((row) => requiredDatabaseValue(row));
        expect(report).toMatchObject({ completeness: 'complete', baselineRunId: first.run.id });
        expect(report.limitationsJson).toEqual([]);
        expect(
            await fixture.db.query.runs
                .findFirst({ where: eq(dbRuns.id, second.run.id) })
                .then((row) => requiredDatabaseValue(row)),
        ).toMatchObject({
            status: 'succeeded',
            outcome: 'no_important_change',
            coverageJson: {
                completeness: 'complete',
                gaps: [],
            },
        });
        expect(
            await fixture.db.query.baselines
                .findFirst({ where: eq(dbBaselines.taskId, first.task.id) })
                .then((row) => requiredDatabaseValue(row)),
        ).toMatchObject({ completeRunId: second.run.id });
        expect(
            await fixture.db
                .select({ count: dbCount() })
                .from(dbInboxItems)
                .where(eq(dbInboxItems.reportId, result.reportId))
                .then((rows) => rows[0]!.count),
        ).toBe(1);
        const completed = await fixture.db.query.runEvents
            .findFirst({
                where: and(
                    eq(dbRunEvents.runId, second.run.id),
                    eq(dbRunEvents.type, 'run.completed'),
                ),
            })
            .then((row) => requiredDatabaseValue(row));
        expect(completed.payload).toMatchObject({
            status: 'succeeded',
            outcome: 'no_important_change',
        });
        expect(
            await fixture.db.query.changeRecords.findMany({
                where: eq(dbChangeRecords.reportId, report.id),
            }),
        ).toMatchObject([{ kind: 'duplicate' }]);
    });

    it.each([false, true])(
        '同URL/hash复用快照仍保留两轮真实observedAt和本次truncated=%s，partial不推进完整基线',
        async (firstTruncated) => {
            const prefix = '公开公告的保存正文内容。'.repeat(10);
            const first = await liveResearch({
                body: firstTruncated ? prefix + '更多尚未保存内容' : prefix,
                maxTextChars: prefix.length,
            });
            await delivery.deliver(first.claimed.token, first.candidate);
            const before = await fixture.db.query.baselines.findFirst({
                where: eq(dbBaselines.taskId, first.task.id),
            });
            const second = await liveResearch({
                previous: first,
                body: firstTruncated ? prefix : prefix + '更多尚未保存内容',
                maxTextChars: prefix.length,
            });
            expect(first.candidate.pages[0].contentHash).toBe(
                second.candidate.pages[0].contentHash,
            );
            await delivery.deliver(second.claimed.token, second.candidate);
            const one = await fixture.db.query.runSources
                .findFirst({
                    where: eq(dbRunSources.runId, first.run.id),
                    with: { snapshot: true },
                })
                .then((row) => requiredDatabaseValue(row));
            const two = await fixture.db.query.runSources
                .findFirst({ where: eq(dbRunSources.runId, second.run.id) })
                .then((row) => requiredDatabaseValue(row));
            expect(two.snapshotId).toBe(one.snapshotId);
            expect(two.observedAt.getTime()).toBeGreaterThan(one.observedAt.getTime());
            expect(one.metadataJson).toMatchObject({ truncated: firstTruncated });
            expect(two.metadataJson).toMatchObject({ truncated: !firstTruncated });
            expect(one.snapshot!.metadataJson).toMatchObject({ truncated: firstTruncated });
            const after = await fixture.db.query.baselines.findFirst({
                where: eq(dbBaselines.taskId, first.task.id),
            });
            if (!firstTruncated) expect(after!.completeRunId).toBe(before!.completeRunId);
            else expect(after!.completeRunId).toBe(second.run.id);
            const secondRun = await fixture.db.query.runs
                .findFirst({ where: eq(dbRuns.id, second.run.id) })
                .then((row) => requiredDatabaseValue(row));
            expect(secondRun.outcome).not.toBe('no_important_change');
        },
    );
    it('资源受限但未截断的正文以partial交付并保留本次采集状态，不推进完整基线', async () => {
        const complete = await liveResearch();
        await delivery.deliver(complete.claimed.token, complete.candidate);
        const baseline = await fixture.db.query.baselines.findFirst({
            where: eq(dbBaselines.taskId, complete.task.id),
        });
        expect(baseline?.completeRunId).toBe(complete.run.id);
        const collection: ReadPage['collection'] = {
            version: 1,
            method: 'browser',
            complete: false,
            limitations: ['resource_limit'],
        };
        const limited = await liveResearch({ previous: complete, collection });
        expect(limited.candidate.pages[0].truncated).toBe(false);
        expect(limited.candidate.pages[0].contentHash).toBe(
            complete.candidate.pages[0].contentHash,
        );
        expect(limited.candidate.coverage.completeness).toBe('partial');
        expect(limited.candidate.changes?.every((change) => change.kind === 'uncertain')).toBe(
            true,
        );
        const result = await delivery.deliver(limited.claimed.token, limited.candidate);
        const report = await fixture.db.query.reports.findFirst({
            where: eq(dbReports.id, result.reportId),
        });
        expect(report?.completeness).toBe('partial');
        expect(JSON.stringify(report?.limitationsJson)).toContain('网页渲染或资源加载受限');
        const observation = await fixture.db.query.runSources.findFirst({
            where: eq(dbRunSources.runId, limited.run.id),
            with: { snapshot: true },
        });
        expect(observation?.metadataJson).toMatchObject({ truncated: false, collection });
        expect(observation?.snapshot?.textBody).toBe(limited.candidate.pages[0].text);
        expect(
            (
                await fixture.db.query.baselines.findFirst({
                    where: eq(dbBaselines.taskId, limited.task.id),
                })
            )?.completeRunId,
        ).toBe(complete.run.id);
        expect(
            await fixture.db.query.runs.findFirst({ where: eq(dbRuns.id, limited.run.id) }),
        ).toMatchObject({
            status: 'partial',
            outcome: 'inconclusive',
        });
    });

    it('保留正文与精确quote定位，partial原子交付1报告/Inbox/终态且不建基线', async () => {
        const seed = await research();
        const result = await delivery.deliver(seed.claimed.token, seed.candidate);
        const report = await fixture.db.query.reports
            .findFirst({
                where: eq(dbReports.id, result.reportId),
                with: {
                    claims: { with: { citations: { with: { evidence: true } } } },
                    inboxItems: true,
                },
            })
            .then((row) => requiredDatabaseValue(row));
        expect(report).toMatchObject({
            userId: seed.user.id,
            runId: seed.run.id,
            taskVersionId: seed.version.id,
            completeness: 'partial',
            format: 'brief',
        });
        expect(report.inboxItems).toHaveLength(1);
        expect(report.limitationsJson).toContain(seed.candidate.demoReason);
        const observations = await fixture.db.query.runSources.findMany({
            where: eq(dbRunSources.runId, seed.run.id),
            with: { snapshot: true, source: true },
        });
        expect(observations).toHaveLength(1);
        expect(observations[0]).toMatchObject({
            requestedUrl: seed.candidate.pages[0].originalUrl,
            fetchedUrl: seed.candidate.pages[0].fetchedUrl,
            fetchStatus: 'succeeded',
        });
        expect(observations[0].source.canonicalUrl).toBe(seed.candidate.pages[0].url);
        const snapshot = observations[0].snapshot!;
        expect(snapshot).toMatchObject({
            textBody: seed.candidate.pages[0].text,
            contentHash: sha(seed.candidate.pages[0].text),
            extractorVersion: seed.candidate.pages[0].extractionVersion,
        });
        expect(snapshot.textExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 29 * 86400_000);
        for (const claim of report.claims) {
            expect(claim.kind).toBe('fact');
            expect(claim.citations.length).toBeGreaterThan(0);
            for (const citation of claim.citations) {
                const evidence = citation.evidence;
                const selector = evidence.selectorJson as {
                    type: string;
                    start: number;
                    end: number;
                    extractorVersion: string;
                };
                expect(selector.type).toBe('text_offset');
                expect(snapshot.textBody!.slice(selector.start, selector.end)).toBe(evidence.quote);
                expect(sha(evidence.quote)).toBe(evidence.quoteHash);
                expect(evidence).toMatchObject({
                    runId: seed.run.id,
                    userId: seed.user.id,
                    snapshotId: snapshot.id,
                });
            }
        }
        expect(
            await fixture.db.query.runs
                .findFirst({ where: eq(dbRuns.id, seed.run.id) })
                .then((row) => requiredDatabaseValue(row)),
        ).toMatchObject({
            status: 'partial',
            outcome: 'inconclusive',
            failureCode: null,
            leaseOwner: null,
            coverageJson: { completeness: 'partial' },
        });
        expect(
            await fixture.db
                .select({ count: dbCount() })
                .from(dbBaselines)
                .where(eq(dbBaselines.taskId, seed.task.id))
                .then((rows) => rows[0]!.count),
        ).toBe(0);
        const events = await fixture.db.query.runEvents.findMany({
            where: eq(dbRunEvents.runId, seed.run.id),
            orderBy: [asc(dbRunEvents.seq)],
        });
        expect(events.slice(-3).map((event) => event.type)).toEqual([
            'coverage.updated',
            'report.published',
            'run.completed',
        ]);
        expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1));
        expect(await runs.finish(seed.claimed.token, { code: 'EXECUTOR_FAILED' })).toBe(false);
    });

    it('提交后未ACK重投和并发deliver都复用同1份报告/Inbox/终态事件', async () => {
        const seed = await research();
        const results = await Promise.all([
            delivery.deliver(seed.claimed.token, seed.candidate),
            delivery.deliver(seed.claimed.token, seed.candidate),
        ]);
        expect(results[0].reportId).toBe(results[1].reportId);
        expect(results.filter((item) => !item.reused)).toHaveLength(1);
        expect(await delivery.deliver(seed.claimed.token, seed.candidate)).toMatchObject({
            reportId: results[0].reportId,
            reused: true,
        });
        expect(await runs.claim(seed.run.id, 'redelivery')).toEqual({ kind: 'ignored' });
        expect(
            await fixture.db
                .select({ count: dbCount() })
                .from(dbReports)
                .where(eq(dbReports.runId, seed.run.id))
                .then((rows) => rows[0]!.count),
        ).toBe(1);
        expect(
            await fixture.db
                .select({ count: dbCount() })
                .from(dbInboxItems)
                .where(eq(dbInboxItems.reportId, results[0].reportId))
                .then((rows) => rows[0]!.count),
        ).toBe(1);
        expect(
            await fixture.db
                .select({ count: dbCount() })
                .from(dbRunEvents)
                .where(
                    and(
                        eq(dbRunEvents.runId, seed.run.id),
                        eq(dbRunEvents.type, 'report.published'),
                    ),
                )
                .then((rows) => rows[0]!.count),
        ).toBe(1);
        expect(
            await fixture.db
                .select({ count: dbCount() })
                .from(dbRunEvents)
                .where(
                    and(eq(dbRunEvents.runId, seed.run.id), eq(dbRunEvents.type, 'run.completed')),
                )
                .then((rows) => rows[0]!.count),
        ).toBe(1);
    });

    it.each(['owner', 'run', 'version', 'mode', 'quote', 'page', 'coverage', 'url'] as const)(
        '拒绝候选伪造：%s',
        async (kind) => {
            const seed = await research();
            const other = await seedRun(fixture.db);
            const candidate = structuredClone(seed.candidate);
            if (kind === 'owner') candidate.userId = other.user.id;
            if (kind === 'run') candidate.runId = other.run.id;
            if (kind === 'version') candidate.taskVersionId = other.version.id;
            if (kind === 'mode') candidate.mode = 'live';
            if (kind === 'quote') candidate.claims[0].citations[0].quote = '从未采集的虚构文本';
            if (kind === 'page') candidate.claims[0].citations[0].pageId = 'other-owner-page';
            if (kind === 'coverage')
                candidate.coverage = {
                    completeness: 'complete',
                    searchedQueries: [],
                    exhausted: [],
                    gaps: [],
                };
            if (kind === 'url') candidate.pages[0].fetchedUrl = 'https://evil.example/forged';
            await expect(delivery.deliver(seed.claimed.token, candidate)).rejects.toMatchObject({
                code: 'INVALID_DELIVERY_EVIDENCE',
            });
            await assertEmpty(seed.run.id);
            expect(
                await fixture.db
                    .select({ count: dbCount() })
                    .from(dbSources)
                    .where(eq(dbSources.userId, seed.user.id))
                    .then((rows) => rows[0]!.count),
            ).toBe(0);
        },
    );

    it('即使伪造正文已写入并提升checkpoint也必须匹配当前Run成功read账本', async () => {
        const seed = await research();
        const run = await fixture.db.query.runs
            .findFirst({ where: eq(dbRuns.id, seed.run.id) })
            .then((row) => requiredDatabaseValue(row));
        const ref = run.checkpointRef as {
            threadId: string;
            namespace: '';
            checkpointId: string;
            leaseEpoch: number;
        };
        const config = {
            configurable: {
                thread_id: ref.threadId,
                checkpoint_ns: '',
                checkpoint_id: ref.checkpointId,
            },
        };
        const tuple = (await saver.getTuple(config))!;
        const checkpoint = structuredClone(tuple.checkpoint);
        const state = checkpoint.channel_values.research as {
            pages: AgentCandidate['pages'];
            claims: AgentCandidate['claims'];
        };
        const text = '伪造正文不能冒充成功采集结果';
        state.pages[0].text = text;
        state.pages[0].contentHash = sha(text);
        state.claims[0].text = text;
        state.claims[0].citations[0].quote = text;
        checkpoint.id = crypto.randomUUID();
        const saved = await saver.put(
            config,
            checkpoint,
            tuple.metadata!,
            checkpoint.channel_versions,
        );
        await createAgentRepository(fixture.db, seed.claimed.token).promoteCheckpoint({
            ...ref,
            checkpointId: saved.configurable!.checkpoint_id as string,
        });
        const forged = candidateFromCheckpoint(
            { ...seed.context, demoReason: seed.candidate.demoReason },
            state,
        );
        await expect(delivery.deliver(seed.claimed.token, forged)).rejects.toMatchObject({
            code: 'INVALID_DELIVERY_EVIDENCE',
        });
        await assertEmpty(seed.run.id);
    });

    it.each(['upgrade', 'delete'] as const)(
        '提升checkpoint后%s采集状态仍须匹配不可变read账本，正文hash相同不能证明完整采集',
        async (forgery) => {
            const seed = await liveResearch({
                collection: {
                    version: 1,
                    method: 'browser',
                    complete: false,
                    limitations: ['resource_failure'],
                },
            });
            const run = await fixture.db.query.runs
                .findFirst({ where: eq(dbRuns.id, seed.run.id) })
                .then((row) => requiredDatabaseValue(row));
            const ref = run.checkpointRef as {
                threadId: string;
                namespace: '';
                checkpointId: string;
                leaseEpoch: number;
            };
            const config = {
                configurable: {
                    thread_id: ref.threadId,
                    checkpoint_ns: '',
                    checkpoint_id: ref.checkpointId,
                },
            };
            const tuple = (await saver.getTuple(config))!;
            const checkpoint = structuredClone(tuple.checkpoint);
            const state = checkpoint.channel_values.research as {
                gaps: string[];
                pages: AgentCandidate['pages'];
            };
            const originalHash = state.pages[0].contentHash;
            const repository = createAgentRepository(fixture.db, seed.claimed.token);
            const restoredContext = {
                ...seed.context,
                ...(await repository.comparison()),
                usage: await repository.usage(),
            };
            expect(candidateFromCheckpoint(restoredContext, state)).toEqual(seed.candidate);
            if (forgery === 'delete') delete state.pages[0].collection;
            else
                state.pages[0].collection = {
                    version: 1,
                    method: 'browser',
                    complete: true,
                    limitations: [],
                };
            state.gaps = [];
            expect(state.pages[0].contentHash).toBe(originalHash);
            checkpoint.id = crypto.randomUUID();
            const saved = await saver.put(
                config,
                checkpoint,
                tuple.metadata!,
                checkpoint.channel_versions,
            );
            await createAgentRepository(fixture.db, seed.claimed.token).promoteCheckpoint({
                ...ref,
                checkpointId: saved.configurable!.checkpoint_id as string,
            });
            const forged = candidateFromCheckpoint(restoredContext, state);
            await expect(delivery.deliver(seed.claimed.token, forged)).rejects.toMatchObject({
                code: 'INVALID_DELIVERY_EVIDENCE',
            });
            await assertEmpty(seed.run.id);
        },
    );

    it('删除并保存checkpoint中的采集缺口后，服务端仍恢复partial而非声称完整', async () => {
        const seed = await liveResearch({
            collection: {
                version: 1,
                method: 'browser',
                complete: false,
                limitations: ['render_timeout'],
            },
        });
        const run = await fixture.db.query.runs
            .findFirst({ where: eq(dbRuns.id, seed.run.id) })
            .then((row) => requiredDatabaseValue(row));
        const ref = run.checkpointRef as {
            threadId: string;
            namespace: '';
            checkpointId: string;
            leaseEpoch: number;
        };
        const config = {
            configurable: {
                thread_id: ref.threadId,
                checkpoint_ns: '',
                checkpoint_id: ref.checkpointId,
            },
        };
        const tuple = (await saver.getTuple(config))!;
        const checkpoint = structuredClone(tuple.checkpoint);
        const state = checkpoint.channel_values.research as { gaps: string[] };
        const repository = createAgentRepository(fixture.db, seed.claimed.token);
        const restoredContext = {
            ...seed.context,
            ...(await repository.comparison()),
            usage: await repository.usage(),
        };
        expect(candidateFromCheckpoint(restoredContext, state)).toEqual(seed.candidate);
        state.gaps = [];
        checkpoint.id = crypto.randomUUID();
        const saved = await saver.put(
            config,
            checkpoint,
            tuple.metadata!,
            checkpoint.channel_versions,
        );
        await createAgentRepository(fixture.db, seed.claimed.token).promoteCheckpoint({
            ...ref,
            checkpointId: saved.configurable!.checkpoint_id as string,
        });
        const restored = candidateFromCheckpoint(restoredContext, state);
        expect(restored.coverage.completeness).toBe('partial');
        expect(restored.coverage.gaps.join(' ')).toContain('网页渲染或资源加载受限');
        const delivered = await delivery.deliver(seed.claimed.token, restored);
        expect(
            await fixture.db.query.reports.findFirst({
                where: eq(dbReports.id, delivered.reportId),
            }),
        ).toMatchObject({ completeness: 'partial' });
        expect(
            await fixture.db.query.baselines.findFirst({
                where: eq(dbBaselines.taskId, seed.task.id),
            }),
        ).toBeUndefined();
    });

    it('取消事务先持有Run锁时，等待中的交付不得保存任何成果', async () => {
        const seed = await research();
        let unlock!: () => void;
        let entered!: () => void;
        const held = new Promise<void>((resolve) => {
            entered = resolve;
        });
        const release = new Promise<void>((resolve) => {
            unlock = resolve;
        });
        const cancel = fixture.db.transaction(async (tx) => {
            await queryRows<Record<string, unknown>>(
                tx,
                sql`SELECT id FROM runs WHERE id=${seed.run.id}::uuid FOR UPDATE`,
            );
            await tx
                .update(dbRuns)
                .set({ status: 'cancel_requested', cancelRequestedAt: new Date() })
                .where(eq(dbRuns.id, seed.run.id))
                .returning()
                .then((rows) => requiredDatabaseValue(rows[0]));
            entered();
            await release;
        });
        try {
            await held;
            const delivering = delivery.deliver(seed.claimed.token, seed.candidate);
            void delivering.catch(() => undefined);
            unlock();
            await cancel;
            await expect(delivering).rejects.toMatchObject({ code: 'RUN_CANCELED' });
            await assertEmpty(seed.run.id);
            expect(await runs.finish(seed.claimed.token, { code: 'EXECUTOR_FAILED' })).toBe(true);
            expect(
                await fixture.db.query.runs
                    .findFirst({ where: eq(dbRuns.id, seed.run.id) })
                    .then((row) => requiredDatabaseValue(row)),
            ).toMatchObject({
                status: 'canceled',
            });
        } finally {
            unlock();
            await cancel;
        }
    });

    it('事务末尾Inbox写入失败回滚来源、快照、证据、报告及Run状态', async () => {
        const seed = await research();
        await fixture.db.execute(
            sql.raw(
                `CREATE FUNCTION fail_delivery_inbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected inbox failure'; END $$`,
            ),
        );
        await fixture.db.execute(
            sql.raw(
                `CREATE TRIGGER fail_delivery_inbox BEFORE INSERT ON inbox_items FOR EACH ROW EXECUTE FUNCTION fail_delivery_inbox()`,
            ),
        );
        try {
            await expect(delivery.deliver(seed.claimed.token, seed.candidate)).rejects.toThrow();
            await assertEmpty(seed.run.id);
            expect(
                await fixture.db
                    .select({ count: dbCount() })
                    .from(dbSources)
                    .where(eq(dbSources.userId, seed.user.id))
                    .then((rows) => rows[0]!.count),
            ).toBe(0);
            expect(
                await fixture.db
                    .select({ count: dbCount() })
                    .from(dbSourceSnapshots)
                    .where(eq(dbSourceSnapshots.userId, seed.user.id))
                    .then((rows) => rows[0]!.count),
            ).toBe(0);
            expect(
                await fixture.db.query.runs
                    .findFirst({ where: eq(dbRuns.id, seed.run.id) })
                    .then((row) => requiredDatabaseValue(row)),
            ).toMatchObject({
                status: 'running',
                finishedAt: null,
            });
            expect(
                await fixture.db
                    .select({ count: dbCount() })
                    .from(dbRunEvents)
                    .where(
                        and(
                            eq(dbRunEvents.runId, seed.run.id),
                            eq(dbRunEvents.type, 'report.published'),
                        ),
                    )
                    .then((rows) => rows[0]!.count),
            ).toBe(0);
        } finally {
            await fixture.db.execute(sql.raw('DROP TRIGGER fail_delivery_inbox ON inbox_items'));
            await fixture.db.execute(sql.raw('DROP FUNCTION fail_delivery_inbox()'));
        }
        expect((await delivery.deliver(seed.claimed.token, seed.candidate)).reused).toBe(false);
    });

    it('deadline仅使用截止前成功正文，不再调用provider，确定性partial可交付', async () => {
        const seed = await research();
        await fixture.db
            .update(dbRuns)
            .set({ deadlineAt: new Date(Date.now() - 1) })
            .where(eq(dbRuns.id, seed.run.id))
            .returning()
            .then((rows) => requiredDatabaseValue(rows[0]));
        const partial = (await seed.session.partial())!;
        expect(partial.coverage.exhausted).toContain('time');
        const forged = structuredClone(partial);
        forged.claims[0].citations[0].quote = '截止后伪造的引用';
        await expect(delivery.deliver(seed.claimed.token, forged, true)).rejects.toMatchObject({
            code: 'INVALID_DELIVERY_EVIDENCE',
        });
        await assertEmpty(seed.run.id);
        // A stale or fabricated completeness flag cannot override the domain projection.
        partial.coverage = {
            completeness: 'complete',
            searchedQueries: [],
            gaps: [],
            exhausted: [],
        };
        const result = await delivery.deliver(seed.claimed.token, partial, true);
        expect(
            await fixture.db.query.reports
                .findFirst({ where: eq(dbReports.id, result.reportId) })
                .then((row) => requiredDatabaseValue(row)),
        ).toMatchObject({ completeness: 'partial' });
        expect(
            await fixture.db.query.runs
                .findFirst({ where: eq(dbRuns.id, seed.run.id) })
                .then((row) => requiredDatabaseValue(row)),
        ).toMatchObject({
            status: 'partial',
            outcome: 'inconclusive',
            coverageJson: { completeness: 'partial', exhausted: ['time'] },
        });
    });

    it('deadline拒绝截止后才确认的正文，取消后也不能走partial交付', async () => {
        const seed = await research();
        const partial = await seed.session.partial();
        expect(partial).not.toBeNull();
        await fixture.db
            .update(dbRuns)
            .set({ deadlineAt: new Date(0) })
            .where(eq(dbRuns.id, seed.run.id))
            .returning()
            .then((rows) => requiredDatabaseValue(rows[0]));
        await expect(delivery.deliver(seed.claimed.token, partial!, true)).rejects.toMatchObject({
            code: 'NO_EVIDENCE',
        });
        await fixture.db
            .update(dbRuns)
            .set({ status: 'cancel_requested', cancelRequestedAt: new Date() })
            .where(eq(dbRuns.id, seed.run.id))
            .returning()
            .then((rows) => requiredDatabaseValue(rows[0]));
        await expect(delivery.deliver(seed.claimed.token, partial!, true)).rejects.toMatchObject({
            code: 'RUN_CANCELED',
        });
        await assertEmpty(seed.run.id);
    });

    it('旧epoch交付拒绝；成功账本与候选无正文时NO_EVIDENCE失败不产生报告', async () => {
        const seed = await research();
        await fixture.db
            .update(dbRuns)
            .set({ leaseExpiresAt: new Date(0) })
            .where(eq(dbRuns.id, seed.run.id))
            .returning()
            .then((rows) => requiredDatabaseValue(rows[0]));
        const next = await runs.claim(seed.run.id, 'new-owner');
        expect(next.kind).toBe('claimed');
        await expect(delivery.deliver(seed.claimed.token, seed.candidate)).rejects.toMatchObject({
            code: 'LEASE_LOST',
        });
        await assertEmpty(seed.run.id);
        const empty = await seedRun(fixture.db);
        const base = createConnectorBundle();
        const bundle: ConnectorBundle = {
            ...base,
            reader: {
                async read() {
                    throw new Error('no body');
                },
            },
        };
        const runtime = createAgentRuntime({
            database: fixture.db,
            databaseUrl: fixture.databaseUrl,
            checkpointSchema: schema,
            bundle,
            enableDelivery: true,
        });
        try {
            await runtime.connect();
            expect(
                await new RunService({
                    repository: runs,
                    executorFactory: (token) => runtime.executorFactory(token),
                }).execute(empty.run.id),
            ).toBe('processed');
            expect(
                await fixture.db.query.runs
                    .findFirst({ where: eq(dbRuns.id, empty.run.id) })
                    .then((row) => requiredDatabaseValue(row)),
            ).toMatchObject({ status: 'failed', failureCode: 'NO_EVIDENCE' });
            await assertEmpty(empty.run.id);
        } finally {
            await runtime.close();
        }
    });

    it.each(['demo', 'live'] as const)(
        '生产runtime对%s缺配置明确失败，不交付演示报告',
        async (mode) => {
            const seed = await seedRun(fixture.db, { mode });
            const runtime = createAgentRuntime({
                database: fixture.db,
                databaseUrl: fixture.databaseUrl,
                checkpointSchema: schema,
                enableDelivery: true,
                env: {},
            });
            try {
                await runtime.connect();
                await new RunService({
                    repository: runs,
                    executorFactory: (token) => runtime.executorFactory(token),
                }).execute(seed.run.id);
                const run = await fixture.db.query.runs
                    .findFirst({ where: eq(dbRuns.id, seed.run.id) })
                    .then((row) => requiredDatabaseValue(row));
                expect(run).toMatchObject({
                    status: 'failed',
                    outcome: null,
                    failureCode: 'AGENT_CONFIGURATION_INVALID',
                });
                expect(
                    await fixture.db
                        .select({ count: dbCount() })
                        .from(dbReports)
                        .where(eq(dbReports.runId, seed.run.id))
                        .then((rows) => rows[0]!.count),
                ).toBe(0);
            } finally {
                await runtime.close();
            }
        },
    );
});
