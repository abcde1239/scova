import { object } from '../guards.ts';
import { structuredSupport, type ReportSupportOptions } from '../gap-kind.ts';
import { type ReportArtifact, type ReportValue } from '@scova/models';
import type { AgentClaim, ComparisonExtraction } from '../types.ts';
import { isDeepStrictEqual } from 'node:util';
import { mentionsObject } from './field-value.ts';
import type { PlannedRequirement } from './requirements.ts';

export interface ArtifactFieldContext {
    planned: PlannedRequirement[];
    format: ReportArtifact['format'];
    validPlan: boolean;
    claimIndexes: number[];
    claims: AgentClaim[];
    value: ReportValue | undefined;
    extractions: ComparisonExtraction[];
    validateClaim: (raw: unknown) => AgentClaim | undefined;
    fieldPatches: boolean;
    reviewConflicts: boolean;
    supportOptions: ReportSupportOptions;
}
export function buildArtifactFields({
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
}: ArtifactFieldContext) {
    // Preserve first-match semantics while reusing the same lookup throughout the projection.
    const selections = new Map<number, NonNullable<ReportValue>['selections'][number]>();
    for (const selection of value?.selections ?? [])
        if (!selections.has(selection.claimIndex)) selections.set(selection.claimIndex, selection);
    const requirements = planned
        .filter((r) => r.format === format)
        .map((requirement) => {
            let indexes: number[] = [];
            let text = '';
            let bestScore = -1;
            // A repair's explicit requirement value supersedes its predecessor only if valid.
            for (const receipt of extractions) {
                const data = receipt.response.data;
                if (!object(data) || !Array.isArray(data.artifacts) || !Array.isArray(data.claims))
                    continue;
                const answers = data.artifacts.flatMap((artifact) =>
                    object(artifact) &&
                    artifact.format === format &&
                    Array.isArray(artifact.requirements)
                        ? artifact.requirements.filter((r) => object(r) && r.id === requirement.id)
                        : [],
                );
                // Split groups of one format are compatible; duplicate IDs are ambiguous.
                if (answers.length !== 1) continue;
                const answer = answers[0];
                if (
                    !object(answer) ||
                    typeof answer.text !== 'string' ||
                    answer.text.length > 2000 ||
                    !Array.isArray(answer.claimIndexes)
                )
                    continue;
                const rawClaims = data.claims;
                const mapped = answer.claimIndexes.flatMap((index): number[] => {
                    if (
                        !Number.isSafeInteger(index) ||
                        Number(index) < 0 ||
                        Number(index) >= rawClaims.length
                    )
                        return [];
                    const checked = validateClaim(rawClaims[Number(index)]);
                    const global = checked
                        ? claims.findIndex((claim) => isDeepStrictEqual(claim, checked))
                        : -1;
                    const selection = selections.get(global);
                    return global >= 0 &&
                        claimIndexes.includes(global) &&
                        checked?.kind !== 'insufficient' &&
                        !checked?.uncertainty?.length &&
                        selection?.placement === 'main' &&
                        requirement.questionIds.some((id) => selection.questionIds.includes(id))
                        ? [global]
                        : [];
                });
                const unique = [...new Set(mapped)];
                if (!unique.length || !answer.text.trim()) continue;
                const exactSource = unique.find((index) =>
                    claims[index]!.text.includes(answer.text as string),
                );
                const safeFallback =
                    mapped.length === answer.claimIndexes.length &&
                    unique.map((index) => claims[index]!.text).join('\n\n').length <= 2000 &&
                    unique.every((index) => {
                        const selection = selections.get(index);
                        return (
                            selection?.assessment?.relevance === 'direct' &&
                            (claims[index]!.kind === 'model_answer' ||
                                ['direct', 'partial'].includes(selection.assessment.support)) &&
                            selection.assessment.role !== 'lead' &&
                            mentionsObject(requirement.object, claims[index]!)
                        );
                    });
                const fallbackSource = safeFallback
                    ? unique.find((source) =>
                          unique.every((index) =>
                              claims[source]!.text.includes(claims[index]!.text),
                          ),
                      )
                    : undefined;
                if (exactSource !== undefined || fallbackSource !== undefined) {
                    const covered = new Set(unique.flatMap((index) => claims[index]!.questionIds));
                    const direct =
                        requirement.questionIds.every((id) => covered.has(id)) &&
                        (structuredSupport(
                            unique.map((index) => ({
                                claim: claims[index]!,
                                assessment: selections.get(index)?.assessment,
                            })),
                            requirement.questionIds,
                            supportOptions,
                        ) ??
                            unique.every((index) => {
                                const assessment = selections.get(index)?.assessment;
                                return (
                                    (!reviewConflicts || claims[index]!.kind !== 'conflict') &&
                                    assessment?.support === 'direct' &&
                                    !assessment.gap
                                );
                            }));
                    const model = unique.some((index) => claims[index]!.kind === 'model_answer');
                    const score = direct ? 2 : model ? 1.5 : 1;
                    // A failed/partial patch must not replace a previously supported field.
                    if (fieldPatches && score < bestScore) continue;
                    bestScore = score;
                    indexes = unique;
                    // The field's display paraphrase is not evidence. Reuse only a complete
                    // validated claim from this receipt's explicit group, never another object.
                    const source = exactSource ?? fallbackSource!;
                    const claim = claims[source]!;
                    const selection = selections.get(source);
                    const conditional =
                        !!selection?.assessment?.conditions.trim() ||
                        /\b(?:if|when|unless|except|only|however|but)\b|但|除非|例外|仅|若|条件/u.test(
                            claim.text,
                        );
                    text =
                        exactSource === undefined ||
                        (format === 'comparison' && claim.text !== answer.text && conditional)
                            ? claim.text
                            : answer.text;
                }
            }
            const coveredQuestions = new Set(
                indexes.flatMap((index) => selections.get(index)?.questionIds ?? []),
            );
            const supported =
                validPlan &&
                requirement.questionIds.every((id) => coveredQuestions.has(id)) &&
                indexes.length > 0 &&
                indexes.every((index) => !reviewConflicts || claims[index]!.kind !== 'conflict') &&
                (structuredSupport(
                    indexes.map((index) => ({
                        claim: claims[index]!,
                        assessment: selections.get(index)?.assessment,
                    })),
                    requirement.questionIds,
                    supportOptions,
                ) ??
                    indexes.every((index) => {
                        const selection = selections.get(index);
                        return (
                            selection?.assessment?.support === 'direct' && !selection.assessment.gap
                        );
                    }));
            const modelAnswered =
                validPlan &&
                requirement.questionIds.every((id) => coveredQuestions.has(id)) &&
                indexes.some((index) => claims[index]!.kind === 'model_answer') &&
                indexes.every(
                    (index) =>
                        claims[index]!.kind === 'model_answer' ||
                        selections.get(index)?.assessment?.support === 'direct',
                );
            const status = supported
                ? ('supported' as const)
                : modelAnswered
                  ? ('model_answered' as const)
                  : indexes.length
                    ? ('partial' as const)
                    : ('unknown' as const);
            const gap = !validPlan
                ? '规划未形成可核验的对象与字段范围，不能确认本成果完整覆盖。'
                : status === 'supported' || status === 'model_answered'
                  ? ''
                  : indexes.length
                    ? '仅找到部分支持，仍需核对所需字段。'
                    : '本次未取得该对象和字段的可核验回答。';
            return { ...requirement, status, claimIndexes: indexes, gap, text };
        });

    return requirements;
}
