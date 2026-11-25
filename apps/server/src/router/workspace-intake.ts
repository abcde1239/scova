import { Elysia } from 'elysia';
import {
    ApiErrorSchema,
    IdempotencyHeadersSchema,
    WorkspaceHomeSchema,
    WorkspaceIntakeInputSchema,
    WorkspaceIntakeResultSchema,
} from '@scova/models';
import type { ApiServices } from '@/app/services';
import { createWorkspaceIntakeHandlers } from '@/handler/workspace-intake';

export function createWorkspaceIntakePlugin(services: ApiServices) {
    const handlers = createWorkspaceIntakeHandlers(services);
    return new Elysia({ name: 'scova-workspace-intake', prefix: '/api/v1/workspace' })
        .get('/home', handlers.home, {
            response: { 200: WorkspaceHomeSchema, 401: ApiErrorSchema },
            detail: {
                tags: ['项目'],
                operationId: 'getWorkspaceHome',
                summary: '读取工作台最近项目与待处理事项',
                description: '返回本人账号最近活动过的项目和仍可处理的会话动作。',
            },
        })
        .post('/intake', handlers.intake, {
            headers: IdempotencyHeadersSchema,
            body: WorkspaceIntakeInputSchema,
            response: {
                200: WorkspaceIntakeResultSchema,
                400: ApiErrorSchema,
                401: ApiErrorSchema,
                403: ApiErrorSchema,
                404: ApiErrorSchema,
                409: ApiErrorSchema,
                422: ApiErrorSchema,
            },
            detail: {
                tags: ['项目'],
                operationId: 'submitWorkspaceIntake',
                summary: '归类全局输入并创建项目会话',
                description:
                    '需要会话、CSRF 和 Idempotency-Key。自动归类无法确定时返回候选项目。返回的轮次标识用于发送首条会话消息。',
            },
        });
}
