import { MemorySaver } from '@langchain/langgraph';
import { describe, expect, it, vi } from 'vite-plus/test';
import { DEFAULT_TASK_BUDGET } from '@scova/models';
import { ConnectorError, createModelProvider, pageFingerprint } from '@scova/connectors';
import { createRuntime } from '../src/research/runtime.ts';
import { createSynthesisRequest } from '../src/research/nodes/synthesis/request.ts';
import { synthesizeNode } from '../src/research/nodes/synthesize.ts';
import { planNode } from '../src/research/nodes/plan.ts';
import { fieldSynthesisBatches } from '../src/research/synthesis-batches.ts';
import { gapActions, fieldChecksSchema } from '../src/research/loop.ts';
import { runResearchAgent } from '../src/research/graph.ts';
import type { ResearchState } from '../src/research/state.ts';
import type { AgentCandidate, AgentContext, AgentDependencies } from '../src/types.ts';

const requirement = {
    id: 'r0',
    format: 'research_report' as const,
    object: 'PostgreSQL 17',
    field: '快照建立时机',
    required: true,
    questionIds: ['q0'],
    verification: 'source_required' as const,
};

function fixture() {
    const context: AgentContext = {
        runId: crypto.randomUUID(),
        userId: crypto.randomUUID(),
        taskVersionId: crypto.randomUUID(),
        mode: 'live',
        startedAt: new Date(),
        deadlineAt: new Date(Date.now() + 600000),
        signal: new AbortController().signal,
        async assertActive() {},
        budget: { ...DEFAULT_TASK_BUDGET },
        usage: { pages: 0, searches: 0, inputTokens: 0, outputTokens: 0, estimated: false },
        config: {
            title: '事务快照',
            topic: 'PostgreSQL 17',
            goal: '快照建立时机',
            focusPoints: [],
            exclusions: [],
            researchMode: 'analysis',
            outputFormat: 'research_report',
            outputFormats: ['research_report'],
            sourcePreferences: { preferredUrls: [], excludedUrls: [], officialOnly: false },
            timeRange: { kind: 'rolling', days: 7 },
            timezone: 'UTC',
            schedule: { frequency: 'manual' },
            budget: { ...DEFAULT_TASK_BUDGET },
            notificationPreference: { mode: 'off', runIssues: false },
        },
    };
    const state: ResearchState = {
        schemaVersion: 1,
        runId: context.runId,
        userId: context.userId,
        taskVersionId: context.taskVersionId,
        mode: 'live',
        questions: [{ id: 'q0', text: context.config.goal }],
        queries: [],
        searchIndex: 0,
        searches: [],
        selections: [],
        readIndex: 0,
        pages: [],
        claims: [],
        synthesisAttempts: 0,
        gaps: [],
        notes: [],
        exhausted: [],
        ready: false,
        artifactPolicy: 1,
        evidencePolicy: 1,
        researchLoopPolicy: 1,
        gapKindPolicy: 1,
        coveragePolicy: 3,
        synthesisPolicy: 1,
        loopQualityPolicy: 1,
        gapLoopPolicy: 1,
        outputFormats: ['research_report'],
        planningExtraction: {
            operationKey: 'plan-0',
            response: {
                mode: 'live',
                data: { queries: [], requirements: [requirement] },
                usage: { inputTokens: 1, outputTokens: 1, estimated: false },
            },
        },
    };
    const model = vi.fn<AgentDependencies['tools']['model']>(async () => {
        throw new Error('Unexpected model dispatch');
    });
    const deps: AgentDependencies = {
        tools: {
            model,
            async read() {
                throw new Error('Unexpected read');
            },
            async search() {
                throw new Error('Unexpected search');
            },
        },
        checkpointer: new MemorySaver(),
        config: { configurable: { thread_id: context.runId } },
        async promote() {},
    };
    return {
        context,
        state,
        model,
        deps,
        runtime: createRuntime(context, deps, state.questions, state),
    };
}

