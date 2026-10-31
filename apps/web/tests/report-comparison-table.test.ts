import { describe, expect, it } from 'vite-plus/test';
import { ReportSchema, parseContract, type Report } from '@scova/models';
import { claimEvidence } from '@/composables/useReport';
import { reportComparison } from '@/utils/report-comparison';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const kinds = [
    'baseline',
    'new',
    'changed',
    'duplicate',
    'duplicate_candidate',
    'non_material',
    'uncertain',
] as const;
function fixture(): Report {
    const evidence = (n: number) => ({
        id: id(n),
        sourceId: id(100),
        snapshotId: id(n + 200),
        title: `来源 ${n}`,
        url: `https://example.test/saved/${n}`,
        quote: `保存原文 ${n} <script>字面文本</script>`,
        location: '第 2 段',
        observedAt: '2026-10-31T01:00:00Z',
    });
    return parseContract(ReportSchema, {
        id: id(1),
        runId: id(2),
        taskId: id(3),
        taskVersionId: id(4),
        baselineRunId: id(5),
        schemaVersion: 1,
        title: '受控对比报告',
        summary: '全部结论、分类与双方证据保留原样。',
        format: 'brief',
        mode: 'demo',
        outcome: 'inconclusive',
        coverage: {
            completeness: 'partial',
            searchedQueries: ['已有比较查询'],
            gaps: ['受控样本覆盖缺口'],
            exhausted: ['pages'],
        },
        limitations: ['受控样本限制'],
        claims: [
            {
                id: id(10),
                kind: 'inference',
                text: '同文不同标识',
                confidenceLabel: '推断有限',
                evidenceIds: [id(21)],
            },
            {
                id: id(11),
                kind: 'fact',
                text: '本次完整事实',
                confidenceLabel: '逐字引用',
                evidenceIds: [id(21), id(20)],
            },
            {
                id: id(12),
                kind: 'insufficient',
                text: '证据不足不能下结论',
                confidenceLabel: '不足',
                evidenceIds: [],
            },
            {
                id: id(13),
                kind: 'conflict',
                text: '双方说明仍有冲突',
                confidenceLabel: '待核对',
                evidenceIds: [id(20)],
            },
            {
                id: id(14),
                kind: 'inference',
                text: '同文不同标识',
                confidenceLabel: '另一引用',
                evidenceIds: [id(20)],
            },
        ],
        evidence: [evidence(20), evidence(21), evidence(22), evidence(23)],
        changes: kinds.map((kind, index) => ({
            id: id(30 + index),
            sourceId: id(100),
            kind,
            factKey: index === 2 || index === 3 ? '同文维度仍是不同记录' : `维度 ${index}`,
            oldValue: ['baseline', 'new'].includes(kind) ? null : '  旧值\n<em>字面文本</em>  ',
            newValue: kind === 'uncertain' ? null : '  新值\n第二行  ',
            oldEvidenceIds: ['baseline', 'new', 'non_material'].includes(kind)
                ? []
                : [id(22), id(20)],
            newEvidenceIds: kind === 'uncertain' ? [] : [id(21), id(22)],
            important: kind === 'changed',
            reason: '  原始原因\n保留空格与 <b>普通文字</b>  ',
        })),
        publishedAt: '2026-10-31T02:00:00Z',
    });
}
const entries = (report: Report) =>
    reportComparison(report).groups.flatMap((group) => group.entries);
function freeze(value: unknown) {
    if (value !== null && typeof value === 'object') {
        Object.values(value).forEach(freeze);
        Object.freeze(value);
    }
}

