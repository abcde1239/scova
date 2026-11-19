import { object } from '../../utils/guards.ts';
import { conflictFingerprint, resolvedConflictHashes } from '../../research/conflict-review.ts';
import { type ReportArtifact, type ReportValue } from '@scova/models';
import type { AgentClaim, ComparisonExtraction } from '../../types.ts';
import { isDeepStrictEqual } from 'node:util';

/** Only retire an older answer to the exact same field when source evidence overlaps. */
export function supersededArtifactClaims(
    claims: AgentClaim[],
    value: ReportValue | undefined,
    artifacts: ReportArtifact[],
    extractions: ComparisonExtraction[],
    validateClaim: (raw: unknown) => AgentClaim | undefined,
): Set<number> {
    const current = artifacts.flatMap((a) => a.coverage?.requirements ?? []);
    const owners = new Map(
        artifacts.flatMap((a) =>
            (a.coverage?.requirements ?? []).map((r) => [r.id, a.format] as const),
        ),
    );
    const active = new Set(current.flatMap((r) => r.claimIndexes));
    const previous = new Map<number, Set<string>>();
    for (const receipt of extractions) {
        const data = receipt.response.data;
        if (!object(data) || !Array.isArray(data.artifacts) || !Array.isArray(data.claims))
            continue;
        const rawClaims = data.claims;
        for (const artifact of data.artifacts) {
            if (!object(artifact) || !Array.isArray(artifact.requirements)) continue;
            for (const requirement of artifact.requirements) {
                if (
                    !object(requirement) ||
                    typeof requirement.id !== 'string' ||
                    owners.get(requirement.id) !== artifact.format ||
                    typeof requirement.text !== 'string' ||
                    !requirement.text.trim() ||
                    !Array.isArray(requirement.claimIndexes)
                )
                    continue;
                const duplicates = data.artifacts.flatMap((group) =>
                    object(group) &&
                    group.format === artifact.format &&
                    Array.isArray(group.requirements)
                        ? group.requirements.filter((r) => object(r) && r.id === requirement.id)
                        : [],
                );
                if (duplicates.length !== 1) continue;
                for (const local of requirement.claimIndexes) {
                    if (
                        !Number.isSafeInteger(local) ||
                        Number(local) < 0 ||
                        Number(local) >= rawClaims.length
                    )
                        continue;
                    const checked = validateClaim(rawClaims[Number(local)]);
                    const index = checked
                        ? claims.findIndex((claim) => isDeepStrictEqual(claim, checked))
                        : -1;
                    if (
                        index < 0 ||
                        active.has(index) ||
                        !checked?.text.includes(requirement.text) ||
                        value?.selections.find((s) => s.claimIndex === index)?.placement !== 'main'
                    )
                        continue;
                    const ids = previous.get(index) ?? new Set<string>();
                    ids.add(requirement.id);
                    previous.set(index, ids);
                }
            }
        }
    }
    const resolved = resolvedConflictHashes(
        extractions,
        artifacts.flatMap((a) =>
            (a.coverage?.requirements ?? []).map((r) => ({ ...r, format: a.format })),
        ),
        claims,
    );
    const result = new Set<number>();
    for (const [index, ids] of previous) {
        const claim = claims[index]!;
        if (
            (claim.kind === 'conflict' && !resolved.has(conflictFingerprint(claim))) ||
            claim.kind === 'insufficient'
        )
            continue;
        const replaced = [...ids].every((id) => {
            const next = current.find((r) => r.id === id);
            return (
                next?.status === 'supported' &&
                next.claimIndexes.some((replacement) => {
                    const newer = claims[replacement]!;
                    const selection = value?.selections.find((s) => s.claimIndex === replacement);
                    return (
                        newer.kind !== 'conflict' &&
                        selection?.placement === 'main' &&
                        selection.assessment?.support === 'direct' &&
                        claim.citations.some(
                            (oldQuote) =>
                                oldQuote.quote.length >= 24 &&
                                newer.citations.some(
                                    (newQuote) =>
                                        newQuote.pageId === oldQuote.pageId &&
                                        newQuote.quote.length >= 24 &&
                                        (newQuote.quote.includes(oldQuote.quote) ||
                                            oldQuote.quote.includes(newQuote.quote)),
                                ),
                        )
                    );
                })
            );
        });
        if (replaced) result.add(index);
    }
    return result;
}
