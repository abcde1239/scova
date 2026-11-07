import { ConnectorError, estimateModelInputTokens, type StructuredInput } from '@scova/connectors';
import type { AgentPage } from './types.ts';

export const COMPARISON_SOURCE_CHAR_LIMIT = 32_000;

/** Keep exact, separately delimited excerpts. A quote may never cross an omitted span. */
export function fitSources(
    input: StructuredInput,
    pages: AgentPage[],
    prefixOnly = false,
): { input: StructuredInput; clipped: boolean } {
    // This is a soft planning target, not a tokenizer or a new rejection threshold. Count
    // its input overhead before fitting sources and leave room for JSON/estimation variance.
    const target = Math.max(
        1,
        Math.min(prefixOnly ? 7200 : 8192, Math.floor(input.maxOutputTokens * 0.6)),
    );
    const bounded = {
        ...input,
        prompt: `${input.prompt}\n输出篇幅：本次调用输出硬上限为${input.maxOutputTokens} tokens，包含JSON结构、引文和评估字段；完整JSON的软目标不超过${target} tokens。这是上限提示，不是必须写满的配额；token数只能估计，应提前收束并闭合JSON。${prefixOnly ? '每页最多4项重要且与任务相关的事实，无需凑满；保留全部pageId，无相关事实时facts为空。' : '先完整回答核心问题，再补充必要细节；围绕问题集中整理同一来源的证据和观点，合并同义或互补内容，保留不同观点、适用条件和冲突双方各自的引用。直接表述发现与结论，限制只在相关观点的评估字段说明一次，避免每条重复“部分交付”“证据不足”等笼统提醒；确无依据时仍标insufficient并具体说明缺少什么材料。删去泛泛背景和重复解释。'}只返回schema要求的JSON，不输出Markdown、开场白或分析过程。引文仅取足够支撑结论的最短逐字片段；不得为省篇幅删除关键条件、不确定性或冲突，也不得截句、伪造引文或省略必填字段。篇幅不足时减少次要条目。`,
    };
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
