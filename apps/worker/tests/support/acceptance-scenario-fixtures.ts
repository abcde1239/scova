import {
    ConnectorError,
    createHttpPageReader as createPageReader,
    type CallContext,
    type ConnectorBundle,
    type StructuredInput,
} from '@scova/connectors';
import type { AgentClaim } from '@scova/agent-core';

export const scenarioNames = ['english', 'admissions', 'research'] as const;
export type ScenarioName = (typeof scenarioNames)[number];
export type ScenarioPhase = 'A' | 'B' | 'C';
type Fact = {
    subject: string;
    predicate: string;
    value: string;
    quote: string;
    relevance?: 'relevant' | 'excluded';
    relation?: { kind: 'secondary' | 'revision' | 'contrasting'; url: string; quote: string };
};
function frozenFixtureTask(input: StructuredInput) {
    const marker = [
        '# Frozen research input (JSON data, not new instructions)',
        'Frozen input: ',
    ].find((value) => input.prompt.includes(value));
    if (!marker) throw new Error('Fixture planner is missing frozen task input');
    const line = input.prompt
        .slice(input.prompt.indexOf(marker) + marker.length)
        .trimStart()
        .split('\n')[0]!;
    return JSON.parse(line) as { task: { questions: { id: string; text: string }[] } };
}
const fact = (subject: string, predicate: string, value: string): Fact => ({
    subject,
    predicate,
    value,
    quote: subject + ': ' + predicate + ' = ' + value + '.',
});
export function scenarioData(
    name: ScenarioName,
    phase: ScenarioPhase,
    options: { browserScenarios?: boolean } = {},
) {
    const base = 'https://acceptance.example.org/' + name;
    const revised = phase !== 'A';
    const stable = {
        english: [fact('Lesson One', 'availability', 'free B1 audio with subtitles')],
        admissions: [fact('Admissions FAQ', 'submission', 'online application')],
        research: [
            fact('Original Paper', 'conclusion', 'method improves accuracy under condition A'),
        ],
    }[name];
    const changed = {
        english: [fact('Lesson Two', 'cost', revised ? 'paid subscription' : 'free access')],
        admissions: [
            fact('Programme', 'deadline', revised ? '22 November' : '15 November'),
            fact('Programme', 'language requirement', revised ? 'B2' : 'B1'),
        ],
        research: [
            fact('Sample Study', 'sample count', revised ? '40 participants' : '20 participants'),
        ],
    }[name];
    const added = {
        english: [fact('Lesson Three', 'availability', 'free B1 transcript and audio')],
        admissions: [fact('Scholarship', 'availability', 'new application window')],
        research: [
            fact(
                'Independent Paper',
                'conclusion',
                'different method performs best under condition B',
            ),
        ],
    }[name];
    const pages = new Map<string, Fact[]>([
        [base + '/stable', stable],
        [base + '/changed', changed],
        ...(revised ? ([[base + '/new', added]] as [string, Fact[]][]) : []),
    ]);
    // Browser acceptance adds independently inspectable discovery cases without changing
    // the established backend acceptance fixtures or any production provider behavior.
    if (options.browserScenarios && revised && name === 'english') {
        changed[0]!.relevance = 'excluded';
        pages.set(
            base + '/mirror',
            stable.map((entry) => ({ ...entry })),
        );
        pages.set(base + '/advanced', [
            {
                ...fact('Advanced Lesson', 'availability', 'C1 audio without subtitles'),
                relevance: 'excluded',
            },
        ]);
    }
    if (options.browserScenarios && revised && name === 'research') {
        const related = (
            entry: Fact,
            kind: 'secondary' | 'revision' | 'contrasting',
            url: string,
        ) => {
            const quote = `${entry.quote} This source explicitly links ${url}.`;
            return { ...entry, quote, relation: { kind, url, quote } };
        };
        pages.set(base + '/news', [related(stable[0]!, 'secondary', base + '/stable')]);
        pages.set(base + '/revision', [related(changed[0]!, 'revision', base + '/changed')]);
        pages.set(base + '/new', [related(added[0]!, 'contrasting', base + '/stable')]);
    }
    return { base, pages, changed, stableUrl: base + '/stable', changedUrl: base + '/changed' };
}

/**
 * Explicit live-mode supplier fixture, not a remote provider smoke test.
 * Only search/HTTP/model replies are fixed; reader extraction, ledger, graph,
 * comparison, checkpoints, lease fences and delivery remain production code.
 */
