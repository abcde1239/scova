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

/** Share the baseline reason between execution and report views. */
export function baselineReason(coverage: Report['coverage']) {
    const baseline = coverage.baseline;
    if (!baseline) return '本次查阅不完整';
    if (baseline.modelOnlyFields) return `${baseline.modelOnlyFields} 个字段仅有模型回答`;
    return {
        eligible: '已满足比较条件',
        external_incomplete: '部分必答字段缺少外部证据',
        date_unconfirmed: '部分条目的日期尚未确认',
        incomplete: '部分必答字段尚未完成',
        comparison_incomplete: '比较所需的证据尚不完整',
    }[baseline.reason];
}

export function changeSummary(report: Report) {
    const previous = report.baselineRunId || report.baseline;
    const important = report.changes.filter(
        (change) => change.important && change.kind !== 'baseline',
    ).length;
    if (
        report.outcome === 'baseline' &&
        report.coverage.completeness === 'complete' &&
        report.coverage.baseline?.eligible !== false
    )
        return {
            state: 'baseline',
            title: '已设为比较起点',
            message: `${report.changes.filter((change) => change.kind === 'baseline').length || report.claims.length} 项事实，下次执行将与本次对比`,
        };
    if (!previous) {
        const eligible =
            report.coverage.baseline?.eligible ??
            (report.outcome === 'baseline' && report.coverage.completeness === 'complete');
        if (eligible)
            return {
                state: 'baseline',
                title: '已设为比较起点',
                message: `${report.changes.filter((change) => change.kind === 'baseline').length || report.claims.length} 项事实，下次执行将与本次对比`,
            };
        if (report.coverage.baseline || report.outcome === 'baseline')
            return {
                state: 'inconclusive',
                title: '未设为比较起点',
                message: baselineReason(report.coverage),
            };
    }
    if (report.coverage.completeness === 'partial')
        return { state: 'inconclusive', title: '变化未定', message: '本次查阅不完整' };
    if (report.changes.some((change) => change.oldValue !== null && !change.oldEvidenceIds.length))
        return { state: 'inconclusive', title: '变化未定', message: '旧值证据不足，比较仍待核验' };
    if (report.changes.some((change) => change.kind === 'uncertain'))
        return { state: 'inconclusive', title: '变化未定', message: '存在待核验的比较' };
    if (important && report.outcome === 'important_change')
        return { state: 'important_change', title: `${important} 项重要变化`, message: '' };
    if (important)
        return {
            state: 'inconclusive',
            title: '变化未定',
            message: '逐项重要变化与报告结论尚需核对',
        };
    if (report.outcome === 'no_important_change')
        return { state: 'no_important_change', title: '无重要变化', message: '' };
    if (report.outcome === 'new_findings')
        return { state: 'new_findings', title: '新增资料', message: '' };
    return {
        state: 'inconclusive',
        title: '变化未定',
        message: '当前记录尚不足以形成确定的比较结论',
    };
}
