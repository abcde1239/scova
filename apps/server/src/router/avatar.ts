import { Elysia, t } from 'elysia';
import {
    ApiErrorSchema,
    AvatarStateSchema,
    AvatarVersionQuerySchema,
    SessionResponseSchema,
    UuidSchema,
} from '@scova/models';
import type { ApiServices } from '@/app/services';
import { createAvatarHandlers } from '@/handler/avatar';

export function createAvatarPlugin(services: ApiServices) {
    const handlers = createAvatarHandlers(services);
    const errors = {
        400: 'AvatarApiError',
        401: 'AvatarApiError',
        403: 'AvatarApiError',
        404: 'AvatarApiError',
        409: 'AvatarApiError',
        413: 'AvatarApiError',
        415: 'AvatarApiError',
        422: 'AvatarApiError',
        429: 'AvatarApiError',
        500: 'AvatarApiError',
        503: 'AvatarApiError',
    } as const;
    return new Elysia({ name: 'scova-avatar', prefix: '/api/v1/me/avatar', normalize: false })
        .model({
            AvatarApiError: ApiErrorSchema,
            AvatarState: AvatarStateSchema,
            AvatarVersionQuery: AvatarVersionQuerySchema,
            AvatarSessionResponse: SessionResponseSchema,
        })
        .onBeforeHandle(({ set }) => {
            set.headers['cache-control'] = 'no-store';
        })
        .get('', ({ request }) => handlers.state(request), {
            response: { 200: 'AvatarState', ...errors },
            detail: {
                operationId: 'getAvatarState',
                tags: ['账号'],
                summary: '读取头像状态',
                description: '读取当前账号头像版本及部署是否启用上传，不返回图床密钥或对象路径。',
            },
        })
        .put('', ({ request, query }) => handlers.upload(request, query), {
            parse: 'none',
            query: 'AvatarVersionQuery',
            response: { 200: 'AvatarSessionResponse', ...errors },
            detail: {
                operationId: 'uploadAvatar',
                tags: ['账号'],
                summary: '上传或替换账号头像',
                description:
                    '要求本人会话、Origin和CSRF；原始图片请求体最多5MiB，按预期版本原子替换，解码裁剪为256像素WebP并移除元信息。',
                requestBody: {
                    required: true,
                    content: Object.fromEntries(
                        ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].map((type) => [
                            type,
                            {
                                schema: {
                                    type: 'string',
                                    format: 'binary',
                                    description: '原始图片字节，最多5MiB',
                                },
                            },
                        ]),
                    ),
                },
            },
        })
        .delete('', ({ request, query }) => handlers.remove(request, query), {
            query: 'AvatarVersionQuery',
            response: { 200: 'AvatarSessionResponse', ...errors },
            detail: {
                operationId: 'removeAvatar',
                tags: ['账号'],
                summary: '移除账号头像',
                description: '要求本人会话、Origin和CSRF，按预期版本清除头像引用并尝试清理旧对象。',
            },
        })
        .get('/:version', ({ request, params }) => handlers.image(request, params.version), {
            params: t.Object({ version: UuidSchema }),
            response: { 302: t.Any(), ...errors },
            detail: {
                operationId: 'getAvatarImage',
                tags: ['账号'],
                summary: '读取当前头像图片',
                description:
                    '仅允许当前会话读取本人当前头像版本；重定向至五分钟有效的私有图床签名地址，响应不缓存。',
            },
        });
}
