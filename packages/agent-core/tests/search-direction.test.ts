import { MemorySaver } from '@langchain/langgraph';
import { describe, expect, it, vi } from 'vite-plus/test';
import { DEFAULT_TASK_BUDGET } from '@scova/models';
import { ConnectorError, createModelProvider, type SearchResponse } from '@scova/connectors';
import { createRuntime } from '../src/research/runtime.ts';
import { gapLoopNode } from '../src/research/nodes/gap-loop.ts';
import { searchNode } from '../src/research/nodes/search.ts';
import { planNode } from '../src/research/nodes/plan.ts';
import { deterministicClaims } from '../src/research/claims.ts';
import { verifyIdentity } from '../src/research/identity.ts';
import { sourceDirectoryHints } from '../src/search/source-directory.ts';
import { diversifyQueries } from '../src/search/recovery.ts';
import { rewriteGapSearch, gapSearchQuery, sameSearch } from '../src/search/direction.ts';
import type { ResearchState } from '../src/research/state.ts';
import type { AgentContext, AgentDependencies } from '../src/types.ts';

function fixture() {
    const budget = {
        ...DEFAULT_TASK_BUDGET,
        maxSearches: 4,
        maxPages: 8,
        maxInputTokens: 80000,
        maxOutputTokens: 16000,
    };
    const context: AgentContext = {
        runId: 'run',
        userId: 'owner',
        taskVersionId: 'version',
        mode: 'live',
        startedAt: new Date('2026-11-18T00:00:00Z'),
        deadlineAt: new Date(Date.now() + 600000),
        signal: new AbortController().signal,
        async assertActive() {},
        budget,
        usage: { searches: 1, pages: 0, inputTokens: 0, outputTokens: 0, estimated: false },
        config: {
            title: 'Node',
            topic: 'Node.js 24',
            goal: '发布说明',
            focusPoints: [],
            exclusions: ['其他运行时'],
            researchMode: 'collection',
            outputFormat: 'brief',
            outputFormats: ['brief'],
            sourcePreferences: { preferredUrls: [], excludedUrls: [], officialOnly: false },
            timeRange: { kind: 'unbounded' },
            timezone: 'UTC',
            schedule: { frequency: 'manual' },
            budget,
            notificationPreference: { mode: 'off', runIssues: false },
        },
    };
    const state: ResearchState = {
        schemaVersion: 1,
        runId: 'run',
        userId: 'owner',
        taskVersionId: 'version',
        mode: 'live',
        questions: [{ id: 'q0', text: '发布说明' }],
        queries: [{ query: 'Node.js 24 发布说明', questionIds: ['q0'], language: 'zh' }],
        searchIndex: 1,
        searches: [],
        selections: [],
        readIndex: 0,
        pages: [],
        claims: [],
        synthesisAttempts: 2,
        notes: [],
        gaps: ['未获得目标正文'],
        exhausted: [],
        ready: false,
        artifactPolicy: 1,
        evidencePolicy: 1,
        researchLoopPolicy: 1,
        coveragePolicy: 3,
        collectionPolicy: 1,
        synthesisPolicy: 1,
        loopQualityPolicy: 1,
        gapLoopPolicy: 1,
        searchDirectionPolicy: 1,
        outputFormats: ['brief'],
        planningExtraction: {
            operationKey: 'plan-0',
            response: {
                mode: 'live',
                usage: { inputTokens: 1, outputTokens: 1, estimated: false },
                data: {
                    requirements: [
                        {
                            id: 'r0',
                            format: 'brief',
                            object: 'Node.js 24',
                            field: '发布说明',
                            required: true,
                            questionIds: ['q0'],
                            verification: 'source_required',
                        },
                    ],
                },
            },
        },
    };
    const model = vi.fn<AgentDependencies['tools']['model']>(async () => ({
        mode: 'live',
        usage: { inputTokens: 10, outputTokens: 10, estimated: false },
        data: {
            query: 'Node.js 24 release notes site:nodejs.org',
            language: 'en',
            reason: '转查英文官方发布记录',
        },
    }));
    const search = vi.fn<AgentDependencies['tools']['search']>(async (_key, query) => {
        context.usage.searches++;
        return {
            kind: 'search_results',
            mode: 'live',
            provider: 'searxng',
            query,
            searchedAt: context.startedAt!.toISOString(),
            results: [],
            coverage: {
                complete: true,
                gaps: [],
                unresponsiveEngines: [],
                receivedResults: 0,
                returnedResults: 0,
                discardedResults: 0,
                totalResults: 0,
                truncated: false,
            },
        } satisfies SearchResponse;
    });
    const deps: AgentDependencies = {
        tools: {
            model,
            search,
            async read() {
                throw new Error('unexpected read');
            },
        },
        checkpointer: new MemorySaver(),
        config: { configurable: { thread_id: 'run' } },
        async promote() {},
    };
    state.claims = deterministicClaims(state).map((claim) => ({ ...claim, outputFormat: 'brief' }));
    const runtime = createRuntime(context, deps, state.questions, state);
    return { state, context, deps, model, search, runtime };
}
const target = {
    requirementId: 'r0',
    questionIds: ['q0'],
    action: 'search' as const,
    query: 'Node.js 24 发布说明',
};

