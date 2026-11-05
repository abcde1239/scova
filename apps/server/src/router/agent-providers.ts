import { Elysia, t } from 'elysia';
import {
    AgentProviderInputSchema,
    AgentProviderUpdateSchema,
    AgentProviderSchema,
    AgentProviderListSchema,
    AgentProviderRevisionSchema,
    AgentProviderActivationSchema,
    AgentModelCatalogInputSchema,
    AgentModelCatalogSchema,
    ApiErrorSchema,
    UuidSchema,
} from '@scova/models';
import type { ApiServices } from '@/app/services';
import { createAgentProviderHandlers } from '@/handler/agent-providers';

export function createAgentProviderPlugin(services: ApiServices) {
    const handlers = createAgentProviderHandlers(services);
    const params = t.Object({ id: UuidSchema });
    const errors = {
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        404: ApiErrorSchema,
        409: ApiErrorSchema,
        422: ApiErrorSchema,
        503: ApiErrorSchema,
    };
    return new Elysia({
        name: 'scova-agent-providers',
        prefix: '/api/v1/me/agent-providers',
        normalize: false,
    })
        .onBeforeHandle(({ set }) => {
            set.headers['cache-control'] = 'no-store';
        })
        .get('/', ({ request }) => handlers.list(request), {
            response: { 200: AgentProviderListSchema, ...errors },
            detail: {
                operationId: 'listAgentProviders',
                tags: ['账号'],
                summary: '列出账号供应商',
                description: '仅返回当前账号的供应商和模型配置，不返回密钥。',
            },
        })
        .post('/models', ({ request, body }) => handlers.models(request, body), {
            body: AgentModelCatalogInputSchema,
            response: { 200: AgentModelCatalogSchema, ...errors },
            detail: {
                operationId: 'listAgentProviderModels',
                tags: ['账号'],
                summary: '读取供应商模型列表',
                description:
                    '按接口协议读取模型目录，不保存配置或生成内容。可复用本人指定修订的已存密钥；更改地址或协议须重填密钥。',
            },
        })
        .post(
            '/',
            async ({ request, body, set }) => {
                const result = await handlers.create(request, body);
                set.status = 201;
                return result;
            },
            {
                body: AgentProviderInputSchema,
                response: { 201: AgentProviderSchema, ...errors },
                detail: {
                    operationId: 'createAgentProvider',
                    tags: ['账号'],
                    summary: '添加账号供应商',
                    description: '服务端加密保存API密钥，新增后需显式设为当前使用。',
                },
            },
        )
        .patch('/:id', ({ request, params, body }) => handlers.update(request, params.id, body), {
            params,
            body: AgentProviderUpdateSchema,
            response: { 200: AgentProviderSchema, ...errors },
            detail: {
                operationId: 'updateAgentProvider',
                tags: ['账号'],
                summary: '编辑账号供应商',
                description: '校验账号归属和修订号；未传密钥时保留原值。',
            },
        })
        .post(
            '/:id/activate',
            ({ request, params, body }) => handlers.activate(request, params.id, body),
            {
                params,
                body: AgentProviderActivationSchema,
                response: { 200: AgentProviderSchema, ...errors },
                detail: {
                    operationId: 'activateAgentProvider',
                    tags: ['账号'],
                    summary: '切换账号模型',
                    description:
                        '事务内仅切换指定用途的模型：research用于研究执行与报告问答，task_draft用于需求整理；省略用途兼容研究执行。',
                },
            },
        )
        .delete(
            '/:id',
            async ({ request, params, body }) => {
                await handlers.remove(request, params.id, body);
                return new Response(null, { status: 204 });
            },
            {
                params,
                body: AgentProviderRevisionSchema,
                detail: {
                    operationId: 'deleteAgentProvider',
                    tags: ['账号'],
                    summary: '删除账号供应商',
                    description:
                        '校验账号归属和修订号；删除当前项后使用部署默认配置，当前执行会话保持启动时配置，恢复执行重新读取。',
                    responses: { 204: { description: '已删除配置' } },
                },
            },
        );
}
