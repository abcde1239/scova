import { Elysia, t } from 'elysia';
import {
    SearchConfigurationSchema,
    SearchConfigurationResultSchema,
    SearchConfigurationInputSchema,
    SearchConfigurationImportSchema,
    ApiErrorSchema,
    UuidSchema,
} from '@scova/models';
import type { ApiServices } from '@/app/services';
import { createSearchConfigurationHandlers } from '@/handler/search-configuration';

export function createSearchConfigurationPlugin(services: ApiServices) {
    const handlers = createSearchConfigurationHandlers(services);
    const errors = {
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        404: ApiErrorSchema,
        409: ApiErrorSchema,
        422: ApiErrorSchema,
        503: ApiErrorSchema,
    };
    return new Elysia({
        name: 'scova-search-configuration',
        prefix: '/api/v1/me/search-configuration',
        normalize: false,
    })
        .onBeforeHandle(({ set }) => {
            set.headers['cache-control'] = 'no-store';
        })
        .get('/', ({ request }) => handlers.get(request), {
            response: { 200: SearchConfigurationResultSchema, ...errors },
            detail: {
                operationId: 'readSearchConfiguration',
                tags: ['账号'],
                summary: '读取独立搜索与正文提取配置',
                description: '只读取当前账号配置，不读取模型配置或服务器环境变量搜索默认。',
            },
        })
        .put('/', ({ request, body }) => handlers.save(request, body), {
            body: SearchConfigurationInputSchema,
            response: { 200: SearchConfigurationSchema, ...errors },
            detail: {
                operationId: 'saveSearchConfiguration',
                tags: ['账号'],
                summary: '保存独立搜索与正文提取配置',
                description:
                    '按账号隔离并加密保存搜索密钥，修订号校验并发。更改模型配置不改变搜索配置。',
            },
        })
        .post(
            '/import/:providerId',
            ({ request, params, body }) => handlers.importLegacy(request, params.providerId, body),
            {
                params: t.Object({ providerId: UuidSchema }),
                body: SearchConfigurationImportSchema,
                response: { 200: SearchConfigurationSchema, ...errors },
                detail: {
                    operationId: 'importLegacySearchConfiguration',
                    tags: ['账号'],
                    summary: '迁入旧模型中的搜索 API 配置',
                    description:
                        '显式复制本人旧模型中的搜索密钥，重新加密后独立保存；不修改或绑定旧模型。',
                },
            },
        );
}
