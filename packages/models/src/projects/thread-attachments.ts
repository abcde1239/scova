import { Type, type Static } from '@sinclair/typebox';
import { InstantSchema, UuidSchema } from '../common/schema.ts';
import { REPORT_ATTACHMENT_MEDIA_TYPES } from '../report/attachments.ts';

export const PROJECT_THREAD_ATTACHMENT_MAX_BYTES = 256 * 1024;
const formatSchema = Type.Union(
    [
        Type.Literal('csv'),
        Type.Literal('txt'),
        Type.Literal('pdf'),
        Type.Literal('md'),
        Type.Literal('json'),
        Type.Literal('tsv'),
        Type.Literal('png'),
        Type.Literal('jpeg'),
        Type.Literal('webp'),
    ],
    {
        description: '附件文件格式',
    },
);
type ProjectThreadAttachmentFormat = Static<typeof formatSchema>;
export const PROJECT_THREAD_ATTACHMENT_MEDIA_TYPES = {
    csv: REPORT_ATTACHMENT_MEDIA_TYPES.csv,
    txt: REPORT_ATTACHMENT_MEDIA_TYPES.txt,
    pdf: REPORT_ATTACHMENT_MEDIA_TYPES.pdf,
    md: 'text/markdown',
    json: 'application/json',
    tsv: 'text/tab-separated-values',
    png: 'image/png',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
} as const satisfies Record<ProjectThreadAttachmentFormat, string>;
export type ProjectThreadAttachmentMediaType =
    (typeof PROJECT_THREAD_ATTACHMENT_MEDIA_TYPES)[ProjectThreadAttachmentFormat];

const formats = Object.keys(
    PROJECT_THREAD_ATTACHMENT_MEDIA_TYPES,
) as ProjectThreadAttachmentFormat[];
const extensions = new Map<string, ProjectThreadAttachmentFormat>([
    ...formats.map((format) => [`.${format}`, format] as const),
    ['.markdown', 'md'],
    ['.jpg', 'jpeg'],
]);
export const PROJECT_THREAD_ATTACHMENT_ACCEPT = [...extensions.keys()].join(',');

export function projectThreadAttachmentFormat(filename: string) {
    const dot = filename.lastIndexOf('.');
    return dot > 0 ? extensions.get(filename.slice(dot).toLowerCase()) : undefined;
}

export const ProjectThreadAttachmentFilenameSchema = Type.String({
    minLength: 4,
    maxLength: 120,
    description: '带受支持扩展名的原始会话附件文件名',
});
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
        filename: ProjectThreadAttachmentFilenameSchema,
        format: formatSchema,
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
