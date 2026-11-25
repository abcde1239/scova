import { runStructuredFixture as runResearchAgent } from './structured-fixtures.ts';
import { createHash, randomUUID } from 'node:crypto';
import { MemorySaver } from '@langchain/langgraph';
import { describe, expect, it, vi } from 'vite-plus/test';
import {
    ConnectorError,
    FIRECRAWL_EXTRACTION_VERSION,
    normalizeUrl,
    type ReadPage,
} from '@scova/connectors';
import {
    compareResearch,
    candidateFromCheckpoint,
    type AgentBaseline,
    type AgentCandidate,
    type AgentContext,
    type AgentTools,
    type ComparisonFact,
    type ComparisonExtraction,
} from '../src/index.ts';

type Fact = Omit<ComparisonFact, 'id'>;
type Source = {
    url: string;
    text: string;
    facts: Fact[];
    publication?: string;
    truncated?: boolean;
};
const origin = 'https://example.org';
const date = '2026-10-25T00:00:00Z';
const fact = (
    subject: string,
    predicate: string,
    value: string,
    quote: string,
    extra: Partial<Fact> = {},
): Fact => ({
    subject,
    predicate,
    value,
    quote,
    relevance: 'relevant',
    importance: 'important',
    ...extra,
});
const source = (
    path: string,
    text: string,
    facts: Fact[],
    extra: Partial<Source> = {},
): Source => ({ url: `${origin}${path}`, text, facts, ...extra });
function context(): AgentContext {
    const budget = {
        maxSearches: 10,
        maxPages: 20,
        maxDurationSeconds: 300,
        maxInputTokens: 40000,
        maxOutputTokens: 12000,
    };
    return {
        runId: randomUUID(),
        userId: 'owner',
        taskVersionId: 'version',
        comparisonScopeHash: 'scope-live-v2',
        baselineRunId: null,
        mode: 'live',
        budget,
        usage: { searches: 0, pages: 0, inputTokens: 0, outputTokens: 0, estimated: false },
        startedAt: new Date('2026-10-26T00:00:00Z'),
        deadlineAt: new Date(Date.now() + 300000),
        signal: new AbortController().signal,
        assertActive: async () => {},
        config: {
            title: '持续研究',
            topic: '资料变化',
            goal: '核验目标相关事实',
            focusPoints: [],
            exclusions: ['付费和C1材料不推荐'],
            sourcePreferences: { preferredUrls: [], excludedUrls: [], officialOnly: false },
            timeRange: { kind: 'rolling', days: 7 },
            timezone: 'UTC',
            schedule: { frequency: 'manual' },
            outputFormat: 'brief',
            budget,
            notificationPreference: { mode: 'off', runIssues: false },
        },
    };
}
function baseline(candidate: AgentCandidate): AgentBaseline {
    return {
        runId: candidate.runId,
        userId: candidate.userId,
        comparisonScopeHash: candidate.manifest!.comparisonScopeHash,
        mode: candidate.mode,
        status: 'ready',
        coverage: candidate.coverage,
        manifest: candidate.manifest!,
        evidence: candidate.manifest!.pages.flatMap((p) =>
            p.facts.map((f) => ({
                id: `${candidate.runId}/${p.pageId}/${f.id}`,
                pageId: p.pageId,
                quote: f.quote,
            })),
        ),
    };
}
async function execute(
    sources: Source[],
    frozen?: AgentBaseline,
    options: {
        mutate?: (context: AgentContext) => void;
        failedUrls?: string[];
        badCompare?: boolean;
    } = {},
) {
    const ctx = context();
    if (frozen) {
        ctx.baseline = frozen;
        ctx.baselineRunId = frozen.runId;
    }
    options.mutate?.(ctx);
    let readCount = 0;
    const reads: string[] = [];
    const pages = new Map<string, Source>();
    const tools: AgentTools = {
        search: vi.fn<AgentTools['search']>(async (key, query) => {
            const offset = key === 'search-1' ? 10 : 0;
            const returned = sources.slice(offset, offset + 10);
            return {
                kind: 'search_results',
                mode: 'live',
                provider: 'searxng',
                query,
                searchedAt: date,
                results: returned.map((s) => ({
                    kind: 'search_snippet',
                    originalUrl: s.url,
                    url: normalizeUrl(s.url),
                    title: 'source',
                    snippet: 'not evidence',
                })),
                coverage: {
                    complete: true,
                    gaps: [],
                    unresponsiveEngines: [],
                    receivedResults: returned.length,
                    returnedResults: returned.length,
                    discardedResults: 0,
                    totalResults: returned.length,
                    truncated: false,
                },
            };
        }),
        read: vi.fn(async (_key, url): Promise<ReadPage> => {
            reads.push(url);
            if (options.failedUrls?.includes(normalizeUrl(url)))
                throw new ConnectorError('network', 'unreachable old page');
            const current = sources.find((s) => normalizeUrl(s.url) === normalizeUrl(url));
            if (!current) throw new ConnectorError('network', 'not observed');
            pages.set(`read-${readCount++}`, current);
            return {
                kind: 'read_page',
                mode: 'live',
                originalUrl: url,
                fetchedUrl: current.url,
                url: normalizeUrl(current.url),
                title: 'source',
                text: current.text,
                contentHash: createHash('sha256').update(current.text).digest('hex'),
                extractionVersion: 'reader-v1',
                collectedAt: date,
                truncated: current.truncated ?? false,
                untrusted: true,
                publication: {
                    parserVersion: 'scova-publication-v1',
                    status: 'unknown',
                    instant: null,
                    observations: [
                        {
                            field: 'datePublished',
                            rawValue: current.publication ?? date,
                            locator: 'meta',
                        },
                    ],
                },
            };
        }),
        model: vi.fn<AgentTools['model']>(async (key, input) => ({
            mode: 'live',
            researchPolicy: input.researchPolicy,
            usage: { inputTokens: 20, outputTokens: 20, estimated: false },
            data:
                key === 'plan-0'
                    ? {
                          queries: (sources.length > 10 ? ['facts', 'more facts'] : ['facts']).map(
                              (query) => ({ query, questionIds: ['q0'] }),
                          ),
                      }
                    : key.startsWith('compare-facts')
                      ? {
                            pages: (
                                input.untrustedSources as { pageId: string; url: string }[]
                            ).map((p) => ({
                                pageId: p.pageId,
                                facts: options.badCompare
                                    ? [{ ...sources[0]!.facts[0], value: 'fabricated value' }]
                                    : sources.find((s) => normalizeUrl(s.url) === p.url)!.facts,
                            })),
                        }
                      : {
                            claims: [...pages.entries()]
                                .slice(0, sources.length > 10 ? 1 : undefined)
                                .map(([pageId, s]) => ({
                                    kind: 'fact',
                                    assessment: {
                                        relevance: 'direct',
                                        support: 'direct',
                                        role: 'answer',
                                        sourceRelation: 'unknown',
                                        reason: '对比题的明确原文',
                                        conditions: '',
                                        gap: '',
                                    },
                                    text: s.facts[0]?.quote ?? s.text.slice(0, 100),
                                    citations: [
                                        {
                                            pageId,
                                            quote: s.facts[0]?.quote ?? s.text.slice(0, 100),
                                        },
                                    ],
                                    questionIds: ['q0'],
                                })),
                        },
        })),
    };
    // IDs are read operation indices, including failed reads, rather than success counters.
    const originalRead = tools.read;
    tools.read = vi.fn(async (key, url) => {
        const result = await originalRead(key, url);
        const selected = sources.find((s) => normalizeUrl(s.url) === normalizeUrl(url))!;
        pages.delete(`read-${readCount - 1}`);
        pages.set(key, selected);
        return result;
    });
    const checkpointer = new MemorySaver();
    const graphConfig = { configurable: { thread_id: randomUUID() } };
    const output = await runResearchAgent(ctx, {
        tools,
        checkpointer,
        config: graphConfig,
        promote: async () => {},
    });
    return { output, ctx, tools, reads, checkpointer, graphConfig };
}

