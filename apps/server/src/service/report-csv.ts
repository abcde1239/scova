import {
    REPORT_ATTACHMENT_MAX_CELL_CHARS,
    REPORT_ATTACHMENT_MAX_COLUMNS,
    REPORT_ATTACHMENT_MAX_ROWS,
    type ReportAttachmentFailure,
    type ReportAttachmentRow,
} from '@scova/models';

type CsvResult =
    | { status: 'ready'; rows: ReportAttachmentRow[] }
    | { status: 'failed'; failureCode: ReportAttachmentFailure };

type FieldState = 'start' | 'plain' | 'quoted' | 'closed';
const failure = (failureCode: ReportAttachmentFailure): CsvResult => ({
    status: 'failed',
    failureCode,
});

export function parseReportCsv(content: Uint8Array): CsvResult {
    let text: string;
    try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(content);
    } catch {
        return failure('INVALID_UTF8');
    }
    // CSV text permits tab and record separators; reject other ASCII controls.
    // oxlint-disable-next-line no-control-regex
    if (!text || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(text))
        return failure('INVALID_CSV');

    const rows: ReportAttachmentRow[] = [];
    let cells: string[] = [];
    let value = '';
    let state: FieldState = 'start';
    let line = 1;
    let startLine = line;

    function endField() {
        cells.push(value);
        state = 'start';
        value = '';
    }

    function endRecord(): ReportAttachmentFailure | undefined {
        endField();
        if (
            cells.length > REPORT_ATTACHMENT_MAX_COLUMNS ||
            rows.length >= REPORT_ATTACHMENT_MAX_ROWS
        )
            return 'CSV_LIMIT_EXCEEDED';
        if (rows[0] && cells.length !== rows[0].cells.length) return 'INVALID_CSV';
        rows.push({ rowNumber: rows.length + 1, startLine, endLine: line, cells });
        cells = [];
    }

    for (let offset = 0; offset < text.length; offset += 1) {
        const character = text.charAt(offset);
        const newline = character === '\r' || character === '\n';
        if (state === 'quoted') {
            if (character === '"') {
                if (text.charAt(offset + 1) === '"') {
                    value += '"';
                    offset += 1;
                } else {
                    state = 'closed';
                }
            } else {
                value += character;
                if (newline) {
                    if (character === '\r' && text.charAt(offset + 1) === '\n') {
                        value += '\n';
                        offset += 1;
                    }
                    line += 1;
                }
            }
        } else if (character === ',') {
            endField();
            if (cells.length >= REPORT_ATTACHMENT_MAX_COLUMNS) return failure('CSV_LIMIT_EXCEEDED');
        } else if (newline) {
            const error = endRecord();
            if (error) return failure(error);
            if (character === '\r' && text.charAt(offset + 1) === '\n') offset += 1;
            line += 1;
            startLine = line;
        } else if (state === 'start' && character === '"') {
            state = 'quoted';
        } else {
            if (state === 'closed' || character === '"') return failure('INVALID_CSV');
            state = 'plain';
            value += character;
        }
        if (value.length > REPORT_ATTACHMENT_MAX_CELL_CHARS) return failure('CSV_LIMIT_EXCEEDED');
    }

    if (state === 'quoted') return failure('INVALID_CSV');
    if (state !== 'start' || cells.length > 0) {
        const error = endRecord();
        if (error) return failure(error);
    }
    return { status: 'ready', rows };
}
