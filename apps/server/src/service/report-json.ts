import { createHash } from 'node:crypto';
import {
    REPORT_EXPORT_MAX_BYTES,
    REPORT_JSON_MAX_QUOTE_CHARS,
    ReportJsonDocumentSchema,
    parseContract,
    serializeReportJson,
    type Report,
} from '@scova/models';
import { ApiError } from '@/utils/errors.ts';

function shortQuote(quote: string) {
    let end = 0;
    for (const character of quote) {
        if (end + character.length > REPORT_JSON_MAX_QUOTE_CHARS) break;
        end += character.length;
    }
    return { quote: quote.slice(0, end), quoteTruncated: end < quote.length };
}

// Project fields only from the authorized, delivered report DTO.
export function renderReportJson(report: Report) {
    const document = parseContract(ReportJsonDocumentSchema, {
        schemaVersion: 1,
        reportId: report.id,
        title: report.title,
        summary: report.summary,
        publishedAt: report.publishedAt,
        format: report.format,
        mode: report.mode,
        outcome: report.outcome,
        coverage: { completeness: report.coverage.completeness, gaps: report.coverage.gaps },
        limitations: report.limitations,
        conclusions: report.claims,
        changes: report.changes,
        citations: report.evidence.map(({ id, title, url, location, observedAt, quote }) => ({
            id,
            title,
            url,
            location,
            observedAt,
            ...shortQuote(quote),
        })),
    });
    const content = serializeReportJson(document);
    const byteLength = Buffer.byteLength(content);
    if (byteLength > REPORT_EXPORT_MAX_BYTES)
        throw new ApiError(422, 'REPORT_EXPORT_TOO_LARGE', '报告超过 256 KiB 导出上限');
    return { content, byteLength, sha256: createHash('sha256').update(content).digest('hex') };
}
