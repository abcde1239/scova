import { createHash } from 'node:crypto';
import { normalizeUrl } from '@scova/connectors';
import type { FeedbackEffect, FeedbackSnapshotItem } from '@scova/models';
import type { AgentClaim, AgentContext, AgentPage, AgentChange } from '../types.ts';
import { baselineReady } from '../report/comparison/compare.ts';
import type { Query } from './state.ts';
type Selection = { url: string; questionIds: string[] };
export interface FeedbackResearch {
    queries: Query[];
    searches: { query: Query; response: { query: string; results: { url: string }[] } }[];
    selections: Selection[];
    pages: AgentPage[];
}
const canonical = (url: string) => {
    try {
        return normalizeUrl(url);
    } catch {
        return '';
    }
};
const items = (context: AgentContext) => context.feedback?.items ?? [];
const targets = (item: FeedbackSnapshotItem) => item.sources.map((source) => canonical(source.url));
const baselines = (context: AgentContext) =>
    new Set(
        baselineReady(context) ? context.baseline!.manifest!.pages.map((page) => page.url) : [],
    );
export function feedbackDigest(context: AgentContext) {
    if (!items(context).length) return undefined;
    if (context.feedback!.userId !== context.userId) throw new Error('反馈快照归属不符');
    return createHash('sha256').update(JSON.stringify(context.feedback)).digest('hex');
}
export function deeperQuery(context: AgentContext, item: FeedbackSnapshotItem) {
    const target = item.text?.slice(0, 160) ?? item.sources[0]?.url ?? '';
    return `${context.config.topic} ${target} 详细条件 限制 原始来源`
        .replace(/\s+/g, ' ')
        .slice(0, 2000);
}
export function expandFeedbackQueries(
    context: AgentContext,
    queries: Query[],
    questions: { id: string }[],
): Query[] {
    const result = [...queries],
        limit = Math.min(10, context.budget.maxSearches);
    // 基础问题全部得到计划槽位后才扩展，不挤占必要覆盖。
    if (
        questions.some(
            (question) => !result.some((query) => query.questionIds.includes(question.id)),
        )
    )
        return result;
    for (const item of items(context).filter((item) => item.kind === 'deeper')) {
        const query = deeperQuery(context, item);
        if (result.length < limit && !result.some((entry) => entry.query === query))
            result.push({ query, questionIds: questions.map((question) => question.id) });
    }
    return result;
}
export function feedbackSelections(
    context: AgentContext,
    selections: Selection[],
    allowed: (url: string) => boolean,
): Selection[] {
    const baseline = baselines(context),
        selected = new Map(selections.map((item) => [canonical(item.url), item]));
    const allQuestions = [...new Set(selections.flatMap((item) => item.questionIds))];
    for (const item of items(context).filter((item) => ['deeper', 'known'].includes(item.kind)))
        for (const source of item.sources)
            if (allowed(source.url) && !selected.has(canonical(source.url)))
                selected.set(canonical(source.url), { url: source.url, questionIds: allQuestions });
    const irrelevant = new Set(
        items(context)
            .filter((item) => item.kind === 'irrelevant' && item.sourceId)
            .flatMap(targets),
    );
    const deeper = new Set(
        items(context)
            .filter((item) => item.kind === 'deeper')
            .flatMap(targets),
    );
    const known = new Set(
        items(context)
            .filter((item) => item.kind === 'known')
            .flatMap(targets),
    );
    const rank = (url: string) =>
        baseline.has(url) ? 0 : deeper.has(url) ? 1 : known.has(url) ? 2 : 3;
    return [...selected.entries()]
        .filter(([url]) => baseline.has(url) || !irrelevant.has(url))
        .sort(([left], [right]) => rank(left) - rank(right))
        .map(([, selection]) => selection);
}
function unchanged(item: FeedbackSnapshotItem, claim: AgentClaim, pages: AgentPage[]) {
    if (
        !claim.citations.length ||
        (item.sourceId && claim.kind !== 'fact') ||
        (item.claimId && claim.text !== item.text)
    )
        return false;
    // 混合新来源、未核验推断或任一新指纹均不能被旧来源的“已了解”覆盖。
    return claim.citations.every((citation) => {
        const page = pages.find((page) => page.id === citation.pageId);
        return (
            page &&
            item.sources.some(
                (source) =>
                    canonical(source.url) === canonical(page.url) &&
                    source.contentHash === page.contentHash &&
                    (!item.claimId || source.quote === citation.quote),
            )
        );
    });
}
export function explainFeedback(
    context: AgentContext,
    state: FeedbackResearch,
    claims: AgentClaim[],
    allowed: (url: string) => boolean,
    changes: AgentChange[] = [],
) {
    const relevant = items(context),
        baseline = baselines(context);
    const important = new Set(
        changes
            .filter((change) => change.important && ['changed', 'new'].includes(change.kind))
            .map((change) => change.pageId),
    );
    const lower = (claim: AgentClaim) =>
        relevant.some(
            (item) =>
                (item.kind === 'known' || (item.kind === 'irrelevant' && item.claimId)) &&
                !claim.citations.some((citation) => important.has(citation.pageId)) &&
                unchanged(item, claim, state.pages),
        );
    const ordered = claims
        .map((claim, index) => ({ claim, index }))
        .sort((a, b) => Number(lower(a.claim)) - Number(lower(b.claim)));
    const effects: FeedbackEffect[] = [];
    for (const item of relevant) {
        const base = {
            feedbackId: item.id,
            kind: item.kind,
            targetType: item.sourceId ? ('source' as const) : ('claim' as const),
            targetId: (item.sourceId ?? item.claimId)!,
        };
        const push = (
            effect: FeedbackEffect['effect'],
            reason: string,
            extra: { url?: string; query?: string } = {},
        ) => effects.push({ ...base, effect, reason, ...extra });
        const urls = targets(item);
        const selected = state.selections.filter((selection) =>
            urls.includes(canonical(selection.url)),
        );
        const pages = state.pages.filter((page) => urls.includes(canonical(page.url)));
        if (urls.some((url) => baseline.has(url)) && selected.length && item.kind !== 'deeper')
            push('baseline_protected', '冻结基线来源仍参与复读，反馈不会跳过其新条件核验');
        if (item.kind === 'deeper') {
            const query = deeperQuery(context, item);
            if (
                state.searches.some(
                    (search) => search.query.query === query && search.response.query === query,
                )
            )
                push('expanded_query', '已执行深入查询并获得有效搜索结果', { query });
            const promoted = pages.find((page) => !baseline.has(canonical(page.url)));
            if (promoted)
                push('promoted', '已优先采集希望深入的目标来源正文', { url: promoted.url });
            const planned = state.queries.some((entry) => entry.query === query);
            if (!planned && state.queries.length >= Math.min(10, context.budget.maxSearches))
                push(
                    'not_applied_budget',
                    '基础问题已占用可用搜索预算，未执行深入子查询；来源优先采集单独说明',
                );
            if (!effects.some((effect) => effect.feedbackId === item.id)) {
                push(
                    !planned && state.queries.length >= Math.min(10, context.budget.maxSearches)
                        ? 'not_applied_budget'
                        : 'not_applied_unmatched',
                    !planned
                        ? '基础问题已占用可用搜索预算，深入请求未执行'
                        : '深入请求尚未获得有效搜索或目标正文，不宣称已经生效',
                );
            }
        } else if (item.kind === 'irrelevant' && item.sourceId) {
            const encountered =
                state.searches.some((search) =>
                    search.response.results.some((result) => urls.includes(canonical(result.url))),
                ) ||
                context.config.sourcePreferences.preferredUrls.some((url) =>
                    urls.includes(canonical(url)),
                );
            if (
                encountered &&
                !selected.length &&
                urls.some(allowed) &&
                !urls.some((url) => baseline.has(url))
            )
                push('excluded', '已从新发现候选中排除此资料；未删除历史证据');
            else if (!effects.some((effect) => effect.feedbackId === item.id))
                push('not_applied_unmatched', '本次未遇到可由该反馈排除的新发现候选');
        } else {
            const moved = ordered.some(
                (entry, index) =>
                    index > entry.index &&
                    lower(entry.claim) &&
                    unchanged(item, entry.claim, state.pages),
            );
            if (moved)
                push(
                    'deprioritized',
                    '仅将原文与内容指纹均未变化的目标结论移到其他结论之后，保留全部引用',
                );
            else if (pages.length)
                push('monitoring', '已读取目标来源；未降低新值或未确认内容的优先级，也未删除结论');
            else if (!effects.some((effect) => effect.feedbackId === item.id))
                push('not_applied_unmatched', '没有足以确认同一未变事实的正文，未声称已调整结果');
        }
    }
    return { claims: ordered.map((entry) => entry.claim), effects };
}
