import type { ReportArtifact } from './report-artifacts.ts';
import type { ReportValue } from './report-value.ts';

type Claim = { kind: string; text: string };
type Value = { text: string; claimIndexes: number[]; status: string; gap: string };
const unique = (values: readonly string[]) => new Set(values).size === values.length;

/** Structural provenance only. Matching model text is not independent semantic verification. */
export function validReportArtifacts(
    artifacts: readonly ReportArtifact[] | undefined,
    claims: readonly Claim[],
    reportValue?: ReportValue,
): boolean {
    if (!artifacts) return true;
    const questionIds = reportValue && new Set(reportValue.questions.map((q) => q.id));
    for (const artifact of artifacts) {
        const owned = new Set(artifact.claimIndexes);
        const within = (indexes: readonly number[]) =>
            indexes.every((index) => owned.has(index) && !!claims[index]);
        const usable = (indexes: readonly number[]) =>
            indexes.length > 0 && indexes.every((index) => claims[index]?.kind !== 'insufficient');
        const validValue = (value: Value) => {
            if (!within(value.claimIndexes)) return false;
            if (value.status === 'unknown')
                return !value.text && !value.claimIndexes.length && !!value.gap.trim();
            if (!value.text.trim() || !usable(value.claimIndexes)) return false;
            if (!value.claimIndexes.some((index) => claims[index]!.text.includes(value.text)))
                return false;
            return value.status === 'supported' || !!value.gap.trim();
        };
        const requirements = artifact.coverage?.requirements;
        if (requirements) {
            if (!unique(requirements.map((r) => r.id))) return false;
            for (const requirement of requirements) {
                if (
                    !within(requirement.claimIndexes) ||
                    (questionIds && requirement.questionIds.some((id) => !questionIds.has(id)))
                )
                    return false;
                if (requirement.status === 'supported' && !usable(requirement.claimIndexes))
                    return false;
                if (requirement.status !== 'supported' && !requirement.gap.trim()) return false;
            }
        }
        const content = artifact.content;
        if (!content) continue;
        if (content.list) {
            if (artifact.format !== 'list' || !unique(content.list.entries.map((e) => e.id)))
                return false;
            for (const entry of content.list.entries) {
                if (!unique(entry.fields.map((f) => f.id)) || !entry.fields.every(validValue))
                    return false;
            }
        }
        if (content.comparison) {
            if (artifact.format !== 'comparison') return false;
            const matrix = content.comparison;
            const objects = new Set(matrix.objects.map((o) => o.id));
            const dimensions = new Set(matrix.dimensions.map((d) => d.id));
            const keys = matrix.cells.map((c) => JSON.stringify([c.objectId, c.dimensionId]));
            if (
                objects.size !== matrix.objects.length ||
                dimensions.size !== matrix.dimensions.length ||
                !unique(keys) ||
                matrix.cells.length !== objects.size * dimensions.size ||
                !matrix.cells.every(
                    (cell) =>
                        objects.has(cell.objectId) &&
                        dimensions.has(cell.dimensionId) &&
                        validValue(cell),
                )
            )
                return false;
        }
    }
    return true;
}
