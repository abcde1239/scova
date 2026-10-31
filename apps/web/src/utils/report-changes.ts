import { ContractValidationError, type Evidence, type Report } from '@scova/models';

type Change = Report['changes'][number];
export const changeKinds: { kind: Change['kind']; title: string }[] = [
    { kind: 'baseline', title: '基线记录' },
    { kind: 'new', title: '新增资料' },
    { kind: 'changed', title: '实质变化' },
    { kind: 'duplicate', title: '重复资料' },
    { kind: 'duplicate_candidate', title: '疑似转载' },
    { kind: 'non_material', title: '非实质变化' },
    { kind: 'uncertain', title: '待核验' },
];

export function mapReportChanges(report: Report) {
    const available = new Map(report.evidence.map((evidence) => [evidence.id, evidence]));
    function resolve(ids: string[], side: 'old' | 'new', index: number): Evidence[] {
        return ids.map((id) => {
            const evidence = available.get(id);
            if (!evidence)
                throw new ContractValidationError([
                    {
                        path: `/changes/${index}/${side}EvidenceIds`,
                        message: '变化引用缺失，无法展示完整对照',
                    },
                ]);
            return evidence;
        });
    }
    // The API has already authorized ownership and evidence sides. Only project those IDs here.
    const entries = report.changes.map((record, index) => ({
        record,
        oldEvidence: resolve(record.oldEvidenceIds, 'old', index),
        newEvidence: resolve(record.newEvidenceIds, 'new', index),
        missingOldEvidence: record.oldValue !== null && record.oldEvidenceIds.length === 0,
    }));
    return changeKinds
        .map((group) => ({
            ...group,
            entries: entries.filter((entry) => entry.record.kind === group.kind),
        }))
        .filter((group) => group.entries.length > 0);
}

export function changeSummary(report: Report) {
    const incomplete = report.coverage.completeness === 'partial';
    const unknown =
        report.outcome === 'inconclusive' ||
        report.changes.some(
            (change) =>
                change.kind === 'uncertain' ||
                (change.oldValue !== null && change.oldEvidenceIds.length === 0),
        );
    if (incomplete || unknown)
        return {
            state: 'inconclusive',
            title: '变化结论仍不确定',
            message: incomplete
                ? '本次查阅不完整，以下记录只代表已取得的证据，不能据此认定没有重要变化。'
                : report.changes.some(
                        (change) => change.oldValue !== null && change.oldEvidenceIds.length === 0,
                    )
                  ? '旧值证据不足，不能据此认定没有重要变化。'
                  : report.changes.some((change) => change.kind === 'uncertain')
                    ? '存在待核验比较，不能据此认定没有重要变化。'
                    : '报告尚未得出确定的变化结论，不能据此认定没有重要变化。',
        };
    if (
        report.outcome === 'no_important_change' &&
        !report.changes.some((change) => change.important)
    )
        return {
            state: 'no_important_change',
            title: '本次范围内未发现重要变化',
            message:
                '本次计划范围内查阅完整；此结论不表示穷尽互联网资料，也不表示所有内容完全相同。',
        };
    if (report.outcome === 'baseline')
        return {
            state: 'baseline',
            title: '本次建立比较基线',
            message: '这是报告给出的基线结果；建立基线本身不代表已经比较出重要变化。',
        };
    if (report.outcome === 'important_change')
        return {
            state: 'important_change',
            title: '报告记录了重要变化',
            message: '请结合逐项原因、旧值与本次观测及双方引用阅读。',
        };
    if (report.outcome === 'new_findings')
        return {
            state: 'new_findings',
            title: '报告记录了新增发现',
            message: '新增发现与已确认的重要事实变化分别呈现，请查看各项分类和引用。',
        };
    return {
        state: 'inconclusive',
        title: '变化结论仍需核对',
        message: '当前记录不足以支持无重要变化结论，请结合报告和逐项证据阅读。',
    };
}
