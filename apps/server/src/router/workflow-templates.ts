import { Elysia, t } from 'elysia';
import {
    ApiErrorSchema,
    IdempotencyHeadersSchema,
    WorkflowDetailSchema,
    WorkflowStartResponseSchema,
    WorkflowTemplateListSchema,
    WorkflowTemplateSaveSchema,
    WorkflowTemplateSchema,
    WorkflowTemplateStartSchema,
} from '@scova/models';
import type { ApiServices } from '@/app/services';
import { createWorkflowTemplateHandlers } from '@/handler/workflow-templates.ts';

const errors = {
    400: ApiErrorSchema,
    401: ApiErrorSchema,
    403: ApiErrorSchema,
    404: ApiErrorSchema,
    409: ApiErrorSchema,
    422: ApiErrorSchema,
    428: ApiErrorSchema,
};
const tags = ['工作流'];
const startHeaders = t.Object(
    { 'idempotency-key': t.Optional(IdempotencyHeadersSchema.properties['idempotency-key']) },
    { additionalProperties: true },
);

export function createWorkflowTemplatePlugin(services: ApiServices) {
    const handlers = createWorkflowTemplateHandlers(services);
    return new Elysia({ name: 'scova-workflow-templates', prefix: '/api/v1', normalize: false })
        .get('/workflow-templates', handlers.list, {
            response: { 200: WorkflowTemplateListSchema, ...errors },
            detail: {
                operationId: 'listWorkflowTemplates',
                tags,
                summary: '查看内置模板和当前账号的个人模板',
                description:
                    '返回模板的固定版本、画布快照和参数定义。已经使用过的模板同时返回当前账号的运行历史入口。',
            },
        })
        .post('/workflow-templates', handlers.save, {
            body: WorkflowTemplateSaveSchema,
            response: { 201: WorkflowTemplateSchema, ...errors },
            detail: {
                operationId: 'saveWorkflowTemplate',
                tags,
                summary: '从已发布的工作流版本保存个人模板',
                description:
                    '将当前账号拥有的发布版本保存为个人模板，记录公开的参数定义，并清除研究任务绑定。',
            },
        })
        .post('/workflow-templates/:templateId/versions/:templateVersion/copy', handlers.copy, {
            response: { 201: WorkflowDetailSchema, ...errors },
            detail: {
                operationId: 'copyWorkflowTemplate',
                tags,
                summary: '将模板版本复制为独立草稿',
                description:
                    '复制指定模板版本的画布、节点和连线。新草稿由当前账号独立编辑和发布，研究节点需要重新选择任务。',
            },
        })
        .post('/workflow-templates/:templateId/versions/:templateVersion/start', handlers.start, {
            headers: startHeaders,
            body: WorkflowTemplateStartSchema,
            response: { 202: WorkflowStartResponseSchema, ...errors },
            detail: {
                operationId: 'startWorkflowTemplate',
                tags,
                summary: '填写参数并幂等启动指定模板版本',
                description:
                    '校验公开的运行输入并启动固定模板版本。相同幂等键和输入返回同一次运行。',
            },
        });
}
