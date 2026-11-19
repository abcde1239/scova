import type { Evidence, Report } from '@scova/models';

/** Page identity excludes fragments and tracking parameters, preserving meaningful query values. */
export function evidencePageUrl(entry: Evidence): string {
    const value = entry.snapshot?.canonicalUrl || entry.snapshot?.originalUrl || entry.url;
    return normalizePageUrl(value);
}

function normalizePageUrl(value: string): string {
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

/** Preserve connector date precision; labels describe where the observed date came from. */
export function dateSourceLabel(source: string | null | undefined) {
    if (!source) return '未确认';
    if (/modified|updated/i.test(source)) return '页面更新时间';
    if (/published|datePublished/i.test(source)) return '页面发布时间';
    if (/body|text|正文/i.test(source)) return '正文日期';
    if (/time/i.test(source)) return '页面日期标记';
    return '页面日期信息';
}

export function collectionRows(report: Report) {
    return report.claims
        .filter((claim) => claim.kind === 'fact')
        .map((claim) => {
            const evidence = report.evidence.filter((entry) =>
                claim.evidenceIds.includes(entry.id),
            );
            const urls = new Set(
                evidence.flatMap((entry) =>
                    [
                        entry.url,
                        entry.snapshot?.canonicalUrl,
                        entry.snapshot?.fetchedUrl,
                        entry.snapshot?.originalUrl,
                    ]
                        .filter((url): url is string => !!url)
                        .map(normalizePageUrl),
                ),
            );
            const pages =
                report.coverage.dateScreening?.entries.filter(
                    (entry) => entry.status === 'accepted' && urls.has(normalizePageUrl(entry.url)),
                ) ?? [];
            return { claim, evidence, pages };
        });
}
