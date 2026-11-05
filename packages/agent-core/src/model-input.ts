import { ConnectorError, estimateModelInputTokens, type StructuredInput } from '@scova/connectors';
import type { AgentPage } from './types.ts';

export const COMPARISON_SOURCE_CHAR_LIMIT = 32_000;

/** Keep exact, separately delimited excerpts. A quote may never cross an omitted span. */
export function fitSources(
    input: StructuredInput,
    pages: AgentPage[],
    prefixOnly = false,
): { input: StructuredInput; clipped: boolean } {
    const bodies = pages.map((page) => Array.from(page.text));
    const project = (limit: number) =>
        pages.map((page, index) => {
            const chars = bodies[index];
            const base = { pageId: page.id, url: page.url, questionIds: page.questionIds };
            if (chars.length <= limit) return { ...base, text: page.text };
            if (prefixOnly) return { ...base, text: chars.slice(0, limit).join('') };
            const size = Math.floor(limit / 3);
            const middle = Math.floor((chars.length - size) / 2);
            return {
                ...base,
                excerpts: [
                    chars.slice(0, size).join(''),
                    chars.slice(middle, middle + size).join(''),
                    chars.slice(chars.length - size).join(''),
                ],
            };
        });
    let low = 0;
    let high = Math.max(0, ...bodies.map((body) => body.length));
    if (prefixOnly) high = Math.min(high, COMPARISON_SOURCE_CHAR_LIMIT);
    const withSources = (limit: number) => ({ ...input, untrustedSources: project(limit) });
    if (estimateModelInputTokens(withSources(high)) <= input.maxInputTokens)
        return { input: withSources(high), clipped: bodies.some((body) => body.length > high) };
    while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (estimateModelInputTokens(withSources(mid)) <= input.maxInputTokens) low = mid;
        else high = mid - 1;
    }
    if (low < 3 || estimateModelInputTokens(withSources(low)) > input.maxInputTokens)
        throw new ConnectorError('budget_exceeded', '剩余输入预算不足以容纳正文与结构');
    return { input: withSources(low), clipped: bodies.some((body) => body.length > low) };
}

/** Evidence remains verbatim; the visible brief must be concise and mostly synthesized. */
export function isConciseBrief(claims: { kind: string; text: string }[], pages: AgentPage[]) {
    if (claims.length > 8 || claims.some((claim) => Array.from(claim.text).length > 320))
        return false;
    const size = claims.reduce((sum, claim) => sum + Array.from(claim.text).length, 0);
    if (size > 1600) return false;
    if (size > 320 && !claims.some((claim) => claim.kind === 'inference')) return false;
    return !claims.some(
        (claim) =>
            claim.kind === 'inference' &&
            Array.from(claim.text).length > 160 &&
            pages.some((page) => page.text.includes(claim.text)),
    );
}

/** Prefer complete sentences; an evidence excerpt is never presented as a generated summary. */
export function evidenceExcerpt(text: string): string {
    const prefix = Array.from(text.trimStart()).slice(0, 500).join('');
    const endings = [...prefix.matchAll(/[。！？.!?](?:[”’"']?)(?=\s|$)|[。！？]/gu)];
    const last = endings.at(-1);
    return last ? prefix.slice(0, last.index + last[0].length) : prefix;
}
