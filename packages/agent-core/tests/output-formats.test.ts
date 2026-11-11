import { createHash } from 'node:crypto';
import { MemorySaver } from '@langchain/langgraph';
import { describe, expect, it, vi } from 'vite-plus/test';
import { DEFAULT_TASK_BUDGET } from '@scova/models';
import type { ReadPage, StructuredInput } from '@scova/connectors';
import {
    runResearchAgent,
    candidateFromCheckpoint,
    type AgentContext,
    type AgentDependencies,
} from '../src/index.ts';

const url = 'https://example.com/research';
const sourceText =
    '甲对象价格100元，每月支付。乙对象价格80元，每月支付。甲对象支持离线使用，乙对象需联网。';
function fixture() {
    const context: AgentContext = {
        runId: 'output-format-run',
        userId: 'user',
        taskVersionId: 'version',
        mode: 'live',
        budget: { ...DEFAULT_TASK_BUDGET },
        usage: { searches: 0, pages: 0, inputTokens: 0, outputTokens: 0, estimated: false },
        deadlineAt: new Date(Date.now() + 300_000),
        signal: new AbortController().signal,
        assertActive: async () => {},
        adaptiveSearchDisabled: true,
        config: {
            title: '比较甲乙对象',
            topic: '甲乙对象价格',
            goal: '比较甲乙的价格和使用条件',
            focusPoints: [],
            exclusions: [],
            sourcePreferences: { preferredUrls: [], excludedUrls: [], officialOnly: false },
            timeRange: { kind: 'rolling', days: 30 },
            timezone: 'UTC',
            schedule: { frequency: 'manual' },
            outputFormat: 'brief',
            outputFormats: ['brief', 'comparison'],
            researchMode: 'collection',
            budget: { ...DEFAULT_TASK_BUDGET },
            notificationPreference: { mode: 'off', runIssues: false },
        },
    };
    const page: ReadPage = {
        kind: 'read_page',
        mode: 'live',
        url,
        originalUrl: url,
        fetchedUrl: url,
        title: '甲乙对象价格资料',
        text: sourceText,
        contentHash: createHash('sha256').update(sourceText).digest('hex'),
        extractionVersion: 'test-v1',
        collectedAt: '2026-11-10T00:00:00Z',
        truncated: false,
        untrusted: true,
    };
    const calls: { key: string; input: StructuredInput }[] = [];
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
                searchedAt: '2026-11-10T00:00:00Z',
                results: [
                    {
                        kind: 'search_snippet',
                        originalUrl: url,
                        url,
                        title: '甲乙对象价格资料',
                        snippet: '甲乙对象的价格及使用条件',
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
            read: vi.fn(async () => structuredClone(page)),
            model: vi.fn<AgentDependencies['tools']['model']>(async (key, input) => {
                calls.push({ key, input });
                const base = {
                    kind: 'inference',
                    questionIds: ['q0'],
                    assessment: {
                        relevance: 'direct',
                        support: 'direct',
                        role: 'answer',
                        sourceRelation: 'unknown',
                        reason: '原文价格与条件',
                        conditions: '按月支付',
                        gap: '',
                    },
                    citations: [{ pageId: 'read-0', quote: sourceText }],
                };
                return {
                    mode: 'live',
                    usage: { inputTokens: 100, outputTokens: 100, estimated: false },
                    data: key.startsWith('plan')
                        ? { queries: [{ query: '甲乙对象价格 使用条件', questionIds: ['q0'] }] }
                        : {
                              claims: [
                                  {
                                      ...base,
                                      outputFormat: 'brief',
                                      text: '乙对象月费更低；需要离线使用时应关注甲对象。',
                                  },
                                  {
                                      ...base,
                                      outputFormat: 'comparison',
                                      text: '月费：甲100元，乙80元；使用条件：甲可离线，乙需联网。',
                                  },
                              ],
                          },
                };
            }),
        },
    };
    return { context, deps, calls };
}