describe('empty source synthesis boundaries', () => {
    it('compiles the real empty-page request schema, accepts insufficiency and rejects invented citations', async () => {
        const { state, runtime } = fixture();
        const batch = fieldSynthesisBatches(['research_report'], [requirement])[0]!;
        const { requestSchema } = createSynthesisRequest(runtime, state, {
            batch,
            requirements: [requirement],
            fieldActions: [],
            attempt: 0,
            batchLimits: { input: 40000, initial: 4000, repair: 4000 },
            synthesisOutputBudget: 8000,
            synthesisClaimLimit: 30,
            localTarget: undefined,
        });
        const data = {
            claims: [
                {
                    kind: 'insufficient',
                    text: '尚未取得可用正文。',
                    questionIds: ['q0'],
                    citations: [] as { pageId: string; quote: string }[],
                    outputFormat: 'research_report',
                    assessment: {
                        relevance: 'unknown',
                        support: 'none',
                        role: 'lead',
                        sourceRelation: 'unknown',
                        reason: '没有正文',
                        conditions: '',
                        gap: '缺少正文',
                        gapKind: 'missing_core',
                    },
                },
            ],
            artifacts: [
                {
                    format: 'research_report',
                    document: null,
                    requirements: [{ id: 'r0', text: '', claimIndexes: [] }],
                },
            ],
            evidenceLinks: [],
            fieldChecks: [
                {
                    requirementId: 'r0',
                    status: 'evidence_missing',
                    query: 'PostgreSQL 17 快照',
                    reason: '没有正文',
                },
            ],
        };
        const request = vi.fn(async () => ({
            status: 200,
            headers: {},
            url: 'https://model.example/v1/chat/completions',
            body: JSON.stringify({
                choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(data) } }],
                usage: { prompt_tokens: 10, completion_tokens: 10 },
            }),
        }));
        const provider = createModelProvider({
            model: 'fixture',
            apiKey: 'fixture',
            protocol: 'openai_json',
            baseUrl: 'https://model.example/v1',
            maxAttempts: 1,
            http: { request },
        });
        const input = {
            prompt: 'Return an honest insufficient result.',
            schema: requestSchema,
            maxInputTokens: 100000,
            maxOutputTokens: 1000,
        };
        await expect(provider.generateStructured(input)).resolves.toMatchObject({ data });
        data.claims[0]!.citations.push({ pageId: 'invented', quote: 'invented' });
        await expect(provider.generateStructured(input)).rejects.toMatchObject({
            code: 'invalid_response',
            modelFailure: 'schema',
        });
        expect(request).toHaveBeenCalledTimes(2);
    });

    it('does not spend model calls on empty eligible sources or discard previously accepted answers', async () => {
        const { state, runtime, model } = fixture();
        state.claims = [
            {
                kind: 'model_answer',
                text: '已保存的机制说明。',
                questionIds: ['q0'],
                citations: [],
            },
        ];
        const saved = structuredClone(state.claims);
        await synthesizeNode(runtime)(state);
        expect(model).not.toHaveBeenCalled();
        expect(state.claims).toEqual(saved);
        expect(state.synthesisAttempts).toBeGreaterThanOrEqual(2);
        expect(state.synthesisBatchIndex ?? 0).toBe(0);
    });

    it('retrieves actual missing material instead of repeatedly repairing nonexistent evidence', () => {
        const candidate = {
            pages: [],
            claims: [],
            coverage: {
                artifacts: [
                    {
                        coverage: {
                            requirements: [{ ...requirement, status: 'unknown', claimIndexes: [] }],
                        },
                    },
                ],
            },
        } as unknown as AgentCandidate;
        expect(gapActions(candidate, [requirement], [], true)[0]).toMatchObject({
            action: 'search',
            query: 'PostgreSQL 17 快照建立时机',
        });
        expect(gapActions(candidate, [requirement], [], false)[0]?.action).toBe('repair');
    });

    it.each(['read_timeout', 'date_unconfirmed'] as const)(
        'runs the bounded graph after %s without source-free synthesis, with bounded query correction',
        async (failure) => {
            const { context, deps, model } = fixture();
            Object.assign(context, {
                coverageDriven: true,
                fieldDriven: true,
                evidenceReasoning: true,
                gapDriven: true,
                gapLoop: true,
            });
            context.budget.maxSearches = 2;
            context.budget.maxPages = 2;
            context.config.budget = { ...context.budget };
            context.config.researchMode =
                failure === 'date_unconfirmed' ? 'collection' : 'analysis';
            const url = 'https://example.com/release';
            const sourceText = 'Version 24 was released.';
            model.mockImplementation(async (key, input) => {
                if (key.startsWith('search-rewrite-'))
                    return {
                        mode: 'live',
                        usage: { inputTokens: 1, outputTokens: 1, estimated: false },
                        data: {
                            query: 'PostgreSQL 17 snapshot release notes',
                            language: 'en',
                            reason: '查找英文官方发布记录',
                        },
                    };
                if (key !== 'plan-0') throw new Error(`Unexpected model call: ${key}`);
                return {
                    mode: 'live',
                    usage: { inputTokens: 1, outputTokens: 1, estimated: false },
                    researchPolicy: input.researchPolicy,
                    data: {
                        queries: [{ query: 'Initial source search', questionIds: ['q0'] }],
                        requirements: [requirement],
                    },
                };
            });
            deps.tools.search = vi.fn<AgentDependencies['tools']['search']>(async (_key, query) => {
                context.usage.searches++;
                return {
                    kind: 'search_results',
                    mode: 'live',
                    provider: 'searxng',
                    query,
                    searchedAt: new Date().toISOString(),
                    results: [
                        {
                            kind: 'search_snippet',
                            originalUrl: url,
                            url,
                            title: 'Source',
                            snippet: 'PostgreSQL 17 快照建立时机',
                        },
                    ],
                    coverage: {
                        complete: true,
                        gaps: [],
                        unresponsiveEngines: [],
                        truncated: false,
                        receivedResults: 1,
                        returnedResults: 1,
                        discardedResults: 0,
                        totalResults: 1,
                    },
                };
            });
            deps.tools.read = vi.fn<AgentDependencies['tools']['read']>(async () => {
                context.usage.pages++;
                if (failure === 'read_timeout')
                    throw new ConnectorError('timeout', 'Upstream read timed out', true);
                return {
                    kind: 'read_page',
                    mode: 'live',
                    originalUrl: url,
                    fetchedUrl: url,
                    url,
                    title: 'Source',
                    text: sourceText,
                    contentHash: pageFingerprint(sourceText),
                    collectedAt: new Date().toISOString(),
                    extractionVersion: 'fixture',
                    truncated: false,
                    untrusted: true,
                    publication: {
                        parserVersion: 'scova-publication-v2',
                        status: 'unknown',
                        instant: null,
                        observations: [],
                    },
                };
            });
            if (failure === 'read_timeout')
                await expect(runResearchAgent(context, deps)).rejects.toMatchObject({
                    code: 'NO_EVIDENCE',
                });
            else {
                const candidate = await runResearchAgent(context, deps);
                expect(candidate.coverage).toMatchObject({
                    completeness: 'partial',
                    metrics: { answeredFields: 0 },
                    dateScreening: { accepted: 0, unconfirmed: 1 },
                });
                expect(candidate.pages).toEqual([]);
                expect(
                    candidate.claims.every((c) => c.kind === 'insufficient' && !c.citations.length),
                ).toBe(true);
            }
            expect(model.mock.calls.map(([key]) => key)).toEqual(
                failure === 'date_unconfirmed' ? ['plan-0', 'search-rewrite-1'] : ['plan-0'],
            );
            expect(deps.tools.read).toHaveBeenCalledTimes(1);
            expect(vi.mocked(deps.tools.search).mock.calls.length).toBeLessThanOrEqual(2);
        },
    );

    it.each(['planning', 'synthesis'] as const)(
        'propagates a local configuration error from %s without model-output repair',
        async (stage) => {
            const { state, runtime, model } = fixture();
            state.pages = [{ id: 'read-0', text: '正文' } as ResearchState['pages'][number]];
            const error = new ConnectorError('configuration', '本地模型输出契约无效');
            model.mockRejectedValue(error);
            await expect(
                (stage === 'planning' ? planNode(runtime) : synthesizeNode(runtime))(state),
            ).rejects.toBe(error);
            expect(model).toHaveBeenCalledTimes(1);
        },
    );

    it('keeps an empty field diagnosis schema valid and closed to foreign entries', async () => {
        const provider = createModelProvider({
            model: 'fixture',
            apiKey: 'fixture',
            protocol: 'openai_json',
            baseUrl: 'https://model.example/v1',
            maxAttempts: 1,
            http: {
                async request() {
                    return {
                        status: 200,
                        headers: {},
                        body: JSON.stringify({
                            choices: [
                                {
                                    finish_reason: 'stop',
                                    message: { content: '{"fieldChecks":[]}' },
                                },
                            ],
                            usage: { prompt_tokens: 1, completion_tokens: 1 },
                        }),
                        url: 'https://model.example/v1/chat/completions',
                    };
                },
            },
        });
        await expect(
            provider.generateStructured({
                prompt: 'No targets.',
                schema: {
                    type: 'object',
                    properties: { fieldChecks: fieldChecksSchema([]) },
                    required: ['fieldChecks'],
                    additionalProperties: false,
                },
                maxInputTokens: 10000,
                maxOutputTokens: 1000,
            }),
        ).resolves.toMatchObject({ data: { fieldChecks: [] } });
    });
});
