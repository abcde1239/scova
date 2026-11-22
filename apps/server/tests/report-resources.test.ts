import { describe, expect, it, vi } from 'vite-plus/test';
import { REPORT_ATTACHMENT_MAX_BYTES, type Report } from '@scova/models';
import { readReportAttachment } from '@/handler/http/report-attachment-body.ts';
import { parseReportText, validateReportPdf } from '../src/service/report-attachment-formats.ts';
import { reportPdfFixture } from './fixtures/report-pdf.ts';
import { parseReportCsv } from '@/service/report-csv.ts';
import { renderSourceHostChart, reportSourceHostRows } from '@/service/report-source-host-chart.ts';

const time = '2026-11-20T00:00:00.000Z';

function evidence(id: string, sourceId: string, url: string): Report['evidence'][number] {
    return {
        id,
        sourceId,
        url,
        snapshotId: 'snapshot',
        title: '标题',
        location: '原文',
        quote: '私有引文',
        observedAt: time,
    };
}

function claim(evidenceIds: string[]): Report['claims'][number] {
    return { id: 'claim', kind: 'fact', text: '已查阅', confidenceLabel: '原文', evidenceIds };
}

describe('报告来源主机名图表', () => {
    it('去重同一主机下的引用来源，忽略未引用材料，并保持聚合和 SVG 确定性', () => {
        const report = {
            evidence: [
                evidence('e4', 's3', 'https://z.test'),
                evidence('e3', 's2', 'https://example.test:443/second'),
                evidence('e2', 's1', 'https://Example.Test./first'),
                evidence('e1', 's1', 'http://example.test/first'),
                evidence('unused', 's4', 'https://a.test'),
                evidence('legacy', 's5', 'no saved URL'),
                evidence('non-http', 's6', 'file:///private.csv'),
            ],
            claims: [claim(['e4', 'e2', 'e1', 'legacy', 'non-http']), claim(['e3', 'e2'])],
            changes: [],
        } satisfies Pick<Report, 'evidence' | 'claims' | 'changes'>;
        const rows = reportSourceHostRows(report);
        expect(rows).toEqual([
            {
                hostname: 'example.test',
                count: 2,
                sources: [
                    { sourceId: 's1', evidenceIds: ['e1', 'e2'] },
                    { sourceId: 's2', evidenceIds: ['e3'] },
                ],
            },
            { hostname: 'z.test', count: 1, sources: [{ sourceId: 's3', evidenceIds: ['e4'] }] },
        ]);
        const chart = renderSourceHostChart(rows);
        expect(
            renderSourceHostChart(
                reportSourceHostRows({ ...report, evidence: report.evidence.toReversed() }),
            ),
        ).toEqual(chart);
        const svg = chart.content.toString('utf8');
        expect(svg).toContain('<desc id="description">example.test：2，z.test：1</desc>');
        expect(svg).not.toContain('私有引文');
    });

    it('生成可阅读的空图表并转义标签文本', () => {
        const rows = reportSourceHostRows({ evidence: [], claims: [], changes: [] });
        expect(rows).toEqual([]);
        expect(renderSourceHostChart(rows).content.toString()).toContain(
            '这份报告没有可统计的网页引用',
        );
        const escaped = renderSourceHostChart([{ hostname: '<example&"', count: 1, sources: [] }]);
        expect(escaped.content.toString()).toContain('&lt;example&amp;&quot;');
    });
});

