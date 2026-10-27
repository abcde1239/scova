import { Elysia } from 'elysia';
import {
    ApiErrorSchema,
    ReportQuestionInputSchema,
    ReportQuestionSchema,
    QuestionFollowupInputSchema,
    RunCommandResponseSchema,
} from '@scova/models';
import type { ApiServices } from '@/app/context.ts';
import { createReportQuestionHandlers } from '@/handler/report-questions.ts';
export function createReportQuestionPlugin(services: ApiServices) {
    const handlers = createReportQuestionHandlers(services);
    const errors = {
        400: ApiErrorSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        404: ApiErrorSchema,
        409: ApiErrorSchema,
        422: ApiErrorSchema,
        428: ApiErrorSchema,
        429: ApiErrorSchema,
        503: ApiErrorSchema,
    };
    return new Elysia({ name: 'scova-report-questions', prefix: '/api/v1', normalize: false })
        .post('/reports/:reportId/questions', handlers.create, {
            body: ReportQuestionInputSchema,
            response: { 201: ReportQuestionSchema, ...errors },
            detail: {
                operationId: 'createReportQuestion',
                tags: ['报告问答'],
                summary: '围绕报告证据提问',
                description:
                    '仅使用当前用户报告内授权引用，独立限流与计量；没有模型或证据不足时明确标记不足。必须携带会话、CSRF与Idempotency-Key，不会搜索或创建执行。',
            },
        })
        .get('/reports/:reportId/questions/:questionId', handlers.get, {
            response: { 200: ReportQuestionSchema, ...errors },
            detail: {
                operationId: 'getReportQuestion',
                tags: ['报告问答'],
                summary: '读取已有报告问答',
                description: '仅返回当前账号指定报告下的问答和关联执行；不重复调用模型。',
            },
        })
        .post('/reports/:reportId/questions/:questionId/followup', handlers.followup, {
            body: QuestionFollowupInputSchema,
            response: { 202: RunCommandResponseSchema, ...errors },
            detail: {
                operationId: 'confirmQuestionFollowup',
                tags: ['报告问答'],
                summary: '确认后续联网研究',
                description:
                    'confirm=true后才创建关联Run，固定原报告配置、问题、模式及预算，使用任务互斥与幂等事务。不覆盖原报告或任务配置；任务有活动执行时返回409。',
            },
        });
}
