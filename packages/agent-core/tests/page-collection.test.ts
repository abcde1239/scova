import { runStructuredFixture as runResearchAgent } from './structured-fixtures.ts';
import { randomUUID } from 'node:crypto';
import { MemorySaver } from '@langchain/langgraph';
import { describe, expect, it, vi } from 'vite-plus/test';
import { pageFingerprint, type ReadPage } from '@scova/connectors';
import {
    candidateFromCheckpoint,
    deterministicPartial,
    type AgentCandidate,
    type AgentContext,
    type AgentTools,
} from '../src/index.ts';

const url = 'https://official.example/notice';
const text = 'The application deadline is 15 November 2026.';
const limited: ReadPage['collection'] = {
    version: 1,
    method: 'browser',
    complete: false,
    limitations: ['resource_limit'],
};
const full: ReadPage['collection'] = {
    version: 1,
    method: 'html',
    complete: true,
    limitations: [],
};

async function execute(collection: ReadPage['collection']) {
    const budget = {
        maxSearches: 1,
        maxPages: 1,
        maxDurationSeconds: 300,
        maxInputTokens: 40000,
        maxOutputTokens: 8000,
    };
    const context: AgentContext = {
        runId: randomUUID(),
        userId: 'owner',
        taskVersionId: 'version',
        mode: 'live',
        comparisonScopeHash: 'reader-collection-scope',
        baselineRunId: null,
        startedAt: new Date('2026-11-10T00:00:00Z'),
        budget,
        usage: { searches: 0, pages: 0, inputTokens: 0, outputTokens: 0, estimated: false },
        deadlineAt: new Date(Date.now() + 300000),
        signal: new AbortController().signal,
        assertActive: async () => {},
        config: {
            title: 'Application notices',
            topic: 'Application deadline',
            goal: 'When is the deadline?',
            researchMode: 'analysis',
            focusPoints: [],
            exclusions: [],
            sourcePreferences: { preferredUrls: [], excludedUrls: [], officialOnly: false },
            timeRange: { kind: 'rolling', days: 30 },
            timezone: 'UTC',
            schedule: { frequency: 'manual' },
            outputFormat: 'brief',
            budget,
            notificationPreference: { mode: 'off', runIssues: false },
        },
    };
    const tools: AgentTools = {
        search: vi.fn<AgentTools['search']>(async () => ({
            kind: 'search_results',
            mode: 'live',
            provider: 'searxng',
            query: 'deadline',
            searchedAt: new Date().toISOString(),
            results: [
                {
                    kind: 'search_snippet',
                    originalUrl: url,
                    url,
                    title: 'notice',
                    snippet: 'Candidate only',
                },
            ],
            coverage: {
                complete: true,
                gaps: [],
                unresponsiveEngines: [],
                receivedResults: 1,
                returnedResults: 1,
                discardedResults: 0,
                totalResults: 1,
                truncated: false,
            },
        })),
        read: vi.fn<AgentTools['read']>(async () => ({
            kind: 'read_page',
            mode: 'live',
            originalUrl: url,
            fetchedUrl: url,
            url,
            title: 'Application notice',
            text,
            contentHash: pageFingerprint(text),
            extractionVersion: 'reader-quality-fixture-v1',
            collectedAt: new Date().toISOString(),
            truncated: false,
            untrusted: true,
            collection: structuredClone(collection),
            publication: {
                parserVersion: 'scova-publication-v1',
                status: 'known',
                instant: '2026-11-09T00:00:00Z',
                observations: [
                    { field: 'datePublished', rawValue: '2026-11-09T00:00:00Z', locator: 'meta' },
                ],
            },
        })),
        model: vi.fn<AgentTools['model']>(async (key, input) => ({
            mode: 'live',
            usage: { inputTokens: 30, outputTokens: 30, estimated: false },
            data: key.startsWith('plan')
                ? { queries: [{ query: 'deadline', questionIds: ['q0'] }] }
                : key.startsWith('compare-facts')
                  ? {
                        pages: (input.untrustedSources as { pageId: string }[]).map((page) => ({
                            pageId: page.pageId,
                            facts: [
                                {
                                    subject: 'application',
                                    predicate: 'deadline',
                                    value: '15 November 2026',
                                    quote: text,
                                    relevance: 'relevant',
                                    importance: 'important',
                                },
                            ],
                        })),
                    }
                  : {
                        claims: [
                            {
                                kind: 'fact',
                                assessment: {
                                    relevance: 'direct',
                                    support: 'direct',
                                    role: 'answer',
                                    sourceRelation: 'unknown',
                                    reason: 'The deadline is explicitly stated in the collected notice.',
                                    conditions: '',
                                    gap: '',
                                },
                                text,
                                questionIds: ['q0'],
                                citations: [{ pageId: 'read-0', quote: text }],
                            },
                        ],
                    },
        })),
    };
    const checkpointer = new MemorySaver();
    const config = { configurable: { thread_id: randomUUID() } };
    const candidate = await runResearchAgent(context, {
        tools,
        checkpointer,
        config,
        promote: async () => {},
    });
    const saved = (await checkpointer.getTuple(config))!;
    const state = structuredClone(saved.checkpoint.channel_values.research) as {
        gaps: string[];
        pages: AgentCandidate['pages'];
    };
    return { context, candidate, state };
}

