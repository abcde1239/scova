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
