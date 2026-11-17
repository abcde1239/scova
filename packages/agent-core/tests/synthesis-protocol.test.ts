import { createHash } from 'node:crypto';
import { MemorySaver } from '@langchain/langgraph';
import type { RunnableConfig } from '@langchain/core/runnables';
import { describe, expect, it } from 'vite-plus/test';
import { DEFAULT_TASK_BUDGET, type TaskConfig } from '@scova/models';
import { createModelProvider, ConnectorError, type StructuredInput } from '@scova/connectors';
import {
    runResearchAgent,
    candidateFromCheckpoint,
    type AgentContext,
    type AgentDependencies,
} from '../src/index.ts';
import { synthesisBatches, synthesisBatchLimits } from '../src/synthesis-batches.ts';

type Wire = {
    properties: {
        claims?: {
            maxItems: number;
            items: {
                required: string[];
                properties: { outputFormat: { enum: TaskConfig['outputFormat'][] } };
            };
        };
        requirements?: {
            items: { properties: { format: { enum: TaskConfig['outputFormat'][] } } };
        };
        artifacts?: {
            items: {
                properties: {
                    format: { enum: TaskConfig['outputFormat'][] };
                    requirements: { items: { properties: { id: { enum: string[] } } } };
                };
            };
        };
    };
};
const text = '甲方案月费100元，可离线使用。乙方案月费80元，需要联网。';
const url = 'https://example.com/prices';
function fixture(
    fault?:
        | 'json'
        | 'enum'
        | 'count'
        | 'assessment'
        | 'permanent'
        | 'quote'
        | 'supplement'
        | 'missing-artifact'
        | 'all-count'
        | 'document-extra'
        | 'citation-extra'
        | 'document-missing'
        | 'text-empty'
        | 'partial-quote'
        | 'coverage'
        | 'plan-scope'
        | 'many-claims'
        | 'growth',
    // Field patches must not ask for already supported IDs again.
    options: { requirements: number; pages: number; longField?: boolean } = {
        requirements: 1,
        pages: 1,
    },
) {
    const context: AgentContext = {
        runId: crypto.randomUUID(),
        userId: crypto.randomUUID(),
        taskVersionId: crypto.randomUUID(),
        mode: 'live',
        startedAt: new Date(),
        deadlineAt: new Date(Date.now() + 60000),
        signal: new AbortController().signal,
        async assertActive() {},
        usage: { pages: 0, searches: 0, inputTokens: 0, outputTokens: 0, estimated: false },
        budget: { ...DEFAULT_TASK_BUDGET },
        config: {
            title: '方案比较回归',
            topic: '甲乙方案',
            goal: '比较价格和使用条件',
            focusPoints: [],
            exclusions: [],
            sourcePreferences: { preferredUrls: [], excludedUrls: [], officialOnly: false },
            timeRange: { kind: 'rolling', days: 30 },
            timezone: 'UTC',
            schedule: { frequency: 'manual' },
            researchMode: 'collection',
            outputFormat: 'research_report',
            outputFormats: ['research_report', 'comparison'],
            budget: { ...DEFAULT_TASK_BUDGET },
            notificationPreference: { mode: 'off', runIssues: false },
        },
    };
    const calls: { key: string; input: StructuredInput }[] = [];
    const failures: ConnectorError[] = [];
    let current: { key: string; input: StructuredInput };
    const provider = createModelProvider({
        protocol: 'openai_json',
        model: 'fixture',
        apiKey: 'fixture-only',
        baseUrl: 'https://model.example/v1',
        maxAttempts: 1,
        http: {
            async request(requestUrl) {
                const { key, input } = current;
                const schema = input.schema as unknown as Wire;
                const plan = key.startsWith('plan');
                const format = schema.properties.claims?.items.properties.outputFormat.enum[0];
                const formats = schema.properties.requirements?.items.properties.format.enum ?? [];
                const ids =
                    schema.properties.artifacts?.items.properties.requirements.items.properties.id
                        .enum ?? [];
                let data: unknown;
                if (plan) {
                    data = {
                        queries: Array.from({ length: Math.ceil(options.pages / 10) }, (_, i) => ({
                            query: `甲乙方案 价格 条件 ${i}`,
                            questionIds: ['q0'],
                        })),
                        requirements: formats.flatMap((format) =>
                            Array.from({ length: options.requirements }, (_, i) => ({
                                id: `${format}-q0-${i}`,
                                format,
                                questionIds: ['q0'],
                                object: '',
                                field: options.longField ? '长'.repeat(1000) : `价格与条件${i}`,
                                required: true,
                                group: '',
                            })),
                        ),
                    };
                    if (fault === 'plan-scope' && key === 'plan-0')
                        (data as { requirements: { format: string }[] }).requirements = (
                            data as { requirements: { format: string }[] }
                        ).requirements.filter((r) => r.format !== 'comparison');
                } else {
                    const claim = {
                        outputFormat: format,
                        kind: 'inference',
                        text,
                        citations: [{ pageId: 'read-0', quote: text }],
                        questionIds: ['q0'],
                        assessment: {
                            relevance: 'direct',
                            support: 'direct',
                            role: 'answer',
                            sourceRelation: 'unknown',
                            reason: '原文载明价格及使用条件',
                            conditions: '',
                            gap: '',
                        },
                    };
                    const response = {
                        claims: [claim],
                        artifacts: [
                            {
                                format,
                                requirements: ids.map((id) => ({ id, text, claimIndexes: [0] })),
                                document:
                                    format === 'research_report'
                                        ? {
                                              version: 1,
                                              sections: [
                                                  {
                                                      id: 'findings',
                                                      title: '价格和适用条件',
                                                      role: 'analysis',
                                                      claimIndexes: [0],
                                                  },
                                              ],
                                          }
                                        : null,
                            },
                        ],
                    };
                    if (fault === 'growth') {
                        response.claims = Array.from({ length: 4 }, (_, i) => ({
                            ...structuredClone(claim),
                            text: `${text} ${key}结论${i}`,
                        }));
                        const index = key.endsWith('-0') ? 3 : 0;
                        if (index === 3)
                            response.claims[3]!.citations[0]!.quote = 'unmatched quotation';
                        response.artifacts[0]!.requirements = ids.map((id) => ({
                            id,
                            text: response.claims[index]!.text,
                            claimIndexes: [index],
                        }));
                        response.artifacts[0]!.document = null;
                    }
                    if (
                        fault === 'missing-artifact' &&
                        format === 'comparison' &&
                        key.endsWith('-0')
                    )
                        response.artifacts[0]!.requirements = [];
                    if (fault === 'all-count' && key.endsWith('-0'))
                        response.claims = Array.from(
                            { length: schema.properties.claims!.maxItems + 1 },
                            () => structuredClone(claim),
                        );
                    if (
                        fault === 'supplement' &&
                        format === 'research_report' &&
                        key.endsWith('-0')
                    ) {
                        claim.assessment.support = 'partial';
                        claim.assessment.gap = '适用条件仍缺材料';
                    }
                    if (fault === 'supplement' && format === 'comparison' && key.endsWith('-1'))
                        response.claims = Array.from(
                            { length: schema.properties.claims!.maxItems + 1 },
                            () => structuredClone(claim),
                        );
                    if (fault === 'coverage' && /-[01]$/.test(key)) {
                        claim.assessment.support = 'partial';
                        claim.assessment.gap = '还缺适用条件证据';
                    }
                    if (fault === 'quote' || fault === 'partial-quote' || fault === 'many-claims') {
                        response.claims = Array.from(
                            { length: schema.properties.claims!.maxItems },
                            (_, i) => ({
                                ...structuredClone(claim),
                                text: `${text} ${fault === 'many-claims' ? key : ''}第${i + 1}项说明。`,
                            }),
                        );
                        response.artifacts[0]!.requirements.forEach(
                            (r) => (r.text = response.claims[0]!.text),
                        );
                        if (format === 'comparison' && key.endsWith('-0'))
                            response.claims.at(-1)!.citations[0]!.quote = 'unmatched quotation';
                        if (fault === 'partial-quote' && format === 'comparison')
                            response.claims.forEach((c, i) => {
                                if (key.endsWith('-0') || i === response.claims.length - 1)
                                    c.citations[0]!.quote = 'unmatched quotation';
                            });
                    }
                    if (format === 'comparison' && (key.endsWith('-0') || fault === 'permanent')) {
                        if (fault === 'json')
                            return {
                                url: requestUrl,
                                status: 200,
                                headers: {},
                                body: JSON.stringify({
                                    choices: [
                                        {
                                            finish_reason: 'stop',
                                            message: {
                                                content: '{ invalid DO_NOT_RENDER sk-secret',
                                            },
                                        },
                                    ],
                                    usage: { prompt_tokens: 100, completion_tokens: 100 },
                                }),
                            };
                        if (fault === 'enum')
                            claim.assessment.relevance = 'relevant DO_NOT_RENDER sk-secret';
                        if (fault === 'assessment')
                            delete (claim as Partial<typeof claim>).assessment;
                        if (fault === 'document-extra')
                            response.artifacts[0]!.document = Object.assign(
                                {
                                    version: 1,
                                    sections: [
                                        {
                                            id: 'core',
                                            title: '核心差异',
                                            role: 'overview',
                                            claimIndexes: [0],
                                        },
                                    ],
                                },
                                { DO_NOT_RENDER: 'sk-secret' },
                            );
                        if (fault === 'citation-extra')
                            Object.assign(claim.citations[0]!, { DO_NOT_RENDER: 'sk-secret' });
                        if (fault === 'document-missing')
                            delete (
                                response.artifacts[0] as Partial<
                                    (typeof response.artifacts)[number]
                                >
                            ).document;
                        if (fault === 'text-empty') claim.text = '';
                        if (fault === 'count' || fault === 'permanent')
                            response.claims = Array.from(
                                { length: schema.properties.claims!.maxItems + 1 },
                                () => structuredClone(claim),
                            );
                    }
                    data = response;
                }
                return {
                    url: requestUrl,
                    status: 200,
                    headers: {},
                    body: JSON.stringify({
                        choices: [
                            { finish_reason: 'stop', message: { content: JSON.stringify(data) } },
                        ],
                        usage: { prompt_tokens: 100, completion_tokens: 100 },
                    }),
                };
            },
        },
    });
    const saver = new MemorySaver();
    const deps: AgentDependencies = {
        checkpointer: saver,
        config: { configurable: { thread_id: crypto.randomUUID() } },
        async promote() {},
        tools: {
            async search(_key, query) {
                return {
                    kind: 'search_results',
                    mode: 'live',
                    provider: 'searxng',
                    query,
                    searchedAt: new Date().toISOString(),
                    results: Array.from({ length: Math.min(10, options.pages) }, (_, i) => ({
                        kind: 'search_snippet',
                        originalUrl: `${url}/${i + (Number(_key.split('-')[1]) % Math.ceil(options.pages / 10)) * 10}`,
                        url: `${url}/${i + (Number(_key.split('-')[1]) % Math.ceil(options.pages / 10)) * 10}`,
                        title: '方案价格和条件',
                        snippet: text,
                    })),
                    coverage: {
                        complete: true,
                        gaps: [],
                        unresponsiveEngines: [],
                        receivedResults: Math.min(10, options.pages),
                        returnedResults: Math.min(10, options.pages),
                        discardedResults: 0,
                        totalResults: options.pages,
                        truncated: false,
                    },
                };
            },
            async read(_key, requested) {
                return {
                    kind: 'read_page',
                    mode: 'live',
                    url: requested,
                    originalUrl: requested,
                    fetchedUrl: requested,
                    title: '价格',
                    text,
                    contentHash: createHash('sha256').update(text).digest('hex'),
                    extractionVersion: 'fixture-v1',
                    collectedAt: new Date().toISOString(),
                    truncated: false,
                    untrusted: true,
                };
            },
            async model(key, input) {
                current = { key, input };
                calls.push(structuredClone(current));
                try {
                    return await provider.generateStructured(input);
                } catch (error) {
                    failures.push(error as ConnectorError);
                    throw error;
                }
            },
        },
    };
    return { context, deps, calls, failures, saver };
}

