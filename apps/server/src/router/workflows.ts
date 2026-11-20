import { Elysia, t } from 'elysia';
import {
    ApiErrorSchema,
    IdempotencyHeadersSchema,
    PageQuerySchema,
    RevisionHeadersSchema,
} from '@scova/models';
import {
    WorkflowDetailSchema,
    WorkflowDraftInputSchema,
    WorkflowListSchema,
    WorkflowRunListSchema,
    WorkflowRunSchema,
    WorkflowStartInputSchema,
    WorkflowStartResponseSchema,
    WorkflowVersionSchema,
    WorkflowVersionListSchema,
} from '@scova/models';
import type { ApiServices } from '@/app/services';
import { createWorkflowHandlers } from '@/handler/workflows.ts';

const pageQuery = t.Object(
    {
        cursor: PageQuerySchema.properties.cursor,
        limit: t.Optional(
            t.Numeric({
                minimum: 1,
                maximum: Number.MAX_SAFE_INTEGER,
                description: '每页请求条数',
            }),
        ),
    },
    { additionalProperties: false },
);
const revisionHeaders = t.Object(
    { 'if-match': t.Optional(RevisionHeadersSchema.properties['if-match']) },
    { additionalProperties: true },
);
const startHeaders = t.Object(
    { 'idempotency-key': t.Optional(IdempotencyHeadersSchema.properties['idempotency-key']) },
    { additionalProperties: true },
);
const errors = {
    400: ApiErrorSchema,
    401: ApiErrorSchema,
    403: ApiErrorSchema,
    404: ApiErrorSchema,
    409: ApiErrorSchema,
    412: ApiErrorSchema,
    422: ApiErrorSchema,
    428: ApiErrorSchema,
};
const tags = ['工作流'];

export function createWorkflowPlugin(services: ApiServices) {
    const handlers = createWorkflowHandlers(services);
    return new Elysia({ name: 'scova-workflows', prefix: '/api/v1', normalize: false })
        .get('/workflows', handlers.list, {
            query: pageQuery,
            response: { 200: WorkflowListSchema, ...errors },
            detail: {
                operationId: 'listWorkflows',
                tags,
                summary: '分页查看账号工作流',
                description: '按创建时间倒序返回当前账号的工作流，支持游标分页。',
            },
        })
        .post('/workflows', handlers.create, {
            body: WorkflowDraftInputSchema,
            response: { 201: WorkflowDetailSchema, ...errors },
            detail: {
                operationId: 'createWorkflow',
                tags,
                summary: '创建工作流草稿',
                description: '创建可继续编辑的工作流草稿。需要当前账号会话及来源和 CSRF 校验。',
            },
        })
        .get('/workflows/:workflowId', handlers.get, {
            response: { 200: WorkflowDetailSchema, ...errors },
            detail: {
                operationId: 'getWorkflow',
                tags,
                summary: '查看草稿及最近发布版本',
                description: '返回工作流草稿与最近发布版本，草稿修订号同时通过 ETag 返回。',
            },
        })
        .patch('/workflows/:workflowId/draft', handlers.updateDraft, {
            headers: revisionHeaders,
            body: WorkflowDraftInputSchema,
            response: { 200: WorkflowDetailSchema, ...errors },
            detail: {
                operationId: 'updateWorkflowDraft',
                tags,
                summary: '按修订号更新工作流草稿',
                description: '使用 If-Match 防止覆盖较新的草稿，允许保存尚未连通的草稿。',
            },
        })
        .post('/workflows/:workflowId/publish', handlers.publish, {
            headers: revisionHeaders,
            response: { 200: WorkflowDetailSchema, ...errors },
            detail: {
                operationId: 'publishWorkflow',
                tags,
                summary: '校验图并冻结研究任务配置版本',
                description:
                    '验证节点、端口、连线和任务所有权，发布不可变版本。同一草稿修订重复发布复用已有版本。',
            },
        })
        .get('/workflows/:workflowId/versions', handlers.listVersions, {
            query: pageQuery,
            response: { 200: WorkflowVersionListSchema, ...errors },
            detail: {
                operationId: 'listWorkflowVersions',
                tags,
                summary: '分页查看已发布工作流版本',
                description: '按版本号倒序列出所有已发布快照，包含尚未运行的版本。',
            },
        })
        .get('/workflows/:workflowId/versions/:versionId', handlers.version, {
            response: { 200: WorkflowVersionSchema, ...errors },
            detail: {
                operationId: 'getWorkflowVersion',
                tags,
                summary: '查看不可变工作流版本',
                description: '返回指定发布快照与其中引用的任务配置版本。',
            },
        })
        .get('/workflows/:workflowId/runs', handlers.listRuns, {
            query: pageQuery,
            response: { 200: WorkflowRunListSchema, ...errors },
            detail: {
                operationId: 'listWorkflowRuns',
                tags,
                summary: '分页查看工作流运行历史',
                description: '按创建时间倒序返回当前工作流的节点运行记录。',
            },
        })
        .post('/workflows/:workflowId/runs', handlers.start, {
            headers: startHeaders,
            body: WorkflowStartInputSchema,
            response: { 202: WorkflowStartResponseSchema, ...errors },
            detail: {
                operationId: 'startWorkflowRun',
                tags,
                summary: '手动运行指定发布版本',
                description: '启动指定发布版本，使用 Idempotency-Key 安全重发同一次启动动作。',
            },
        })
        .get('/workflow-runs/:runId', handlers.getRun, {
            response: { 200: WorkflowRunSchema, ...errors },
            detail: {
                operationId: 'getWorkflowRun',
                tags,
                summary: '查看节点检查点与研究子执行',
                description: '返回节点运行快照，可通过子执行标识查看研究运行详情。',
            },
        })
        .post('/workflow-runs/:runId/cancel', handlers.cancel, {
            response: { 200: WorkflowRunSchema, ...errors },
            detail: {
                operationId: 'cancelWorkflowRun',
                tags,
                summary: '请求取消运行及正在执行的研究节点',
                description: '请求取消活动研究子执行并跳过后续节点，等待 Worker 确认取消。',
            },
        });
}
