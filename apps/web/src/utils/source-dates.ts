import type { Report } from '@scova/models';
import { normalizePageUrl } from '@/utils/evidence-groups';

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
