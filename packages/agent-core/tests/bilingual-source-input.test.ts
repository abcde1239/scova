import { describe, expect, it, vi } from 'vite-plus/test';
import { MemorySaver } from '@langchain/langgraph';
import { createHash } from 'node:crypto';
import { ConnectorError, estimateModelInputTokens, type StructuredInput } from '@scova/connectors';
import { runResearchAgent, type AgentContext, type AgentDependencies } from '../src/index.ts';
import { bilingualRetrievalTerms, retrievalTermMatcher } from '../src/retrieval-terms.ts';
import {
    bilingualWatcherBody,
    watcherSourceParagraphs,
    watcherTaskFixture,
} from './fixtures/bilingual-task-source.ts';

describe('production source input from bilingual task requirements', () => {
    it.each(['zh', 'en'] as const)(
        'retains lifecycle conditions and manual action using the actual %s task path',
        async (language) => {
            const task = watcherTaskFixture[language];
            const url = 'https://vuejs.org/guide/essentials/watchers.html';
            const budget = {
                maxSearches: 2,
                maxPages: 1,
                maxDurationSeconds: 180,
                maxInputTokens: 40000,
                maxOutputTokens: 18000,
            };
            const requirements = task.fields.map((field, index) => ({
                id: `r${index + 1}`,
                format: 'brief',
                object: task.objects[index],
                field,
                required: true,
                questionIds: ['q0'],
            }));
            const context: AgentContext = {
                runId: crypto.randomUUID(),
                userId: 'fixture',
                taskVersionId: 'fixture',
                mode: 'live',
                budget,
                usage: { searches: 0, pages: 0, inputTokens: 0, outputTokens: 0, estimated: false },
                startedAt: new Date(),
                deadlineAt: new Date(Date.now() + 180000),
                signal: new AbortController().signal,
                assertActive: async () => {},
                comparisonScopeHash: 'bilingual-source-fixture',
                adaptiveSearchDisabled: true,
                config: {
                    title: task.topic,
                    topic: task.topic,
                    goal: task.goal,
                    focusPoints: [],
                    exclusions: [],
                    sourcePreferences: {
                        preferredUrls: [url],
                        excludedUrls: [],
                        officialOnly: true,
                    },
                    researchMode: 'collection',
                    timeRange: { kind: 'rolling', days: 30 },
                    timezone: 'Asia/Shanghai',
                    schedule: { frequency: 'manual' },
                    outputFormat: 'brief',
                    outputFormats: ['brief'],
                    budget,
                    notificationPreference: { mode: 'off', runIssues: false },
                },
            };
            const captured: { key: string; input: StructuredInput }[] = [];
            const deps: AgentDependencies = {
                checkpointer: new MemorySaver(),
                config: { configurable: { thread_id: crypto.randomUUID() } },
                promote: async () => {},
                tools: {
                    search: vi.fn<AgentDependencies['tools']['search']>(async (_key, query) => ({
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
                                title: 'Watchers',
                                snippet: 'Official Watchers guide',
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
                    read: vi.fn<AgentDependencies['tools']['read']>(async () => ({
                        kind: 'read_page',
                        mode: 'live',
                        originalUrl: url,
                        fetchedUrl: url,
                        url,
                        title: 'Watchers',
                        text: bilingualWatcherBody,
                        contentHash: createHash('sha256')
                            .update(bilingualWatcherBody)
                            .digest('hex'),
                        extractionVersion: 'fixture-v1',
                        collectedAt: new Date().toISOString(),
                        truncated: false,
                        untrusted: true,
                    })),
                    model: vi.fn<AgentDependencies['tools']['model']>(async (key, input) => {
                        expect(estimateModelInputTokens(input)).toBeLessThanOrEqual(
                            input.maxInputTokens,
                        );
                        if (key.startsWith('plan'))
                            return {
                                mode: 'live',
                                usage: { inputTokens: 1, outputTokens: 1, estimated: false },
                                data: {
                                    queries: [{ query: 'Vue Watchers', questionIds: ['q0'] }],
                                    requirements,
                                },
                            };
                        captured.push({ key, input });
                        if (key.startsWith('compare-facts'))
                            return {
                                mode: 'live',
                                usage: { inputTokens: 1, outputTokens: 1, estimated: false },
                                data: { pages: [{ pageId: 'read-0', facts: [] }] },
                            };
                        // Capture production inputs without pretending that a model verified the source.
                        throw new ConnectorError(
                            'invalid_response',
                            'Fixture intentionally supplies no generated answer',
                        );
                    }),
                },
            };
            const candidate = await runResearchAgent(context, deps);
            for (const key of ['compare-facts-v1', 'synthesize-0']) {
                const request = captured.find((entry) => entry.key === key)!.input;
                const sources = request.untrustedSources as {
                    excerpts: string[];
                    excerptRanges: { start: number; end: number }[];
                }[];
                expect(
                    sources[0]!.excerpts.some((text) => text.includes(watcherSourceParagraphs[0]!)),
                ).toBe(true);
                expect(
                    sources[0]!.excerpts.some((text) => text.includes(watcherSourceParagraphs[2]!)),
                ).toBe(true);
                expect(
                    sources[0]!.excerpts.some((text) => text.includes(watcherSourceParagraphs[3]!)),
                ).toBe(true);
                sources[0]!.excerptRanges.forEach((range, index) =>
                    expect(bilingualWatcherBody.slice(range.start, range.end)).toBe(
                        sources[0]!.excerpts[index],
                    ),
                );
                expect(request.maxInputTokens).toBe(key.startsWith('compare') ? 12000 : 24000);
            }
            expect(candidate.coverage.completeness).toBe('partial');
            expect(candidate.coverage.delivery?.status).toBe('sources_only');
        },
    );
    it('uses general language concepts and keeps sync separate from async', () => {
        expect(bilingualRetrievalTerms('异步订阅，手动停止资源')).toEqual(
            expect.arrayContaining(['async', 'subscription', 'manual', 'stop', 'resource']),
        );
        expect(bilingualRetrievalTerms('异步回调')).not.toContain('synchronous');
        expect(retrievalTermMatcher('synchronous')('asynchronous callbacks')).toBe(false);
        expect(retrievalTermMatcher('callback')('callbackHandler')).toBe(false);
        expect(retrievalTermMatcher('callback')('an async callback, when invoked')).toBe(true);
    });
});
