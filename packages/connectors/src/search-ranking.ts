import type { SearchResult } from './types.ts';

const generic = new Set([
    '最新',
    '前沿',
    '综述',
    '进展',
    '研究',
    '信息',
    'the',
    'and',
    'latest',
    'recent',
    'new',
    'of',
    'in',
    'a',
]);
function terms(value: string): string[] {
    return [
        ...new Set(
            (value.toLowerCase().match(/[a-z][a-z0-9-]+|[\p{Script=Han}]{2,}/gu) ?? [])
                .flatMap((word) =>
                    /\p{Script=Han}/u.test(word) && word.length > 2
                        ? Array.from({ length: word.length - 1 }, (_, i) => word.slice(i, i + 2))
                        : [word],
                )
                .filter((word) => !generic.has(word)),
        ),
    ];
}

/** Candidate relevance is a selection heuristic, never evidence or official-source certification. */
export function searchRelevance(
    query: string,
    source: Pick<SearchResult, 'title' | 'snippet' | 'url'>,
): number {
    const text = `${source.title} ${source.snippet} ${source.url}`.toLowerCase();
    const tokens = terms(query);
    let score = tokens.reduce(
        (sum, term) => sum + (text.includes(term) ? (/^[a-z]/.test(term) ? 3 : 1) : 0),
        0,
    );
    if (
        (/\bReAct\b/.test(query) || /\bagents?\b|智能体/i.test(query)) &&
        /\breact\b/i.test(text) &&
        !/\bagents?\b|智能体|reasoning|acting/i.test(text)
    )
        score -= 20;
    if (/\bagents?\b|智能体/i.test(query) && !/\bagents?\b|智能体/i.test(text)) score -= 10;
    return score;
}

export function rankSearchCandidates(query: string, sources: SearchResult[]): SearchResult[] {
    return sources
        .map((source, index) => ({ source, index, score: searchRelevance(query, source) }))
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .map((entry) => entry.source);
}

/** SearxNG query operators must not override the deployment's engine allowlist. */
export function plainSearchQuery(query: string): string {
    return query.replace(/(^|\s)[!:][^\s]+/g, '$1').trim();
}
