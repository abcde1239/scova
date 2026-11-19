import { type ReportSupportOptions } from '../../evidence/support.ts';
import { selectedOutputFormats, type ReportArtifact, type ReportValue } from '@scova/models';
import type { AgentClaim, AgentContext, ComparisonExtraction } from '../../types.ts';
import { plannedRequirements, fallbackRequirements } from './requirements.ts';
import { finalizeReportArtifacts } from './finalize.ts';
import { buildArtifactFields } from './fields.ts';

/** Rebuild from successful immutable extractions; synthesized coverage cannot alter the plan. */
const withGroup = (group: string | undefined) => (group ? { group } : {});

export function createReportArtifacts(
    context: AgentContext,
    questions: { id: string; text: string }[],
    claims: AgentClaim[],
    value: ReportValue | undefined,
    plan: ComparisonExtraction | undefined,
    extractions: ComparisonExtraction[],
    validateClaim: (raw: unknown) => AgentClaim | undefined,
    completeCoveragePlan = false,
    fieldPatches = false,
    reviewConflicts = false,
    supportOptions: ReportSupportOptions = {},
) {
    const formats = selectedOutputFormats(context.config);
    const frozenPlan = plannedRequirements(
        plan?.response.data,
        formats,
        questions,
        false,
        completeCoveragePlan,
    );
    const planned = frozenPlan ?? fallbackRequirements(formats, questions);
    const artifacts = formats.map((format) => {
        const validPlan =
            !!frozenPlan &&
            !!plannedRequirements(
                { requirements: planned.filter((r) => r.format === format) },
                [format],
                questions,
            );
        const claimIndexes = claims.flatMap((claim, index) =>
            (claim.outputFormat ?? formats[0]) === format ? [index] : [],
        );
        const requirements = buildArtifactFields({
            planned,
            format,
            validPlan,
            claimIndexes,
            claims,
            value,
            extractions,
            validateClaim,
            fieldPatches,
            reviewConflicts,
            supportOptions,
        });
        const artifact: ReportArtifact = {
            format,
            claimIndexes,
            coverage: {
                version: 1,
                requirements: requirements.map(
                    ({
                        format: _format,
                        text: _text,
                        group: _group,
                        verification: _verification,
                        ...r
                    }) => r,
                ),
            },
        };
        const names = [...new Set(requirements.map((r) => r.object).filter(Boolean))];
        const dimensions = [...new Set(requirements.filter((r) => r.object).map((r) => r.field))];
        const groupOf = (match: (r: (typeof requirements)[number]) => boolean) =>
            requirements.find((r) => match(r) && r.group)?.group;
        const fieldValue = (r: (typeof requirements)[number] | undefined) => ({
            text: r?.text ?? '',
            claimIndexes: r?.claimIndexes ?? [],
            status: r?.status ?? ('unknown' as const),
            gap: r?.gap ?? '本次未取得该对象和字段的可核验回答。',
        });
        if (format === 'list' && names.length)
            artifact.content = {
                version: 1,
                list: {
                    entries: names.map((name, index) => ({
                        id: `o${index}`,
                        name,
                        ...withGroup(groupOf((r) => r.object === name)),
                        fields: requirements
                            .filter((r) => r.object === name)
                            .map((r) => ({ id: r.id, label: r.field, ...fieldValue(r) })),
                    })),
                },
            };
        if (
            validPlan &&
            format === 'comparison' &&
            names.length &&
            dimensions.length &&
            names.length * dimensions.length <= 60
        )
            artifact.content = {
                version: 1,
                comparison: {
                    objects: names.map((name, index) => ({ id: `o${index}`, name })),
                    dimensions: dimensions.map((label, index) => ({
                        id: `d${index}`,
                        label,
                        ...withGroup(groupOf((r) => !!r.object && r.field === label)),
                    })),
                    cells: names.flatMap((name, oi) =>
                        dimensions.map((field, di) => ({
                            objectId: `o${oi}`,
                            dimensionId: `d${di}`,
                            ...fieldValue(
                                requirements.find((r) => r.object === name && r.field === field),
                            ),
                        })),
                    ),
                },
            };
        return artifact;
    });
    return {
        artifacts,
        finalize(finalValue: ReportValue | undefined) {
            return finalizeReportArtifacts(
                artifacts,
                claims,
                finalValue,
                extractions,
                validateClaim,
            );
        },
    };
}

/** Complete projection for previews and consumers that already have the final report value. */
export function buildReportArtifacts(
    ...args: Parameters<typeof createReportArtifacts>
): ReportArtifact[] {
    return createReportArtifacts(...args).finalize(args[3]);
}
