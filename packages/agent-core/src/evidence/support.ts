import type { ClaimAssessment } from '@scova/models';
import type { AgentClaim, AgentPage } from '../types.ts';
import { object } from '../utils/guards.ts';

export const GAP_KINDS = ['none', 'missing_core', 'missing_detail', 'condition'] as const;
export interface ReportSupportOptions {
    gapKinds?: boolean;
    pages?: AgentPage[];
    strictFields?: boolean;
}

/** Require a structured gap kind in a synthesis request without touching the legacy wire schema. */
export function requireGapKinds(schema: Record<string, unknown>) {
    const claims = object(schema.properties) ? schema.properties.claims : undefined;
    const items = object(claims) ? claims.items : undefined;
    const props = object(items) ? items.properties : undefined;
    const assessment = object(props) ? props.assessment : undefined;
    if (!object(props) || !object(assessment) || !object(assessment.properties))
        throw new Error('synthesis schema has no claim assessment');
    props.assessment = {
        ...assessment,
        required: [...(assessment.required as string[]), 'gapKind'],
        properties: {
            ...assessment.properties,
            gapKind: { type: 'string', enum: [...GAP_KINDS] },
        },
    };
    return schema;
}

/**
 * Structured support for one field or question. Undefined keeps the legacy rule: a legacy
 * receipt or a model answer carries no gap kind. Only a missing core proposition blocks support;
 * several partial claims count only when they come from more than one page.
 */
export function structuredSupport(
    entries: { claim: AgentClaim; assessment?: ClaimAssessment }[],
    questionIds: string[],
    options: ReportSupportOptions,
): boolean | undefined {
    if (!options.gapKinds) return undefined;
    if (options.strictFields)
        return (
            entries.length > 0 &&
            entries.every(
                (e) =>
                    ['fact', 'inference'].includes(e.claim.kind) &&
                    e.assessment?.relevance === 'direct' &&
                    e.assessment.support === 'direct' &&
                    !e.assessment.gap.trim() &&
                    (e.assessment.gapKind === 'none' ||
                        (e.assessment.gapKind === 'condition' && !!e.assessment.conditions.trim())),
            )
        );
    if (
        !entries.length ||
        entries.some((e) => e.claim.kind === 'model_answer' || !e.assessment?.gapKind)
    )
        return undefined;
    if (
        entries.some(
            (e) =>
                e.claim.kind === 'insufficient' ||
                e.claim.kind === 'conflict' ||
                e.assessment!.gapKind === 'missing_core' ||
                (e.assessment!.gapKind === 'condition' && !e.assessment!.conditions.trim()) ||
                !['direct', 'partial'].includes(e.assessment!.support),
        )
    )
        return false;
    if (entries.some((e) => e.assessment!.support === 'direct')) return true;
    // Partial statements about different questions cannot vote each other into full support.
    if (entries.some((e) => !questionIds.every((id) => e.claim.questionIds.includes(id))))
        return false;
    const pages = entries.flatMap((e) =>
        e.claim.citations.flatMap((c) => {
            const page = options.pages?.find((p) => p.id === c.pageId && p.text.includes(c.quote));
            return page ? [page] : [];
        }),
    );
    return (
        entries.length >= 2 &&
        new Set(pages.map((p) => p.contentHash)).size >= 2 &&
        new Set(pages.map((p) => p.url)).size >= 2
    );
}
