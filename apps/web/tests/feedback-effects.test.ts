import { describe, expect, it } from 'vite-plus/test';
import {
    FeedbackEffectsSchema,
    ReportSchema,
    parseContract,
    type FeedbackEffect,
    type Report,
} from '@scova/models';
import { reportFeedbackEffects } from '@/utils/feedback-effects';
import { sourceLink } from '@/composables/useReport';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function effect(overrides: Partial<FeedbackEffect> = {}): FeedbackEffect {
    return {
        feedbackId: id(30),
        kind: 'known',
        targetType: 'source',
        targetId: id(10),
        effect: 'monitoring',
        reason: '已读取目标正文，保留其引用。',
        ...overrides,
    };
}
function report(effects?: FeedbackEffect[]): Report {
    return parseContract(ReportSchema, {
        id: id(1),
        taskId: id(2),
        runId: id(3),
        taskVersionId: id(4),
        baselineRunId: id(5),
        schemaVersion: 1,
        title: '受控反馈作用报告',
        summary: '重要新事实与未变内容分别保留。',
        format: 'brief',
        mode: 'demo',
        outcome: 'important_change',
        coverage: {
            completeness: 'partial',
            searchedQueries: ['受控样本查询'],
            gaps: ['此为受控展示样本，不代表真实查阅'],
            exhausted: [],
        },
        limitations: ['受控报告样本'],
        claims: [
            {
                id: id(10),
                kind: 'fact',
                text: '结论全文\n重要新值仍然保留。',
                confidenceLabel: '来自样本原文',
                evidenceIds: [id(20)],
            },
            {
                id: id(11),
                kind: 'inference',
                text: '未变结论也不从报告中删除。',
                confidenceLabel: '样本推断',
                evidenceIds: [id(21)],
            },
        ],
        evidence: [
            {
                id: id(20),
                sourceId: id(10),
                snapshotId: id(22),
                title: '资料标题',
                url: 'https://example.test/source',
                quote: '<script>sample</script> 原始新值引用',
                location: '第 2 段',
                observedAt: '2026-10-31T01:00:00Z',
            },
            {
                id: id(21),
                sourceId: id(10),
                snapshotId: id(23),
                title: '同一资料的另一引用',
                url: 'https://example.test/source',
                quote: '原始旧值引用',
                location: '第 1 段',
                observedAt: '2026-10-30T01:00:00Z',
            },
        ],
        changes: [
            {
                id: id(40),
                sourceId: id(10),
                kind: 'changed',
                factKey: '样本指标',
                oldValue: '100',
                newValue: '120',
                oldEvidenceIds: [id(21)],
                newEvidenceIds: [id(20)],
                important: true,
                reason: '重要的新值',
            },
            {
                id: id(41),
                sourceId: id(10),
                kind: 'new',
                factKey: '新增指标',
                oldValue: null,
                newValue: '已确认的新值',
                oldEvidenceIds: [],
                newEvidenceIds: [id(20)],
                important: true,
                reason: '重要的新事实',
            },
        ],
        ...(effects === undefined ? {} : { feedbackEffects: effects }),
        publishedAt: '2026-10-31T02:00:00Z',
    });
}
function freeze(value: unknown) {
    if (value !== null && typeof value === 'object') {
        Object.values(value).forEach(freeze);
        Object.freeze(value);
    }
}

