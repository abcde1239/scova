import { Elysia, t } from 'elysia';
import {
    ApiErrorSchema,
    InboxItemSchema,
    InboxListQuerySchema,
    InboxListResponseSchema,
    InboxPatchInputSchema,
    ReportListQuerySchema,
    ReportListResponseSchema,
    ReportSchema,
} from '@scova/models';
import type { ApiServices } from '@/app/context.ts';
import { createReportHandlers } from '@/handler/reports.ts';

const limit = t.Optional(
    t.Numeric({
        minimum: 1,
        maximum: Number.MAX_SAFE_INTEGER,
        description: '每页条数，默认 50，上限 100',
    }),
);
const reportQuery = t.Object(
    { ...ReportListQuerySchema.properties, limit },
    { additionalProperties: false, description: '报告历史分页和任务筛选' },
);
const inboxQuery = t.Object(
    {
        ...InboxListQuerySchema.properties,
        limit,
        unread: t.Optional(t.BooleanString({ description: '只查看未读或已读，省略返回全部' })),
    },
    { additionalProperties: false, description: '收件箱分页和已读状态筛选' },
);

export function createReportPlugin(services: ApiServices) {
    const handlers = createReportHandlers(services);
    const errors = {
        400: ApiErrorSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        404: ApiErrorSchema,
        409: ApiErrorSchema,
        422: ApiErrorSchema,
    } as const;
    return new Elysia({ name: 'scova-reports', prefix: '/api/v1', normalize: false })
        .model({
            Report: ReportSchema,
            ReportListResponse: ReportListResponseSchema,
            InboxItem: InboxItemSchema,
            InboxListResponse: InboxListResponseSchema,
            InboxPatchInput: InboxPatchInputSchema,
        })
        .get('/reports', handlers.list, {
            query: reportQuery,
            response: { 200: ReportListResponseSchema, ...errors },
            detail: {
                operationId: 'listReports',
                tags: ['报告'],
                summary: '读取报告历史',
                description:
                    '按交付时间分页读取当前账号的报告摘要，可筛选所属任务；保留演示模式和覆盖缺口。',
            },
        })
        .get('/reports/:reportId', handlers.get, {
            response: { 200: ReportSchema, ...errors },
            detail: {
                operationId: 'getReport',
                tags: ['报告'],
                summary: '读取报告与原文证据',
                description:
                    '校验当前账号、执行归属及来源快照后返回结构化结论与引用；正文过期仍保留证据片段，不暴露完整正文或内部执行状态。',
            },
        })
        .get('/inbox', handlers.inbox, {
            query: inboxQuery,
            response: { 200: InboxListResponseSchema, ...errors },
            detail: {
                operationId: 'listInbox',
                tags: ['收件箱'],
                summary: '读取报告收件箱',
                description: '按交付时间分页读取当前账号的收件箱，可按已读状态筛选。',
            },
        })
        .patch('/inbox/:inboxId', handlers.patchInbox, {
            body: InboxPatchInputSchema,
            response: { 200: InboxItemSchema, ...errors },
            detail: {
                operationId: 'patchInbox',
                tags: ['收件箱'],
                summary: '更新收件箱已读状态',
                description:
                    '需要会话与 CSRF 校验，可标记已读或恢复未读；重复标记已读保留首次已读时间。',
            },
        });
}
