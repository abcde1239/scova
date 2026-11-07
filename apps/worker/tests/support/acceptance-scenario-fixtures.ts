import {
    createPageReader,
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
                    throw new Error('Acceptance fixture: source temporarily unavailable');
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
                    const marker = input.prompt.indexOf('任务=');
                    if (marker < 0) throw new Error('Fixture planner is missing task input');
                    const task = JSON.parse(input.prompt.slice(marker + 3)) as {
                        questions: { id: string; text: string }[];
                    };
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
                      : { claims };
                return {
                    mode: 'live',
                    usage: { inputTokens: 1, outputTokens: 1, estimated: false },
                    data: payload as T,
                };
            },
        },
    };
}
