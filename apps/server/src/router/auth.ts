import { Elysia } from 'elysia';
import {
    ApiErrorSchema,
    LoginInputSchema,
    RegisterInputSchema,
    SessionResponseSchema,
    UpdatePreferencesInputSchema,
} from '@scova/models';
import type { ApiServices } from '@/app/services';
import { createAuthHandlers } from '@/handler/auth.ts';

const errorResponses = {
    400: 'ApiError',
    401: 'ApiError',
    403: 'ApiError',
    409: 'ApiError',
    422: 'ApiError',
    429: 'ApiError',
    500: 'ApiError',
    503: 'ApiError',
} as const;

/** 账号相关的路由插件 */
export function createAuthPlugin(services: ApiServices) {
    const handlers = createAuthHandlers(services);
    return new Elysia({ name: 'scova-auth', prefix: '/api/v1', normalize: false })
        .model({
            ApiError: ApiErrorSchema,
            RegisterInput: RegisterInputSchema,
            LoginInput: LoginInputSchema,
            SessionResponse: SessionResponseSchema,
            UpdatePreferencesInput: UpdatePreferencesInputSchema,
        })
        .onBeforeHandle(({ set }) => {
            set.headers['cache-control'] = 'no-store';
        })
        .post(
            '/auth/register',
            async ({ body, request, set }) => {
                const response = await handlers.register(request, body);
                set.status = 201;
                set.headers['set-cookie'] = response.cookie;
                return response.body;
            },
            {
                body: 'RegisterInput',
                response: { 201: 'SessionResponse', ...errorResponses },
                detail: {
                    operationId: 'registerAccount',
                    tags: ['账号'],
                    summary: '邮箱密码注册',
                    description:
                        '同源注册并创建安全 Cookie 会话；密码以 Argon2id 哈希保存，不要求邮件服务。',
                },
            },
        )
        .post(
            '/auth/login',
            async ({ body, request, set }) => {
                const response = await handlers.login(request, body);
                set.headers['set-cookie'] = response.cookie;
                return response.body;
            },
            {
                body: 'LoginInput',
                response: { 200: 'SessionResponse', ...errorResponses },
                detail: {
                    operationId: 'loginAccount',
                    tags: ['账号'],
                    summary: '邮箱密码登录',
                    description:
                        '执行 Redis 跨实例限流；成功后更换随机会话 token，Cookie 不在响应 JSON 中返回。',
                },
            },
        )
        .post('/auth/logout', ({ request }) => handlers.logout(request), {
            detail: {
                operationId: 'logoutAccount',
                tags: ['账号'],
                summary: '注销当前会话',
                description: '要求同源 Origin 与 CSRF 校验，撤销持久化会话并清理 Cookie。',
                responses: { 204: { description: '会话已注销，无响应体' } },
            },
        })
        .get('/me', ({ request }) => handlers.me(request), {
            response: { 200: 'SessionResponse', ...errorResponses },
            detail: {
                operationId: 'getCurrentSession',
                tags: ['账号'],
                summary: '恢复当前会话',
                description: '返回当前用户及稳定 CSRF 值，不返回会话 token、密码哈希或内部记录。',
            },
        })
        .patch('/me/preferences', ({ body, request }) => handlers.preferences(request, body), {
            body: 'UpdatePreferencesInput',
            response: { 200: 'SessionResponse', ...errorResponses },
            detail: {
                operationId: 'updateCurrentPreferences',
                tags: ['账号'],
                summary: '修改默认时区与提醒偏好',
                description: '只修改当前账号默认设置，不追溯改变已保存任务配置版本。',
            },
        });
}
