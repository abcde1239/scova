import { Elysia } from 'elysia';
import {
    ApiErrorSchema,
    ReportQuestionInputSchema,
    ReportQuestionSchema,
    QuestionFollowupInputSchema,
    RunCommandResponseSchema,
    ReportConversationSchema,
    ReportConversationQuerySchema,
} from '@scova/models';
import type { ApiServices } from '@/app/services';
import { createReportQuestionHandlers } from '@/handler/report-questions.ts';
/* 报告追问相关的路由插件 */
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
        .get('/reports/:reportId/conversation', handlers.conversation, {
            query: ReportConversationQuerySchema,
            response: { 200: ReportConversationSchema, ...errors },
            detail: {
                operationId: 'getReportConversation',
                tags: ['报告问答'],
                summary: '读取报告连续对话',
                description:
                    '读取当前账号报告最近100轮问答、待完成轮次及关联成果，可通过beforeQuestionId向前分页；不调用模型。',
            },
        })
        .post('/reports/:reportId/questions', handlers.create, {
            body: ReportQuestionInputSchema,
            response: { 201: ReportQuestionSchema, ...errors },
            detail: {
                operationId: 'createReportQuestion',
                tags: ['报告问答'],
                summary: '围绕报告证据提问',
                description:
                    '结合原报告与有界历史对话，仅使用当前用户报告内授权引用，独立限流与计量；afterQuestionId核对最新轮次。必须携带会话、CSRF与Idempotency-Key，不会搜索或创建执行。',
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
                summary: '确认报告修订或后续研究',
                description:
                    'confirm=true后创建关联Run；research联网补充，revise仅使用已保存证据生成新版。冻结原报告、历史对话、当前问题、交付形式及预算。仅接受真实报告，不覆盖原报告或任务计划；任务有活动执行时返回409。',
            },
        });
}
