import { isDeepStrictEqual } from 'node:util';
import type { ReportArtifact } from '@scova/models';
import type { AgentClaim } from './types.ts';

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
