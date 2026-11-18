import { conflictFingerprint, isConflictReviewOperation } from '../conflict-review.ts';
import {
    fallbackRequirements,
    plannedRequirements,
    type PlannedRequirement,
} from '../../report/artifacts/index.ts';
import { type ReportArtifact } from '@scova/models';
import { type AgentClaim } from '../../types.ts';
import { type ResearchState, object } from '../state.ts';
import { validatedClaims } from './validation.ts';

export function frozenRequirements(state: ResearchState) {
    const formats = state.outputFormats ??
        state.modelAnswerFormats ?? [
            ...new Set(state.claims.flatMap((c) => (c.outputFormat ? [c.outputFormat] : []))),
        ];
    // The plan carries all formats even when no external claim was accepted for one of them.
    const data = state.planningExtraction?.response.data;
    const plannedFormats =
        object(data) && Array.isArray(data.requirements)
            ? [
                  ...new Set(
                      data.requirements.flatMap((r) =>
                          object(r) && typeof r.format === 'string'
                              ? [r.format as ReportArtifact['format']]
                              : [],
                      ),
                  ),
              ]
            : formats;
    return (
        plannedRequirements(
            data,
            plannedFormats,
            state.questions,
            false,
            (state.coveragePolicy ?? 0) >= 2,
        ) ?? fallbackRequirements(formats, state.questions)
    );
}

/** Use explicit field ownership from the original immutable synthesis bindings. */
export function fieldConflicts(
    state: ResearchState,
    requirement: PlannedRequirement,
): AgentClaim[] {
    const found: AgentClaim[] = [];
    for (const receipt of state.synthesisExtractions ?? []) {
        if (isConflictReviewOperation(receipt.operationKey)) continue;
        const data = receipt.response.data;
        if (!object(data) || !Array.isArray(data.artifacts) || !Array.isArray(data.claims))
            continue;
        const raw = data.claims;
        for (const a of data.artifacts) {
            if (!object(a) || a.format !== requirement.format || !Array.isArray(a.requirements))
                continue;
            for (const r of a.requirements) {
                if (!object(r) || r.id !== requirement.id || !Array.isArray(r.claimIndexes))
                    continue;
                for (const i of r.claimIndexes) {
                    const claim = Number.isSafeInteger(i)
                        ? validatedClaims({ claims: [raw[Number(i)]] }, state)?.[0]
                        : undefined;
                    if (
                        claim?.kind === 'conflict' &&
                        state.claims.some(
                            (c) => conflictFingerprint(c) === conflictFingerprint(claim),
                        ) &&
                        !found.some((c) => conflictFingerprint(c) === conflictFingerprint(claim))
                    )
                        found.push(claim);
                }
            }
        }
    }
    return found;
}

export function needsConflictReview(state: ResearchState) {
    return (
        !!state.conflictReviewPolicy &&
        !state.modelBlocked &&
        !state.synthesisBatchIndex &&
        (state.gapLoopPolicy
            ? state.gapLoop?.target?.action === 'conflict' ||
              (state.synthesisAttempts === 2 && !state.gapLoop?.history.length)
            : [2, 4].includes(state.synthesisAttempts)) &&
        (state.conflictReviewPass !== state.synthesisAttempts ||
            (state.conflictReviewIndex ?? 0) < (state.conflictReviewTargets?.length ?? 0))
    );
}
