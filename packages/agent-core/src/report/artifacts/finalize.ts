import { primaryArtifactSummary, type ReportArtifact, type ReportValue } from '@scova/models';
import type { AgentClaim, ComparisonExtraction } from '../../types.ts';
import { buildArtifactDocument } from './document.ts';

/** Finalize only after field binding and question coverage have settled. */
export function finalizeReportArtifacts(
    artifacts: ReportArtifact[],
    claims: AgentClaim[],
    value: ReportValue | undefined,
    extractions: ComparisonExtraction[],
    validateClaim: (raw: unknown) => AgentClaim | undefined,
): ReportArtifact[] {
    for (const artifact of artifacts) {
        const bound = new Set(
            [
                ...(artifact.content?.list?.entries.flatMap((entry) => entry.fields) ?? []),
                ...(artifact.content?.comparison?.cells ?? []),
            ].flatMap((cell) => cell.claimIndexes),
        );
        const structured = !!artifact.content?.list || !!artifact.content?.comparison;
        // Structured formats outline only synthesis outside cells; fallback lists keep no outline.
        const document =
            structured || artifact.format === 'brief' || artifact.format === 'research_report'
                ? buildArtifactDocument(
                      artifact.format,
                      claims,
                      value,
                      extractions,
                      validateClaim,
                      bound,
                  )
                : undefined;
        if (artifact.content?.document) delete artifact.content.document;
        if (document) artifact.content = { ...artifact.content, version: 1, document };
        delete artifact.summary;
        artifact.summary = primaryArtifactSummary(claims, {
            artifacts: [artifact],
            reportValue: value,
        });
        const missing =
            artifact.coverage?.requirements.filter(
                (r) => r.required && !['supported', 'model_answered'].includes(r.status),
            ) ?? [];
        if (missing.length)
            artifact.summary =
                `${artifact.summary}\n\n尚有${missing.length}项所需信息未完整取得，详见覆盖说明。`.slice(
                    0,
                    2000,
                );
    }
    return artifacts;
}
