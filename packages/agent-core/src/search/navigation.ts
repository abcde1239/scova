import { normalizeUrl, searchRelevance } from '@scova/connectors';
import { matchesQueryVersion } from './recovery.ts';
import type { GapTarget } from '../research/gap-loop.ts';
import { allowed, type ResearchState, type Selection } from '../research/state.ts';
import type { AgentContext } from '../types.ts';
import { unsupportedSearchReadCandidate, unsupportedReadCandidate } from './read-candidates.ts';

export function observedSelections(state: ResearchState): Selection[] {
    return [
        ...state.searches.flatMap((s) =>
            s.response.results.map((r) => ({
                url: r.originalUrl,
                questionIds: s.query.questionIds,
            })),
        ),
        ...state.pages.flatMap((p) =>
            (p.links ?? []).map((l) => ({ url: l.url, questionIds: p.questionIds })),
        ),
    ];
}

/** Only observed, allowed URLs may be scheduled. A navigation link grants no semantic support. */
export function observedReadTarget(
    context: AgentContext,
    state: ResearchState,
    target: GapTarget & { field?: string },
    providerReads = false,
): Selection | undefined {
    const focus = `${context.config.topic} ${target.query}`;
    const request = `${context.config.topic} ${context.config.goal}`;
    const attempted = new Set(
        state.selections.slice(0, state.readIndex).map((s) => normalizeUrl(s.url)),
    );
    const candidates = [
        ...state.searches.flatMap((s) =>
            s.response.results
                .filter((r) => !unsupportedSearchReadCandidate(r, providerReads))
                .map((r) => ({
                    url: r.originalUrl,
                    title: r.title,
                    snippet: r.snippet,
                    questionIds: s.query.questionIds,
                })),
        ),
        ...state.pages.flatMap((page) =>
            (page.links ?? [])
                .filter((l) => providerReads || !unsupportedReadCandidate(l.url))
                .map((link) => ({
                    url: link.url,
                    title: link.text,
                    snippet: link.text,
                    questionIds: page.questionIds,
                })),
        ),
    ].filter(
        (c) =>
            allowed(context, c.url) &&
            !attempted.has(normalizeUrl(c.url)) &&
            c.questionIds.some((id) => target.questionIds.includes(id)) &&
            matchesQueryVersion(request, c) &&
            searchRelevance(focus, c) > 0,
    );
    const latest =
        /最新|latest/i.test(request) &&
        /版本|发布|日期|version|release|date/i.test(`${target.query} ${target.field ?? ''}`);
    const version = (text: string) =>
        text
            .match(/(?:^|[^0-9])(\d+\.\d+\.\d+)\b/)?.[1]
            ?.split('.')
            .map(Number) ?? [];
    candidates.sort((a, b) => {
        if (latest) {
            const av = version(`${a.title} ${a.url}`),
                bv = version(`${b.title} ${b.url}`);
            if (!!av.length !== !!bv.length) return bv.length - av.length;
            if (av.length && bv.length)
                for (let i = 0; i < 3; i++) {
                    const delta = bv[i]! - av[i]!;
                    if (delta) return delta;
                }
        }
        return searchRelevance(focus, b) - searchRelevance(focus, a);
    });
    const selected = candidates[0];
    return selected ? { url: selected.url, questionIds: [...selected.questionIds] } : undefined;
}