describe('saved report feedback effects', () => {
    it('maps all nine effects independently of snapshot intent and target type', () => {
        const labels: [FeedbackEffect['effect'], string][] = [
            ['expanded_query', '深入查询已执行'],
            ['promoted', '目标来源已优先采集'],
            ['excluded', '已排除新发现候选'],
            ['deprioritized', '未变结论已后移'],
            ['baseline_protected', '基线来源保留复读'],
            ['monitoring', '已读取目标来源'],
            ['not_applied_budget', '未执行：预算不足'],
            ['not_applied_unmatched', '未执行：未匹配'],
            ['not_applied_policy', '未执行：策略限制'],
        ];
        for (const [kind, kindLabel] of [
            ['irrelevant', '不相关'],
            ['known', '已了解'],
            ['deeper', '希望深入'],
        ] as const) {
            for (const targetType of ['source', 'claim'] as const) {
                const entries = labels.map(([value]) =>
                    effect({ effect: value, kind, targetType }),
                );
                const projected = reportFeedbackEffects(report(entries));
                expect(projected.map((item) => item.label)).toEqual(
                    labels.map(([, label]) => label),
                );
                expect(projected.map((item) => item.kindLabel)).toEqual(
                    labels.map(() => kindLabel),
                );
                expect(projected.map((item) => item.targetLabel)).toEqual(
                    labels.map(() => (targetType === 'source' ? '资料' : '结论')),
                );
                expect(projected.map((item) => item.limited)).toEqual([
                    false,
                    false,
                    false,
                    false,
                    false,
                    false,
                    true,
                    true,
                    true,
                ]);
            }
        }
    });

    it('preserves multi-effect, success plus budget failure, and exact duplicate records in order', () => {
        const entries = [
            effect({ effect: 'expanded_query', query: '深入查询', kind: 'deeper' }),
            effect({ effect: 'promoted', kind: 'deeper' }),
            effect({ effect: 'not_applied_budget', kind: 'deeper', reason: '子查询预算不足' }),
            effect({ effect: 'promoted', kind: 'deeper' }),
        ];
        const saved = report(entries);
        const projected = reportFeedbackEffects(saved);
        expect(projected.map((item) => item.entry)).toEqual(entries);
        expect(new Set(projected.map((item) => item.key)).size).toBe(4);
        projected.forEach((item, index) => expect(item.entry).toBe(saved.feedbackEffects![index]));
    });

    it('projects absent and empty snapshots as no panel items without current-state inference', () => {
        expect(reportFeedbackEffects(report())).toEqual([]);
        expect(reportFeedbackEffects(report([]))).toEqual([]);
    });

    it('resolves only exact typed targets in this report and keeps missing old target identities', () => {
        const saved = report([
            effect(),
            effect({ targetType: 'claim' }),
            effect({ targetId: id(99) }),
            effect({ targetType: 'source', targetId: id(11) }),
            effect({ targetType: 'claim', targetId: id(20) }),
        ]);
        const projected = reportFeedbackEffects(saved);
        expect(projected.map((item) => item.targetName)).toEqual([
            '资料标题',
            saved.claims[0]!.text,
            undefined,
            undefined,
            undefined,
        ]);
        expect(projected[2]?.entry.targetId).toBe(id(99));
        expect(projected[2]?.targetLabel).toBe('资料');
    });

    it('keeps raw reason, query and URL text and uses the existing safe link contract', () => {
        const reason = '  <script>sample</script>\n<img src=x onerror=sample>  ';
        const query = '  第一行\n第二行\t<em>原文</em>  ';
        const url = 'https://example.test/source?q=%3Cscript%3E#section';
        const [item] = reportFeedbackEffects(report([effect({ reason, query, url })]));
        expect(item?.entry).toMatchObject({ reason, query, url });
        expect(sourceLink(url)).toBe(url);
        for (const unsafe of ['javascript:sample()', 'data:text/html,sample', '//example.test']) {
            expect(sourceLink(unsafe)).toBeUndefined();
            expect(() => report([effect({ url: unsafe })])).toThrow();
        }
        const [withoutOptional] = reportFeedbackEffects(report([effect()]));
        expect(withoutOptional?.entry).not.toHaveProperty('query');
        expect(withoutOptional?.entry).not.toHaveProperty('url');
    });

    it('retains all 600 records and full boundary text while shared schema rejects overlimits', () => {
        const boundary = effect({ reason: '原'.repeat(1000), query: '查'.repeat(2000) });
        const entries = Array.from({ length: 600 }, () => ({ ...boundary }));
        const projected = reportFeedbackEffects(report(entries));
        expect(projected).toHaveLength(600);
        expect(new Set(projected.map((item) => item.key)).size).toBe(600);
        expect(projected[599]?.entry).toEqual(boundary);
        for (const invalid of [
            [...entries, boundary],
            [effect({ reason: '原'.repeat(1001) })],
            [effect({ query: '查'.repeat(2001) })],
            [{ ...boundary, effect: 'invented' }],
            [{ ...boundary, active: true }],
        ]) {
            expect(() => parseContract(FeedbackEffectsSchema, invalid)).toThrow();
            expect(() =>
                parseContract(ReportSchema, { ...report(), feedbackEffects: invalid }),
            ).toThrow();
        }
    });

    it('does not alter important new/changed facts, classifications, old/new quotes or report identity', () => {
        const saved = report([
            effect({ effect: 'deprioritized' }),
            effect({ effect: 'baseline_protected' }),
        ]);
        const original = structuredClone(saved);
        freeze(saved);
        reportFeedbackEffects(saved);
        expect(saved).toEqual(original);
        expect(saved.changes.map((change) => [change.kind, change.important])).toEqual([
            ['changed', true],
            ['new', true],
        ]);
        expect(saved.evidence.map((entry) => entry.quote)).toEqual(
            original.evidence.map((entry) => entry.quote),
        );
    });

    it('keeps old and post-revocation report snapshots independent across repeated projections', () => {
        const oldReport = report([effect({ kind: 'deeper', effect: 'promoted' })]);
        const nextReport = parseContract(ReportSchema, {
            ...report([]),
            id: id(100),
            runId: id(101),
        });
        // Controlled snapshots model a later Run after revocation; current active feedback is not input.
        const oldProjection = reportFeedbackEffects(oldReport);
        expect(reportFeedbackEffects(nextReport)).toEqual([]);
        expect(reportFeedbackEffects(oldReport)).toEqual(oldProjection);
        expect(oldReport.feedbackEffects).toHaveLength(1);
        expect(nextReport.feedbackEffects).toEqual([]);
    });
});