describe('Reader collection receipts survive Agent projection and checkpoint recovery', () => {
    it.each(['content_restricted', 'interaction_required', 'visual_structure'] as const)(
        'retains %s through model output, comparison and checkpoint recovery',
        async (reason) => {
            const collection: ReadPage['collection'] = {
                version: 1,
                method: 'html',
                complete: false,
                limitations: [reason],
            };
            const run = await execute(collection);
            expect(run.candidate.pages[0].collection).toEqual(collection);
            expect(run.candidate.coverage.completeness).toBe('partial');
            expect(run.candidate.changes?.[0].kind).toBe('uncertain');
            run.state.gaps = [];
            const restored = candidateFromCheckpoint(run.context, run.state);
            expect(restored.coverage.completeness).toBe('partial');
            expect(restored.coverage.gaps.join(' ')).toContain(
                reason === 'content_restricted'
                    ? '公开摘要或订阅预览'
                    : reason === 'interaction_required'
                      ? '需交互加载'
                      : '图形连接与空间关系',
            );
            expect(restored.changes?.[0].kind).toBe('uncertain');
        },
    );

    it('keeps a limited rendered page partial even after checkpoint gaps are removed', async () => {
        const run = await execute(limited);
        expect(run.candidate.pages[0].text).toBe(text);
        expect(run.candidate.pages[0].truncated).toBe(false);
        expect(run.candidate.pages[0].collection).toEqual(limited);
        expect(run.candidate.coverage.completeness).toBe('partial');
        run.state.gaps = [];
        const restored = candidateFromCheckpoint(run.context, run.state);
        expect(restored.coverage.completeness).toBe('partial');
        expect(restored.coverage.gaps.join(' ')).toContain('网页渲染或资源加载受限');
    });

    it('keeps incomplete acquisition uncertain in longitudinal comparison', async () => {
        const run = await execute(limited);
        expect(run.candidate.comparison).toBe('completed');
        expect(run.candidate.changes).toHaveLength(1);
        expect(run.candidate.changes?.[0]).toMatchObject({ kind: 'uncertain', important: false });
        expect(
            run.candidate.changes?.some(
                (change) => change.kind === 'baseline' || change.kind === 'duplicate',
            ),
        ).toBe(false);
        run.state.gaps = [];
        expect(candidateFromCheckpoint(run.context, run.state).changes).toEqual(
            run.candidate.changes,
        );
    });

    it('allows complete static acquisition to create the first comparison baseline', async () => {
        const run = await execute(full);
        expect(run.candidate.coverage.gaps).toEqual([]);
        expect(run.candidate.coverage.completeness).toBe('complete');
        expect(run.candidate.changes?.[0].kind).toBe('baseline');
        expect(run.candidate.coverage.gaps.join(' ')).not.toContain('网页渲染或资源加载受限');
    });

    it.each([
        { version: 1, method: 'browser', complete: true, limitations: ['resource_limit'] },
        { version: 1, method: 'browser', complete: false, limitations: [] },
        { version: 1, method: 'browser', complete: false, limitations: ['unknown'] },
        {
            version: 1,
            method: 'browser',
            complete: false,
            limitations: ['resource_limit', 'resource_limit'],
        },
        { version: 2, method: 'browser', complete: true, limitations: [] },
        { version: 1, method: 'model', complete: true, limitations: [] },
        null,
    ])('rejects malformed checkpoint collection metadata %#', async (forged) => {
        const run = await execute(full);
        run.state.pages[0].collection = forged as ReadPage['collection'];
        run.state.gaps = [];
        expect(() => candidateFromCheckpoint(run.context, run.state)).toThrowError(
            expect.objectContaining({ code: 'INVALID_STATE' }),
        );
    });

    it('retains acquisition limitations in deterministic deadline recovery', async () => {
        const run = await execute(limited);
        const recovered = deterministicPartial(run.context, run.candidate.pages);
        expect(recovered.coverage.completeness).toBe('partial');
        expect(recovered.coverage.gaps.join(' ')).toContain('网页渲染或资源加载受限');
        expect(recovered.pages[0].collection).toEqual(limited);
    });
});
