import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import {
    LoginInputSchema,
    PageQuerySchema,
    SessionResponseSchema,
    UuidSchema,
    parseContract,
    type LoginInput,
    type PageQuery,
    type SessionResponse,
} from '@scova/models';
import { defineEndpoint } from 'requestlane';
import { createApi } from '@/api/client';
import {
    currentSessionEndpoint,
    defineApiEndpoint,
    loginEndpoint,
    logoutEndpoint,
    updatePreferencesEndpoint,
} from '@/api/endpoints';
import { ApiRequestError } from '@/api/errors';
import { modelValidator, voidValidator } from '@/api/validator';

const session: SessionResponse = {
    user: {
        id: '00000000-0000-4000-8000-000000000001',
        email: 'test@example.org',
        preferences: {
            defaultTimezone: 'Asia/Shanghai',
            notificationPreference: { mode: 'summary', runIssues: true },
        },
        createdAt: '2026-10-30T00:00:00Z',
    },
    csrfToken: 'test-csrf-value',
};
const login: LoginInput = { email: 'test@example.org', password: 'password' };
const commandKey = 'user-action-stable-0001';
const clients: ReturnType<typeof createApi>[] = [];

function setup(fetcher = vi.fn<typeof fetch>(async () => Response.json(session))) {
    const api = createApi({ fetcher });
    clients.push(api);
    return { api, fetcher };
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

afterEach(() => {
    for (const api of clients.splice(0)) api.dispose();
    vi.useRealTimers();
});

describe('requestlane HTTP 契约', () => {
    it('读取使用同源 Cookie、identity JSON 与真实响应元信息', async () => {
        const { api, fetcher } = setup(
            vi.fn<typeof fetch>(async () =>
                Response.json(session, { status: 200, headers: { ETag: '"3"' } }),
            ),
        );
        const result = await api.request(currentSessionEndpoint, {});
        expect(result.data).toEqual(session);
        expect(result.status).toBe(200);
        expect(result.headers.etag).toBe('"3"');
        expect(fetcher).toHaveBeenCalledTimes(1);
        const [url, init] = fetcher.mock.calls[0]!;
        expect(url).toBe('/api/v1/me');
        expect(init).toMatchObject({
            method: 'GET',
            credentials: 'same-origin',
            cache: 'no-store',
        });
        expect(new Headers(init?.headers).get('authorization')).toBeNull();
        expect(new Headers(init?.headers).get('cookie')).toBeNull();
        expect(new Headers(init?.headers).get('x-csrf-token')).toBeNull();
    });

    it('登录无需已有 CSRF，body 使用普通 JSON，共享 schema 保持真实契约', async () => {
        parseContract(LoginInputSchema, login);
        parseContract(SessionResponseSchema, session);
        const { api, fetcher } = setup();
        await api.request(loginEndpoint, { body: login });
        const [url, init] = fetcher.mock.calls[0]!;
        expect(url).toBe('/api/v1/auth/login');
        if (typeof init?.body !== 'string') throw new Error('Expected JSON string body');
        expect(JSON.parse(init.body)).toEqual(login);
        expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
        expect(new Headers(init?.headers).has('x-csrf-token')).toBe(false);
    });

    it('认证写集中注入 CSRF、幂等键和带引号的 If-Match', async () => {
        const { api, fetcher } = setup();
        await api.request(
            updatePreferencesEndpoint,
            { body: { defaultTimezone: 'Asia/Tokyo' } },
            { csrfToken: session.csrfToken, idempotencyKey: commandKey, ifMatch: '"42"' },
        );
        const headers = new Headers(fetcher.mock.calls[0]![1]?.headers);
        expect(headers.get('x-csrf-token')).toBe(session.csrfToken);
        expect(headers.get('idempotency-key')).toBe(commandKey);
        expect(headers.get('if-match')).toBe('"42"');
    });

    it('缺少 CSRF 在网络派发前拒绝', async () => {
        const { api, fetcher } = setup();
        await expect(api.request(logoutEndpoint, {})).rejects.toMatchObject({ status: undefined });
        expect(fetcher).not.toHaveBeenCalled();
    });

    it.each([
        { idempotencyKey: 'short' },
        { idempotencyKey: 'user-action with spaces' },
        { ifMatch: '42' },
        { ifMatch: 'W/"42"' },
    ])('非法命令头零派发并保留字段定位 %j', async (options) => {
        const { api, fetcher } = setup();
        await expect(
            api.request(logoutEndpoint, {}, { csrfToken: session.csrfToken, ...options }),
        ).rejects.toMatchObject({ kind: 'validation', fieldErrors: expect.any(Array) });
        expect(fetcher).not.toHaveBeenCalled();
    });

    it('非法 body 使用 models 错误定位且零派发', async () => {
        const { api, fetcher } = setup();
        await expect(
            api.request(loginEndpoint, { body: { email: 'invalid', password: 'password' } }),
        ).rejects.toMatchObject({
            kind: 'validation',
            fieldErrors: [{ path: '/email', message: expect.any(String) }],
        });
        expect(fetcher).not.toHaveBeenCalled();
    });

    it('非法 params 在发送前校验，合法路径参数正确编码', async () => {
        const { api, fetcher } = setup();
        const endpoint = defineApiEndpoint<{ params: { id: string }; data: SessionResponse }>({
            method: 'GET',
            path: '/items/:id',
            inputValidators: {
                params: {
                    parse: (value) => ({
                        id: parseContract(UuidSchema, (value as { id: string }).id),
                    }),
                },
            },
            validator: modelValidator(SessionResponseSchema),
        });
        await expect(api.request(endpoint, { params: { id: 'invalid' } })).rejects.toMatchObject({
            kind: 'validation',
        });
        expect(fetcher).not.toHaveBeenCalled();
        await api.request(endpoint, { params: { id: session.user.id } });
        expect(fetcher.mock.calls[0]![0]).toBe(`/api/v1/items/${session.user.id}`);
    });

    it('非法 query 零派发，合法 query 经过共享 schema 序列化', async () => {
        const { api, fetcher } = setup();
        const endpoint = defineApiEndpoint<{ query: PageQuery; data: SessionResponse }>({
            method: 'GET',
            path: '/items',
            inputValidators: { query: modelValidator(PageQuerySchema) },
            validator: modelValidator(SessionResponseSchema),
        });
        await expect(api.request(endpoint, { query: { limit: 0 } })).rejects.toMatchObject({
            kind: 'validation',
        });
        expect(fetcher).not.toHaveBeenCalled();
        await api.request(endpoint, { query: { cursor: 'a/b +', limit: 10 } });
        expect(fetcher.mock.calls[0]![0]).toBe('/api/v1/items?cursor=a%2Fb+%2B&limit=10');
    });

    it('非法输出保留实际成功状态与追踪头，并拒绝当作有效数据', async () => {
        const { api } = setup(
            vi.fn<typeof fetch>(async () =>
                Response.json({ user: null }, { headers: { 'x-request-id': 'output-check' } }),
            ),
        );
        await expect(api.request(currentSessionEndpoint, {})).rejects.toMatchObject({
            kind: 'validation',
            status: 200,
            requestId: 'output-check',
            fieldErrors: expect.any(Array),
        });
    });

    it.each([401, 403, 409, 429])('HTTP %i 保留完整标准错误体与真实状态', async (status) => {
        const body = {
            code: `ERROR_${status}`,
            message: '服务端明确说明',
            requestId: 'server-request-id',
            fieldErrors: [{ path: '/config/title', message: '字段说明' }],
        };
        const { api, fetcher } = setup(
            vi.fn<typeof fetch>(async () => Response.json(body, { status })),
        );
        await expect(api.request(currentSessionEndpoint, {})).rejects.toMatchObject({
            ...body,
            status,
            kind: 'http',
            retryable: status === 429,
        });
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('非标准错误体仍保留 HTTP 状态和追踪头，不伪造字段错误', async () => {
        const { api } = setup(
            vi.fn<typeof fetch>(
                async () =>
                    new Response('proxy unavailable', {
                        status: 503,
                        headers: { 'x-request-id': 'proxy-id' },
                    }),
            ),
        );
        await expect(api.request(currentSessionEndpoint, {})).rejects.toMatchObject({
            status: 503,
            kind: 'http',
            requestId: 'proxy-id',
            fieldErrors: undefined,
        });
    });

    it('204 保持无 body 和实际状态', async () => {
        const { api } = setup(vi.fn<typeof fetch>(async () => new Response(null, { status: 204 })));
        const result = await api.request(logoutEndpoint, {}, { csrfToken: session.csrfToken });
        expect(result.status).toBe(204);
        expect(result.data).toBeUndefined();
    });

    it('写请求网络失败不自动重试，调用方重发复用同一动作的 key', async () => {
        const fetcher = vi
            .fn<typeof fetch>()
            .mockRejectedValueOnce(new TypeError('network disconnected'))
            .mockResolvedValueOnce(Response.json(session));
        const { api } = setup(fetcher);
        const options = { csrfToken: session.csrfToken, idempotencyKey: commandKey };
        const input = { body: { defaultTimezone: 'Asia/Tokyo' } };
        await expect(api.request(updatePreferencesEndpoint, input, options)).rejects.toMatchObject({
            kind: 'network',
        });
        expect(fetcher).toHaveBeenCalledTimes(1);
        await api.request(updatePreferencesEndpoint, input, options);
        expect(fetcher).toHaveBeenCalledTimes(2);
        for (const [, init] of fetcher.mock.calls)
            expect(new Headers(init?.headers).get('idempotency-key')).toBe(commandKey);
    });

    it('重复读取和显式 cache:true 端点仍不缓存服务端结果', async () => {
        const { api, fetcher } = setup();
        const endpoint = defineEndpoint<{ data: SessionResponse }>({
            method: 'GET',
            path: '/me',
            cache: true,
            validator: modelValidator(SessionResponseSchema),
        });
        await api.request(endpoint, {});
        await api.request(endpoint, {});
        expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it('拒绝外站、协议相对地址和路径穿越', async () => {
        const { api, fetcher } = setup();
        for (const path of [
            'https://example.org',
            '//example.org/me',
            '/../me',
            '/foo/../me',
            '/%2e%2e/me',
        ]) {
            const endpoint = defineEndpoint<{ data: SessionResponse }>({
                method: 'GET',
                path,
                validator: modelValidator(SessionResponseSchema),
            });
            await expect(api.request(endpoint, {})).rejects.toBeInstanceOf(ApiRequestError);
        }
        expect(fetcher).not.toHaveBeenCalled();
    });

    it('未配置输入或响应校验器的端点不发送', async () => {
        const { api, fetcher } = setup();
        const missingOutput = defineEndpoint<{ data: unknown }>({ method: 'GET', path: '/me' });
        await expect(api.request(missingOutput, {})).rejects.toBeInstanceOf(ApiRequestError);
        const missingInput = defineEndpoint<{ body: LoginInput; data: SessionResponse }>({
            method: 'POST',
            path: '/auth/login',
            anonymous: true,
            validator: modelValidator(SessionResponseSchema),
        });
        await expect(api.request(missingInput, { body: login })).rejects.toBeInstanceOf(
            ApiRequestError,
        );
        expect(fetcher).not.toHaveBeenCalled();
    });

    it('native 与 JSON 客户端共用注入的 fetcher，返回原始 Response 流', async () => {
        const fetcher = vi.fn<typeof fetch>(async (_input, init) =>
            init?.headers && new Headers(init.headers).get('accept') === 'text/event-stream'
                ? new Response('data: test\n\n', {
                      headers: { 'content-type': 'text/event-stream' },
                  })
                : Response.json(session),
        );
        const { api } = setup(fetcher);
        await api.request(currentSessionEndpoint, {});
        const controller = new AbortController();
        const response = await api.transport.native('/api/v1/runs/example/events', {
            credentials: 'same-origin',
            signal: controller.signal,
            headers: { accept: 'text/event-stream' },
        });
        expect(response).toBeInstanceOf(Response);
        expect(response.body).toBeInstanceOf(ReadableStream);
        expect(await response.text()).toBe('data: test\n\n');
        expect(fetcher).toHaveBeenCalledTimes(2);
        expect(fetcher.mock.calls[1]![1]?.signal).toBe(controller.signal);
    });

    it('void validator 拒绝非空响应', () => {
        expect(() => voidValidator.parse({})).toThrow('预期无响应体');
    });
});

describe('requestlane 取消与生命周期', () => {
    it('预先取消时零派发且保留可识别的 AbortError', async () => {
        const { api, fetcher } = setup();
        await expect(
            api.request(currentSessionEndpoint, {}, { signal: AbortSignal.abort('stopped') }),
        ).rejects.toMatchObject({ name: 'AbortError', kind: 'cancelled', retryable: false });
        expect(fetcher).not.toHaveBeenCalled();
    });

    it('中途取消及时结束，即使 fetcher 忽略信号', async () => {
        const started = deferred<void>();
        const late = deferred<Response>();
        const { api, fetcher } = setup(
            vi.fn<typeof fetch>(async () => {
                started.resolve();
                return late.promise;
            }),
        );
        const controller = new AbortController();
        const pending = api.request(currentSessionEndpoint, {}, { signal: controller.signal });
        const rejected = expect(pending).rejects.toMatchObject({
            name: 'AbortError',
            kind: 'cancelled',
        });
        await started.promise;
        controller.abort();
        await rejected;
        expect(fetcher.mock.calls[0]![1]?.signal?.aborted).toBe(true);
        late.resolve(Response.json(session));
    });

    it('dispose 取消等待中的响应校验，后续请求零派发', async () => {
        const started = deferred<void>();
        const late = deferred<SessionResponse>();
        const { api, fetcher } = setup();
        const endpoint = defineApiEndpoint<{ data: SessionResponse }>({
            method: 'GET',
            path: '/me',
            validator: {
                parse: async () => {
                    started.resolve();
                    return late.promise;
                },
            },
        });
        const pending = api.request(endpoint, {});
        const rejected = expect(pending).rejects.toMatchObject({ kind: 'cancelled' });
        await started.promise;
        api.dispose();
        await rejected;
        await expect(api.request(currentSessionEndpoint, {})).rejects.toMatchObject({
            kind: 'cancelled',
        });
        expect(fetcher).toHaveBeenCalledTimes(1);
        late.resolve(session);
    });

    it('取消等待中的异步输入校验不会迟到派发', async () => {
        const started = deferred<void>();
        const late = deferred<LoginInput>();
        const { api, fetcher } = setup();
        const endpoint = defineApiEndpoint<{ body: LoginInput; data: SessionResponse }>({
            method: 'POST',
            path: '/auth/login',
            anonymous: true,
            inputValidators: {
                body: {
                    parse: async () => {
                        started.resolve();
                        return late.promise;
                    },
                },
            },
            validator: modelValidator(SessionResponseSchema),
        });
        const controller = new AbortController();
        const pending = api.request(endpoint, { body: login }, { signal: controller.signal });
        const rejected = expect(pending).rejects.toMatchObject({ kind: 'cancelled' });
        await started.promise;
        controller.abort();
        await rejected;
        late.resolve(login);
        await Promise.resolve();
        expect(fetcher).not.toHaveBeenCalled();
    });

    it('端点超时覆盖整个调用并保持 timeout 分类', async () => {
        vi.useFakeTimers();
        const { api } = setup(vi.fn<typeof fetch>(async () => new Promise<Response>(() => {})));
        const endpoint = defineApiEndpoint<{ data: SessionResponse }>({
            method: 'GET',
            path: '/me',
            timeout: 20,
            validator: modelValidator(SessionResponseSchema),
        });
        const pending = api.request(endpoint, {});
        const rejected = expect(pending).rejects.toMatchObject({
            kind: 'timeout',
            retryable: true,
        });
        await vi.advanceTimersByTimeAsync(20);
        await rejected;
    });
});
