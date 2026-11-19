import { Type, type Static } from '@sinclair/typebox';
import { InstantSchema, UuidSchema } from '../common/schema.ts';

export const REPORT_MARKDOWN_MAX_BYTES = 256 * 1024;
export const ReportExportSchema = Type.Object(
    {
        id: UuidSchema,
        reportId: UuidSchema,
        filename: Type.String({
            description: '安全的 Markdown 文件名',
            pattern: '^scova-report-[a-f0-9-]{36}\\.md$',
        }),
        markdown: Type.String({
            description: '报告摘要、结论、缺口及证据片段',
            minLength: 1,
            maxLength: REPORT_MARKDOWN_MAX_BYTES,
        }),
        byteLength: Type.Integer({
            description: 'Markdown 的 UTF-8 字节数',
            minimum: 1,
            maximum: REPORT_MARKDOWN_MAX_BYTES,
        }),
        sha256: Type.String({ description: 'Markdown 的 SHA-256 指纹', pattern: '^[a-f0-9]{64}$' }),
        expiresAt: InstantSchema,
    },
    {
        additionalProperties: false,
        description: '账号私有的报告 Markdown 快照，不包含原始采集正文',
    },
);
export type ReportExport = Static<typeof ReportExportSchema>;
