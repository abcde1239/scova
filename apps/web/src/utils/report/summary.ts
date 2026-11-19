import type { Claim, Report } from '@scova/models';

export const claimLabels: Record<Claim['kind'], string> = {
    fact: '来源事实',
    inference: 'Agent 推断',
    conflict: '冲突证据',
    insufficient: '证据不足',
    model_answer: '模型自回答',
};

export function reportSections(report: Report) {
    if (report.coverage.reportValue) return [];
    return (Object.entries(claimLabels) as [Claim['kind'], string][])
        .map(([kind, title]) => ({
            kind,
            title,
            claims: report.claims.filter((claim) => claim.kind === kind),
        }))
        .filter((section) => section.claims.length);
}

export function claimEvidence(report: Report, claim: Claim) {
    return claim.evidenceIds
        .map((id) => report.evidence.find((entry) => entry.id === id))
        .filter((entry) => entry !== undefined);
}

/** Display projection only: keep different sources and different limitations intact. */
export function uniqueCoverageNotes(values: string[]): string[] {
    return [...new Set(values.map((value) => value.replace(/\s+/g, ' ').trim()).filter(Boolean))];
}

export function reportIntegrity(report: Report) {
    return {
        partial: report.coverage.completeness === 'partial',
        limitations: uniqueCoverageNotes([...report.limitations, ...report.coverage.gaps]),
        demo: report.mode === 'demo',
    };
}
