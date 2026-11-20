import { createHash } from 'node:crypto';
import { REPORT_CHART_MAX_BYTES, type Report, type ReportSourceHostRow } from '@scova/models';
import { ApiError } from '@/utils/errors.ts';

const compareText = (left: string, right: string) => (left < right ? -1 : left === right ? 0 : 1);

export function reportSourceHostRows(report: Pick<Report, 'claims' | 'changes' | 'evidence'>) {
    const cited = new Set([
        ...report.claims.flatMap(({ evidenceIds }) => evidenceIds),
        ...report.changes.flatMap(({ oldEvidenceIds, newEvidenceIds }) => [
            ...oldEvidenceIds,
            ...newEvidenceIds,
        ]),
    ]);
    const hosts = new Map<string, Map<string, Set<string>>>();
    for (const { id, sourceId, url } of report.evidence) {
        if (!cited.has(id)) continue;
        const parsed = URL.parse(url);
        if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) continue;
        const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
        if (!hostname) continue;
        const sources = hosts.get(hostname) ?? new Map<string, Set<string>>();
        const evidenceIds = sources.get(sourceId) ?? new Set<string>();
        evidenceIds.add(id);
        sources.set(sourceId, evidenceIds);
        hosts.set(hostname, sources);
    }
    return [...hosts]
        .sort(([left], [right]) => compareText(left, right))
        .map(([hostname, sources]): ReportSourceHostRow => ({
            hostname,
            count: sources.size,
            sources: [...sources]
                .sort(([left], [right]) => compareText(left, right))
                .map(([sourceId, evidenceIds]) => ({
                    sourceId,
                    evidenceIds: [...evidenceIds].sort(),
                })),
        }));
}

function escapeXml(text: string) {
    return text
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&apos;');
}

export function renderSourceHostChart(rows: ReportSourceHostRow[]) {
    const metadata = JSON.stringify(rows);
    if (Buffer.byteLength(metadata) > REPORT_CHART_MAX_BYTES)
        throw new ApiError(422, 'REPORT_CHART_TOO_LARGE', '图表超出资源大小上限');
    const title = '已引用来源的主机名分布';
    const summary = rows.length
        ? rows.map(({ hostname, count }) => `${hostname}：${count}`).join('，')
        : '这份报告没有可统计的网页引用。';
    const labelWidth = Math.max(180, ...rows.map(({ hostname }) => hostname.length * 8 + 12));
    const width = labelWidth + 370;
    const height = 66 + 27 * Math.max(1, rows.length);
    const max = Math.max(1, ...rows.map(({ count }) => count));
    const bars = rows.map(({ hostname, count }, index) => {
        const y = 62 + 27 * index;
        const bar = Math.max(1, Math.round((count / max) * 300));
        return `<text x="16" y="${y}">${escapeXml(hostname)}</text><rect x="${labelWidth}" y="${y - 14}" width="${bar}" height="18" fill="#285ba6"/><text x="${labelWidth + bar + 8}" y="${y}">${count}</text>`;
    });
    const empty = rows.length ? '' : `<text x="16" y="62">${summary}</text>`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-labelledby="title description"><title id="title">${title}</title><desc id="description">${escapeXml(summary)}</desc><rect width="100%" height="100%" fill="white"/><g font-family="monospace" font-size="13" fill="#18243a"><text x="16" y="30" font-size="18">${title}</text>${bars.join('')}${empty}</g></svg>\n`;
    const content = Buffer.from(svg);
    if (content.byteLength > REPORT_CHART_MAX_BYTES)
        throw new ApiError(422, 'REPORT_CHART_TOO_LARGE', '图表超出资源大小上限');
    return {
        content,
        contentKey: createHash('sha256').update(content).update(metadata).digest('hex'),
    };
}
