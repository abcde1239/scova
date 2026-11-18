import type { Coverage } from '@scova/models';

/** Delivery can contain knowledge answers; a new comparison origin requires every mandatory field externally supported. */
export function baselineEligibility(coverage: Coverage): NonNullable<Coverage['baseline']> {
    const fields =
        coverage.artifacts
            ?.flatMap((a) => a.coverage?.requirements ?? [])
            .filter((r) => r.required) ?? [];
    const modelOnlyFields = fields.filter((r) => r.status === 'model_answered').length;
    const external = fields.length > 0 && fields.every((r) => r.status === 'supported');
    const reason = !external
        ? coverage.dateScreening?.unconfirmed
            ? 'date_unconfirmed'
            : 'external_incomplete'
        : coverage.completeness !== 'complete'
          ? coverage.gaps.some((g) => /比较|基线|变化/.test(g))
              ? 'comparison_incomplete'
              : 'incomplete'
          : 'eligible';
    return { version: 1, eligible: reason === 'eligible', reason, modelOnlyFields };
}
