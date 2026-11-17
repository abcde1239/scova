import { assessPublication, normalizeUrl } from '@scova/connectors';
import { comparisonFromExtractions } from '../../comparison-extraction.ts';
import { baselineReady } from '../../comparison.ts';
import { type AgentContext, type AgentPage } from '../../types.ts';
import { type ResearchState, unique } from '../state.ts';

export function publicationGaps(context: AgentContext, pages: AgentPage[]): string[] {
    const range = context.config.timeRange;
    const end = range.kind === 'fixed' ? new Date(range.end) : context.startedAt;
    const start =
        range.kind === 'fixed'
            ? new Date(range.start)
            : end && new Date(end.getTime() - range.days * 86_400_000);
    if (!start || !end || !Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()))
        return ['查阅时间窗口尚未固定，无法校验来源声明的发布时间'];
    const gaps: string[] = [];
    for (const page of pages) {
        // Frozen baseline URLs are monitoring targets; their old publication is not rediscovery.
        if (
            baselineReady(context) &&
            context.baseline!.manifest!.pages.some((entry) => entry.url === normalizeUrl(page.url))
        )
            continue;
        const result = assessPublication(page.publication, start, end);
        if (result === 'unknown')
            gaps.push(
                '来源未提供可解析且带时区的发布时间，时间范围未核验；内容可供参考，不确认在窗口内发布',
            );
        if (result === 'conflict') gaps.push('来源声明的发布时间存在冲突，时间范围未核验');
        if (result === 'outside')
            gaps.push(
                '采集来源声明的发布时间超出本次查阅时间范围；作为背景保留，不作为窗口内新发布事实',
            );
    }
    return unique(gaps);
}

export function extractedComparison(context: AgentContext, state: ResearchState) {
    if (!state.comparisonExtractions) return null;
    const baseCount =
        state.coveragePolicy === 3
            ? state.pages.length
            : (state.answerSupplement?.basePages ?? state.pages.length);
    const result = comparisonFromExtractions(
        context,
        state.pages.slice(0, baseCount),
        state.comparisonExtractions,
    );
    if (result.manifest && state.pages.length > baseCount) {
        result.manifest.pages.push(
            ...state.pages.slice(baseCount).map((p) => ({
                pageId: p.id,
                url: normalizeUrl(p.url),
                contentHash: p.contentHash,
                extractorVersion: p.extractionVersion,
                facts: [],
            })),
        );
        result.gaps.push('定向补证新增正文未重复执行事实比较，变化覆盖仍不完整，不推进完整基线');
    }
    return result;
}