describe('two-run continuous comparison through the persistent graph', () => {
    const enableReuse = (ctx: AgentContext) => {
        ctx.comparisonReuse = true;
    };
    const comparisonCalls = (run: Awaited<ReturnType<typeof execute>>) =>
        vi.mocked(run.tools.model).mock.calls.filter(([key]) => key.startsWith('compare-facts'));

    it('skips unchanged pages and preserves the original operation key for the changed tail page', async () => {
        const withLargeBudget = (ctx: AgentContext) => {
            enableReuse(ctx);
            ctx.budget = { ...ctx.budget, maxInputTokens: 160_000, maxOutputTokens: 60_000 };
        };
        const sources = Array.from({ length: 20 }, (_, i) => {
            const quote = `Source ${i} confirms the initial value.`;
            return source(`/item-${i}`, quote, [fact(`item-${i}`, 'value', 'initial', quote)]);
        });
        const first = await execute(sources, undefined, { mutate: withLargeBudget });
        expect(comparisonCalls(first)).toHaveLength(7);
        expect(first.output.manifest?.pages).toHaveLength(20);
        expect(first.output.coverage.baseline?.eligible).toBe(true);
        expect(first.output.manifest?.pages.every((p) => p.completeComparisonInput === 1)).toBe(
            true,
        );
        const previous = baseline(first.output);
        const same = await execute(sources, previous, { mutate: withLargeBudget });
        expect(comparisonCalls(same)).toHaveLength(0);
        expect(same.output.changes?.map((c) => c.kind)).toEqual(Array(20).fill('duplicate'));
        const checkpoint = (await same.checkpointer.getTuple(same.graphConfig))!.checkpoint
            .channel_values.research;
        expect(candidateFromCheckpoint(same.ctx, checkpoint)).toEqual(same.output);
        expect(() =>
            candidateFromCheckpoint({ ...same.ctx, baseline: null }, checkpoint),
        ).toThrow();

        const text = 'Source 19 confirms the revised value.';
        const changed = await execute(
            [
                ...sources.slice(0, 19),
                source('/item-19', text, [fact('item-19', 'value', 'revised', text)]),
            ],
            previous,
            { mutate: withLargeBudget },
        );
        const calls = comparisonCalls(changed);
        expect(calls.map(([key]) => key)).toEqual(['compare-facts-batch-6-v2']);
        expect(calls[0]![1].untrustedSources).toMatchObject([{ url: `${origin}/item-19` }]);
        expect(changed.output.changes?.at(-1)).toMatchObject({
            kind: 'changed',
            oldValue: 'initial',
            newValue: 'revised',
        });
    });

    it('extracts normally when coverage, evidence or scope cannot authorize reuse', async () => {
        const text = 'The original source confirms the price is free.';
        const sources = [source('/reuse-fallback', text, [fact('course', 'price', 'free', text)])];
        const first = await execute(sources, undefined, { mutate: enableReuse });
        const qualified = baseline(first.output);
        expect(qualified.manifest?.pages[0]?.completeComparisonInput).toBe(1);
        for (const reason of ['coverage', 'quote', 'scope'] as const) {
            const previous = structuredClone(qualified);
            if (reason === 'coverage') delete previous.manifest!.pages[0]!.completeComparisonInput;
            if (reason === 'quote') previous.evidence = [];
            if (reason === 'scope') previous.comparisonScopeHash = 'other-scope';
            const next = await execute(sources, previous, { mutate: enableReuse });
            expect(comparisonCalls(next)).toHaveLength(1);
        }
    });

    it.each(['search-api/deepseek/v1', FIRECRAWL_EXTRACTION_VERSION])(
        'does not certify complete-page comparisons from %s extracts even when locally untruncated',
        async (extractionVersion) => {
            const result = await execute([
                source('/api-extract', 'Price free.', [
                    fact('service', 'price', 'free', 'Price free.'),
                ]),
            ]);
            const pages = structuredClone(result.output.pages);
            const manifest = structuredClone(result.output.manifest!);
            pages[0].extractionVersion = extractionVersion;
            pages[0].truncated = false;
            manifest.pages[0].extractorVersion = pages[0].extractionVersion;
            const comparison = compareResearch(result.ctx, pages, manifest);
            expect(comparison.changes[0].kind).toBe('uncertain');
            expect(comparison.gaps.join(' ')).toContain('不能声明没有重要变化');
        },
    );
    it('英语材料：重复、同URL费用变化、新增、转载和排除分别分类并保留双方引用', async () => {
        const first = await execute([
            source('/english/lesson-1', 'B1 subtitles free', [
                fact('lesson-1', 'price', 'free', 'B1 subtitles free'),
            ]),
            source('/english/lesson-2', 'B1 subtitles free', [
                fact('lesson-2', 'price', 'free', 'B1 subtitles free'),
            ]),
        ]);
        expect(first.output.coverage.completeness).toBe('complete');
        expect(first.output.changes!.every((c) => c.kind === 'baseline')).toBe(true);
        const second = await execute(
            [
                source(
                    '/english/lesson-1?utm_source=email',
                    'B1 subtitles free',
                    [fact('lesson-1', 'price', 'free', 'B1 subtitles free')],
                    { publication: '2020-01-01T00:00:00Z' },
                ),
                source(
                    '/english/lesson-2',
                    'B1 subtitles paid',
                    [
                        fact('lesson-2', 'price', 'paid', 'B1 subtitles paid', {
                            relevance: 'excluded',
                        }),
                    ],
                    { publication: '2020-01-01T00:00:00Z' },
                ),
                source('/english/lesson-3', 'lesson-3 B1 subtitles free', [
                    fact('lesson-3', 'price', 'free', 'lesson-3 B1 subtitles free'),
                ]),
                source('/mirror/lesson-1', 'B1 subtitles free', [
                    fact('lesson-1', 'price', 'free', 'B1 subtitles free'),
                ]),
                source('/english/advanced', 'C1 no subtitles', [
                    fact('advanced', 'level', 'C1', 'C1 no subtitles', { relevance: 'excluded' }),
                ]),
            ],
            baseline(first.output),
        );
        expect(second.reads.slice(0, 2)).toEqual(first.output.manifest!.pages.map((p) => p.url));
        expect(second.output.coverage.completeness).toBe('complete');
        const changes = second.output.changes!;
        expect(changes.map((c) => c.kind)).toEqual([
            'duplicate',
            'changed',
            'new',
            'duplicate_candidate',
            'non_material',
        ]);
        expect(changes[1]).toMatchObject({
            oldValue: 'free',
            newValue: 'paid',
            important: true,
            newCitations: [{ quote: 'B1 subtitles paid' }],
        });
        expect(changes[1]!.oldEvidenceIds).toHaveLength(1);
        expect(changes.filter((c) => c.kind === 'new')).toHaveLength(1);
    });

    it('招生通知：同URL条件变化优先于其他来源相同hash，导航变化不发重要变化', async () => {
        const first = await execute([
            source('/admission/notice', 'Deadline November 15. Requirement B1.', [
                fact('admission', 'deadline', 'November 15', 'Deadline November 15.'),
                fact('admission', 'requirement', 'B1', 'Requirement B1.'),
            ]),
            source('/admission/faq', 'FAQ answer unchanged. Navigation 1.', [
                fact('faq', 'answer', 'unchanged', 'FAQ answer unchanged.', {
                    importance: 'non_material',
                }),
            ]),
            source('/other/new-values', 'Deadline November 22. Requirement B2.', [
                fact('other-institution', 'deadline', 'November 22', 'Deadline November 22.'),
            ]),
        ]);
        const second = await execute(
            [
                source('/admission/notice', 'Deadline November 22. Requirement B2.', [
                    fact('admission', 'deadline', 'November 22', 'Deadline November 22.'),
                    fact('admission', 'requirement', 'B2', 'Requirement B2.'),
                ]),
                source('/admission/faq', 'FAQ answer unchanged. Navigation 2.', [
                    fact('faq', 'answer', 'unchanged', 'FAQ answer unchanged.', {
                        importance: 'non_material',
                    }),
                ]),
                source('/other/new-values', 'Deadline November 22. Requirement B2.', [
                    fact('other-institution', 'deadline', 'November 22', 'Deadline November 22.'),
                ]),
                source('/admission/scholarship', 'New scholarship available', [
                    fact('scholarship', 'availability', 'available', 'New scholarship available'),
                ]),
                source('/blog/repost', `Deadline November 15. Source ${origin}/admission/notice`, [
                    fact('admission', 'deadline', 'November 15', 'Deadline November 15.', {
                        relation: {
                            kind: 'secondary',
                            url: `${origin}/admission/notice`,
                            quote: `Source ${origin}/admission/notice`,
                        },
                    }),
                ]),
            ],
            baseline(first.output),
        );
        expect(second.output.changes!.filter((c) => c.kind === 'changed')).toHaveLength(2);
        expect(
            second.output
                .changes!.filter((c) => c.kind === 'changed')
                .every((c) => c.oldEvidenceIds.length && c.newCitations.length && c.important),
        ).toBe(true);
        expect(second.output.changes!.find((c) => c.url.endsWith('/faq'))).toMatchObject({
            kind: 'non_material',
            important: false,
        });
        expect(second.output.changes!.find((c) => c.url.endsWith('/repost'))).toMatchObject({
            kind: 'duplicate_candidate',
            newValue: 'November 15',
        });
        const stale = second.output.claims.find(
            (claim) => claim.kind === 'inference' && claim.text.includes('转载可能滞后'),
        )!;
        expect(stale.citations.map((citation) => citation.quote)).toContain(
            'Deadline November 15.',
        );
        expect(stale.citations.map((citation) => citation.quote)).toContain(
            'Deadline November 22.',
        );
        const third = await execute(
            [
                source('/admission/faq', 'FAQ answer unchanged. Navigation 3.', [
                    fact('faq', 'answer', 'unchanged', 'FAQ answer unchanged.', {
                        importance: 'non_material',
                    }),
                ]),
            ],
            baseline(second.output),
            { failedUrls: [`${origin}/admission/notice`] },
        );
        expect(third.output.coverage.completeness).toBe('partial');
        expect(third.output.coverage.gaps.join(' ')).toContain('不能推断撤回');
        expect(third.output.changes!.some((c) => /withdraw|撤回/.test(c.newValue ?? ''))).toBe(
            false,
        );
    });

    it('研究原文：次级来源不新增独立证据，不同观点不等于推翻，修订保存new及双方changed', async () => {
        const first = await execute([
            source('/papers/a', 'Sample size 100. Effect positive.', [
                fact('paper-a', 'sample', '100', 'Sample size 100.'),
                fact('paper-a', 'effect', 'positive', 'Effect positive.'),
            ]),
            source('/news/a', `Summary of ${origin}/papers/a. Effect positive.`, [
                fact('paper-a', 'effect', 'positive', 'Effect positive.', {
                    relation: {
                        kind: 'secondary',
                        url: `${origin}/papers/a`,
                        quote: `Summary of ${origin}/papers/a.`,
                    },
                }),
            ]),
        ]);
        const second = await execute(
            [
                source('/papers/a', 'Sample size 100. Effect positive.', [
                    fact('paper-a', 'sample', '100', 'Sample size 100.'),
                    fact('paper-a', 'effect', 'positive', 'Effect positive.'),
                ]),
                source('/news/a', `Summary of ${origin}/papers/a. Effect positive.`, [
                    fact('paper-a', 'effect', 'positive', 'Effect positive.', {
                        relation: {
                            kind: 'secondary',
                            url: `${origin}/papers/a`,
                            quote: `Summary of ${origin}/papers/a.`,
                        },
                    }),
                ]),
                source(
                    '/papers/b',
                    `Different conditions from ${origin}/papers/a. Effect negative.`,
                    [
                        fact('paper-b', 'effect', 'negative', 'Effect negative.', {
                            relation: {
                                kind: 'contrasting',
                                url: `${origin}/papers/a`,
                                quote: `Different conditions from ${origin}/papers/a.`,
                            },
                        }),
                    ],
                ),
                source('/papers/a-revision', `Correction of ${origin}/papers/a. Sample size 120.`, [
                    fact('paper-a', 'sample', '120', 'Sample size 120.', {
                        relation: {
                            kind: 'revision',
                            url: `${origin}/papers/a`,
                            quote: `Correction of ${origin}/papers/a.`,
                        },
                    }),
                ]),
            ],
            baseline(first.output),
        );
        const correction = second.output.changes!.filter((c) => c.url.endsWith('a-revision'));
        expect(correction.map((c) => c.kind)).toEqual(['new', 'changed']);
        expect(correction[1]).toMatchObject({ oldValue: '100', newValue: '120', important: true });
        expect(correction[1]!.oldEvidenceIds).toHaveLength(1);
        expect(second.output.changes!.find((c) => c.url.endsWith('/news/a'))!.kind).toBe(
            'duplicate',
        );
        expect(second.output.coverage.completeness).toBe('complete');
        const viewpoint = second.output.claims.find(
            (claim) => claim.kind === 'inference' && claim.text.includes('两份原文'),
        )!;
        expect(viewpoint.citations.map((citation) => citation.quote)).toContain('Effect positive.');
        expect(viewpoint.citations.map((citation) => citation.quote)).toContain('Effect negative.');
        expect(viewpoint.citations.map((citation) => citation.quote)).toContain(
            `Different conditions from ${origin}/papers/a.`,
        );
        expect(
            second.output.claims.every((c) =>
                c.citations.every((e) =>
                    second.output.pages.find((p) => p.id === e.pageId)!.text.includes(e.quote),
                ),
            ),
        ).toBe(true);
    });

    it('title edits preserve frozen scope while scope/mode mismatch cannot authorize a baseline', async () => {
        const page = source('/facts', 'Price free.', [
            fact('item', 'price', 'free', 'Price free.'),
        ]);
        const first = await execute([page]);
        const frozen = baseline(first.output);
        const title = await execute([page], frozen, {
            mutate: (ctx) => {
                ctx.config.title = '新标题';
                ctx.taskVersionId = 'new-version';
            },
        });
        expect(title.output.changes![0]!.kind).toBe('duplicate');
        const changedScope = await execute([page], frozen, {
            mutate: (ctx) => {
                ctx.comparisonScopeHash = 'changed-source-scope';
            },
        });
        expect(changedScope.output.coverage.completeness).toBe('partial');
        expect(changedScope.output.changes![0]!.kind).toBe('uncertain');
        const mode = await execute([page], { ...frozen, mode: 'demo' });
        expect(mode.output.coverage.completeness).toBe('partial');
    });

    it('empty facts, fabricated values and unknown importance never imply no change', async () => {
        const page = source('/facts', 'Price free.', [
            fact('item', 'price', 'free', 'Price free.'),
        ]);
        const first = await execute([page]);
        const frozen = baseline(first.output);
        const empty = await execute([{ ...page, facts: [] }], frozen);
        expect(empty.output.coverage.completeness).toBe('partial');
        expect(empty.output.coverage.gaps.join(' ')).toContain('空清单');
        const fabricated = await execute([page], frozen, { badCompare: true });
        expect(fabricated.output.comparison).toBe('completed');
        expect(fabricated.output.manifest!.pages[0]!.facts).toEqual([]);
        expect(fabricated.output.changes).toContainEqual(
            expect.objectContaining({
                kind: 'uncertain',
                newValue: 'fabricated value',
                newCitations: [],
                important: false,
            }),
        );
        expect(fabricated.output.coverage.completeness).toBe('partial');
        const unknown = await execute(
            [{ ...page, facts: [{ ...page.facts[0]!, importance: 'unknown' }] }],
            frozen,
        );
        expect(unknown.output.changes![0]!.kind).toBe('uncertain');
        expect(unknown.output.coverage.completeness).toBe('partial');
        const changed = structuredClone(first.output.manifest!);
        changed.pages[0]!.facts[0]!.value = 'unsupported';
        expect(() => compareResearch(first.ctx, first.output.pages, changed)).toThrow();
    });
    it('does not suppress independent institutions or papers merely sharing a fact value', async () => {
        const first = await execute([
            source('/school-a', 'Institution A deadline November 15.', [
                fact('admission', 'deadline', 'November 15', 'Institution A deadline November 15.'),
            ]),
        ]);
        const next = await execute(
            [
                source('/school-a', 'Institution A deadline November 15.', [
                    fact(
                        'admission',
                        'deadline',
                        'November 15',
                        'Institution A deadline November 15.',
                    ),
                ]),
                source('/school-b', 'Institution B independently announces deadline November 15.', [
                    fact(
                        'admission',
                        'deadline',
                        'November 15',
                        'Institution B independently announces deadline November 15.',
                    ),
                ]),
            ],
            baseline(first.output),
        );
        expect(next.output.changes!.find((entry) => entry.url.endsWith('school-b'))!.kind).toBe(
            'new',
        );
    });
    it('extracts a change after character 32000 even with a reusable baseline', async () => {
        const front = 'Navigation data. '.repeat(2100);
        const event = (day: string) => {
            const quote = `Deadline November ${day}.`;
            return source('/late-change', `${front}${quote}`, [
                fact('item', 'deadline', `November ${day}`, quote),
            ]);
        };
        const mutate = (ctx: AgentContext) => {
            enableReuse(ctx);
            ctx.budget = { ...ctx.budget, maxInputTokens: 160_000 };
        };
        const first = await execute([event('15')], undefined, { mutate });
        expect(first.output.coverage.baseline?.eligible).toBe(true);
        expect(first.output.manifest?.pages[0]?.completeComparisonInput).toBe(1);
        const next = await execute([event('22')], baseline(first.output), { mutate });
        expect(comparisonCalls(next)).toHaveLength(1);
        expect(next.output.changes?.[0]).toMatchObject({
            kind: 'changed',
            newValue: 'November 22',
        });
    });

    it('marks budget-clipped comparison partial while retaining the long-page tail', async () => {
        const front = 'Price free. ' + 'Navigation data. '.repeat(2100);
        const old = source('/long', `${front} Deadline November 15.`, [
            fact('item', 'price', 'free', 'Price free.'),
        ]);
        const first = await execute([old], undefined, { mutate: enableReuse });
        expect(first.output.manifest?.pages[0]?.completeComparisonInput).toBeUndefined();
        const next = await execute(
            [{ ...old, text: `${front} Deadline November 22.` }],
            baseline(first.output),
        );
        expect(next.output.coverage.completeness).toBe('partial');
        expect(next.output.coverage.gaps.join(' ')).toContain('比较输入受预算限制');
        const comparisonCall = vi
            .mocked(next.tools.model)
            .mock.calls.find(([, input]) =>
                input.prompt.includes('Extract stable facts for longitudinal comparison'),
            );
        expect(JSON.stringify(comparisonCall?.[1].untrustedSources)).toContain(
            'Deadline November 22.',
        );
    });
    it('rebuilds missing legacy long-page coverage gaps from checkpoint receipts after resume', async () => {
        const run = await execute([
            source('/legacy-long', 'Price free. ' + 'Navigation data. '.repeat(2100), [
                fact('item', 'price', 'free', 'Price free.'),
            ]),
        ]);
        const saved = (await run.checkpointer.getTuple(run.graphConfig))!;
        const state = structuredClone(saved.checkpoint.channel_values.research) as {
            gaps: string[];
            comparisonExtractions: ComparisonExtraction[];
        };
        expect(state.comparisonExtractions[0]!.sourceCoverage?.version).toBe(1);
        state.gaps = [];
        const current = candidateFromCheckpoint(run.ctx, state);
        expect(current.coverage.completeness).toBe('partial');
        expect(current.coverage.gaps.join(' ')).toContain('比较输入受预算限制');
        for (const receipt of state.comparisonExtractions) delete receipt.sourceCoverage;
        const legacy = candidateFromCheckpoint(run.ctx, state);
        expect(legacy.coverage.completeness).toBe('partial');
        expect(legacy.coverage.gaps.join(' ')).toContain('旧比较记录缺少完整输入覆盖证明');
    });
    it('keeps legacy manifest-only checkpoints partial when long-page input coverage is unknown', async () => {
        const run = await execute([
            source('/manifest-only-long', 'Price free. ' + 'Navigation data. '.repeat(2100), [
                fact('item', 'price', 'free', 'Price free.'),
            ]),
        ]);
        const saved = (await run.checkpointer.getTuple(run.graphConfig))!;
        const state = structuredClone(saved.checkpoint.channel_values.research) as {
            gaps: string[];
            manifest?: AgentCandidate['manifest'];
            comparisonExtractions?: ComparisonExtraction[];
        };
        expect(state.manifest).toBeDefined();
        delete state.comparisonExtractions;
        state.gaps = [];
        const legacy = candidateFromCheckpoint(run.ctx, state);
        expect(legacy.comparison).toBe('completed');
        expect(legacy.manifest).toEqual(state.manifest);
        expect(legacy.coverage.completeness).toBe('partial');
        expect(legacy.coverage.gaps.join(' ')).toContain('旧比较记录缺少完整输入覆盖证明');
    });
    it.each([
        ['15 November 2026', 'November 15, 2026'],
        ['1 kg', '1000 g'],
        ['1.001 kg', '1001 g'],
    ])(
        'normalizes unambiguous presentation changes %s to %s without an important alert',
        async (before, after) => {
            const first = await execute([
                source('/value', `Value ${before}.`, [
                    fact('item', 'value', before, `Value ${before}.`),
                ]),
            ]);
            const next = await execute(
                [
                    source('/value', `Value ${after}.`, [
                        fact('item', 'value', after, `Value ${after}.`),
                    ]),
                ],
                baseline(first.output),
            );
            expect(next.output.changes![0]).toMatchObject({
                kind: 'non_material',
                important: false,
                oldValue: before,
                newValue: after,
            });
        },
    );
    it('cannot authorize unavailable baselines or evidence-free historical facts', async () => {
        const page = source('/facts', 'Price free.', [
            fact('item', 'price', 'free', 'Price free.'),
        ]);
        const first = await execute([page]);
        const unavailable = await execute([page], {
            ...baseline(first.output),
            status: 'unavailable',
            manifest: null,
        });
        expect(unavailable.output.coverage.completeness).toBe('partial');
        expect(unavailable.output.changes![0]!.kind).toBe('uncertain');
        const noEvidence = await execute([page], { ...baseline(first.output), evidence: [] });
        expect(noEvidence.output.coverage.completeness).toBe('partial');
        expect(noEvidence.output.changes![0]!.kind).toBe('uncertain');
    });
    it.each([
        ['CO', 'Co'],
        ['1 Mg', '1 mg'],
        ['9007199254740992 g', '9007199254740993 g'],
    ])(
        'preserves case-sensitive and exact decimal fact changes %s to %s',
        async (before, after) => {
            const first = await execute([
                source('/value', `Value ${before}.`, [
                    fact('item', 'value', before, `Value ${before}.`),
                ]),
            ]);
            const next = await execute(
                [
                    source('/value', `Value ${after}.`, [
                        fact('item', 'value', after, `Value ${after}.`),
                    ]),
                ],
                baseline(first.output),
            );
            expect(next.output.changes![0]).toMatchObject({
                kind: 'changed',
                important: true,
                oldValue: before,
                newValue: after,
            });
        },
    );
    it('classifies an explicitly extracted navigation timestamp change as non-material with both raw values', async () => {
        const first = await execute([
            source('/faq', 'Updated navigation 10:00.', [
                fact('faq-navigation', 'timestamp', '10:00', 'Updated navigation 10:00.', {
                    importance: 'non_material',
                }),
            ]),
        ]);
        const next = await execute(
            [
                source('/faq', 'Updated navigation 11:00.', [
                    fact('faq-navigation', 'timestamp', '11:00', 'Updated navigation 11:00.', {
                        importance: 'non_material',
                    }),
                ]),
            ],
            baseline(first.output),
        );
        expect(next.output.changes![0]).toMatchObject({
            kind: 'non_material',
            important: false,
            oldValue: '10:00',
            newValue: '11:00',
            newCitations: [{ quote: 'Updated navigation 11:00.' }],
        });
        expect(next.output.changes![0]!.oldEvidenceIds).toHaveLength(1);
    });
    it('a new semantic scope explicitly starts a new baseline instead of reusing history', async () => {
        const page = source('/facts?language=en', 'Price free.', [
            fact('item', 'price', 'free', 'Price free.'),
        ]);
        const first = await execute([page]);
        const next = await execute([page], baseline(first.output), {
            mutate: (ctx) => {
                ctx.comparisonScopeHash = 'new-scope';
                ctx.baselineRunId = null;
                ctx.baseline = null;
            },
        });
        expect(next.output.coverage.completeness).toBe('complete');
        expect(next.output.changes![0]!.kind).toBe('baseline');
        expect(next.output.manifest!.pages[0]!.url).toContain('language=en');
    });
});
