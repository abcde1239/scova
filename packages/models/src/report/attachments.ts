import { Type, type Static } from '@sinclair/typebox';
import { InstantSchema, UuidSchema } from '../common/schema.ts';

export const REPORT_ATTACHMENT_MAX_BYTES = 256 * 1024;
export const REPORT_ATTACHMENT_MAX_ROWS = 2000;
export const REPORT_ATTACHMENT_MAX_COLUMNS = 64;
export const REPORT_ATTACHMENT_MAX_CELL_CHARS = 4096;
export const REPORT_ATTACHMENT_MAX_PAGE_ROWS = 100;

export const ReportAttachmentFilenameSchema = Type.String({
    minLength: 5,
    maxLength: 120,
    description: '原始 CSV 文件名',
});
const AttachmentFailureSchema = Type.Union([
    Type.Literal('INVALID_UTF8'),
    Type.Literal('INVALID_CSV'),
    Type.Literal('CSV_LIMIT_EXCEEDED'),
]);
export type ReportAttachmentFailure = Static<typeof AttachmentFailureSchema>;

const fields = {
    id: UuidSchema,
    reportId: UuidSchema,
    filename: ReportAttachmentFilenameSchema,
    byteLength: Type.Integer({
        minimum: 1,
        maximum: REPORT_ATTACHMENT_MAX_BYTES,
        description: '原始文件字节数',
    }),
    createdAt: InstantSchema,
    downloadUrl: Type.String({ minLength: 1, description: '本人会话可访问的原件下载路径' }),
};

const ready = {
    status: Type.Literal('ready', { description: '解析成功' }),
    rowCount: Type.Integer({
        minimum: 1,
        maximum: REPORT_ATTACHMENT_MAX_ROWS,
        description: 'CSV 逻辑记录的行号或总数',
    }),
    failureCode: Type.Null({ description: '无解析错误' }),
};
const failed = {
    status: Type.Literal('failed', { description: '解析失败，仍保留私有原件' }),
    rowCount: Type.Null({ description: '解析失败时无行数' }),
    failureCode: { ...AttachmentFailureSchema, description: '解析失败原因' },
};
const AttachmentParseStateSchema = Type.Union([Type.Object(ready), Type.Object(failed)]);
export type ReportAttachmentParseState = Static<typeof AttachmentParseStateSchema>;

export const ReportAttachmentSchema = Type.Union([
    Type.Object({ ...fields, ...ready }, { additionalProperties: false }),
    Type.Object({ ...fields, ...failed }, { additionalProperties: false }),
]);
export type ReportAttachment = Static<typeof ReportAttachmentSchema>;

export const ReportAttachmentListSchema = Type.Object(
    { items: Type.Array(ReportAttachmentSchema, { description: '报告附带的私有 CSV 文件' }) },
    { additionalProperties: false },
);

const ReportAttachmentRowSchema = Type.Object(
    {
        rowNumber: Type.Integer({
            minimum: 1,
            maximum: REPORT_ATTACHMENT_MAX_ROWS,
            description: 'CSV 逻辑记录的行号或总数',
        }),
        startLine: Type.Integer({ minimum: 1, description: '原件起始物理行号，从一计数' }),
        endLine: Type.Integer({ minimum: 1, description: '原件结束物理行号，包含结束行' }),
        cells: Type.Array(Type.String({ maxLength: REPORT_ATTACHMENT_MAX_CELL_CHARS }), {
            minItems: 1,
            maxItems: REPORT_ATTACHMENT_MAX_COLUMNS,
            description: '当前逻辑记录的各列原始文本',
        }),
    },
    { additionalProperties: false },
);
export type ReportAttachmentRow = Static<typeof ReportAttachmentRowSchema>;

export const ReportAttachmentRowsSchema = Type.Object(
    {
        attachmentId: { ...UuidSchema, description: '当前附件标识' },
        rowCount: Type.Integer({
            minimum: 1,
            maximum: REPORT_ATTACHMENT_MAX_ROWS,
            description: 'CSV 逻辑记录的行号或总数',
        }),
        rows: Type.Array(ReportAttachmentRowSchema, {
            maxItems: REPORT_ATTACHMENT_MAX_PAGE_ROWS,
            description: '请求区间内的逻辑记录',
        }),
    },
    { additionalProperties: false },
);

export const ReportAttachmentDeletedSchema = Type.Object(
    { id: UuidSchema },
    { additionalProperties: false },
);