describe('source-language search correction', () => {
    it('uses the real model wire schema, corrects a source-free gap, persists language and stops duplicate directions', async () => {
        const f = fixture();
        const provider = createModelProvider({
            apiKey: 'fixture',
            model: 'fixture',
            http: {
                request: async () => ({
                    url: 'https://model.example',
                    status: 200,
                    headers: {},
                    body: JSON.stringify({
                        choices: [
                            {
                                finish_reason: 'stop',
                                message: {
                                    content: JSON.stringify({
                                        query: 'Node.js 24 release notes site:nodejs.org',
                                        language: 'en',
                                        reason: '转查英文官方发布记录',
                                    }),
                                },
                            },
                        ],
                        usage: { prompt_tokens: 10, completion_tokens: 10 },
                    }),
                }),
            },
        });
        f.model.mockImplementation(async (_key, input) => provider.generateStructured(input));
        await gapLoopNode(f.runtime)(f.state);
        expect(f.model).toHaveBeenCalledTimes(1);
        expect(f.state.gapLoop?.target).toMatchObject({ action: 'search', language: 'en' });
        expect(f.state.queries.at(-1)).toMatchObject({
            query: 'Node.js 24 release notes site:nodejs.org',
            language: 'en',
            questionIds: ['q0'],
        });
        await searchNode(f.runtime)(f.state);
        expect(f.search).toHaveBeenCalledWith(
            'search-1',
            'Node.js 24 release notes site:nodejs.org',
            { language: 'en' },
        );
        await gapLoopNode(f.runtime)(f.state);
        expect(f.state.gapLoop?.stopped).toBe(true);
        expect(f.state.verificationStopReason).toBe('no_progress');
        expect(f.search).toHaveBeenCalledTimes(1);
        expect(f.state.pages).toEqual([]);
        expect(f.state.claims.every((c) => c.kind === 'insufficient' && !c.citations.length)).toBe(
            true,
        );
    });

    it('does not add another model call when synthesis already supplied the query language', async () => {
        const f = fixture();
        const corrected = { ...target, query: 'Node.js 24 release notes', language: 'en' as const };
        expect(await rewriteGapSearch(f.runtime, f.state, corrected)).toBe(corrected);
        expect(f.model).not.toHaveBeenCalled();
        expect(gapSearchQuery(corrected, f.runtime).query).toBe(corrected.query);
    });

    it('stops after two target attempts with no gain even when rewrites keep changing', async () => {
        const f = fixture();
        let n = 0;
        f.model.mockImplementation(async () => ({
            mode: 'live',
            data: {
                query: `Node.js 24 release notes ${++n}`,
                language: 'en',
                reason: '改查官方记录',
            },
            usage: { inputTokens: 1, outputTokens: 1, estimated: false },
        }));
        for (let i = 0; i < 2; i++) {
            await gapLoopNode(f.runtime)(f.state);
            await searchNode(f.runtime)(f.state);
        }
        await gapLoopNode(f.runtime)(f.state);
        expect(f.state.gapLoop?.stopped).toBe(true);
        expect(f.model).toHaveBeenCalledTimes(2);
        expect(f.search).toHaveBeenCalledTimes(2);
    });

    it('preserves old checkpoints and respects search budget, deadline and model quota', async () => {
        const legacy = fixture();
        delete legacy.state.searchDirectionPolicy;
        expect(await rewriteGapSearch(legacy.runtime, legacy.state, target)).toBe(target);
        expect(legacy.model).not.toHaveBeenCalled();
        for (const kind of ['search', 'deadline'] as const) {
            const f = fixture();
            if (kind === 'search') f.context.usage.searches = f.context.budget.maxSearches;
            else f.context.deadlineAt = new Date(Date.now() + 10000);
            await gapLoopNode(f.runtime)(f.state);
            expect(f.model).not.toHaveBeenCalled();
            expect(f.state.gapLoop?.stopped).toBe(true);
        }
        const quota = fixture();
        quota.model.mockRejectedValue(new ConnectorError('model_quota_exceeded', 'quota'));
        await gapLoopNode(quota.runtime)(quota.state);
        expect(quota.state.verificationStopReason).toBe('provider_unavailable');
        expect(quota.state.queries).toHaveLength(1);
    });

    it('keeps task constraints and candidate snippets separate from evidence in rewrite input', async () => {
        const f = fixture();
        await rewriteGapSearch(f.runtime, f.state, target);
        const input = f.model.mock.calls[0][1];
        expect(input.prompt).toContain('其他运行时');
        expect(input.prompt).toContain('Node.js 24');
        expect(input.prompt).toContain('UNTRUSTED');
        expect(input.prompt).toContain('not to bypass 403/login');
        expect(input.maxOutputTokens).toBeLessThanOrEqual(384);
        f.model.mockClear();
        f.context.budget.maxInputTokens = 4500;
        await rewriteGapSearch(f.runtime, f.state, target);
        expect(f.model).not.toHaveBeenCalled();
    });

    it('plans source-language queries and rejects invalid language in a restored checkpoint', async () => {
        const f = fixture();
        f.model.mockResolvedValue({
            mode: 'live',
            usage: { inputTokens: 1, outputTokens: 1, estimated: false },
            data: {
                queries: [
                    { query: 'Node.js 24 release notes', language: 'en', questionIds: ['q0'] },
                ],
                requirements: (
                    f.state.planningExtraction!.response.data as { requirements: unknown[] }
                ).requirements,
                knowledgePlan: [],
            },
        });
        await planNode(f.runtime)(f.state);
        expect(f.state.queries[0].language).toBe('en');
        expect(JSON.stringify(f.model.mock.calls[0][1].schema)).toContain('"language"');
        f.state.queries[0].language = 'invalid' as 'en';
        expect(() => verifyIdentity(f.state, f.context)).toThrow();
    });

    it.each([1, 2, 3] as const)(
        'keeps geographic guidance versioned for planning and gap rewrite (%s)',
        async (policy) => {
            const f = fixture();
            f.state.searchDirectionPolicy = policy;
            const planning = f.state.planningExtraction!.response;
            f.model.mockImplementationOnce(async (_key, input) => ({
                ...planning,
                researchPolicy: input.researchPolicy,
                data: {
                    ...(planning.data as object),
                    knowledgePlan: [],
                    queries: [{ ...f.state.queries[0] }],
                },
            }));
            await planNode(f.runtime)(f.state);
            expect(f.model.mock.calls[0][1].prompt.includes('Geographic scope:')).toBe(
                policy !== 1,
            );
            expect(f.model.mock.calls[0][1].researchPolicy?.searchDirectionPolicy).toBe(policy);
            expect(() => verifyIdentity(f.state, f.context)).not.toThrow();
            if (policy === 3) {
                f.state.planningExtraction!.response.researchPolicy!.searchDirectionPolicy = 2;
                expect(() => verifyIdentity(f.state, f.context)).toThrow('规划回执不一致');
                f.state.planningExtraction!.response.researchPolicy!.searchDirectionPolicy = 3;
            }
            await rewriteGapSearch(f.runtime, f.state, target);
            expect(f.model.mock.calls[1][1].prompt.includes('Geographic scope:')).toBe(
                policy !== 1,
            );
        },
    );

    it('uses a second publisher language after a source-free search yields no evidence', async () => {
        const f = fixture();
        f.state.searchDirectionPolicy = 3;
        await gapLoopNode(f.runtime)(f.state);
        await searchNode(f.runtime)(f.state);
        f.model.mockResolvedValueOnce({
            mode: 'live',
            usage: { inputTokens: 1, outputTokens: 1, estimated: false },
            data: { query: 'Node.js 24 リリースノート', language: 'ja', reason: '尝试日文资料' },
        });
        await gapLoopNode(f.runtime)(f.state);
        expect(f.model.mock.calls[1]?.[0]).toBe('search-rewrite-2-1');
        const prompt = f.model.mock.calls[1]?.[1].prompt;
        expect(prompt).toContain('"changeDirection":true');
        expect(prompt).toContain('Node.js 24 release notes site:nodejs.org');
        expect(prompt).toContain('wikipedia.org');
        await searchNode(f.runtime)(f.state);
        expect(f.search).toHaveBeenLastCalledWith('search-2', 'Node.js 24 リリースノート', {
            language: 'ja',
        });
        await gapLoopNode(f.runtime)(f.state);
        expect(f.state.gapLoop?.history.map((h) => h.gain)).toEqual([false, false]);
        expect(f.state.gapLoop?.stopped).toBe(true);
        expect(f.model).toHaveBeenCalledTimes(2);
    });

    it('reuses an already diagnosed new language but rejects a same-language rephrase', async () => {
        const f = fixture();
        f.state.searchDirectionPolicy = 3;
        const tried = { ...target, language: 'zh' as const };
        expect(
            await rewriteGapSearch(f.runtime, f.state, { ...target, language: 'ja' }),
        ).toMatchObject({
            language: 'ja',
        });
        expect(f.model).not.toHaveBeenCalled();
        const data = { query: 'Node.js 24 的版本发布说明', language: 'zh', reason: '改写' };
        f.model.mockResolvedValueOnce({
            mode: 'live',
            data,
            usage: { inputTokens: 1, outputTokens: 1, estimated: false },
        });
        expect(await rewriteGapSearch(f.runtime, f.state, tried)).toBeUndefined();
        f.state.searchDirectionPolicy = 2;
        expect(await rewriteGapSearch(f.runtime, f.state, tried)).toBe(tried);
        expect(f.model).toHaveBeenCalledTimes(1);
    });

    it('uses a relevant regional directory without switching language or changing jurisdiction', async () => {
        const f = fixture();
        f.state.searchDirectionPolicy = 3;
        f.context.config.topic = 'UK Employment Rights Act 1996';
        f.context.config.goal = '英国法条';
        const regional = {
            ...target,
            query: 'UK Employment Rights Act 1996 section 1',
            language: 'en' as const,
        };
        f.state.queries[0] = regional;
        const data = {
            query: regional.query + ' site:legislation.gov.uk',
            language: 'en',
            reason: '转查英国法条库',
        };
        f.model.mockResolvedValue({
            mode: 'live',
            data,
            usage: { inputTokens: 1, outputTokens: 1, estimated: false },
        });
        expect(await rewriteGapSearch(f.runtime, f.state, regional)).toMatchObject(data);
        expect(f.model.mock.calls[0][1].prompt).toContain('not country filters');
        expect(f.model.mock.calls[0][1].prompt).toContain('"region":"United Kingdom"');
        f.state.queries.push({ ...regional, query: data.query });
        expect(await rewriteGapSearch(f.runtime, f.state, regional)).toBeUndefined();
    });

    it('limits directory suggestions and honors excluded sites and official-only mode', async () => {
        const f = fixture();
        f.state.searchDirectionPolicy = 3;
        const hints = sourceDirectoryHints(f.context, '浏览器 DOM API');
        expect(hints.map((h) => h.site)).toEqual([
            'developer.mozilla.org',
            'wikipedia.org',
            'wikidata.org',
        ]);
        expect(hints[1].use).toContain('not primary evidence');
        const prefs = f.context.config.sourcePreferences;
        prefs.excludedUrls = ['https://wikipedia.org/'];
        const data = {
            query: 'Node.js 24 release site:en.wikipedia.org',
            language: 'en',
            reason: '查词条',
        };
        f.model.mockResolvedValue({
            mode: 'live',
            data,
            usage: { inputTokens: 1, outputTokens: 1, estimated: false },
        });
        expect(await rewriteGapSearch(f.runtime, f.state, target)).toBeUndefined();
        expect(
            sourceDirectoryHints(f.context, '浏览器 DOM API').some(
                (h) => h.site === 'wikipedia.org',
            ),
        ).toBe(false);
        prefs.excludedUrls = [];
        prefs.officialOnly = true;
        prefs.preferredUrls = ['https://nodejs.org/'];
        expect(sourceDirectoryHints(f.context, '浏览器 DOM API')).toEqual([]);
        expect(await rewriteGapSearch(f.runtime, f.state, target)).toBeUndefined();
    });

    it('prefers an observed URL over rewriting and never reads a catalog homepage', async () => {
        const f = fixture();
        f.state.searchDirectionPolicy = 3;
        const query = f.state.queries[0];
        const response = await f.search('initial', query.query, { language: 'zh' });
        const url = 'https://nodejs.org/en/blog/release/v24.0.0';
        response.results.push({
            kind: 'search_snippet',
            url,
            originalUrl: url,
            title: 'Node.js 24 发布说明',
            snippet: 'Node.js 24 发布说明',
        });
        f.state.searches.push({ query, response });
        await gapLoopNode(f.runtime)(f.state);
        expect(f.state.gapLoop?.target).toMatchObject({ action: 'read', url });
        expect(f.state.selections.map((s) => s.url)).toEqual([url]);
        expect(f.model).not.toHaveBeenCalled();
    });

    it.each(['search', 'read', 'deadline', 'input', 'output'] as const)(
        'does not pay for a diversity rewrite after the %s gate closes',
        async (limit) => {
            const f = fixture();
            f.state.searchDirectionPolicy = 3;
            await gapLoopNode(f.runtime)(f.state);
            await searchNode(f.runtime)(f.state);
            if (limit === 'search') f.context.usage.searches = f.context.budget.maxSearches;
            if (limit === 'read') f.context.usage.pages = f.context.budget.maxPages;
            if (limit === 'deadline') f.context.deadlineAt = new Date(Date.now() + 30_000);
            if (limit === 'input')
                f.context.usage.inputTokens = f.context.budget.maxInputTokens - 7999;
            if (limit === 'output')
                f.context.usage.outputTokens = f.context.budget.maxOutputTokens - 1599;
            await gapLoopNode(f.runtime)(f.state);
            expect(f.state.gapLoop?.stopped).toBe(true);
            expect(f.model).toHaveBeenCalledTimes(1);
            expect(f.search).toHaveBeenCalledTimes(1);
        },
    );

    it('distinguishes identical text with different languages when deduplicating', () => {
        const queries = ['en', 'ja', 'en'].map((language) => ({
            query: 'Node.js 24',
            questionIds: ['q0'],
            language: language as 'en' | 'ja',
        }));
        expect(diversifyQueries(queries)).toHaveLength(2);
        expect(sameSearch(queries[0], queries[1])).toBe(false);
    });
});
