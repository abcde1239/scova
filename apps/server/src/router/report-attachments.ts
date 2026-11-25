import {
    ApiErrorSchema,
    REPORT_ATTACHMENT_MAX_ROWS,
    REPORT_ATTACHMENT_MEDIA_TYPES,
    ReportAttachmentDeletedSchema,
    ReportAttachmentFilenameSchema,
    ReportAttachmentListSchema,
    ReportAttachmentRowsSchema,
    ReportAttachmentSchema,
    UuidSchema,
} from '@scova/models';
import { Elysia, t } from 'elysia';
import type { ApiServices } from '@/app/services';
import { createReportAttachmentHandlers } from '@/handler/report-attachments.ts';

const report = t.Object({ reportId: UuidSchema });
const attachment = t.Object({ reportId: UuidSchema, attachmentId: UuidSchema });
const rowNumber = t.Numeric({
    minimum: 1,
    maximum: REPORT_ATTACHMENT_MAX_ROWS,
    multipleOf: 1,
    description: '从一计数的逻辑记录行号，包含此行',
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
} as const;

export function createReportAttachmentPlugin(services: ApiServices) {
    const handlers = createReportAttachmentHandlers(services);
    return new Elysia({
        name: 'scova-report-attachments',
        prefix: '/api/v1/reports/:reportId/attachments',
        normalize: false,
    })
        .onBeforeHandle(({ set }) => {
            set.headers['cache-control'] = 'private, no-store';
        })
        .post(
            '',
            ({ request, params, query }) =>
                handlers.upload(request, params.reportId, query.filename),
            {
                parse: 'none',
                params: report,
                query: t.Object(
                    { filename: ReportAttachmentFilenameSchema },
                    { additionalProperties: false },
                ),
                response: { 200: ReportAttachmentSchema, ...errors, 503: ApiErrorSchema },
                detail: {
                    operationId: 'uploadReportAttachment',
                    tags: ['报告'],
                    summary: '上传私有参考附件',
                    description:
                        '仅本人可上传，要求会话及请求校验。接收不超过 10 MiB 的原始请求体，文件扩展名须与 Content-Type 匹配，文本使用 UTF-8。超过 256 KiB 时使用私有对象存储，仅供下载。',
                    requestBody: {
                        required: true,
                        content: Object.fromEntries(
                            Object.values(REPORT_ATTACHMENT_MEDIA_TYPES).map((type) => [
                                type,
                                { schema: { type: 'string', format: 'binary' } },
                            ]),
                        ),
                    },
                },
            },
        )
        .get('', ({ request, params }) => handlers.list(request, params.reportId), {
            params: report,
            response: { 200: ReportAttachmentListSchema, ...errors },
            detail: {
                operationId: 'listReportAttachments',
                tags: ['报告'],
                summary: '读取报告私有附件状态',
                description: '只返回本人报告中附件的文件名、可用状态与下载路径。',
            },
        })
        .get(
            '/:attachmentId/rows',
            ({ request, params, query }) =>
                handlers.rows(
                    request,
                    params.reportId,
                    params.attachmentId,
                    query.start,
                    query.end,
                ),
            {
                params: attachment,
                query: t.Object(
                    { start: rowNumber, end: rowNumber },
                    { additionalProperties: false },
                ),
                response: { 200: ReportAttachmentRowsSchema, ...errors },
                detail: {
                    operationId: 'readReportAttachmentRows',
                    tags: ['报告'],
                    summary: '读取 CSV 或纯文本的预览行和对应原文行区间',
                    description:
                        '仅本人会话可读取已解析文本，每次最多一百个逻辑记录，包含其对应的原文物理行号。',
                },
            },
        )
        .get(
            '/:attachmentId/download',
            ({ request, params }) =>
                handlers.download(request, params.reportId, params.attachmentId),
            {
                params: attachment,
                response: { 200: t.Any(), ...errors, 503: ApiErrorSchema },
                detail: {
                    operationId: 'downloadReportAttachment',
                    tags: ['报告'],
                    summary: '下载本人私有附件的原始内容',
                    description: '会话归属校验后返回原始字节，文本解析失败时仍可下载原件。',
                    responses: {
                        200: {
                            description: '可下载的私有附件原件',
                            content: {
                                'application/octet-stream': {
                                    schema: { type: 'string', format: 'binary' },
                                },
                            },
                        },
                    },
                },
            },
        )
        .delete(
            '/:attachmentId',
            ({ request, params }) => handlers.remove(request, params.reportId, params.attachmentId),
            {
                params: attachment,
                response: { 200: ReportAttachmentDeletedSchema, ...errors },
                detail: {
                    operationId: 'deleteReportAttachment',
                    tags: ['报告'],
                    summary: '删除本人私有附件及提取状态',
                    description: '需要本人会话和请求校验。删除附件的保存记录、解析状态和原始字节。',
                },
            },
        );
}