describe('output selection reaches research planning and saved content', () => {
    it('persists planned object dimensions, per-cell values and immutable structure on checkpoint restore', async () => {
        const { context, deps, calls } = fixture();
        const original = deps.tools.model;
        const requirements = [
            {
                id: 'brief-answer',
                format: 'brief',
                questionIds: ['q0'],
                object: '',
                field: '核心选择',
                required: true,
            },
            ...['甲', '乙'].flatMap((name, oi) =>
                ['月费', '使用条件'].map((field, di) => ({
                    id: `cell-${oi}-${di}`,
                    format: 'comparison',
                    questionIds: ['q0'],
                    object: name,
                    field,
                    required: true,
                })),
            ),
        ];
        deps.tools.model = async (key, input) => {
            const response = await original(key, input);
            const data = response.data as Record<string, unknown>;
            if (key.startsWith('plan')) data.requirements = requirements;
            if (key.startsWith('synthesize')) {
                const prior = data.claims as Record<string, unknown>[];
                data.claims = [
                    prior[0],
                    ...['甲100元', '甲可离线', '乙80元', '乙需联网'].map((text) => ({
                        ...prior[1],
                        text,
                    })),
                ];
                data.artifacts = [
                    {
                        format: 'brief',
                        requirements: [
                            {
                                id: 'brief-answer',
                                text: '乙对象月费更低；需要离线使用时应关注甲对象。',
                                claimIndexes: [0],
                            },
                        ],
                    },
                    {
                        format: 'comparison',
                        requirements: ['甲100元', '甲可离线', '乙80元', '乙需联网'].map(
                            (text, index) => ({
                                id: `cell-${Math.floor(index / 2)}-${index % 2}`,
                                text,
                                claimIndexes: [index + 1],
                            }),
                        ),
                    },
                ];
            }
            if (key === 'synthesize-0')
                (data.artifacts as { requirements: unknown[] }[])[1]!.requirements = [];
            return response;
        };
        const result = await runResearchAgent(context, deps);
        expect(result.coverage.delivery?.status).toBe('answered');
        expect(
            calls.filter((call) => call.key.startsWith('synthesize')).map((call) => call.key),
        ).toEqual(['synthesize-0', 'synthesize-1']);
        expect(calls.find((call) => call.key === 'synthesize-1')?.input.prompt).toContain(
            'artifact_requirement_unresolved',
        );
        expect(calls.find((call) => call.key === 'synthesize-1')?.input.prompt).toContain(
            'Never invent information',
        );
        expect(
            result.coverage.artifacts?.[1]?.content?.comparison?.cells.map((cell) => cell.text),
        ).toEqual(['甲100元', '甲可离线', '乙80元', '乙需联网']);
        const tuple = await (deps.checkpointer as MemorySaver).getTuple(deps.config);
        const saved = structuredClone(tuple!.checkpoint.channel_values.research) as {
            planningExtraction: unknown;
            artifacts?: unknown;
        };
        expect(saved.planningExtraction).toBeDefined();
        saved.artifacts = [{ injected: true }];
        const restored = candidateFromCheckpoint(context, saved);
        expect(restored.coverage.artifacts).toEqual(result.coverage.artifacts);
    });
    it('rebuilds API extraction coverage from saved page provenance after checkpoint gap removal', async () => {
        const { context, deps } = fixture();
        const read = deps.tools.read;
        deps.tools.read = async (...args) => ({
            ...(await read(...args)),
            extractionVersion: 'search-api/deepseek/v1',
        });
        await runResearchAgent(context, deps);
        const tuple = await (deps.checkpointer as MemorySaver).getTuple(deps.config);
        const state = structuredClone(tuple!.checkpoint.channel_values.research) as {
            gaps: string[];
        };
        state.gaps = [];
        const restored = candidateFromCheckpoint(context, state);
        expect(restored.coverage.completeness).toBe('partial');
        expect(restored.coverage.gaps.join(' ')).toContain('整页覆盖未经验证');
    });
    it('generates different content for exactly the selected outputs and authenticates citations', async () => {
        const { context, deps, calls } = fixture();
        const result = await runResearchAgent(context, deps);
        expect(
            result.coverage.artifacts?.map(({ format, claimIndexes }) => ({
                format,
                claimIndexes,
            })),
        ).toEqual([
            { format: 'brief', claimIndexes: [0] },
            { format: 'comparison', claimIndexes: [1] },
        ]);
        expect(result.claims[0].text).not.toBe(result.claims[1].text);
        expect(
            result.claims.every((claim) =>
                claim.citations.every((citation) => sourceText.includes(citation.quote)),
            ),
        ).toBe(true);
        const planning = calls.find((call) => call.key.startsWith('plan'))!.input;
        expect(planning.prompt).toContain('shared dimensions');
        expect(planning.prompt).toContain('decisive answer');
        const synthesis = calls.find((call) => call.key.startsWith('synthesize'))!.input;
        expect(JSON.stringify(synthesis.schema)).toContain('outputFormat');
        expect(synthesis.prompt).toContain('shared comparison dimension');
        expect(synthesis.prompt).toContain('Simplified Chinese');
        expect(synthesis.prompt).not.toContain('研究报告：');
        expect(result.coverage.artifacts?.map((entry) => entry.format)).not.toContain(
            'research_report',
        );
    });

    it('keeps a legacy single-format task single-format throughout execution', async () => {
        const { context, deps } = fixture();
        delete context.config.outputFormats;
        const original = deps.tools.model;
        deps.tools.model = async (key, input) => {
            const response = await original(key, input);
            if (key.startsWith('synthesize')) {
                const data = response.data as { claims: Record<string, unknown>[] };
                data.claims = data.claims
                    .slice(0, 1)
                    .map(({ outputFormat: _format, ...claim }) => claim);
            }
            return response;
        };
        const result = await runResearchAgent(context, deps);
        expect(
            result.coverage.artifacts?.map(({ format, claimIndexes }) => ({
                format,
                claimIndexes,
            })),
        ).toEqual([{ format: 'brief', claimIndexes: [0] }]);
        expect(result.claims).toHaveLength(1);
    });

    it('does not publish an unrequested format even when the model invents one', async () => {
        const { context, deps } = fixture();
        const original = deps.tools.model;
        deps.tools.model = async (key, input) => {
            const response = await original(key, input);
            if (key.startsWith('synthesize')) {
                const data = response.data as { claims: Record<string, unknown>[] };
                data.claims.push({
                    ...data.claims[0],
                    outputFormat: 'research_report',
                    text: '未选择的研究报告内容，不应发布。',
                });
            }
            return response;
        };
        const result = await runResearchAgent(context, deps);
        expect(result.coverage.artifacts?.map((artifact) => artifact.format)).toEqual([
            'brief',
            'comparison',
        ]);
        expect(result.claims.some((claim) => claim.text.includes('未选择的研究报告内容'))).toBe(
            false,
        );
    });

    it('marks an unfinished selected artifact as missing instead of copying another artifact', async () => {
        const { context, deps } = fixture();
        const original = deps.tools.model;
        deps.tools.model = async (key, input) => {
            const response = await original(key, input);
            if (key.startsWith('synthesize')) {
                const data = response.data as { claims: Record<string, unknown>[] };
                data.claims = data.claims.filter((claim) => claim.outputFormat === 'brief');
            }
            return response;
        };
        const result = await runResearchAgent(context, deps);
        const comparison = result.coverage.artifacts!.find(
            (artifact) => artifact.format === 'comparison',
        )!;
        expect(comparison.claimIndexes.length).toBeGreaterThan(0);
        const claims = comparison.claimIndexes.map((index) => result.claims[index]!);
        expect(claims.every((claim) => claim.kind === 'insufficient')).toBe(true);
        expect(claims.some((claim) => claim.text === result.claims[0]!.text)).toBe(false);
        expect(result.coverage.completeness).toBe('partial');
    });
});