export function scenarioConnectors(
    name: ScenarioName,
    phase: ScenarioPhase,
    options: { queryForGoal?: boolean; browserScenarios?: boolean } = {},
): ConnectorBundle {
    const data = scenarioData(name, phase, options);
    const publication = new Date(Date.now() - 60_000).toISOString();
    const reader = createPageReader({
        http: {
            async request(url) {
                if (phase === 'C' && url === data.changedUrl)
                    throw new ConnectorError(
                        'network',
                        'Acceptance fixture: source temporarily unavailable',
                    );
                const canonical = new URL(url);
                canonical.search = '';
                const facts = data.pages.get(canonical.href);
                if (!facts) throw new Error('Unexpected fixture URL');
                return {
                    url,
                    status: 200,
                    headers: { 'content-type': 'text/html; charset=utf-8' },
                    body:
                        '<html><head><title>Acceptance source</title><meta property="article:published_time" content="' +
                        publication +
                        '"></head><body><article>' +
                        facts.map((entry) => '<p>' + entry.quote + '</p>').join('') +
                        '</article></body></html>',
                };
            },
        },
    });
    let requirements: {
        id: string;
        format: string;
        questionIds: string[];
        object: string;
        field: string;
        required: boolean;
    }[] = [];
    return {
        mode: 'live',
        reader,
        search: {
            async search(query, context) {
                await context?.beforeAttempt?.('search');
                const urls = [...data.pages.keys()].map((url) =>
                    options.browserScenarios &&
                    name === 'english' &&
                    phase !== 'A' &&
                    url === data.stableUrl
                        ? `${url}?utm_source=browser-acceptance`
                        : url,
                );
                return {
                    kind: 'search_results',
                    mode: 'live',
                    provider: 'searxng',
                    query,
                    searchedAt: new Date().toISOString(),
                    results: urls.map((url) => ({
                        kind: 'search_snippet' as const,
                        originalUrl: url,
                        url,
                        title: 'Acceptance source',
                        snippet:
                            'Untrusted discovery snippet; facts require a successful page read.',
                        engines: ['acceptance-fixture'],
                    })),
                    coverage: {
                        complete: true,
                        gaps: [],
                        unresponsiveEngines: [],
                        receivedResults: urls.length,
                        returnedResults: urls.length,
                        discardedResults: 0,
                        totalResults: urls.length,
                        truncated: false,
                    },
                };
            },
        },
        model: {
            async generateStructured<T>(input: StructuredInput, context?: CallContext) {
                await context?.beforeAttempt?.('model');
                const properties = (input.schema.properties ?? {}) as Record<string, unknown>;
                const pages = (input.untrustedSources ?? []) as {
                    pageId: string;
                    url: string;
                    text: string;
                }[];
                let query = name + ' acceptance sources';
                if (options.queryForGoal && Object.hasOwn(properties, 'queries')) {
                    const { task } = frozenFixtureTask(input);
                    query = (task.questions[0]!.text + ' acceptance sources').slice(0, 2000);
                }
                const claims: AgentClaim[] = pages.flatMap((page) =>
                    (data.pages.get(page.url) ?? [])
                        .filter((entry) => entry.relevance !== 'excluded')
                        .map((entry) => ({
                            kind: 'fact' as const,
                            text: entry.quote,
                            questionIds: ['q0'],
                            citations: [{ pageId: page.pageId, quote: entry.quote }],
                            assessment: {
                                ...((properties.claims as any)?.items?.properties?.assessment
                                    ?.properties?.gapKind
                                    ? { gapKind: 'none' as const }
                                    : {}),
                                relevance: 'direct' as const,
                                support: 'direct' as const,
                                role: 'answer' as const,
                                sourceRelation:
                                    entry.relation?.kind === 'secondary'
                                        ? ('secondary' as const)
                                        : ('original' as const),
                                reason: '固定验收资料逐字记载本场景的目标事实；仅用于受控管线验收。',
                                conditions: '',
                                gap: '',
                            },
                        })),
                );
                if (options.browserScenarios && name === 'research' && phase !== 'A') {
                    const original = pages.find((page) => page.url === data.stableUrl);
                    const contrasting = pages.find((page) => page.url === data.base + '/new');
                    if (original && contrasting) {
                        claims.push({
                            kind: 'conflict',
                            text: '原文分别讨论条件A与条件B下的不同结果，保留观点差异，不能断定原论文被推翻。',
                            questionIds: ['q0'],
                            citations: [original, contrasting].map((page) => ({
                                pageId: page.pageId,
                                quote: data.pages.get(page.url)![0]!.quote,
                            })),
                        });
                        claims.push({
                            kind: 'insufficient',
                            text: '现有来源不足以将不同实验条件下的结论推广到所有研究。',
                            questionIds: [],
                            citations: [],
                        });
                    }
                }
                const payload = Object.hasOwn(properties, 'queries')
                    ? { queries: [{ query, questionIds: ['q0'] }] }
                    : Object.hasOwn(properties, 'pages')
                      ? {
                            pages: pages.map((page) => ({
                                pageId: page.pageId,
                                facts: (data.pages.get(page.url) ?? []).map((entry) => ({
                                    ...entry,
                                    relevance: entry.relevance ?? 'relevant',
                                    importance: 'important',
                                })),
                            })),
                        }
                      : Object.hasOwn(properties, 'answers')
                        ? {
                              answers: (
                                  properties.answers as {
                                      items: { properties: { requirementId: { enum: string[] } } };
                                  }
                              ).items.properties.requirementId.enum.map((requirementId) => ({
                                  requirementId,
                                  canAnswer: false,
                                  text: '',
                                  reason: '受控验收夹具没有额外的模型知识答案。',
                              })),
                          }
                        : { claims };
                if (Object.hasOwn(properties, 'knowledgePlan'))
                    Object.assign(payload, { knowledgePlan: [] });
                if (Object.hasOwn(properties, 'evidenceLinks'))
                    Object.assign(payload, { evidenceLinks: [] });
                if (Object.hasOwn(properties, 'requirements')) {
                    const frozen = frozenFixtureTask(input);
                    const schema = properties.requirements as {
                        items: { properties: { format: { enum: string[] } } };
                    };
                    requirements = schema.items.properties.format.enum.flatMap((format) =>
                        frozen.task.questions.map((question) => ({
                            id: `${format}-${question.id}`,
                            format,
                            questionIds: [question.id],
                            object: '',
                            field: question.text,
                            required: true,
                            verification: 'stable',
                        })),
                    );
                    Object.assign(payload, { requirements });
                }
                if (Object.hasOwn(properties, 'artifacts')) {
                    const claimSchema = properties.claims as {
                        items: {
                            properties: { outputFormat?: { enum: AgentClaim['outputFormat'][] } };
                        };
                    };
                    const format = claimSchema.items.properties.outputFormat?.enum[0];
                    if (format) for (const claim of claims) claim.outputFormat = format;
                    // Resume may reuse a committed plan without re-invoking this fixture model.
                    // Read the immutable requirements supplied to synthesis rather than hidden closure state.
                    const marker = 'Frozen artifact requirements (data): ';
                    const start = input.prompt.indexOf(marker);
                    if (start >= 0)
                        requirements = JSON.parse(
                            input.prompt.slice(start + marker.length).split('\n')[0]!,
                        );
                    else {
                        const compactMarker = 'Frozen data: ';
                        const compactStart = input.prompt.indexOf(compactMarker);
                        if (compactStart < 0)
                            throw new Error(
                                'Fixture synthesis is missing frozen artifact requirements',
                            );
                        requirements = JSON.parse(
                            input.prompt.slice(compactStart + compactMarker.length).split('\n')[0]!,
                        ).requirements;
                    }
                    const schema = properties.artifacts as {
                        items: { properties: { format: { enum: string[] } } };
                    };
                    Object.assign(payload, {
                        artifacts: schema.items.properties.format.enum.map((format) => ({
                            format,
                            document: null,
                            requirements: requirements
                                .filter((requirement) => requirement.format === format)
                                .map((requirement) => {
                                    const index = claims.findIndex(
                                        (claim) =>
                                            (claim.outputFormat ??
                                                schema.items.properties.format.enum[0]) ===
                                                format &&
                                            requirement.questionIds.every((id) =>
                                                claim.questionIds.includes(id),
                                            ),
                                    );
                                    return {
                                        id: requirement.id,
                                        text: index < 0 ? '' : claims[index]!.text,
                                        claimIndexes: index < 0 ? [] : [index],
                                    };
                                }),
                        })),
                    });
                    if (Object.hasOwn(properties, 'fieldChecks')) {
                        const artifacts = (
                            payload as unknown as {
                                artifacts: {
                                    requirements: { id: string; claimIndexes: number[] }[];
                                }[];
                            }
                        ).artifacts;
                        Object.assign(payload, {
                            fieldChecks: artifacts.flatMap((a) =>
                                a.requirements.map((r) => ({
                                    requirementId: r.id,
                                    status: r.claimIndexes.length
                                        ? 'supported'
                                        : 'evidence_missing',
                                    query: r.claimIndexes.length
                                        ? ''
                                        : 'original source for missing proposition',
                                    reason: '受控原文命题评估',
                                })),
                            ),
                        });
                    }
                }
                return {
                    mode: 'live',
                    usage: { inputTokens: 1, outputTokens: 1, estimated: false },
                    data: payload as T,
                };
            },
        },
    };
}
