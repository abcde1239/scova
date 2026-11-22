import {
    REPORT_ATTACHMENT_MAX_CELL_CHARS,
    REPORT_ATTACHMENT_MAX_ROWS,
    type ReportAttachmentFailure,
    type ReportAttachmentRow,
} from '@scova/models';

type TextResult =
    | { status: 'ready'; rows: ReportAttachmentRow[] }
    | { status: 'failed'; failureCode: ReportAttachmentFailure };

export function parseReportText(content: Uint8Array): TextResult {
    let text: string;
    try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(content);
    } catch {
        return { status: 'failed', failureCode: 'INVALID_UTF8' };
    }
    // Allow tabs and line breaks, matching the CSV parser's text controls.
    // oxlint-disable-next-line no-control-regex
    if (!text || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(text))
        return { status: 'failed', failureCode: 'INVALID_TEXT' };

    const lines = text.split(/\r\n|\r|\n/u);
    if (lines.at(-1) === '') lines.pop();
    if (
        lines.length > REPORT_ATTACHMENT_MAX_ROWS ||
        lines.some((line) => line.length > REPORT_ATTACHMENT_MAX_CELL_CHARS)
    )
        return { status: 'failed', failureCode: 'TEXT_LIMIT_EXCEEDED' };

    return {
        status: 'ready',
        rows: lines.map((line, index) => ({
            rowNumber: index + 1,
            startLine: index + 1,
            endLine: index + 1,
            cells: [line],
        })),
    };
}

export function validateReportPdf(content: Buffer): boolean {
    // Latin-1 keeps character offsets aligned with the PDF's byte offsets.
    const file = content.toString('latin1');
    if (!/^%PDF-(?:1\.[0-7]|2\.0)[\r\n]/u.test(file)) return false;
    const trailer = file.lastIndexOf('startxref');
    if (trailer < 0 || !/[\r\n]/u.test(file.charAt(trailer - 1))) return false;
    const offset = /^startxref[ \t]*[\r\n]+(\d+)[ \t]*[\r\n]+%%EOF[ \t\r\n]*$/u.exec(
        file.slice(trailer),
    )?.[1];
    if (!offset || Number(offset) < 9 || Number(offset) >= trailer) return false;

    const xref = file.slice(Number(offset), trailer);
    if (/^xref[ \t]*[\r\n]+\d+[ \t]+\d+[ \t]*[\r\n]/u.test(xref)) return true;

    // PDFs can use a cross-reference stream instead of a plain xref table.
    // This is a format check for download, without interpreting any PDF objects.
    const stream = xref.search(/(?:\r\n|\r|\n)stream(?:\r\n|\n)/u);
    return (
        stream !== -1 &&
        /^\d+[ \t]+\d+[ \t]+obj\s*<</u.test(xref) &&
        /\/Type\s*\/XRef(?=[\s/>])/u.test(xref.slice(0, stream))
    );
}
