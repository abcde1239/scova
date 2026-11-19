import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vite-plus/test';
import {
    REPORT_JSON_MAX_QUOTE_CHARS,
    REPORT_MARKDOWN_MAX_BYTES,
    ReportJsonDocumentSchema,
    ReportJsonExportSchema,
    parseContract,
    type Report,
} from '@scova/models';
import { renderReportJson } from '@/service/report-json.ts';
import { renderReportMarkdown } from '@/service/report-markdown.ts';

const id = '00000000-0000-4000-8000-000000000001';
const date = '2026-11-18T00:00:00.000Z';
function sample(): Report {
    return {
        id,
        runId: id,
        taskId: id,
        taskVersionId: id,
        baselineRunId: null,
        schemaVersion: 1,
        title: '# 标题 <script>',
        summary: '![恶意外链](https://example.test/img)',
        format: 'brief',
        mode: 'demo',
        outcome: 'inconclusive',
        coverage: {
            completeness: 'partial',
            gaps: ['日期未知'],
            searchedQueries: [],
            exhausted: [],
        },
        limitations: ['日期未知'],
        changes: [],
        publishedAt: date,
        claims: [
            {
                id,
                text: '可核对的结论',
                kind: 'fact',
                confidenceLabel: '来源事实',
                evidenceIds: [id],
            },
        ],
        evidence: [
            {
                id,
                quote: '证据  原文\n~~~\n<img src=x>',
                location: '正文 0–19',
                title: '来源',
                url: 'https://example.test/source',
                observedAt: date,
                sourceId: id,
                snapshotId: id,
            },
        ],
    };
}

describe('报告 Markdown 快照', () => {
    it('转义标题和外链，保留证据内部空白及资源定位，并输出确定性 UTF-8 指纹', () => {
        const report = sample();
        const result = renderReportMarkdown(report);
        expect(result.markdown).toContain('\\# 标题 \\<script\\>');
        expect(result.markdown).not.toContain('![恶意外链](');
        expect(result.markdown).toContain('（证据 1）');
        expect(result.markdown).toContain('`https://example.test/source`');
        expect(result.markdown).toContain('~~~~text\n' + report.evidence[0]!.quote + '\n~~~~\n');
        expect(result.markdown.match(/日期未知/g)).toHaveLength(1);
        expect(result.byteLength).toBe(Buffer.byteLength(result.markdown));
        expect(result.sha256).toBe(createHash('sha256').update(result.markdown).digest('hex'));
        expect(renderReportMarkdown(report)).toEqual(result);
    });
    it('拒绝超出 UTF-8 字节上限的输出，不截断引用后假装成功', () => {
        expect(() =>
            renderReportMarkdown({
                ...sample(),
                summary: '研'.repeat(REPORT_MARKDOWN_MAX_BYTES / 2),
            }),
        ).toThrow(expect.objectContaining({ code: 'REPORT_EXPORT_TOO_LARGE' }));
    });
});

describe('报告 JSON 快照', () => {
    it('截取 Unicode 短引用并且只导出允许的字段，校验引用和文件归属', () => {
        const report = sample();
        const prefix = '研' + '📚'.repeat((REPORT_JSON_MAX_QUOTE_CHARS - 2) / 2);
        report.evidence[0]!.quote = prefix + '📚不导出的引用尾部';
        const rendered = renderReportJson(report);
        const document = parseContract(ReportJsonDocumentSchema, JSON.parse(rendered.content));
        expect(renderReportJson(report)).toEqual(rendered);
        expect(document.citations[0]).toMatchObject({ quote: prefix, quoteTruncated: true });
        expect(rendered.content).not.toContain('不导出的引用尾部');
        expect(document.citations[0]).not.toHaveProperty('snapshotId');
        expect(() =>
            parseContract(ReportJsonDocumentSchema, { ...document, citations: [] }),
        ).toThrow();
        expect(() =>
            parseContract(ReportJsonDocumentSchema, { ...document, textBody: '全文' }),
        ).toThrow();
        expect(() =>
            parseContract(ReportJsonExportSchema, {
                id,
                reportId: report.id,
                filename: 'scova-report-00000000-0000-4000-8000-000000000099.json',
                document,
                byteLength: rendered.byteLength,
                sha256: rendered.sha256,
                expiresAt: date,
            }),
        ).toThrow();
    });

    it('拒绝超出 UTF-8 字节上限的结构化结果', () => {
        expect(() =>
            renderReportJson({
                ...sample(),
                summary: '研'.repeat(REPORT_MARKDOWN_MAX_BYTES / 2),
            }),
        ).toThrow(expect.objectContaining({ code: 'REPORT_EXPORT_TOO_LARGE' }));
    });
});
