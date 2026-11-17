import type { Evidence } from '@scova/models';

/** Page identity excludes fragments and tracking parameters, preserving meaningful query values. */
export function evidencePageUrl(entry: Evidence): string {
    const value = entry.snapshot?.canonicalUrl || entry.snapshot?.originalUrl || entry.url;
    try {
        const url = new URL(value);
        url.hash = '';
        const trackingNames = [...url.searchParams.keys()].filter(
            (name) => /^utm_/i.test(name) || /^(?:gclid|fbclid|msclkid)$/i.test(name),
        );
        for (const name of trackingNames) url.searchParams.delete(name);
        url.searchParams.sort();
        return url.href;
    } catch {
        return value;
    }
}

/** One page entry; immutable observations remain separate versions inside it. */
export function groupEvidence(evidence: readonly Evidence[]) {
    const groups = new Map<
        string,
        { key: string; title: string; url: string; evidence: Evidence[] }
    >();
    for (const entry of evidence) {
        const key = evidencePageUrl(entry);
        const group = groups.get(key) ?? { key, title: entry.title, url: key, evidence: [] };
        if (!group.evidence.some((saved) => saved.id === entry.id)) group.evidence.push(entry);
        groups.set(key, group);
    }
    return [...groups.values()];
}

export function groupEvidenceVersions(evidence: readonly Evidence[]) {
    const versions = new Map<string, { key: string; observedAt: string; evidence: Evidence[] }>();
    for (const entry of evidence) {
        const key = `${entry.sourceId.toLowerCase()}:${entry.snapshotId.toLowerCase()}`;
        const version = versions.get(key) ?? { key, observedAt: entry.observedAt, evidence: [] };
        if (!version.evidence.some((saved) => saved.id === entry.id)) version.evidence.push(entry);
        versions.set(key, version);
    }
    return [...versions.values()];
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
