import { Type, type Static } from '@sinclair/typebox';
import { InstantSchema, UuidSchema } from '../common/schema.ts';
import {
    REPORT_ATTACHMENT_MAX_BYTES,
    ReportAttachmentFilenameSchema,
} from '../report/attachments.ts';

export const PROJECT_THREAD_ATTACHMENT_MAX_BYTES = REPORT_ATTACHMENT_MAX_BYTES;
export const PROJECT_THREAD_ATTACHMENT_EXCERPT_CHARS = 1200;
export const ProjectThreadAttachmentRefSchema = Type.Object(
    {
        kind: Type.Literal('attachment', { description: '会话附件引用类型' }),
        id: { ...UuidSchema, description: '所引用的附件标识' },
    },
    { additionalProperties: false },
);
export type ProjectThreadAttachmentRef = Static<typeof ProjectThreadAttachmentRefSchema>;

export const ProjectThreadAttachmentSchema = Type.Object(
    {
        id: { ...UuidSchema, description: '会话附件标识' },
        threadId: { ...UuidSchema, description: '附件所属会话标识' },
        filename: ReportAttachmentFilenameSchema,
        format: Type.Union([Type.Literal('csv'), Type.Literal('txt'), Type.Literal('pdf')], {
            description: '附件文件格式',
        }),
        byteLength: Type.Integer({
            minimum: 1,
            maximum: PROJECT_THREAD_ATTACHMENT_MAX_BYTES,
            description: '原始附件大小，单位为字节',
        }),
        textAvailable: Type.Boolean({ description: '附件具有可供本轮会话读取的有限文本' }),
        createdAt: { ...InstantSchema, description: '附件首次上传完成时间' },
    },
    { additionalProperties: false },
);
export type ProjectThreadAttachment = Static<typeof ProjectThreadAttachmentSchema>;
