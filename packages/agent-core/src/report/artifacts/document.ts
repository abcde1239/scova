import { object } from '../../utils/guards.ts';
import {
    ArtifactDocumentSchema,
    parseContract,
    type ReportValue,
    type ArtifactDocument,
} from '@scova/models';
import type { AgentClaim, ComparisonExtraction } from '../../types.ts';
import { isDeepStrictEqual } from 'node:util';
import { type Format } from './requirements.ts';

/** Recover editorial organization only from validated claims in immutable synthesis receipts. */
export function buildArtifactDocument(
    format: Format,
    claims: AgentClaim[],
    value: ReportValue | undefined,
    extractions: ComparisonExtraction[],
    validateClaim: (raw: unknown) => AgentClaim | undefined,
    bound: ReadonlySet<number> = new Set(),
): ArtifactDocument | undefined {
    if (!value) return;
    const main = claims.flatMap((claim, index) =>
        !bound.has(index) &&
        (claim.outputFormat ?? format) === format &&
        claim.kind !== 'insufficient' &&
        value.selections.some((s) => s.claimIndex === index && s.placement === 'main')
            ? [index]
            : [],
    );
    const sections: ArtifactDocument['sections'] = [];
    const used = new Set<number>();
    const ids = new Set<string>();
    // A repair can replace organization without making its previously accepted bodies disappear.
    for (const receipt of [...extractions].reverse()) {
        const data = receipt.response.data;
        if (!object(data) || !Array.isArray(data.artifacts) || !Array.isArray(data.claims))
            continue;
        const rawClaims = data.claims;
        const groups = data.artifacts.filter((a) => object(a) && a.format === format && a.document);
        if (groups.length !== 1 || !object(groups[0])) continue;
        let document: ArtifactDocument;
        try {
            document = parseContract(ArtifactDocumentSchema, groups[0].document);
        } catch {
            continue;
        }
        const rawIndexes = document.sections.flatMap((section) => section.claimIndexes);
        if (
            new Set(document.sections.map((s) => s.id)).size !== document.sections.length ||
            new Set(rawIndexes).size !== rawIndexes.length ||
            rawIndexes.some((index) => index >= rawClaims.length)
        )
            continue;
        for (const section of document.sections) {
            if (ids.has(section.id)) continue;
            const indexes = section.claimIndexes.flatMap((index) => {
                const checked = validateClaim(rawClaims[index]);
                const global = checked
                    ? claims.findIndex((claim) => isDeepStrictEqual(claim, checked))
                    : -1;
                if (!main.includes(global) || used.has(global)) return [];
                used.add(global);
                return [global];
            });
            if (!indexes.length) continue;
            sections.push({ ...section, claimIndexes: indexes });
            ids.add(section.id);
        }
    }
    if (!sections.length) return;
    // Never let an incomplete outline or a repaired/demoted paragraph hide other valid answers.
    const retained = sections.slice(0, sections.length > 12 ? 11 : 12);
    const covered = new Set(retained.flatMap((section) => section.claimIndexes));
    const remaining = main.filter((index) => !covered.has(index));
    if (remaining.length) {
        if (retained.length === 12) retained.pop();
        const finalCovered = new Set(retained.flatMap((section) => section.claimIndexes));
        let id = 'additional-findings';
        while (retained.some((section) => section.id === id)) id += '-extra';
        retained.push({
            id,
            title: '补充发现',
            role: format === 'research_report' ? 'analysis' : 'key_findings',
            claimIndexes: main.filter((index) => !finalCovered.has(index)),
        });
    }
    return { version: 1, sections: retained };
}
