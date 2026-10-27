import { Elysia } from 'elysia';
import { ApiErrorSchema, TaskDraftInputSchema, TaskDraftResponseSchema } from '@scova/models';
import type { ApiServices } from '@/app/context.ts';
import { createTaskDraftHandlers } from '@/handler/task-drafts.ts';

export function createTaskDraftPlugin(services: ApiServices) {
    return new Elysia({ name: 'scova-task-drafts', prefix: '/api/v1', normalize: false }).post(
        '/task-drafts',
        createTaskDraftHandlers(services).create,
        {
            body: TaskDraftInputSchema,
            response: {
                200: TaskDraftResponseSchema,
                400: ApiErrorSchema,
                401: ApiErrorSchema,
                403: ApiErrorSchema,
                422: ApiErrorSchema,
                429: ApiErrorSchema,
                503: ApiErrorSchema,
            },
            detail: {
                operationId: 'createTaskDraft',
                tags: ['任务'],
                summary: '解析待确认的任务草稿',
                description:
                    '仅生成可编辑草稿，使用独立解析限流与预算；缺少模型或解析失败明确回退手工配置。必须携带会话与CSRF。不会保存任务、创建执行或安排周期；用户确认后另行POST /tasks。',
            },
        },
    );
}
