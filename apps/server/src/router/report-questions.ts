import { Elysia, t } from 'elysia';
import {
    ApiErrorSchema,
    ReportQuestionInputSchema,
    ReportQuestionSchema,
    QuestionFollowupInputSchema,
    ReportFollowupInputSchema,
    IdempotencyHeadersSchema,
    ReportFollowupResponseSchema,
    ReportQuestionDetailSchema,
    RunCommandResponseSchema,
    ReportConversationSchema,
    ReportConversationQuerySchema,
    ReportMergeInputSchema,
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
        .post('/reports/:reportId/followup', handlers.requestFollowup, {
            body: ReportFollowupInputSchema,
            headers: t.Object({
                'idempotency-key': t.Optional(
                    t.String({
                        description:
                            IdempotencyHeadersSchema.properties['idempotency-key'].description,
                    }),
                ),
            }),
            response: { 202: ReportFollowupResponseSchema, ...errors },
            detail: {
                operationId: 'requestReportFollowup',
                tags: ['报告问答'],
                summary: '确认以未发送的问题启动补查',
                description:
                    '须携带会话、CSRF及稳定的Idempotency-Key。明确确认后一次性保存问题和执行，跳过报告问答模型。API模式须提供账号搜索配置版本。相同键和请求返回原问题及执行，不同请求返回409。',
            },
        })
        .post('/reports/:reportId/merge', handlers.merge, {
            body: ReportMergeInputSchema,
            response: { 202: RunCommandResponseSchema, ...errors },
            detail: {
                operationId: 'mergeReportArtifacts',
                tags: ['报告问答'],
                summary: '合并原报告与选定续作',
                description:
                    '接受当前账号同一对话的1至8份续作，冻结保存证据并创建新的资料内改写执行。原报告和续作保留，禁止联网；需要CSRF和稳定的Idempotency-Key，活动执行冲突返回409。',
            },
        })
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
            response: { 200: ReportQuestionDetailSchema, ...errors },
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
