import { isDeepStrictEqual } from 'node:util';
import type { ReportArtifact } from '@scova/models';
import type { AgentClaim } from '../types.ts';
import { object } from '../utils/guards.ts';

/** Keep this patch's validated evidence available for rebinding even when a draft wins display. */
export function pendingFieldClaims(
    data: unknown,
    accepted: AgentClaim[],
    artifacts: ReportArtifact[],
) {
    if (!object(data) || !Array.isArray(data.artifacts) || !Array.isArray(data.claims)) return [];
    const rawClaims = data.claims;
    const pending = new Set(
        artifacts.flatMap((a) =>
            (a.coverage?.requirements ?? [])
                .filter((r) => r.status !== 'supported')
                .map((r) => `${a.format}:${r.id}`),
        ),
    );
    const indexes = data.artifacts.flatMap((a) =>
        object(a) && typeof a.format === 'string' && Array.isArray(a.requirements)
            ? a.requirements.flatMap((r) =>
                  object(r) &&
                  typeof r.id === 'string' &&
                  pending.has(`${String(a.format)}:${r.id}`) &&
                  Array.isArray(r.claimIndexes)
                      ? r.claimIndexes.filter(Number.isSafeInteger)
                      : [],
              )
            : [],
    );
    return accepted.filter(
        (c) =>
            c.kind !== 'model_answer' &&
            indexes.some((i) => isDeepStrictEqual(c, rawClaims[Number(i)])),
    );
}

/** Receipts keep every attempt; the deliverable keeps the currently bound field versions. */
export function activeFieldClaims(claims: AgentClaim[], artifacts: ReportArtifact[]): AgentClaim[] {
    const active = new Set(
        artifacts.flatMap((a) => a.coverage?.requirements.flatMap((r) => r.claimIndexes) ?? []),
    );
    // Conflicting evidence is not discarded just because a new answer appears complete.
    claims.forEach((claim, index) => {
        if (claim.kind === 'conflict' && claim.citations.length) active.add(index);
    });
    // Preserve a bounded best attempt for questions with no usable field binding yet.
    const covered = new Set(
        [...active].flatMap((index) => {
            const claim = claims[index]!;
            return claim.questionIds.map((id) => `${claim.outputFormat}:${id}`);
        }),
    );
    for (let index = claims.length - 1; index >= 0; index--) {
        const claim = claims[index]!;
        const keys = claim.questionIds.map((id) => `${claim.outputFormat}:${id}`);
        if (!keys.some((key) => !covered.has(key))) continue;
        active.add(index);
        keys.forEach((key) => covered.add(key));
    }
    return claims.filter((_, index) => active.has(index));
}

export function mergeFieldClaims(previous: AgentClaim[], next: AgentClaim[]) {
    const claims = [...previous];
    for (const claim of next)
        if (!claims.some((saved) => isDeepStrictEqual(saved, claim))) claims.push(claim);
    return claims;
}
