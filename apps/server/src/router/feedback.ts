import { Elysia } from 'elysia';
import {
    ApiErrorSchema,
    FeedbackInputSchema,
    FeedbackSchema,
    FeedbackListSchema,
} from '@scova/models';
import type { ApiServices } from '@/app/context.ts';
import { createFeedbackHandlers } from '@/handler/feedback.ts';
export function createFeedbackPlugin(services: ApiServices) {
    const handlers = createFeedbackHandlers(services);
    const errors = {
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        404: ApiErrorSchema,
        409: ApiErrorSchema,
        422: ApiErrorSchema,
    };
    return new Elysia({ name: 'scova-feedback', prefix: '/api/v1', normalize: false })
        .get('/tasks/:taskId/feedback', handlers.list, {
            response: { 200: FeedbackListSchema, ...errors },
            detail: {
                operationId: 'listTaskFeedback',
                tags: ['反馈'],
                summary: '读取任务当前生效反馈',
                description: '仅当前账号与任务；最多200条生效反馈。历史Run与报告保留原快照。',
            },
        })
        .post('/feedback', handlers.set, {
            body: FeedbackInputSchema,
            response: { 200: FeedbackSchema, ...errors },
            detail: {
                operationId: 'setFeedback',
                tags: ['反馈'],
                summary: '设置或切换资料及结论反馈',
                description:
                    '恰选一种目标，资料必须曾出现在当前任务，结论必须属于当前任务；需CSRF。同一目标同种反馈幂等，撤销后可重激活。只影响后续新Run，重试作为新执行捕获当前反馈。',
            },
        })
        .delete('/feedback/:feedbackId', handlers.revoke, {
            response: { 200: FeedbackSchema, ...errors },
            detail: {
                operationId: 'revokeFeedback',
                tags: ['反馈'],
                summary: '撤销反馈',
                description:
                    '逻辑撤销且重复撤销幂等；需CSRF。不改写历史报告、TaskVersion或比较基线。',
            },
        });
}
