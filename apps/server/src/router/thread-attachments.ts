import {
    ApiErrorSchema,
    ProjectThreadAttachmentSchema,
    ReportAttachmentFilenameSchema,
    UuidSchema,
} from '@scova/models';
import { Elysia, t } from 'elysia';
import type { ApiServices } from '@/app/services';
import { createThreadAttachmentHandlers } from '@/handler/thread-attachments.ts';

const threadId = { ...UuidSchema, description: '项目会话标识' };
const thread = t.Object({ threadId });
const attachment = t.Object({
    threadId,
    attachmentId: { ...UuidSchema, description: '会话附件标识' },
});
const errors = {
    400: ApiErrorSchema,
    401: ApiErrorSchema,
    403: ApiErrorSchema,
    404: ApiErrorSchema,
    409: ApiErrorSchema,
    413: ApiErrorSchema,
    415: ApiErrorSchema,
    422: ApiErrorSchema,
    503: ApiErrorSchema,
} as const;
const binary = { schema: { type: 'string', format: 'binary' } } as const;

export function createThreadAttachmentPlugin(services: ApiServices) {
    const handlers = createThreadAttachmentHandlers(services);
    return new Elysia({
        name: 'scova-thread-attachments',
        prefix: '/api/v1/threads/:threadId/attachments',
        normalize: false,
    })
        .onBeforeHandle(({ set }) => {
            set.headers['cache-control'] = 'private, no-store';
        })
        .post(
            '',
            ({ request, params, query }) =>
                handlers.upload(request, params.threadId, query.filename),
            {
                parse: 'none',
                params: thread,
                query: t.Object(
                    { filename: ReportAttachmentFilenameSchema },
                    { additionalProperties: false },
                ),
                response: { 200: ProjectThreadAttachmentSchema, ...errors },
                detail: {
                    tags: ['项目'],
                    operationId: 'uploadProjectThreadAttachment',
                    summary: '上传私有会话附件',
                    description:
                        '需要本人会话及 CSRF 校验。接收不超过 256 KiB 的 CSV、UTF-8 纯文本或 PDF 原始请求体。PDF 仅供下载。',
                    requestBody: {
                        required: true,
                        content: {
                            'text/csv': binary,
                            'text/plain': binary,
                            'application/pdf': binary,
                        },
                    },
                },
            },
        )
        .get(
            '/:attachmentId',
            ({ request, params }) =>
                handlers.metadata(request, params.threadId, params.attachmentId),
            {
                params: attachment,
                response: { 200: ProjectThreadAttachmentSchema, ...errors },
                detail: {
                    tags: ['项目'],
                    operationId: 'getProjectThreadAttachment',
                    summary: '读取私有会话附件信息',
                    description:
                        '仅当前账号可读取指定会话内已上传附件的文件名、格式及文字可用状态。',
                },
            },
        )
        .get(
            '/:attachmentId/download',
            ({ request, params }) =>
                handlers.download(request, params.threadId, params.attachmentId),
            {
                params: attachment,
                response: { 200: t.Any(), ...errors },
                detail: {
                    tags: ['项目'],
                    operationId: 'downloadProjectThreadAttachment',
                    summary: '下载私有会话附件原件',
                    description: '校验当前账号与会话归属后返回原始附件字节。已归档会话仍可下载。',
                    responses: {
                        200: {
                            description: '本人可下载的原件',
                            content: { 'application/octet-stream': binary },
                        },
                    },
                },
            },
        );
}