describe('报告私有 CSV', () => {
    it('识别 BOM、引号、带换行的字段和物理行号', () => {
        expect(
            parseReportCsv(Buffer.from('\ufeff名称,内容\r\n"a,b","行 1\r\n行 ""2"""\r\nend,\n')),
        ).toEqual({
            status: 'ready',
            rows: [
                { rowNumber: 1, startLine: 1, endLine: 1, cells: ['名称', '内容'] },
                { rowNumber: 2, startLine: 2, endLine: 3, cells: ['a,b', '行 1\r\n行 "2"'] },
                { rowNumber: 3, startLine: 4, endLine: 4, cells: ['end', ''] },
            ],
        });
    });

    it.each([
        [Buffer.from([0xff]), 'INVALID_UTF8'],
        [Buffer.from('a,b\n"unfinished,c'), 'INVALID_CSV'],
        [Buffer.from('a,b\nb'), 'INVALID_CSV'],
        [Buffer.from('"x"suffix'), 'INVALID_CSV'],
        [Buffer.from('a\u0000'), 'INVALID_CSV'],
        [Buffer.from('x'.repeat(4097)), 'CSV_LIMIT_EXCEEDED'],
        [Buffer.from('a\n'.repeat(2001)), 'CSV_LIMIT_EXCEEDED'],
        [Buffer.from(','.repeat(64)), 'CSV_LIMIT_EXCEEDED'],
    ])('记录解析失败原因 %s', (body, failureCode) => {
        expect(parseReportCsv(body)).toEqual({ status: 'failed', failureCode });
    });

    it('在读取流时限制累积大小并取消请求体', async () => {
        let canceled = false;
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new Uint8Array(REPORT_ATTACHMENT_MAX_BYTES));
                controller.enqueue(Uint8Array.of(0));
            },
            cancel() {
                canceled = true;
            },
        });
        const request = new Request('https://scova.test', {
            method: 'POST',
            headers: { 'content-type': 'text/csv' },
            body,
            duplex: 'half',
        } as RequestInit & { duplex: 'half' });
        await expect(readReportAttachment(request, 'text/csv')).rejects.toMatchObject({
            status: 413,
        });
        expect(canceled).toBe(true);
    });

    it('上传取消时立即取消正在等待数据的读取并释放锁', async () => {
        const abort = new AbortController();
        const waiting = Promise.withResolvers<void>();
        const cancel = vi.fn();
        let source!: ReadableStreamDefaultController<Uint8Array>;
        const body = new ReadableStream<Uint8Array>(
            {
                start(controller) {
                    source = controller;
                },
                pull() {
                    waiting.resolve();
                },
                cancel,
            },
            { highWaterMark: 0 },
        );
        const request = new Request('https://scova.test', {
            method: 'POST',
            headers: { 'content-type': 'text/csv' },
            body,
            signal: abort.signal,
            duplex: 'half',
        } as RequestInit & { duplex: 'half' });
        const result = readReportAttachment(request, 'text/csv').catch((error: unknown) => error);
        await waiting.promise;

        const reason = new DOMException('上传已取消', 'AbortError');
        abort.abort(reason);
        // Close the fixture if the reader ignored abort, so the regression fails by assertion.
        if (!cancel.mock.calls.length) source.close();

        expect(await result).toBe(reason);
        expect(cancel).toHaveBeenCalledExactlyOnceWith(reason);
        expect(body.locked).toBe(false);
    });
});

describe('报告私有 TXT 和 PDF', () => {
    it('保留 UTF-8 纯文本中的空行、引号及物理行号', () => {
        expect(parseReportText(Buffer.from('\ufeff甲,"乙"\r\n\r\n\t丙\r丁\n'))).toEqual({
            status: 'ready',
            rows: ['甲,"乙"', '', '\t丙', '丁'].map((line, index) => ({
                rowNumber: index + 1,
                startLine: index + 1,
                endLine: index + 1,
                cells: [line],
            })),
        });
    });

    it.each([
        [Buffer.from([0xff]), 'INVALID_UTF8'],
        [Buffer.from('a\u0000'), 'INVALID_TEXT'],
        [Buffer.from('\ufeff'), 'INVALID_TEXT'],
        [Buffer.from('x'.repeat(4097)), 'TEXT_LIMIT_EXCEEDED'],
        [Buffer.from('a\n'.repeat(2001)), 'TEXT_LIMIT_EXCEEDED'],
    ])('拒绝预览无效或超限文本 %s', (body, failureCode) => {
        expect(parseReportText(body)).toEqual({ status: 'failed', failureCode });
    });

    it('识别 PDF 的交叉引用表并拒绝伪造或截断的文件', () => {
        const pdf = reportPdfFixture();
        expect(validateReportPdf(Buffer.from(pdf))).toBe(true);
        for (const invalid of [
            '<html>%PDF-1.7</html>',
            '%PDF-1.7\n%%EOF',
            pdf.replace('%%EOF', ''),
            `${pdf}<script>extra content</script>`,
            pdf.replace(/startxref\n\d+/, 'startxref\n10'),
        ]) {
            expect(validateReportPdf(Buffer.from(invalid))).toBe(false);
        }
    });
});
