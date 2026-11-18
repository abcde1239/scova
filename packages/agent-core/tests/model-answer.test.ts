import { createHash } from 'node:crypto';
import { MemorySaver } from '@langchain/langgraph';
import type { RunnableConfig } from '@langchain/core/runnables';
import { describe, expect, it } from 'vite-plus/test';
import { ClaimSchema, parseContract, validReportArtifacts } from '@scova/models';
import {
    ConnectorError,
    createModelProvider,
    type SearchResponse,
    type StructuredInput,
} from '@scova/connectors';
import {
    runResearchAgent,
    candidateFromCheckpoint,
    type AgentContext,
    type AgentDependencies,
} from '../src/index.ts';
import { projectModelAnswers } from '../src/research/model-answer.ts';

function fixture(
    options: {
        conflict?: 'conditional' | 'unresolved' | 'failed';
        sharedConflict?: boolean;
        reviewDisabled?: boolean;
        unknown?: boolean;
        noPages?: boolean;
        schemaFailure?: boolean;
        synthesisFailure?: boolean;
        disabled?: boolean;
        reasoning?: boolean;
        crossQuestion?: boolean;
        invalidLink?: boolean;
        missingLink?: boolean;
        wire?: boolean;
        smallBudget?: boolean;
        gapDriven?: boolean;
        verification?: 'stable' | 'current' | 'exact' | 'source_required';
        diagnosis?: 'binding_missing' | 'evidence_missing' | 'conflict';
        goal?: string;
        answerCompletion?: boolean;
        researchMode?: 'analysis' | 'collection';
        gapKinds?: boolean;
        omitInitialGapKind?: boolean;
        knowledgeFirst?: boolean;
        gapLoop?: boolean;
        manyPages?: boolean;
        sharedAnswer?: boolean;
        navigation?: boolean;
        requiredMissingDetail?: boolean;
        structuredFormat?: 'comparison' | 'list';
    } = {},
) {
    const budget = {
        maxSearches: options.manyPages ? 4 : 3,
        maxPages: options.manyPages
            ? 20
            : options.conflict
              ? 3
              : options.gapDriven && !options.crossQuestion
                ? 3
                : 1,
        maxDurationSeconds: 600,
        maxInputTokens: options.smallBudget ? 40_000 : 1_000_000,
        maxOutputTokens: options.smallBudget ? 8_000 : 128_000,
    };
    const context: AgentContext = {
        coverageDriven: true,
        fieldDriven: true,
        modelAnswerFallback: !options.disabled,
        evidenceReasoning: options.reasoning,
        gapDriven: options.gapDriven,
        conflictResolution: !!options.conflict && !options.reviewDisabled,
        answerCompletion: options.answerCompletion,
        gapKinds: options.gapKinds,
        knowledgeFirst: options.knowledgeFirst,
        gapLoop: options.gapLoop,
        runId: crypto.randomUUID(),
        userId: crypto.randomUUID(),
        taskVersionId: crypto.randomUUID(),
        mode: 'live',
        startedAt: new Date(),
        deadlineAt: new Date(Date.now() + 600_000),
        signal: new AbortController().signal,
        assertActive: async () => {},
        usage: { searches: 0, pages: 0, inputTokens: 0, outputTokens: 0, estimated: false },
        budget,
        config: {
            title: '架构',
            topic: 'ReAct',
            goal: options.goal ?? '比较循环与记忆',
            focusPoints: options.crossQuestion || options.sharedConflict ? ['记忆机制'] : [],
            exclusions: [],
            sourcePreferences: {
                preferredUrls: options.conflict
                    ? ['https://example.com/react', 'https://example.com/react/second']
                    : [],
                excludedUrls: [],
                officialOnly: false,
            },
            timeRange: { kind: 'rolling', days: 30 },
            timezone: 'UTC',
            schedule: { frequency: 'manual' },
            researchMode: options.researchMode ?? 'analysis',
            outputFormat: 'research_report',
            outputFormats: ['research_report', options.structuredFormat ?? 'comparison'],
            budget,
            notificationPreference: { mode: 'off', runIssues: false },
        },
    };
    const formats = ['research_report', options.structuredFormat ?? 'comparison'] as const;
    const requirements = formats.flatMap((format) =>
        ['loop', 'memory'].map((field) => ({
            id: `${format}-${field}`,
            format,
            questionIds:
                (options.sharedConflict || options.sharedAnswer) && field === 'memory'
                    ? ['q0', 'q1']
                    : [options.crossQuestion && field === 'memory' ? 'q1' : 'q0'],
            object: 'ReAct',
            field,
            required: true,
            group: '',
            ...(options.gapDriven ? { verification: options.verification ?? 'stable' } : {}),
        })),
    );
    const url = 'https://example.com/react';
    const text = 'ReAct alternates reasoning and acting.';
    const memoryText =
        'ReAct keeps tool observations in its working context, not persistent memory.';
    const costQuotes = [
        'Planning is cheaper than ReAct on decomposable tasks.',
        'LATS is more expensive than ReAct with multiple candidates.',
    ];
    const calls: string[] = [];
    const readUrls: string[] = [];
    const inputs: { key: string; input: StructuredInput }[] = [];
    const saver = new MemorySaver();
    let promoted: RunnableConfig | undefined;
    const deps: AgentDependencies = {
        checkpointer: saver,
        config: { configurable: { thread_id: crypto.randomUUID() } },
        promote: async (config) => {
            promoted = config;
        },
        tools: {
            search: async (_key, query) => {
                context.usage.searches++;
                return {
                    kind: 'search_results',
                    mode: 'live',
                    provider: 'searxng',
                    query,
                    searchedAt: new Date().toISOString(),
                    results: options.manyPages
                        ? Array.from({ length: 10 }, (_, i) => ({
                              kind: 'search_snippet',
                              originalUrl: `${url}/${_key}/${i}`,
                              url: `${url}/${_key}/${i}`,
                              title: 'ReAct',
                              snippet: text,
                          }))
                        : options.crossQuestion && _key !== 'search-0'
                          ? []
                          : [
                                {
                                    kind: 'search_snippet',
                                    originalUrl: url,
                                    url,
                                    title: 'ReAct',
                                    snippet: text,
                                },
                                ...(options.conflict
                                    ? [
                                          {
                                              kind: 'search_snippet',
                                              originalUrl: url + '/second',
                                              url: url + '/second',
                                              title: 'Cost comparison',
                                              snippet: costQuotes[1],
                                          },
                                      ]
                                    : []),
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
                } as SearchResponse;
            },
            read: async (_key, readUrl) => {
                readUrls.push(readUrl);
                context.usage.pages++;
                if (options.noPages) throw new ConnectorError('network', 'No body');
                const body =
                    options.navigation && readUrl.endsWith('/memory')
                        ? memoryText
                        : options.manyPages
                          ? `${text}\n${readUrl}`
                          : options.conflict
                            ? readUrl.endsWith('/second')
                                ? costQuotes[1]
                                : text + ' ' + costQuotes[0]
                            : options.crossQuestion
                              ? `${text}\n\n${memoryText}`
                              : text;
                return {
                    kind: 'read_page',
                    mode: 'live',
                    originalUrl: readUrl,
                    fetchedUrl: readUrl,
                    url: readUrl,
                    title: 'ReAct',
                    ...(options.navigation && readUrl === url
                        ? {
                              links: [
                                  {
                                      url: url + '/memory',
                                      text: 'ReAct agent persistent memory mechanism original paper',
                                  },
                              ],
                          }
                        : {}),
                    text: body,
                    contentHash: createHash('sha256').update(body).digest('hex'),
                    extractionVersion: 'fixture',
                    collectedAt: new Date().toISOString(),
                    truncated: false,
                    untrusted: true,
                };
            },
            model: async (key, input) => {
                calls.push(key);
                inputs.push({ key, input: structuredClone(input) });
                let data: unknown;
                if (key.startsWith('plan'))
                    data = {
                        queries: options.manyPages
                            ? [
                                  { query: 'ReAct loop', questionIds: ['q0'] },
                                  { query: 'ReAct memory', questionIds: ['q0'] },
                              ]
                            : [{ query: 'ReAct loop memory', questionIds: ['q0'] }],
                        requirements,
                        ...(options.reasoning
                            ? {
                                  knowledgePlan: [
                                      {
                                          questionId: 'q0',
                                          candidate: '候选：循环包含推理和行动。',
                                          verify: '查找原始方法说明并检查终止条件。',
                                      },
                                  ],
                              }
                            : {}),
                    };
                else if (key.startsWith('conflict-review')) {
                    if (options.conflict === 'failed') {
                        const error = new ConnectorError('invalid_response', 'review failed');
                        error.modelFailure = 'schema';
                        throw error;
                    }
                    const schema = input.schema as {
                        properties: {
                            conflictReview: {
                                properties: {
                                    requirementId: { enum: string[] };
                                    priorClaimHashes: { items: { enum: string[] } };
                                };
                            };
                            claims: { items: { properties: { outputFormat: { enum: string[] } } } };
                        };
                    };
                    const id = schema.properties.conflictReview.properties.requirementId.enum[0]!;
                    const format = schema.properties.claims.items.properties.outputFormat.enum[0];
                    const conditional = options.conflict === 'conditional';
                    const answer =
                        'ReAct 成本取决于比较对象：在可分解任务上，规划方法更省；在多候选配置下，LATS 更贵。';
                    const conditions = ['在可分解任务上', '在多候选配置下'];
                    data = {
                        conflictReview: {
                            requirementId: id,
                            priorClaimHashes:
                                schema.properties.conflictReview.properties.priorClaimHashes.items
                                    .enum,
                            resolution: conditional ? 'conditional' : 'unresolved',
                            reason: '比较对象和配置归一',
                            query: conditional
                                ? ''
                                : 'ReAct same configuration conflicting cost original evidence',
                            sides: costQuotes.map((quote, i) => ({
                                pageId: `read-${i}`,
                                quote,
                                subject: i === 0 ? 'Planning' : 'LATS',
                                comparator: 'ReAct',
                                conditions: conditions[i],
                                assertion: i === 0 ? 'lower cost' : 'higher cost',
                            })),
                        },
                        claims: conditional
                            ? [
                                  {
                                      kind: 'inference',
                                      outputFormat: format,
                                      text: answer,
                                      questionIds: options.sharedConflict ? ['q0', 'q1'] : ['q0'],
                                      citations: costQuotes.map((quote, i) => ({
                                          pageId: `read-${i}`,
                                          quote,
                                      })),
                                      assessment: {
                                          relevance: 'direct',
                                          support: 'direct',
                                          role: 'answer',
                                          sourceRelation: 'original',
                                          reason: '条件不同可同时成立',
                                          conditions: conditions.join('；'),
                                          gap: '',
                                      },
                                  },
                              ]
                            : [],
                        artifacts: [
                            {
                                format,
                                requirements: [
                                    {
                                        id,
                                        text: conditional ? answer : '',
                                        claimIndexes: conditional ? [0] : [],
                                    },
                                ],
                                document: null,
                            },
                        ],
                        evidenceLinks: [],
                        fieldChecks: [
                            {
                                requirementId: id,
                                status: conditional ? 'supported' : 'evidence_missing',
                                query: conditional
                                    ? ''
                                    : 'ReAct same configuration conflicting cost original evidence',
                                reason: '按具体条件判断',
                            },
                        ],
                    };
                } else if (key.startsWith('model-answer') || key.startsWith('model-draft')) {
                    if (options.schemaFailure && key.endsWith('-0')) {
                        const error = new ConnectorError('invalid_response', 'schema failure');
                        error.modelFailure = 'schema';
                        throw error;
                    }
                    const schema = input.schema as {
                        properties: {
                            answers: {
                                items: { properties: { requirementId: { enum: string[] } } };
                            };
                        };
                    };
                    data = {
                        answers: schema.properties.answers.items.properties.requirementId.enum.map(
                            (requirementId) => ({
                                requirementId,
                                canAnswer: !options.unknown,
                                text: options.unknown
                                    ? ''
                                    : `ReAct ${requirementId}: 通常把本轮推理与工具观察保留在上下文中；长期持久记忆由具体实现决定。`,
                                reason: options.unknown ? '不知道' : '可按已知机制回答并限定范围',
                            }),
                        ),
                    };
                } else {
                    if (options.synthesisFailure)
                        throw new ConnectorError('network', 'Synthesis unavailable');
                    const schema = input.schema as {
                        properties: {
                            claims: { items: { properties: { outputFormat: { enum: string[] } } } };
                            artifacts: {
                                items: {
                                    properties: {
                                        requirements: {
                                            items: { properties: { id: { enum: string[] } } };
                                        };
                                    };
                                };
                            };
                        };
                    };
                    const format = schema.properties.claims.items.properties.outputFormat.enum[0];
                    const ids =
                        schema.properties.artifacts.items.properties.requirements.items.properties
                            .id.enum;
                    const memory =
                        (options.crossQuestion ||
                            (options.navigation && readUrls.includes(url + '/memory'))) &&
                        ids.every((id) => id.endsWith('memory'));
                    const answerText = memory ? memoryText : text;
                    data = {
                        ...(options.gapDriven
                            ? {
                                  fieldChecks: ids.map((id) => ({
                                      requirementId: id,
                                      status:
                                          id.endsWith('loop') || memory
                                              ? 'supported'
                                              : (options.diagnosis ?? 'evidence_missing'),
                                      query:
                                          id.endsWith('loop') ||
                                          memory ||
                                          (options.diagnosis &&
                                              options.diagnosis !== 'evidence_missing')
                                              ? ''
                                              : 'persistent memory mechanism original paper',
                                      reason: '逐字段核对已有原文与命题',
                                  })),
                              }
                            : {}),
                        ...(options.reasoning
                            ? {
                                  evidenceLinks:
                                      memory && !options.missingLink
                                          ? [
                                                {
                                                    pageId: 'read-0',
                                                    questionId: 'q1',
                                                    quote: options.invalidLink
                                                        ? 'Invented passage'
                                                        : memoryText,
                                                    reason: '原文说明工作上下文与持久记忆的区别。',
                                                },
                                            ]
                                          : [],
                              }
                            : {}),
                        claims: [
                            {
                                outputFormat: format,
                                kind: 'inference',
                                text: answerText,
                                questionIds:
                                    memory && options.sharedAnswer
                                        ? ['q0', 'q1']
                                        : [memory && options.crossQuestion ? 'q1' : 'q0'],
                                citations: [
                                    {
                                        pageId: memory && options.navigation ? 'read-1' : 'read-0',
                                        quote: answerText,
                                    },
                                ],
                                assessment: {
                                    relevance: 'direct',
                                    support: 'direct',
                                    role: 'answer',
                                    sourceRelation: 'original',
                                    reason: '原文',
                                    conditions: '',
                                    gap: options.requiredMissingDetail ? '必需阶段尚不明确' : '',
                                },
                            },
                        ],
                        artifacts: [
                            {
                                format,
                                requirements: ids.map((id) => ({
                                    id,
                                    text: id.endsWith('loop') || memory ? answerText : '',
                                    claimIndexes: id.endsWith('loop') || memory ? [0] : [],
                                })),
                                document: null,
                            },
                        ],
                    };
                }
                if (options.conflict && key.startsWith('synthesize')) {
                    const result = data as {
                        claims: import('../src/types.ts').AgentClaim[];
                        artifacts: {
                            requirements: { id: string; text: string; claimIndexes: number[] }[];
                        }[];
                        fieldChecks: { requirementId: string; status: string; query: string }[];
                    };
                    const conflict: import('../src/types.ts').AgentClaim = {
                        ...result.claims[0],
                        kind: 'conflict',
                        text: 'ReAct 成本比较存在分歧。',
                        questionIds: ['q0'],
                        citations: costQuotes.map((quote, i) => ({ pageId: `read-${i}`, quote })),
                        assessment: { ...result.claims[0]!.assessment!, role: 'risk' },
                    };
                    result.claims.push(conflict);
                    if (options.sharedConflict)
                        result.claims.push({ ...conflict, questionIds: ['q1'] });
                    for (const r of result.artifacts[0].requirements)
                        if (r.id.endsWith('memory')) {
                            r.text = conflict.text;
                            r.claimIndexes = options.sharedConflict ? [1, 2] : [1];
                        }
                    for (const c of result.fieldChecks)
                        if (c.requirementId.endsWith('memory')) {
                            c.status = 'conflict';
                            c.query = '';
                        }
                }
                if (
                    options.gapKinds &&
                    !(options.omitInitialGapKind && key.endsWith('-0')) &&
                    data &&
                    typeof data === 'object' &&
                    'claims' in data
                ) {
                    for (const claim of (data as { claims: any[] }).claims) {
                        if (claim.assessment)
                            claim.assessment.gapKind = options.requiredMissingDetail
                                ? 'missing_detail'
                                : claim.assessment.gap
                                  ? 'missing_core'
                                  : 'none';
                    }
                }
                if (options.wire) {
                    const provider = createModelProvider({
                        protocol: 'openai_json',
                        model: 'fixture',
                        apiKey: 'fixture-only',
                        baseUrl: 'https://model.example/v1',
                        maxAttempts: 1,
                        http: {
                            request: async (url) => ({
                                url,
                                status: 200,
                                headers: {},
                                body: JSON.stringify({
                                    choices: [
                                        {
                                            finish_reason: 'stop',
                                            message: { content: JSON.stringify(data) },
                                        },
                                    ],
                                    usage: { prompt_tokens: 50, completion_tokens: 100 },
                                }),
                            }),
                        },
                    });
                    return provider.generateStructured(input);
                }
                return {
                    mode: 'live',
                    data,
                    usage: { inputTokens: 50, outputTokens: 100, estimated: false },
                };
            },
        },
    };
    return { context, deps, calls, inputs, saver, checkpoint: () => promoted! };
}

describe('external evidence followed by explicitly labelled model answers', () => {
    it('continues later stages after a draft reservation limit without treating it as provider exhaustion', async () => {
        const f = fixture({ reasoning: true, gapDriven: true, knowledgeFirst: true });
        const model = f.deps.tools.model;
        f.deps.tools.model = async (key, input) => {
            if (key.startsWith('model-draft'))
                throw new ConnectorError('budget_exceeded', 'local stage reservation');
            return model(key, input);
        };
        const result = await runResearchAgent(f.context, f.deps);
        expect(f.calls.some((key) => key.startsWith('synthesize'))).toBe(true);
        expect(result.claims.some((c) => c.kind === 'model_answer')).toBe(true);
        const state = (await f.saver.get(f.checkpoint()))!.channel_values.research;
        expect(state).not.toMatchObject({ modelBlocked: true });
        expect(candidateFromCheckpoint(f.context, state)).toEqual(result);
    });

    it('keeps an earlier draft batch when the next batch exhausts provider quota', async () => {
        const f = fixture({ reasoning: true, gapDriven: true, knowledgeFirst: true });
        const model = f.deps.tools.model;
        const calls: string[] = [];
        f.deps.tools.model = async (key, input) => {
            calls.push(key);
            if (key === 'model-draft-1-0')
                throw new ConnectorError('model_quota_exceeded', 'quota exhausted');
            return model(key, input);
        };
        const result = await runResearchAgent(f.context, f.deps);
        expect(calls.at(-1)).toBe('model-draft-1-0');
        expect(result.claims.filter((c) => c.kind === 'model_answer')).toHaveLength(3);
        expect(
            candidateFromCheckpoint(
                f.context,
                (await f.saver.get(f.checkpoint()))!.channel_values.research,
            ),
        ).toEqual(result);
    });

    it('retains successful answers when a later comparison exhausts provider quota, including recovery', async () => {
        const f = fixture({ reasoning: true, gapDriven: true, wire: true });
        f.context.comparisonScopeHash = 'review-scope';
        const model = f.deps.tools.model;
        const calls: string[] = [];
        f.deps.tools.model = async (key, input) => {
            calls.push(key);
            if (key.startsWith('compare'))
                throw new ConnectorError('model_quota_exceeded', 'quota exhausted');
            return model(key, input);
        };
        const result = await runResearchAgent(f.context, f.deps);
        expect(result.claims.filter((c) => c.kind === 'model_answer')).toHaveLength(2);
        expect(calls.at(-1)).toMatch(/^compare/);
        const state = (await f.saver.get(f.checkpoint()))!.channel_values.research;
        expect(state).toMatchObject({ modelBlocked: true });
        expect(candidateFromCheckpoint(f.context, state)).toEqual(result);
        const before = calls.length;
        expect(
            await runResearchAgent(f.context, {
                ...f.deps,
                resume: true,
                config: f.checkpoint(),
                onStep: undefined,
            }),
        ).toEqual(result);
        expect(calls).toHaveLength(before);
    });

    it.each(['model-draft', 'model-answer', 'conflict-review'] as const)(
        'stops subsequent model calls after provider quota failure in %s',
        async (stage) => {
            const f = fixture({
                reasoning: true,
                gapDriven: true,
                knowledgeFirst: stage === 'model-draft',
                ...(stage === 'conflict-review' ? { conflict: 'unresolved' as const } : {}),
            });
            const model = f.deps.tools.model;
            const calls: string[] = [];
            f.deps.tools.model = async (key, input) => {
                calls.push(key);
                if (key.startsWith(stage))
                    throw new ConnectorError('model_quota_exceeded', 'quota exhausted');
                return model(key, input);
            };
            const result = await runResearchAgent(f.context, f.deps);
            const failed = calls.findIndex((key) => key.startsWith(stage));
            expect(failed).toBeGreaterThanOrEqual(0);
            expect(calls.slice(failed + 1)).toEqual([]);
            expect(result.pages.length).toBeGreaterThan(0);
            const state = (await f.saver.get(f.checkpoint()))!.channel_values.research;
            expect(state).toMatchObject({ modelBlocked: true });
            expect(candidateFromCheckpoint(f.context, state)).toEqual(result);
            const before = calls.length;
            expect(
                await runResearchAgent(f.context, {
                    ...f.deps,
                    resume: true,
                    config: f.checkpoint(),
                    onStep: undefined,
                }),
            ).toEqual(result);
            expect(calls).toHaveLength(before);
        },
    );

    it.each(['comparison', 'list'] as const)(
        'excludes bound %s cells from the final document after report coverage adjustment',
        async (format) => {
            const f = fixture({ reasoning: true, gapDriven: true, structuredFormat: format });
            const model = f.deps.tools.model;
            f.deps.tools.model = async (key, input) => {
                const response = await model(key, input);
                if (key.startsWith('synthesize')) {
                    const data = response.data as { artifacts: { document: unknown }[] };
                    for (const artifact of data.artifacts)
                        artifact.document = {
                            version: 1,
                            sections: [
                                {
                                    id: 'overview',
                                    title: '说明',
                                    role: 'overview',
                                    claimIndexes: [0],
                                },
                            ],
                        };
                }
                return createModelProvider({
                    protocol: 'openai_json',
                    model: 'fixture',
                    apiKey: 'fixture-only',
                    baseUrl: 'https://model.example/v1',
                    maxAttempts: 1,
                    http: {
                        request: async (url) => ({
                            url,
                            status: 200,
                            headers: {},
                            body: JSON.stringify({
                                choices: [
                                    {
                                        finish_reason: 'stop',
                                        message: { content: JSON.stringify(response.data) },
                                    },
                                ],
                                usage: { prompt_tokens: 50, completion_tokens: 100 },
                            }),
                        }),
                    },
                }).generateStructured(input);
            };
            const result = await runResearchAgent(f.context, f.deps);
            const artifact = result.coverage.artifacts!.find((a) => a.format === format)!;
            const bound = [
                ...(artifact.content?.comparison?.cells ?? []),
                ...(artifact.content?.list?.entries.flatMap((entry) => entry.fields) ?? []),
            ].flatMap((cell) => cell.claimIndexes);
            const outlined =
                artifact.content?.document?.sections.flatMap((s) => s.claimIndexes) ?? [];
            expect(bound.length).toBeGreaterThan(0);
            expect(outlined.filter((i) => bound.includes(i))).toEqual([]);
            expect(
                validReportArtifacts([artifact], result.claims, result.coverage.reportValue),
            ).toBe(true);
            expect(
                candidateFromCheckpoint(
                    f.context,
                    (await f.saver.get(f.checkpoint()))!.channel_values.research,
                ),
            ).toEqual(result);
        },
    );

    it('runs the new policy through strict HTTP schemas and restores proposition spans and independent metrics', async () => {
        const f = fixture({
            reasoning: true,
            gapDriven: true,
            crossQuestion: true,
            wire: true,
            smallBudget: true,
        });
        const result = await runResearchAgent(f.context, f.deps);
        expect(
            result.coverage.metrics,
            JSON.stringify({ coverage: result.coverage, calls: f.calls }),
        ).toMatchObject({
            answeredQuestions: 2,
            externallySupportedQuestions: 2,
            unresolvedQuestionIds: [],
            requiredFields: 4,
            externallySupportedFields: 4,
        });
        for (const p of result.coverage.propositions!) {
            expect(p.requirementIds.length).toBeGreaterThan(0);
            for (const span of p.passages) {
                const page = result.pages.find((p) => p.id === span.pageId)!;
                expect(page.contentHash).toBe(span.contentHash);
                expect(
                    result.claims[p.claimIndex]!.citations.some(
                        (c) => c.quote === page.text.slice(span.start, span.end),
                    ),
                ).toBe(true);
            }
        }
        expect(
            candidateFromCheckpoint(
                f.context,
                (await f.saver.get(f.checkpoint()))!.channel_values.research,
            ),
        ).toEqual(result);
        expect(result.coverage.research?.supplementalSearches).toBe(0);
        expect(f.context.usage.pages).toBe(1);
    });

    it('searches the diagnosed missing proposition without repeating the first repair pass', async () => {
        const f = fixture({ reasoning: true, gapDriven: true, wire: true });
        const result = await runResearchAgent(f.context, f.deps);
        expect(result.coverage.metrics).toMatchObject({
            answeredQuestions: 1,
            externallySupportedQuestions: 0,
            unresolvedQuestionIds: [],
            answeredFields: 4,
            externallySupportedFields: 2,
        });
        expect(
            result.coverage.searchedQueries.some((q) => q.includes('persistent memory mechanism')),
        ).toBe(true);
        expect(f.calls).not.toContain('synthesize-1-0');
        expect(result.claims.filter((c) => c.kind === 'model_answer')).toHaveLength(2);
    });

    it('repairs bindings with existing sources before allowing stable knowledge, without a missing-source search', async () => {
        const f = fixture({
            reasoning: true,
            gapDriven: true,
            diagnosis: 'binding_missing',
            wire: true,
        });
        const result = await runResearchAgent(f.context, f.deps);
        expect(f.calls.some((key) => key.startsWith('synthesize-1'))).toBe(true);
        expect(f.context.usage.searches).toBe(1);
        expect(result.coverage.metrics?.answeredQuestions).toBe(1);
    });

    it.each(['current', 'exact', 'source_required'] as const)(
        'never uses model knowledge for %s fields',
        async (verification) => {
            const f = fixture({ reasoning: true, gapDriven: true, verification, wire: true });
            const result = await runResearchAgent(f.context, f.deps);
            expect(result.coverage.metrics).toMatchObject({
                answeredQuestions: 0,
                unresolvedQuestionIds: ['q0'],
            });
            expect(result.claims.some((c) => c.kind === 'model_answer')).toBe(false);
            expect(f.calls.some((key) => key.startsWith('model-answer'))).toBe(false);
        },
    );

    it('explicit exact-data requests override a mistaken stable classification', async () => {
        const f = fixture({
            reasoning: true,
            gapDriven: true,
            goal: '给出精确数值与指定出处',
            wire: true,
        });
        const result = await runResearchAgent(f.context, f.deps);
        expect(result.claims.some((c) => c.kind === 'model_answer')).toBe(false);
        expect(result.coverage.metrics?.answeredQuestions).toBe(0);
    });

    it('keeps diagnosed conflicts unresolved without searching or replacing them with model answers', async () => {
        const f = fixture({ reasoning: true, gapDriven: true, diagnosis: 'conflict', wire: true });
        const result = await runResearchAgent(f.context, f.deps);
        expect(result.coverage.metrics?.unresolvedQuestionIds).toEqual(['q0']);
        expect(f.context.usage.searches).toBe(1);
        expect(result.claims.some((c) => c.kind === 'model_answer')).toBe(false);
    });
    it('preserves passage support and frozen scope when editorial overhead is compacted for an old small budget', async () => {
        const f = fixture({ reasoning: true, crossQuestion: true, wire: true, smallBudget: true });
        const result = await runResearchAgent(f.context, f.deps);
        expect(result.coverage.delivery?.answeredQuestions).toBe(2);
        expect(f.calls.some((key) => key.startsWith('model-answer'))).toBe(false);
        const compact = f.inputs.filter(
            (entry) =>
                entry.key.startsWith('synthesize') && entry.input.prompt.includes('Frozen data:'),
        );
        expect(compact.length).toBeGreaterThan(0);
        expect(
            compact.every(
                (entry) =>
                    entry.input.maxInputTokens === 24_000 &&
                    entry.input.prompt.includes('evidenceLinks') &&
                    entry.input.prompt.includes('记忆机制') &&
                    JSON.stringify(entry.input.untrustedSources).includes('persistent memory'),
            ),
        ).toBe(true);
        expect(
            candidateFromCheckpoint(
                f.context,
                (await f.saver.get(f.checkpoint()))!.channel_values.research,
            ),
        ).toEqual(result);
    });
    it('reuses a saved passage across questions through an authenticated span association', async () => {
        const f = fixture({ reasoning: true, crossQuestion: true, wire: true });
        const result = await runResearchAgent(f.context, f.deps);
        expect(result.coverage.delivery?.answeredQuestions).toBe(2);
        expect(result.pages[0]!.questionIds).toEqual(['q0']);
        expect(
            result.claims.some((c) => c.questionIds.includes('q1') && c.kind === 'inference'),
        ).toBe(true);
        expect(f.calls.some((key) => key.startsWith('model-answer'))).toBe(false);
        expect(f.context.usage.pages).toBe(1);
        const state = (await f.saver.get(f.checkpoint()))!.channel_values.research;
        expect(candidateFromCheckpoint(f.context, state)).toEqual(result);
        const forged = structuredClone(state) as {
            synthesisExtractions: { response: { data: { evidenceLinks: { quote: string }[] } } }[];
        };
        for (const receipt of forged.synthesisExtractions)
            for (const link of receipt.response.data.evidenceLinks) link.quote = '伪造原文';
        expect(() => candidateFromCheckpoint(f.context, forged)).toThrow();
        const plan = f.inputs.find((entry) => entry.key.startsWith('plan'))!.input;
        expect(plan.prompt).toContain('UNVERIFIED search leads');
        expect(plan.schema.required).toContain('knowledgePlan');
        const syntheses = f.inputs.filter((entry) => entry.key.startsWith('synthesize'));
        expect(
            syntheses.every(
                (entry) =>
                    Array.isArray(entry.input.schema.required) &&
                    entry.input.schema.required.includes('evidenceLinks'),
            ),
        ).toBe(true);
        expect(
            syntheses.every((entry) => entry.input.prompt.includes('Unverified planning leads')),
        ).toBe(true);
    });

    it.each([{ invalidLink: true }, { missingLink: true }])(
        'does not grant cross-question scope from invalid or absent links (%j)',
        async (options) => {
            const f = fixture({ reasoning: true, crossQuestion: true, unknown: true, ...options });
            const result = await runResearchAgent(f.context, f.deps);
            expect(result.coverage.delivery?.answeredQuestions).toBe(1);
            expect(
                result.claims.some((c) => c.kind === 'inference' && c.questionIds.includes('q1')),
            ).toBe(false);
            expect(result.pages[0]!.questionIds).toEqual(['q0']);
        },
    );

    it('gives knowledge fallback current answers and verbatim research context without changing provenance', async () => {
        const f = fixture({ reasoning: true });
        const result = await runResearchAgent(f.context, f.deps);
        const input = f.inputs.find((entry) => entry.key.startsWith('model-answer'))!.input;
        expect(input.prompt).toContain('Current research context');
        expect(input.prompt).toContain('ReAct alternates reasoning and acting.');
        expect(input.prompt).toContain('fieldGaps');
        expect(JSON.stringify(input.untrustedSources)).toContain(
            'ReAct alternates reasoning and acting.',
        );
        expect(
            result.claims
                .filter((c) => c.kind === 'model_answer')
                .every((c) => !c.citations.length && c.assessment?.support === 'none'),
        ).toBe(true);
    });

    it('fills only missing fields, preserves external answers, and keeps evidence coverage partial', async () => {
        const f = fixture();
        const result = await runResearchAgent(f.context, f.deps);
        expect(result.coverage.delivery?.answeredQuestions).toBe(1);
        expect(result.coverage.completeness).toBe('partial');
        expect(result.claims.filter((c) => c.kind === 'model_answer')).toHaveLength(2);
        expect(
            result.claims
                .filter((c) => c.kind === 'model_answer')
                .every((c) => !c.citations.length && c.assessment?.support === 'none'),
        ).toBe(true);
        for (const artifact of result.coverage.artifacts!) {
            expect(artifact.summary).not.toContain('项所需信息未完整取得');
            expect(artifact.coverage?.requirements.map((r) => r.status)).toEqual([
                'supported',
                'model_answered',
            ]);
        }
        expect(
            validReportArtifacts(
                result.coverage.artifacts,
                result.claims,
                result.coverage.reportValue,
            ),
        ).toBe(true);
        const snapshot = await f.saver.get(f.checkpoint());
        const state = snapshot!.channel_values.research;
        expect(candidateFromCheckpoint(f.context, state)).toEqual(result);
        const forged = structuredClone(state) as { claims: { kind: string; text: string }[] };
        forged.claims.find((c) => c.kind === 'model_answer')!.text = '篡改模型答案';
        expect(() => candidateFromCheckpoint(f.context, forged)).toThrow();
    });

    it('does not invent answers when the model declines', async () => {
        const f = fixture({ unknown: true });
        const result = await runResearchAgent(f.context, f.deps);
        expect(result.claims.some((c) => c.kind === 'model_answer')).toBe(false);
        expect(result.coverage.delivery?.answeredQuestions).toBe(0);
        expect(f.calls.filter((key) => key.startsWith('model-answer'))).toHaveLength(1);
    });

    it('supports a failed external read without manufacturing any evidence', async () => {
        const f = fixture({ noPages: true });
        const result = await runResearchAgent(f.context, f.deps);
        expect(result.pages).toEqual([]);
        expect(result.claims.some((c) => c.kind === 'model_answer')).toBe(true);
        expect(result.coverage.delivery?.answeredQuestions).toBe(1);
    });

    it('preserves the source-only result when synthesis fails and knowledge answers are declined', async () => {
        const f = fixture({ synthesisFailure: true, unknown: true });
        const result = await runResearchAgent(f.context, f.deps);
        expect(result.pages).toHaveLength(1);
        expect(result.claims.length).toBeGreaterThan(0);
        expect(result.claims.every((c) => c.kind === 'insufficient')).toBe(true);
        expect(result.coverage.delivery?.answeredQuestions).toBe(0);
        expect(
            candidateFromCheckpoint(
                f.context,
                (await f.saver.get(f.checkpoint()))!.channel_values.research,
            ),
        ).toEqual(result);
    });

    it('repairs a schema failure once without repeating external research', async () => {
        const f = fixture({ schemaFailure: true });
        const result = await runResearchAgent(f.context, f.deps);
        expect(result.coverage.delivery?.answeredQuestions).toBe(1);
        expect(f.calls.filter((key) => key.startsWith('model-answer'))).toEqual([
            'model-answer-0-0',
            'model-answer-0-1',
        ]);
    });

    it('resumes passage associations without repeating completed model calls or reads', async () => {
        const f = fixture({ reasoning: true, gapDriven: true, crossQuestion: true, wire: true });
        f.deps.onStep = async (step, phase) => {
            if (step === 'model_answer' && phase === 'completed') throw new Error('restart');
        };
        await expect(runResearchAgent(f.context, f.deps)).rejects.toThrow('restart');
        const calls = f.calls.length;
        const reads = f.context.usage.pages;
        const result = await runResearchAgent(f.context, {
            ...f.deps,
            onStep: undefined,
            resume: true,
            config: f.checkpoint(),
        });
        expect(result.coverage.delivery?.answeredQuestions).toBe(2);
        expect(result.pages[0]!.questionIds).toEqual(['q0']);
        expect(f.calls).toHaveLength(calls);
        expect(f.context.usage.pages).toBe(reads);
        expect(
            candidateFromCheckpoint(
                f.context,
                (await f.saver.get(f.checkpoint()))!.channel_values.research,
            ),
        ).toEqual(result);
    });

    it('resumes a promoted answer without repeating the model call', async () => {
        const f = fixture();
        f.deps.onStep = async (step, phase) => {
            if (step === 'model_answer' && phase === 'completed') throw new Error('restart');
        };
        await expect(runResearchAgent(f.context, f.deps)).rejects.toThrow('restart');
        const calls = f.calls.length;
        const result = await runResearchAgent(f.context, {
            ...f.deps,
            onStep: undefined,
            resume: true,
            config: f.checkpoint(),
        });
        expect(result.coverage.delivery?.answeredQuestions).toBe(1);
        expect(f.calls).toHaveLength(calls);
    });

    it('keeps legacy executions on the external evidence policy', async () => {
        const f = fixture({ disabled: true });
        const result = await runResearchAgent(f.context, f.deps);
        expect(f.calls.some((key) => key.startsWith('model-answer'))).toBe(false);
        expect(result.coverage.delivery?.answeredQuestions).toBe(0);
    });

    it('rejects model claims with fake citations and duplicated or foreign field IDs', () => {
        const id = crypto.randomUUID();
        expect(() =>
            parseContract(ClaimSchema, {
                id,
                kind: 'model_answer',
                text: '回答',
                confidenceLabel: '模型自回答',
                evidenceIds: [id],
            }),
        ).toThrow();
        const requirement = {
            id: 'r0',
            format: 'brief' as const,
            questionIds: ['q0'],
            object: '',
            field: '机制',
            required: true,
        };
        const answer = { requirementId: 'r0', canAnswer: true, text: '回答', reason: '已知' };
        const receipt = (answers: unknown[]) => ({
            operationKey: 'model-answer-0-0',
            response: {
                mode: 'live' as const,
                data: { answers },
                usage: { inputTokens: 1, outputTokens: 1, estimated: false },
            },
        });
        expect(projectModelAnswers([receipt([answer, answer])], [requirement])).toEqual([]);
        expect(
            projectModelAnswers(
                [receipt([{ ...answer, requirementId: 'foreign' }])],
                [requirement],
            ),
        ).toEqual([]);
    });
});

describe('bounded evidence conflict review', () => {
    it('normalizes different comparators through real HTTP schemas and survives canonical recovery', async () => {
        const f = fixture({
            reasoning: true,
            gapDriven: true,
            conflict: 'conditional',
            wire: true,
        });
        const result = await runResearchAgent(f.context, f.deps);
        expect(
            f.calls.filter((k) => k.startsWith('conflict-review')),
            JSON.stringify({ calls: f.calls, coverage: result.coverage }),
        ).toHaveLength(2);
        expect(result.coverage.metrics).toMatchObject({
            requiredFields: 4,
            externallySupportedFields: 4,
            unresolvedQuestionIds: [],
        });
        expect(result.claims.filter((c) => c.kind === 'conflict')).toHaveLength(2);
        const indexes = result.coverage
            .reportValue!.selections.filter((s) => s.placement === 'main')
            .map((s) => s.claimIndex);
        expect(indexes.some((i) => result.claims[i]?.kind === 'conflict')).toBe(false);
        const state = (await f.saver.get(f.checkpoint()))!.channel_values.research;
        expect(candidateFromCheckpoint(f.context, state)).toEqual(result);
        const before = f.calls.length;
        expect(
            await runResearchAgent(f.context, { ...f.deps, config: f.checkpoint(), resume: true }),
        ).toEqual(result);
        expect(f.calls.length).toBe(before);
    });
    it('answers a conflict field shared by multiple questions through the actual wire schema', async () => {
        const f = fixture({
            reasoning: true,
            gapDriven: true,
            conflict: 'conditional',
            sharedConflict: true,
            wire: true,
        });
        const result = await runResearchAgent(f.context, f.deps);
        const reviews = f.calls.filter((k) => k.startsWith('conflict-review'));
        expect(
            f.inputs
                .filter((c) => c.key.startsWith('conflict-review'))
                .every(
                    (c) =>
                        c.input.prompt.includes('比较循环与记忆') &&
                        c.input.prompt.includes('记忆机制'),
                ),
        ).toBe(true);
        expect(reviews, JSON.stringify(result.coverage)).toHaveLength(2);
        expect(result.coverage.metrics).toMatchObject({
            answeredQuestions: 2,
            answeredFields: 4,
        });
        expect(
            result.coverage
                .artifacts!.flatMap((a) => a.coverage!.requirements)
                .filter((r) => r.id.endsWith('memory'))
                .every((r) => r.status === 'supported' && r.questionIds.length === 2),
        ).toBe(true);
        expect(
            result.claims
                .filter((c) => c.kind === 'inference' && c.text.includes('成本'))
                .every((c) => c.questionIds.length === 2),
        ).toBe(true);
    });
    it('rejects missing sides, altered quotes, lost conditions and mismatched prior conflicts', async () => {
        const f = fixture({
            reasoning: true,
            gapDriven: true,
            conflict: 'conditional',
            wire: true,
        });
        await runResearchAgent(f.context, f.deps);
        const state = (await f.saver.get(f.checkpoint()))!.channel_values.research as {
            synthesisExtractions: import('../src/types.ts').ComparisonExtraction[];
            claims: import('../src/types.ts').AgentClaim[];
        };
        const receipt = state.synthesisExtractions.find((r) =>
            r.operationKey.startsWith('conflict-review'),
        )!;
        const data = receipt.response.data as {
            conflictReview: {
                requirementId: string;
                priorClaimHashes: string[];
                sides: { quote: string }[];
            };
            claims: import('../src/types.ts').AgentClaim[];
        };
        const requirement = {
            id: data.conflictReview.requirementId,
            format: 'research_report' as const,
            questionIds: ['q0'],
            object: 'ReAct',
            field: 'memory',
            required: true,
        };
        const { validConflictReview, conflictFingerprint } =
            await import('../src/research/conflict-review.ts');
        const prior = state.claims.filter((c) =>
            data.conflictReview.priorClaimHashes.includes(conflictFingerprint(c)),
        );
        expect(validConflictReview(data, requirement, prior)).toBe(true);
        for (const change of ['side', 'quote', 'condition', 'hash'] as const) {
            const forged = structuredClone(data);
            if (change === 'side') forged.conflictReview.sides.pop();
            if (change === 'quote') forged.conflictReview.sides[0]!.quote = 'invented';
            if (change === 'condition') forged.claims[0]!.assessment!.conditions = '';
            if (change === 'hash') forged.conflictReview.priorClaimHashes[0] = '0'.repeat(64);
            expect(validConflictReview(forged, requirement, prior)).toBe(false);
        }
    });
    it('resumes after a promoted review without repeating the committed call', async () => {
        const f = fixture({
            reasoning: true,
            gapDriven: true,
            conflict: 'conditional',
            wire: true,
        });
        let interrupted = false;
        await expect(
            runResearchAgent(f.context, {
                ...f.deps,
                onStep: async (step, phase) => {
                    if (step === 'conflict_review' && phase === 'completed' && !interrupted) {
                        interrupted = true;
                        throw new Error('interrupt after review');
                    }
                },
            }),
        ).rejects.toThrow('interrupt after review');
        const first = f.calls.filter((k) => k.startsWith('conflict-review'));
        expect(first).toHaveLength(1);
        const result = await runResearchAgent(f.context, {
            ...f.deps,
            config: f.checkpoint(),
            resume: true,
        });
        expect(f.calls.filter((k) => k === first[0])).toHaveLength(1);
        expect(result.coverage.metrics!.answeredFields).toBe(4);
    });
    it('retains genuine conflicts, searches the exact diagnosed proposition and refuses knowledge replacement', async () => {
        const f = fixture({ reasoning: true, gapDriven: true, conflict: 'unresolved', wire: true });
        const result = await runResearchAgent(f.context, f.deps);
        expect(f.calls.some((k) => k.startsWith('conflict-review'))).toBe(true);
        expect(result.claims.some((c) => c.kind === 'conflict')).toBe(true);
        expect(result.claims.some((c) => c.kind === 'model_answer')).toBe(false);
        expect(result.coverage.metrics!.unresolvedQuestionIds).toEqual(['q0']);
        expect(result.coverage.research?.supplementalSearches).toBe(1);
    });
    it('bounds schema repair and preserves conflicts after both attempts fail', async () => {
        const f = fixture({ reasoning: true, gapDriven: true, conflict: 'failed' });
        const result = await runResearchAgent(f.context, f.deps);
        const keys = f.calls.filter((k) => k.startsWith('conflict-review'));
        expect(keys.length).toBeGreaterThan(0);
        expect(keys.length).toBeLessThanOrEqual(8);
        expect(keys.every((k) => /-(0|1)$/.test(k))).toBe(true);
        expect(result.claims.some((c) => c.kind === 'model_answer')).toBe(false);
    });
    it('keeps the legacy policy when the new capability is absent', async () => {
        const f = fixture({
            reasoning: true,
            gapDriven: true,
            conflict: 'conditional',
            reviewDisabled: true,
        });
        const result = await runResearchAgent(f.context, f.deps);
        expect(f.calls.some((k) => k.startsWith('conflict-review'))).toBe(false);
        expect(result.claims.some((c) => c.kind === 'conflict')).toBe(true);
        expect((await f.saver.get(f.checkpoint()))!.channel_values.research).not.toHaveProperty(
            'conflictReviewPolicy',
        );
    });
});

describe('answer completion separates answered coverage from external support', () => {
    const answered = { reasoning: true, gapDriven: true, wire: true } as const;

    it('repairs a missing structured gap kind through the strict small-budget protocol', async () => {
        const f = fixture({
            ...answered,
            answerCompletion: true,
            gapKinds: true,
            omitInitialGapKind: true,
            smallBudget: true,
        });
        const result = await runResearchAgent(f.context, f.deps);
        expect(f.calls.some((key) => key.startsWith('synthesize') && key.endsWith('-1'))).toBe(
            true,
        );
        expect(
            result.claims
                .filter((c) => c.kind !== 'model_answer' && c.kind !== 'insufficient')
                .every((c) => c.assessment?.gapKind),
        ).toBe(true);
        const state = (await f.saver.get(f.checkpoint()))!.channel_values.research;
        expect(state).toMatchObject({ gapKindPolicy: 1 });
        expect(candidateFromCheckpoint(f.context, state)).toEqual(result);
    });

    it('completes delivery once every question is answered and reports weak external support as notes', async () => {
        const f = fixture({ ...answered, answerCompletion: true });
        const result = await runResearchAgent(f.context, f.deps);
        expect(result.coverage.metrics).toMatchObject({
            answeredQuestions: 1,
            externallySupportedQuestions: 0,
            answeredFields: 4,
            externallySupportedFields: 2,
        });
        expect(result.coverage.completeness).toBe('complete');
        expect(result.coverage.gaps).toEqual([]);
        expect(result.coverage.notes!.some((n) => n.startsWith('所需信息缺少充分外部证据'))).toBe(
            true,
        );
        const models = result.claims.filter((c) => c.kind === 'model_answer');
        expect(models.length).toBeGreaterThan(0);
        expect(models.every((c) => !c.citations.length && c.assessment?.support === 'none')).toBe(
            true,
        );
        const state = (await f.saver.get(f.checkpoint()))!.channel_values.research;
        expect(candidateFromCheckpoint(f.context, state)).toEqual(result);
    });

    it('keeps the same answers partial without the completion policy', async () => {
        const f = fixture(answered);
        const result = await runResearchAgent(f.context, f.deps);
        expect(result.coverage.delivery?.answeredQuestions).toBe(1);
        expect(result.coverage.completeness).toBe('partial');
        expect(result.coverage.gaps.some((g) => g.startsWith('所需信息缺少充分外部证据'))).toBe(
            true,
        );
    });

    it('completes initial research with unverified page coverage while preserving its diagnostics', async () => {
        const f = fixture({ ...answered, answerCompletion: true, researchMode: 'analysis' });
        const result = await runResearchAgent(f.context, f.deps);
        expect(result.coverage.metrics?.answeredQuestions).toBe(1);
        expect(result.coverage.completeness).toBe('complete');
        expect(result.coverage.notes?.length).toBeGreaterThan(0);
        expect(
            candidateFromCheckpoint(
                f.context,
                (await f.saver.get(f.checkpoint()))!.channel_values.research,
            ),
        ).toEqual(result);
    });

    it('stays partial when the model declines and a question remains unanswered', async () => {
        const f = fixture({ ...answered, answerCompletion: true, unknown: true });
        const result = await runResearchAgent(f.context, f.deps);
        expect(result.coverage.delivery?.answeredQuestions).toBe(0);
        expect(result.coverage.completeness).toBe('partial');
        expect(result.coverage.gaps.length).toBeGreaterThan(0);
    });

    it('stays partial while a genuine conflict is unresolved', async () => {
        const f = fixture({ ...answered, conflict: 'unresolved', answerCompletion: true });
        const result = await runResearchAgent(f.context, f.deps);
        expect(result.coverage.metrics!.unresolvedQuestionIds).toEqual(['q0']);
        expect(result.coverage.completeness).toBe('partial');
    });

    it('rebuilds a checkpoint without the marker under the legacy rule and rejects a forged version', async () => {
        const f = fixture({ ...answered, answerCompletion: true });
        await runResearchAgent(f.context, f.deps);
        const state = (await f.saver.get(f.checkpoint()))!.channel_values.research as Record<
            string,
            unknown
        >;
        const legacy = structuredClone(state);
        delete legacy.answerCompletionPolicy;
        expect(candidateFromCheckpoint(f.context, legacy).coverage.completeness).toBe('partial');
        expect(() =>
            candidateFromCheckpoint(f.context, { ...state, answerCompletionPolicy: 2 }),
        ).toThrow();
        expect(() =>
            candidateFromCheckpoint(f.context, { ...state, researchLoopPolicy: undefined }),
        ).toThrow();
    });
});

describe('knowledge first with independent draft receipts', () => {
    const policy = {
        reasoning: true,
        gapDriven: true,
        gapKinds: true,
        knowledgeFirst: true,
        answerCompletion: true,
        wire: true,
    } as const;
    it('drafts before search and lets verified external field answers replace all drafts', async () => {
        const f = fixture({ ...policy, crossQuestion: true, smallBudget: true });
        const steps: string[] = [];
        f.deps.onStep = async (step, phase) => {
            if (phase === 'started') steps.push(step);
        };
        const result = await runResearchAgent(f.context, f.deps);
        expect(steps.indexOf('model_draft')).toBeLessThan(steps.indexOf('search'));
        expect(f.calls.filter((k) => k.startsWith('model-draft')).length).toBeGreaterThan(0);
        expect(result.coverage.metrics).toMatchObject({
            answeredFields: 4,
            externallySupportedFields: 4,
        });
        expect(result.claims.some((c) => c.kind === 'model_answer')).toBe(false);
        expect(
            candidateFromCheckpoint(
                f.context,
                (await f.saver.get(f.checkpoint()))!.channel_values.research,
            ),
        ).toEqual(result);
    });
    it('keeps stable non-core fields eligible when q0 asks for latest information', async () => {
        const f = fixture({
            ...policy,
            goal: '最新 agent 动态',
            crossQuestion: true,
            noPages: true,
        });
        const result = await runResearchAgent(f.context, f.deps);
        const models = result.claims.filter((c) => c.kind === 'model_answer');
        expect(models).toHaveLength(2);
        expect(
            models.every(
                (c) =>
                    c.questionIds.join() === 'q1' &&
                    !c.citations.length &&
                    c.assessment?.support === 'none',
            ),
        ).toBe(true);
        expect(result.coverage.metrics?.unresolvedQuestionIds).toContain('q0');
    });
    it.each(['current', 'exact', 'source_required'] as const)(
        'does not draft externally required %s fields',
        async (verification) => {
            const f = fixture({ ...policy, verification });
            await runResearchAgent(f.context, f.deps);
            expect(f.calls.some((k) => k.startsWith('model-draft'))).toBe(false);
        },
    );
    it('preserves genuine conflicts over an earlier knowledge draft', async () => {
        const f = fixture({ ...policy, conflict: 'unresolved' });
        const result = await runResearchAgent(f.context, f.deps);
        expect(result.claims.some((c) => c.kind === 'conflict')).toBe(true);
        expect(
            result.claims
                .filter((c) => c.kind === 'model_answer')
                .some((c) => c.text.includes('memory')),
        ).toBe(false);
        expect(result.coverage.metrics?.unresolvedQuestionIds).toEqual(['q0']);
    });
    it('resumes the draft cursor without repeating a committed call', async () => {
        const f = fixture(policy);
        f.deps.onStep = async (step, phase) => {
            if (step === 'model_draft' && phase === 'completed') throw new Error('restart');
        };
        await expect(runResearchAgent(f.context, f.deps)).rejects.toThrow('restart');
        const savedDraft = f.calls.filter((k) => k.startsWith('model-draft'));
        const result = await runResearchAgent(f.context, {
            ...f.deps,
            onStep: undefined,
            resume: true,
            config: f.checkpoint(),
        });
        for (const key of savedDraft) expect(f.calls.filter((k) => k === key)).toHaveLength(1);
        expect(result.coverage.metrics?.answeredQuestions).toBe(1);
        const state = (await f.saver.get(f.checkpoint()))!.channel_values.research;
        expect(() =>
            candidateFromCheckpoint(f.context, { ...(state as object), knowledgeFirstPolicy: 2 }),
        ).toThrow();
    });
});

describe('persisted gap loop', () => {
    const policy = {
        reasoning: true,
        gapDriven: true,
        gapKinds: true,
        gapLoop: true,
        answerCompletion: true,
        unknown: true,
    } as const;
    it('keeps eight reads after the initial twelve and uses observed URLs without another search or false gain', async () => {
        const f = fixture({ ...policy, manyPages: true });
        let initialPages = 0;
        f.deps.onStep = async (step, phase) => {
            if (step === 'verify' && phase === 'started' && !initialPages)
                initialPages = f.context.usage.pages;
        };
        await runResearchAgent(f.context, f.deps);
        expect(initialPages).toBe(12);
        const state = (await f.saver.get(f.checkpoint()))!.channel_values
            .research as import('../src/research/state.ts').ResearchState;
        expect(f.context.usage.searches).toBe(2);
        const reads = state.gapLoop!.history.filter((h) => h.action === 'read');
        expect(reads.length).toBeGreaterThan(0);
        expect(f.context.usage.pages).toBe(12 + reads.length);
        expect(f.context.usage.pages).toBeLessThanOrEqual(16);
        expect(state.gapLoop?.history.every((h) => h.gain === false)).toBe(true);
    });
    it('verifies all knowledge-drafted fields and binds a shared-question claim without widening read scope', async () => {
        const f = fixture({
            ...policy,
            unknown: false,
            knowledgeFirst: true,
            crossQuestion: true,
            sharedAnswer: true,
            wire: true,
        });
        const result = await runResearchAgent(f.context, f.deps);
        expect(result.coverage.completion).toMatchObject({
            answerReady: true,
            verificationDone: true,
            externalEvidenceComplete: true,
            stopReason: 'verified',
        });
        expect(result.coverage.metrics?.externallySupportedFields).toBe(4);
        expect(result.claims.filter((c) => c.kind === 'model_answer')).toEqual([]);
        expect(result.pages[0]!.questionIds).toEqual(['q0']);
        expect(
            result.claims.some((c) => c.questionIds.length === 2 && c.citations.length > 0),
        ).toBe(true);
        expect(
            candidateFromCheckpoint(
                f.context,
                (await f.saver.get(f.checkpoint()))!.channel_values.research,
            ),
        ).toEqual(result);
    });
    it('rejects shared-question support without a valid passage association', async () => {
        const f = fixture({
            ...policy,
            crossQuestion: true,
            sharedAnswer: true,
            invalidLink: true,
        });
        const result = await runResearchAgent(f.context, f.deps);
        expect(result.coverage.metrics?.externallySupportedFields).toBe(2);
        expect(result.coverage.completion?.externalEvidenceComplete).toBe(false);
        expect(result.claims.some((c) => c.questionIds.length === 2)).toBe(false);
    });
    it('reads an observed body link first, resumes that action once and gains target support', async () => {
        const f = fixture({ ...policy, navigation: true });
        f.deps.onStep = async (step, phase) => {
            if (step === 'gap_loop' && phase === 'completed') throw new Error('navigation restart');
        };
        await expect(runResearchAgent(f.context, f.deps)).rejects.toThrow('navigation restart');
        const pending = (await f.saver.get(f.checkpoint()))!.channel_values
            .research as import('../src/research/state.ts').ResearchState;
        expect(pending.gapLoop?.target).toMatchObject({
            action: 'read',
            url: 'https://example.com/react/memory',
        });
        const result = await runResearchAgent(f.context, {
            ...f.deps,
            onStep: undefined,
            resume: true,
            config: f.checkpoint(),
        });
        expect(f.context.usage).toMatchObject({ searches: 1, pages: 2 });
        expect(result.coverage.completion).toMatchObject({
            externalEvidenceComplete: true,
            stopReason: 'verified',
        });
        const state = (await f.saver.get(f.checkpoint()))!.channel_values
            .research as import('../src/research/state.ts').ResearchState;
        expect(state.gapLoop?.history[0]).toMatchObject({ action: 'read', gain: true });
        expect(candidateFromCheckpoint(f.context, state)).toEqual(result);
        expect(() =>
            candidateFromCheckpoint(f.context, { ...state, loopQualityPolicy: undefined }),
        ).toThrow();
    });
    it('retains a required missing component even if the model calls it a detail and marks the field supported', async () => {
        const f = fixture({ ...policy, requiredMissingDetail: true });
        const result = await runResearchAgent(f.context, f.deps);
        expect(result.coverage.metrics?.externallySupportedFields).toBe(0);
        expect(result.coverage.completion).toMatchObject({
            answerReady: false,
            externalEvidenceComplete: false,
            verificationDone: true,
        });
        expect(result.coverage.completeness).toBe('partial');
    });
    it('continues bounded verification after all draft answers are available', async () => {
        const f = fixture({
            ...policy,
            unknown: false,
            knowledgeFirst: true,
            diagnosis: 'binding_missing',
        });
        const result = await runResearchAgent(f.context, f.deps);
        const state = (await f.saver.get(f.checkpoint()))!.channel_values
            .research as import('../src/research/state.ts').ResearchState;
        expect(state.gapLoop?.history.length).toBeGreaterThan(0);
        expect(result.coverage.completion).toMatchObject({
            answerReady: true,
            externalEvidenceComplete: false,
            verificationDone: true,
            stopReason: 'no_progress',
        });
        expect(result.coverage.completeness).toBe('complete');
    });
    it('repairs only one field at a time without searching when the binding is missing', async () => {
        const f = fixture({ ...policy, diagnosis: 'binding_missing' });
        const result = await runResearchAgent(f.context, f.deps);
        const state = (await f.saver.get(f.checkpoint()))!.channel_values
            .research as import('../src/research/state.ts').ResearchState;
        expect(state.gapLoop?.history.length).toBeGreaterThan(0);
        expect(state.gapLoop?.history.every((h) => h.action === 'rebind' && h.gain === false)).toBe(
            true,
        );
        expect(f.context.usage.searches).toBe(1);
        const patches = f.inputs.filter((i) =>
            /^synthesize-(?:[2-9]|batch-\d+-[2-9])$/.test(i.key),
        );
        expect(patches.length).toBeGreaterThan(0);
        for (const patch of patches) {
            const schema = patch.input.schema as any;
            expect(
                schema.properties.artifacts.items.properties.requirements.items.properties.id.enum,
            ).toHaveLength(1);
        }
        expect(new Set(f.calls).size).toBe(f.calls.length);
        expect(candidateFromCheckpoint(f.context, state)).toEqual(result);
    });
    it('does not re-synthesize when a targeted search yields no new body and resumes a saved action once', async () => {
        const f = fixture(policy);
        let stopped = false;
        f.deps.onStep = async (step, phase) => {
            if (!stopped && step === 'gap_loop' && phase === 'completed') {
                stopped = true;
                throw new Error('gap restart');
            }
        };
        await expect(runResearchAgent(f.context, f.deps)).rejects.toThrow('gap restart');
        const previous = [...f.calls];
        const result = await runResearchAgent(f.context, {
            ...f.deps,
            onStep: undefined,
            resume: true,
            config: f.checkpoint(),
        });
        for (const key of previous) expect(f.calls.filter((k) => k === key)).toHaveLength(1);
        const state = (await f.saver.get(f.checkpoint()))!.channel_values
            .research as import('../src/research/state.ts').ResearchState;
        expect(f.context.usage.searches).toBe(2);
        expect(state.gapLoop?.history).toHaveLength(1);
        expect(state.gapLoop?.history[0]).toMatchObject({ action: 'search', gain: false });
        expect(state.gapLoop?.stopped).toBe(true);
        expect(result.coverage.completeness).toBe('partial');
        expect(f.calls.some((k) => k === 'synthesize-2')).toBe(false);
    });
    it('uses extended operation identities for independent repairs without enlarging the claim capacity', async () => {
        const f = fixture({ ...policy, synthesisFailure: true });
        const result = await runResearchAgent(f.context, f.deps);
        const state = (await f.saver.get(f.checkpoint()))!.channel_values
            .research as import('../src/research/state.ts').ResearchState;
        expect(state.synthesisAttempts).toBeGreaterThan(4);
        expect(result.claims.length).toBeLessThanOrEqual(192);
        expect(state.gapLoop?.history.every((h) => h.gain === false)).toBe(true);
        expect(new Set(state.gapLoop?.history.map((h) => h.fingerprint)).size).toBe(
            state.gapLoop?.history.length,
        );
        expect(candidateFromCheckpoint(f.context, state)).toEqual(result);
        expect(() =>
            candidateFromCheckpoint(f.context, { ...state, gapLoopPolicy: undefined }),
        ).toThrow();
    });
    it.each(['time', 'output'] as const)(
        'stops before new calls when the %s envelope is low',
        async (limit) => {
            const f = fixture(policy);
            f.deps.onStep = async (step, phase) => {
                if (step === 'gap_loop' && phase === 'started') {
                    if (limit === 'output')
                        f.context.usage.outputTokens = f.context.budget.maxOutputTokens - 100;
                    else f.context.deadlineAt = new Date(Date.now() + 10000);
                }
            };
            await runResearchAgent(f.context, f.deps);
            const state = (await f.saver.get(f.checkpoint()))!.channel_values
                .research as import('../src/research/state.ts').ResearchState;
            expect(state.gapLoop?.stopped).toBe(true);
            expect(state.gapLoop?.history).toEqual([]);
            expect(f.context.usage.searches).toBe(1);
        },
    );
});