describe('bounded synthesis through real model HTTP decoding and AJV', () => {
    it('repairs an earlier missing field when the last stable batch is already complete', async () => {
        const f = fixture(undefined, { requirements: 1, pages: 1 });
        f.context.coverageDriven = true;
        f.context.fieldDriven = true;
        const original = f.deps.tools.model;
        f.deps.tools.model = async (key, input) => {
            const result = await original(key, input);
            if (key === 'synthesize-0')
                (
                    result.data as { artifacts: { requirements: unknown[] }[] }
                ).artifacts[0]!.requirements = [];
            return result;
        };
        const result = await runResearchAgent(f.context, f.deps);
        expect(f.calls.map((c) => c.key)).toEqual([
            'plan-0',
            'synthesize-0',
            'synthesize-batch-1-0',
            'synthesize-1',
        ]);
        expect(result.coverage.delivery?.answeredQuestions).toBe(1);
    });
    it('runs historical comparison after field coverage is ready, including checkpoint resume', async () => {
        const f = fixture('coverage', { requirements: 1, pages: 1 });
        f.context.coverageDriven = true;
        f.context.fieldDriven = true;
        f.context.comparisonScopeHash = 'a'.repeat(64);
        f.context.deadlineAt = new Date(Date.now() + 600000);
        const search = f.deps.tools.search;
        const read = f.deps.tools.read;
        f.deps.tools.search = async (key, query) => {
            const response = await search(key, query);
            if (query.includes('原始资料 具体依据'))
                response.results.forEach((r) => {
                    r.url = r.originalUrl = `${url}-supplement`;
                });
            return response;
        };
        f.deps.tools.read = async (key, requested) => {
            const page = await read(key, requested);
            if (requested.endsWith('-supplement')) {
                page.text += ' 新增适用条件证据。';
                page.contentHash = createHash('sha256').update(page.text).digest('hex');
            }
            return page;
        };
        const original = f.deps.tools.model;
        const order: string[] = [];
        f.deps.tools.model = async (key, input) => {
            order.push(key);
            if (key.startsWith('compare-facts'))
                return {
                    mode: 'live',
                    usage: { inputTokens: 1, outputTokens: 1, estimated: false },
                    data: {
                        pages: input.untrustedSources!.map((source) => ({
                            pageId: (source as { pageId: string }).pageId,
                            facts: [],
                        })),
                    },
                };
            return original(key, input);
        };
        const promote = f.deps.promote;
        let stopped: RunnableConfig | undefined;
        f.deps.promote = async (config) => {
            await promote(config);
            const state = await f.saver.getTuple(config);
            if ((state!.checkpoint.channel_values.research as { ready: boolean }).ready) {
                stopped = config;
                throw new Error('stop before comparison');
            }
        };
        await expect(runResearchAgent(f.context, f.deps)).rejects.toThrow('stop before comparison');
        expect(order.some((key) => key.startsWith('compare'))).toBe(false);
        const result = await runResearchAgent(f.context, {
            ...f.deps,
            resume: true,
            config: stopped!,
            async promote() {},
        });
        expect(order.at(-1)).toMatch(/^compare-facts/);
        expect(result.comparison).toBe('completed');
        expect(result.pages).toHaveLength(2);
        expect(result.manifest!.pages).toHaveLength(2);
    });
    it('keeps only active field answers across repairs while preserving all authenticated receipts', async () => {
        const f = fixture('growth');
        f.context.coverageDriven = true;
        f.context.fieldDriven = true;
        const result = await runResearchAgent(f.context, f.deps);
        expect(result.claims.filter((c) => c.kind !== 'insufficient')).toHaveLength(2);
        expect(result.coverage.delivery?.answeredQuestions).toBe(1);
        expect(f.calls.filter((c) => c.key.startsWith('synthesize'))).toHaveLength(4);
        const tuple = await f.saver.getTuple(f.deps.config);
        const state = tuple!.checkpoint.channel_values.research as {
            coveragePolicy: number;
            synthesisExtractions: unknown[];
        };
        expect(state.coveragePolicy).toBe(3);
        expect(state.synthesisExtractions).toHaveLength(4);
        expect(candidateFromCheckpoint(f.context, state)).toEqual(result);
    });
    it('narrows repair schemas to missing fields and does not regenerate supported fields', async () => {
        const f = fixture(undefined, { requirements: 3, pages: 1 });
        f.context.coverageDriven = true;
        f.context.fieldDriven = true;
        const original = f.deps.tools.model;
        f.deps.tools.model = async (key, input) => {
            const result = await original(key, input);
            if (key.startsWith('synthesize') && key.endsWith('-0')) {
                const data = result.data as { artifacts: { requirements: { id: string }[] }[] };
                data.artifacts[0]!.requirements.pop();
            }
            return result;
        };
        const result = await runResearchAgent(f.context, f.deps);
        const repairs = f.calls.filter(
            (c) => c.key.startsWith('synthesize') && c.key.endsWith('-1'),
        );
        expect(repairs).toHaveLength(2);
        for (const call of repairs) {
            const ids = (call.input.schema as unknown as Wire).properties.artifacts!.items
                .properties.requirements.items.properties.id.enum;
            expect(ids).toHaveLength(1);
            expect(ids[0]).toMatch(/-2$/);
        }
        expect(
            result.coverage.artifacts?.every((a) =>
                a.coverage?.requirements.every((r) => r.status === 'supported'),
            ),
        ).toBe(true);
        expect(result.claims).toHaveLength(2);
    });
    it('retains accepted independent findings while adding valid repairs beyond the initial slot allocation', async () => {
        const f = fixture('growth');
        f.context.coverageDriven = true;
        const result = await runResearchAgent(f.context, f.deps);
        expect(result.claims.filter((c) => c.kind !== 'insufficient')).toHaveLength(14);
        expect(result.claims.every((c) => !c.uncertainty?.length)).toBe(true);
        expect(result.coverage.delivery?.answeredQuestions).toBe(1);
        expect(f.calls.filter((c) => c.key.startsWith('synthesize'))).toHaveLength(4);
        const tuple = await f.saver.getTuple(f.deps.config);
        expect(
            candidateFromCheckpoint(f.context, tuple!.checkpoint.channel_values.research),
        ).toEqual(result);
    });
    it('keeps more than thirty distinct supported claims across multiple requested formats', async () => {
        const f = fixture('many-claims', { requirements: 10, pages: 20 });
        f.context.coverageDriven = true;
        const result = await runResearchAgent(f.context, f.deps);
        expect(result.claims).toHaveLength(40);
        expect(result.coverage.delivery?.answeredQuestions).toBe(1);
        for (const call of f.calls.filter((c) => c.key.startsWith('synthesize'))) {
            expect(call.input.untrustedSources!.length).toBeLessThanOrEqual(8);
            for (const source of call.input.untrustedSources as {
                pageId: string;
                questionIds: string[];
            }[])
                expect(source.questionIds).toEqual(
                    result.pages.find((p) => p.id === source.pageId)!.questionIds,
                );
        }
        const tuple = await f.saver.getTuple(f.deps.config);
        expect(
            candidateFromCheckpoint(f.context, tuple!.checkpoint.channel_values.research),
        ).toEqual(result);
    });
    it('accepts valid repairs at full capacity even when another item still fails', async () => {
        const f = fixture('partial-quote');
        const result = await runResearchAgent(f.context, f.deps);
        expect(result.claims).toHaveLength(30);
        expect(result.claims.filter((c) => c.outputFormat === 'research_report')).toHaveLength(15);
        expect(
            result.claims.filter((c) => c.outputFormat === 'comparison' && c.kind === 'inference'),
        ).toHaveLength(14);
        expect(result.claims.filter((c) => c.uncertainty?.length)).toHaveLength(1);
        expect(result.coverage.delivery?.answeredQuestions).toBe(1);
        expect(result.coverage.gaps.join(' ')).not.toContain('claim_capacity');
        const tuple = await f.saver.getTuple(f.deps.config);
        expect(
            candidateFromCheckpoint(f.context, tuple!.checkpoint.channel_values.research),
        ).toEqual(result);
    });
    it('repairs an incomplete semantic plan before freezing its matrix', async () => {
        const f = fixture('plan-scope');
        f.context.coverageDriven = true;
        const result = await runResearchAgent(f.context, f.deps);
        expect(f.calls.slice(0, 2).map((c) => c.key)).toEqual(['plan-0', 'plan-1']);
        expect(f.calls[1]!.input.prompt).toContain('Every question');
        expect(result.coverage.delivery?.answeredQuestions).toBe(1);
    });
    it('starts a fresh evidence set for coverage gaps after the repair pass', async () => {
        const f = fixture('coverage');
        f.context.coverageDriven = true;
        f.context.deadlineAt = new Date(Date.now() + 600000);
        const search = f.deps.tools.search;
        const read = f.deps.tools.read;
        f.deps.tools.search = async (key, query) => {
            const response = await search(key, query);
            if (query.includes('原始资料 具体依据'))
                response.results.forEach((r) => {
                    r.url = r.originalUrl = `${url}-supplement`;
                });
            return response;
        };
        f.deps.tools.read = async (key, requested) => {
            const page = await read(key, requested);
            if (requested.endsWith('-supplement')) {
                page.text += ' 新增适用条件证据。';
                page.contentHash = createHash('sha256').update(page.text).digest('hex');
            }
            return page;
        };
        const result = await runResearchAgent(f.context, f.deps);
        expect(f.calls.map((c) => c.key)).toEqual([
            'plan-0',
            'synthesize-0',
            'synthesize-batch-1-0',
            'synthesize-1',
            'synthesize-batch-1-1',
            'synthesize-2',
            'synthesize-batch-1-2',
        ]);
        expect(result.pages).toHaveLength(2);
        expect(result.coverage.delivery?.answeredQuestions).toBe(1);
        expect(f.calls.reduce((n, c) => n + c.input.maxOutputTokens, 0)).toBeLessThanOrEqual(
            f.context.budget.maxOutputTokens,
        );
        const tuple = await f.saver.getTuple(f.deps.config);
        expect(
            candidateFromCheckpoint(f.context, tuple!.checkpoint.channel_values.research),
        ).toEqual(result);
    });
    it('does not claim completion or spend more calls when no new evidence is retrieved', async () => {
        const f = fixture('coverage');
        f.context.coverageDriven = true;
        f.context.deadlineAt = new Date(Date.now() + 600000);
        const result = await runResearchAgent(f.context, f.deps);
        expect(f.calls.filter((c) => c.key.startsWith('synthesize'))).toHaveLength(4);
        expect(result.coverage.delivery?.answeredQuestions).toBe(0);
        expect(result.coverage.gaps.join(' ')).toContain('覆盖验收失败');
    });
    it('bounds repair hints for the maximum legal field label before checkpoint promotion', async () => {
        const f = fixture('missing-artifact', { requirements: 1, pages: 1, longField: true });
        const result = await runResearchAgent(f.context, f.deps);
        expect(result.coverage.delivery?.status).toBe('answered');
        expect(f.calls.at(-1)?.key).toBe('synthesize-batch-1-1');
        expect(f.calls.at(-1)?.input.prompt).toContain('artifact_requirement_unresolved');
        const tuple = await f.saver.getTuple(f.deps.config);
        expect(
            candidateFromCheckpoint(f.context, tuple!.checkpoint.channel_values.research),
        ).toEqual(result);
    });
    it.each([undefined, 'all-count'] as const)(
        'finishes eight batches and twenty reads within the finite graph limit (%s)',
        async (fault) => {
            const f = fixture(fault, { requirements: 60, pages: 20 });
            f.context.config.outputFormats = ['research_report'];
            const result = await runResearchAgent(f.context, f.deps);
            for (const { key, input } of f.calls.filter((c) => c.key.startsWith('synthesize'))) {
                const limit = (input.schema as unknown as Wire).properties.claims!.maxItems;
                expect(input.prompt, key).toContain(`choose N=1..${limit} claims before writing`);
                expect(input.prompt, key).toContain(`never above ${limit - 1}`);
            }
            expect(result.pages).toHaveLength(20);
            expect(result.coverage.artifacts?.[0]?.coverage?.requirements).toHaveLength(60);
            expect(result.coverage.delivery?.status, JSON.stringify(result.coverage.gaps)).toBe(
                'answered',
            );
            expect(f.calls.filter((c) => c.key.startsWith('synthesize'))).toHaveLength(
                fault ? 16 : 8,
            );
            expect(result.coverage.gaps.join(' ')).not.toContain('图步数');
        },
    );
    it('stops all remaining batches after quota failure while retaining completed work', async () => {
        const f = fixture();
        const original = f.deps.tools.model;
        const attempted: string[] = [];
        f.deps.tools.model = async (key, input) => {
            attempted.push(key);
            if (key === 'synthesize-batch-1-0')
                throw new ConnectorError('model_quota_exceeded', 'DO_NOT_RENDER');
            return original(key, input);
        };
        const result = await runResearchAgent(f.context, f.deps);
        expect(attempted).toEqual(['plan-0', 'synthesize-0', 'synthesize-batch-1-0']);
        expect(
            result.claims.some(
                (c) => c.outputFormat === 'research_report' && c.kind === 'inference',
            ),
        ).toBe(true);
        expect(result.coverage.delivery?.status).toBe('partial');
        const tuple = await f.saver.getTuple(f.deps.config);
        const recovered = await runResearchAgent(f.context, {
            ...f.deps,
            resume: true,
            config: tuple!.config,
        });
        expect(recovered).toEqual(result);
        expect(attempted).toHaveLength(3);
    });
    it('preserves completed formats when the optional supplement rewrite fails in a later batch', async () => {
        const f = fixture('supplement');
        f.context.answerSupplementEnabled = true;
        f.context.deadlineAt = new Date(Date.now() + 300000);
        f.context.config.researchMode = 'analysis';
        const search = f.deps.tools.search;
        const read = f.deps.tools.read;
        f.deps.tools.search = async (key, query) => {
            const response = await search(key, query);
            if (query.includes('原始资料 具体依据'))
                response.results = response.results.map((r) => ({
                    ...r,
                    url: `${url}-supplement`,
                    originalUrl: `${url}-supplement`,
                }));
            return response;
        };
        f.deps.tools.read = async (key, requested) => {
            const body = requested.endsWith('-supplement') ? `${text} 新材料补充适用条件。` : text;
            return {
                ...(await read(key, requested)),
                url: requested,
                originalUrl: requested,
                fetchedUrl: requested,
                text: body,
                contentHash: createHash('sha256').update(body).digest('hex'),
            };
        };
        const result = await runResearchAgent(f.context, f.deps);
        expect(f.calls.map((c) => c.key)).toEqual([
            'plan-0',
            'synthesize-0',
            'synthesize-batch-1-0',
            'synthesize-1',
            'synthesize-batch-1-1',
        ]);
        expect(
            result.claims.some((c) => c.outputFormat === 'comparison' && c.kind === 'inference'),
        ).toBe(true);
        expect(
            result.claims.some(
                (c) => c.outputFormat === 'research_report' && c.assessment?.support === 'direct',
            ),
        ).toBe(true);
        const tuple = await f.saver.getTuple(f.deps.config);
        expect(
            candidateFromCheckpoint(f.context, tuple!.checkpoint.channel_values.research),
        ).toEqual(result);
    });
    it('repairs a full claim allocation without displacing the other completed batch', async () => {
        const f = fixture('quote');
        const result = await runResearchAgent(f.context, f.deps);
        expect(result.claims).toHaveLength(30);
        expect(result.claims.filter((c) => c.outputFormat === 'research_report')).toHaveLength(15);
        expect(result.claims.filter((c) => c.outputFormat === 'comparison')).toHaveLength(15);
        expect(result.claims.every((c) => !c.uncertainty?.length)).toBe(true);
        expect(result.coverage.delivery?.status).toBe('answered');
        expect(f.calls.map((c) => c.key)).toEqual([
            'plan-0',
            'synthesize-0',
            'synthesize-batch-1-0',
            'synthesize-batch-1-1',
        ]);
        const tuple = await f.saver.getTuple(f.deps.config);
        expect(
            candidateFromCheckpoint(f.context, tuple!.checkpoint.channel_values.research),
        ).toEqual(result);
    });
    it('can rebuild a pre-batch checkpoint under its legacy contract', async () => {
        const f = fixture();
        f.context.config.outputFormats = ['research_report'];
        const result = await runResearchAgent(f.context, f.deps);
        const tuple = await f.saver.getTuple(f.deps.config);
        const state = structuredClone(tuple!.checkpoint.channel_values.research) as Record<
            string,
            unknown
        >;
        delete state.synthesisPolicy;
        delete state.synthesisBatchIndex;
        delete state.synthesisBatchIssues;
        expect(candidateFromCheckpoint(f.context, state)).toEqual(result);
    });
    it('stops between batches when cancellation arrives', async () => {
        const f = fixture();
        const controller = new AbortController();
        f.context.signal = controller.signal;
        f.deps.promote = async () => {
            if (f.calls.at(-1)?.key === 'synthesize-0') controller.abort();
        };
        await expect(runResearchAgent(f.context, f.deps)).rejects.toMatchObject({
            code: 'ABORTED',
        });
        expect(f.calls.map((c) => c.key)).toEqual(['plan-0', 'synthesize-0']);
    });
    it.each([
        'json',
        'enum',
        'count',
        'assessment',
        'document-extra',
        'citation-extra',
        'document-missing',
        'text-empty',
    ] as const)(
        'repairs only the failing batch (%s) and preserves another format',
        async (fault) => {
            const f = fixture(fault);
            const result = await runResearchAgent(f.context, f.deps);
            expect(f.calls.map((c) => c.key)).toEqual([
                'plan-0',
                'synthesize-0',
                'synthesize-batch-1-0',
                'synthesize-batch-1-1',
            ]);
            expect(result.coverage.delivery?.status, JSON.stringify(result.coverage)).toBe(
                'answered',
            );
            expect(result.claims.map((c) => c.outputFormat)).toEqual([
                'research_report',
                'comparison',
            ]);
            const failed = f.failures[0]!;
            expect(failed.modelDiagnostic?.schemaHash).toMatch(/^[a-f0-9]{64}$/);
            expect(failed.modelUsage).toEqual({
                inputTokens: 100,
                outputTokens: 100,
                estimated: false,
            });
            const repair = f.calls.at(-1)!.input.prompt;
            expect(repair).not.toMatch(/DO_NOT_RENDER|sk-secret/);
            if (fault === 'enum')
                expect(repair).toContain(
                    JSON.stringify(
                        '"allowedValues":["direct","background","unrelated","unknown"]',
                    ).slice(1, -1),
                );
            if (fault === 'count')
                expect(repair).toContain(JSON.stringify('"limit":15').slice(1, -1));
            if (fault === 'assessment')
                expect(repair).toContain(
                    JSON.stringify('"requiredProperty":"assessment"').slice(1, -1),
                );
            if (fault === 'document-missing') {
                expect(failed.modelDiagnostic?.issues).toContainEqual({
                    keyword: 'required',
                    schemaPath: '#/properties/artifacts/items/required',
                    requiredProperty: 'document',
                });
                expect(repair).toContain(
                    JSON.stringify('"requiredProperty":"document"').slice(1, -1),
                );
            }
            if (fault === 'text-empty') {
                expect(failed.modelDiagnostic?.issues).toContainEqual({
                    keyword: 'minLength',
                    schemaPath: '#/properties/claims/items/properties/text/minLength',
                    limit: 1,
                });
                expect(repair).toContain(JSON.stringify('"limit":1').slice(1, -1));
            }
            if (fault === 'document-extra' || fault === 'citation-extra') {
                const properties =
                    fault === 'document-extra' ? ['version', 'sections'] : ['pageId', 'quote'];
                expect(failed.modelDiagnostic?.issues).toContainEqual(
                    expect.objectContaining({
                        keyword: 'additionalProperties',
                        allowedProperties: properties,
                    }),
                );
                expect(repair).toContain(
                    JSON.stringify(`"allowedProperties":${JSON.stringify(properties)}`).slice(
                        1,
                        -1,
                    ),
                );
            }
            const tuple = await f.saver.getTuple(f.deps.config);
            expect(
                candidateFromCheckpoint(f.context, tuple!.checkpoint.channel_values.research),
            ).toEqual(result);
            expect(
                f.calls.reduce((sum, c) => sum + c.input.maxOutputTokens, 0),
            ).toBeLessThanOrEqual(f.context.budget.maxOutputTokens);
        },
    );

    it('retains an authenticated completed report when another format fails twice', async () => {
        const f = fixture('permanent');
        const result = await runResearchAgent(f.context, f.deps);
        expect(f.calls.filter((c) => c.key === 'synthesize-0')).toHaveLength(1);
        expect(f.failures).toHaveLength(2);
        expect(result.coverage.delivery?.status).not.toBe('sources_only');
        expect(result.claims.find((c) => c.outputFormat === 'research_report')?.text).toBe(text);
        expect(result.claims.find((c) => c.outputFormat === 'comparison')?.kind).toBe(
            'insufficient',
        );
    });

    it('resumes the next batch after promotion without regenerating the completed batch', async () => {
        const f = fixture();
        let promoted: RunnableConfig | undefined;
        f.deps.promote = async (config) => {
            promoted = config;
            if (f.calls.at(-1)?.key === 'synthesize-0')
                throw new Error('simulated process stop after promotion');
        };
        await expect(runResearchAgent(f.context, f.deps)).rejects.toThrow('simulated process stop');
        expect(promoted).toBeDefined();
        const result = await runResearchAgent(f.context, {
            ...f.deps,
            resume: true,
            config: promoted!,
            async promote() {},
        });
        expect(f.calls.map((c) => c.key)).toEqual([
            'plan-0',
            'synthesize-0',
            'synthesize-batch-1-0',
        ]);
        expect(result.coverage.delivery?.status).toBe('answered');
    });

    it('uses at most eight requirement batches and partitions the original output envelope', () => {
        const batches = synthesisBatches(
            ['research_report'],
            Array.from({ length: 60 }, (_, i) => ({
                id: `r${i}`,
                format: 'research_report',
                questionIds: ['q0'],
                object: '',
                field: `字段${i}`,
                required: true,
            })),
        );
        expect(batches).toHaveLength(8);
        expect(new Set(batches.flatMap((b) => b.requirements.map((r) => r.id))).size).toBe(60);
        expect(batches.reduce((n, b) => n + b.maxClaims, 0)).toBe(30);
        const limits = synthesisBatchLimits(1_000_000, 80000, batches.length);
        expect((limits.initial + limits.repair) * batches.length).toBeLessThanOrEqual(80000);
    });
});
