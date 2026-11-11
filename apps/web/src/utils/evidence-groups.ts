import type { Evidence } from '@scova/models';

/** Different observations/snapshots must never be displayed as the same saved source. */
export function groupEvidence(evidence: readonly Evidence[]) {
    const groups = new Map<string, { key: string; title: string; evidence: Evidence[] }>();
    for (const entry of evidence) {
        const key = `${entry.sourceId.toLowerCase()}:${entry.snapshotId.toLowerCase()}`;
        const group = groups.get(key) ?? { key, title: entry.title, evidence: [] };
        if (!group.evidence.some((saved) => saved.id === entry.id)) group.evidence.push(entry);
        groups.set(key, group);
    }
    return [...groups.values()];
}

/** Exact duplicates share quote text; every evidence ID still gets its own anchor. */
export function distinctEvidenceQuotes(evidence: readonly Evidence[]) {
    const quotes = new Map<string, { evidence: Evidence; ids: string[] }>();
    for (const entry of evidence) {
        const key = `${entry.snapshotId.toLowerCase()}:${entry.quote}`;
        const quote = quotes.get(key) ?? { evidence: entry, ids: [] };
        if (!quote.ids.includes(entry.id)) quote.ids.push(entry.id);
        quotes.set(key, quote);
    }
    return [...quotes.values()];
}
