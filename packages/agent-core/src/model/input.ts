import { ConnectorError, estimateModelInputTokens, type StructuredInput } from '@scova/connectors';
import type { AgentPage } from '../types.ts';
import { sourceExcerptSelector } from '../evidence/excerpts.ts';

/** Keep exact, separately delimited excerpts. A quote may never cross an omitted span. */
export function fitSources(
    input: StructuredInput,
    pages: AgentPage[],
    prefixOnly = false,
    focus: string[] = [],
): { input: StructuredInput; clipped: boolean } {
    // This is a soft planning target, not a tokenizer or a new rejection threshold. Count
    // its input overhead before fitting sources and leave room for JSON/estimation variance.
    const target = Math.max(
        1,
        Math.min(prefixOnly ? 7200 : 8192, Math.floor(input.maxOutputTokens * 0.6)),
    );
    const bounded = {
        ...input,
        prompt: `${input.prompt}\nOutput budget: hard cap ${input.maxOutputTokens} tokens, including JSON, quotations and assessments. Aim below ${target} tokens; this is a ceiling, not a quota. Estimate conservatively and finish complete JSON. ${prefixOnly ? 'At most four important task-relevant facts per page. Preserve every pageId; facts may be empty.' : 'Answer core questions first. Merge complementary evidence from the same source while preserving distinct conditions, perspectives and both sides of conflicts. Record concrete limitations once near the relevant claim; avoid repetitive generic caveats. Keep insufficient when evidence is missing and specify the missing material. Omit generic background and repetition.'} Return only schema-valid JSON, with no Markdown, preamble or reasoning trace. Generated user-facing prose must be Simplified Chinese. Quotes and literal extracted values retain original language. Use the shortest exact quote sufficient to support a claim, preserving material conditions. Never cut sentences, invent quotes or omit required fields; reduce secondary items instead.`,
    };
    const bodies = pages.map((page) => sourceExcerptSelector(page.text, focus));
    const project = (limit: number) =>
        pages.map((page, index) => {
            const body = bodies[index]!;
            const base = { pageId: page.id, url: page.url, questionIds: page.questionIds };
            if (body.length <= limit) return { ...base, text: page.text };
            return { ...base, ...body.select(limit) };
        });
    let low = 0;
    let high = Math.max(0, ...bodies.map((body) => body.length));
    const withSources = (limit: number) => ({ ...bounded, untrustedSources: project(limit) });
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
