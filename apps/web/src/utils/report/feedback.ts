import type { FeedbackEffect, Report } from '@scova/models';

const effectLabels: Record<FeedbackEffect['effect'], string> = {
    expanded_query: '深入查询已执行',
    promoted: '目标来源已优先采集',
    excluded: '已排除新发现候选',
    deprioritized: '未变结论已后移',
    baseline_protected: '基线来源保留复读',
    monitoring: '已读取目标来源',
    not_applied_budget: '未执行：预算不足',
    not_applied_unmatched: '未执行：未匹配',
    not_applied_policy: '未执行：策略限制',
};
const kindLabels: Record<FeedbackEffect['kind'], string> = {
    irrelevant: '不相关',
    known: '已了解',
    deeper: '希望深入',
};

/** Project this report's saved effects without inferring current feedback or changing its content. */
export function reportFeedbackEffects(report: Report) {
    return (report.feedbackEffects ?? []).map((entry, index) => ({
        key: `${index}:${entry.feedbackId}`,
        entry,
        label: effectLabels[entry.effect],
        kindLabel: kindLabels[entry.kind],
        targetLabel: entry.targetType === 'source' ? '资料' : '结论',
        targetName:
            entry.targetType === 'source'
                ? report.evidence.find((item) => item.sourceId === entry.targetId)?.title
                : report.claims.find((item) => item.id === entry.targetId)?.text,
        limited: entry.effect.startsWith('not_applied_'),
    }));
}