describe('comparison table composition of saved report projections', () => {
    it('keeps seven real categories, original per-category order and same-text distinct records', () => {
        const report = fixture();
        const secondChanged = { ...report.changes[2]!, id: id(50) };
        report.changes.unshift(secondChanged);
        const model = reportComparison(report);
        expect(model.groups.map((group) => group.kind)).toEqual(kinds);
        expect(model.groups.map((group) => group.title)).toEqual([
            '基线记录',
            '新增资料',
            '实质变化',
            '重复资料',
            '疑似转载',
            '非实质变化',
            '待核验',
        ]);
        expect(
            model.groups
                .find((group) => group.kind === 'changed')
                ?.entries.map((entry) => entry.record.id),
        ).toEqual([id(50), id(32)]);
        expect(
            entries(report)
                .filter((entry) => entry.record.factKey === '同文维度仍是不同记录')
                .map((entry) => entry.record.id),
        ).toEqual([id(50), id(32), id(33)]);
    });
    it('preserves old/new evidence separately in exact id order, including shared citations', () => {
        const report = fixture();
        const entry = entries(report).find((item) => item.record.kind === 'changed')!;
        expect(entry.oldEvidence.map((item) => item.id)).toEqual([id(22), id(20)]);
        expect(entry.newEvidence.map((item) => item.id)).toEqual([id(21), id(22)]);
        expect(entry.oldEvidence[0]).toBe(report.evidence[2]);
        expect(entry.newEvidence[1]).toBe(report.evidence[2]);
        expect(entry.record).toBe(report.changes[2]);
    });
    it('keeps null sides and missing-old warnings without borrowing opposite-side evidence', () => {
        const report = fixture();
        const projected = entries(report);
        expect(projected.find((entry) => entry.record.kind === 'new')).toMatchObject({
            record: { oldValue: null },
            oldEvidence: [],
        });
        expect(projected.find((entry) => entry.record.kind === 'non_material')).toMatchObject({
            missingOldEvidence: true,
            oldEvidence: [],
        });
        expect(projected.find((entry) => entry.record.kind === 'uncertain')).toMatchObject({
            record: { newValue: null },
            newEvidence: [],
        });
        expect(reportComparison(report).summary.state).toBe('inconclusive');
    });
    it('retains all four claim types and complete ordered citations even with no change rows', () => {
        const report = parseContract(ReportSchema, { ...fixture(), changes: [] });
        const model = reportComparison(report);
        expect(model.groups).toEqual([]);
        expect(model.sections.map((section) => section.kind)).toEqual([
            'fact',
            'inference',
            'conflict',
            'insufficient',
        ]);
        expect(model.sections.map((section) => section.claims.map((claim) => claim.id))).toEqual([
            [id(11)],
            [id(10), id(14)],
            [id(13)],
            [id(12)],
        ]);
        expect(
            Object.fromEntries(
                model.sections
                    .flatMap((section) => section.claims)
                    .map((claim) => [
                        claim.id,
                        claimEvidence(report, claim).map((item) => item.id),
                    ]),
            ),
        ).toEqual({
            [id(11)]: [id(21), id(20)],
            [id(10)]: [id(21)],
            [id(14)]: [id(20)],
            [id(13)]: [id(20)],
            [id(12)]: [],
        });
        expect(model.summary.state).toBe('inconclusive');
    });
    it('covers the claim/change citation union and keeps unreferenced evidence in the unchanged DTO', () => {
        const report = fixture();
        const model = reportComparison(report);
        const direct = model.sections.flatMap((section) =>
            section.claims.flatMap((claim) => claimEvidence(report, claim).map((item) => item.id)),
        );
        const sides = model.groups.flatMap((group) =>
            group.entries.flatMap((entry) =>
                [...entry.oldEvidence, ...entry.newEvidence].map((item) => item.id),
            ),
        );
        expect(new Set([...direct, ...sides])).toEqual(new Set([id(20), id(21), id(22)]));
        expect(new Set(direct)).toEqual(new Set([id(20), id(21)]));
        expect(report.evidence.map((item) => item.id)).toEqual([id(20), id(21), id(22), id(23)]);
    });
    it('uses the existing conservative summary for partial, missing evidence and explicit outcomes', () => {
        const source = fixture();
        const complete = parseContract(ReportSchema, {
            ...source,
            coverage: { completeness: 'complete', searchedQueries: [], gaps: [], exhausted: [] },
            limitations: [],
            outcome: 'no_important_change',
            changes: [],
        });
        expect(reportComparison(complete).summary.state).toBe('no_important_change');
        expect(
            reportComparison({
                ...complete,
                changes: source.changes.filter((entry) => entry.kind === 'non_material'),
            }).summary.state,
        ).toBe('inconclusive');
        expect(
            reportComparison({ ...complete, outcome: 'inconclusive', baselineRunId: null }).summary
                .state,
        ).toBe('inconclusive');
        expect(reportComparison({ ...complete, outcome: 'baseline' }).summary.state).toBe(
            'baseline',
        );
        expect(() =>
            parseContract(ReportSchema, { ...source, outcome: 'no_important_change' }),
        ).toThrow();
    });
    it('does not mutate raw values/reasons, important flags, modes, versions, baseline or evidence', () => {
        const report = fixture(),
            before = structuredClone(report);
        freeze(report);
        const model = reportComparison(report);
        const changed = model.groups.find((group) => group.kind === 'changed')!.entries[0]!;
        expect(changed.record).toMatchObject({
            important: true,
            oldValue: '  旧值\n<em>字面文本</em>  ',
            newValue: '  新值\n第二行  ',
            reason: '  原始原因\n保留空格与 <b>普通文字</b>  ',
        });
        expect(report).toEqual(before);
        expect(reportComparison({ ...report, format: 'comparison' }).sections).toEqual(
            model.sections,
        );
    });
    it('fails closed for unresolved old or new ids instead of silently dropping a side', () => {
        for (const side of ['oldEvidenceIds', 'newEvidenceIds'] as const) {
            const report = fixture();
            report.changes[2]![side] = [id(999)];
            expect(() => parseContract(ReportSchema, report)).toThrow();
            expect(() => reportComparison(report)).toThrow();
        }
    });
});
