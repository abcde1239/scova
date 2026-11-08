import { Elysia } from 'elysia';
import {
    ApiErrorSchema,
    TaskDraftInputSchema,
    TaskDraftResponseSchema,
    TaskDraftQuestionsInputSchema,
    TaskDraftQuestionsResponseSchema,
} from '@scova/models';
import type { ApiServices } from '@/app/services';
import { createTaskDraftHandlers } from '@/handler/task-drafts.ts';
/* 规划任务相关的路由插件 */
export function createTaskDraftPlugin(services: ApiServices) {
    const handlers = createTaskDraftHandlers(services);
    return new Elysia({ name: 'scova-task-drafts', prefix: '/api/v1', normalize: false })
        .post('/task-drafts/questions', handlers.questions, {
            body: TaskDraftQuestionsInputSchema,
            response: {
                200: TaskDraftQuestionsResponseSchema,
                400: ApiErrorSchema,
                401: ApiErrorSchema,
                403: ApiErrorSchema,
                422: ApiErrorSchema,
                429: ApiErrorSchema,
                503: ApiErrorSchema,
            },
            detail: {
                operationId: 'clarifyTaskDraft',
                tags: ['任务'],
                summary: '通过AI问答澄清任务需求',
                description:
                    '使用需求整理Agent根据原文和已回答内容提出最多三轮澄清；复用独立解析限流与预算。返回可编辑范围供用户确认，不保存任务、启动研究或安排周期。需会话与CSRF；模型不可用明确回退手动填写。',
            },
        })
        .post('/task-drafts', handlers.create, {
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
        });
}
