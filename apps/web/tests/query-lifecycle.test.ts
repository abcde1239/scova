import { deferred } from './support/deferred';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { effectScope, nextTick } from 'vue';
import { MutationObserver, QueryObserver } from '@tanstack/vue-query';
import type { SessionResponse } from '@scova/models';
import { currentSessionEndpoint, loginEndpoint, updatePreferencesEndpoint } from '@/api/endpoints';
import { createSessionLifecycle } from '@/api/session';
import { useSessionMutation, useSessionQuery } from '@/composable/useSessionQuery';

const accountA: SessionResponse = {
    user: {
        id: '00000000-0000-4000-8000-000000000001',
        email: 'a@example.org',
        preferences: {
            defaultTimezone: 'Asia/Shanghai',
            notificationPreference: { mode: 'summary', runIssues: true },
        },
        createdAt: '2026-10-30T00:00:00Z',
    },
    csrfToken: 'csrf-a',
};
const accountB: SessionResponse = {
    ...accountA,
    user: { ...accountA.user, id: '00000000-0000-4000-8000-000000000002', email: 'b@example.org' },
    csrfToken: 'csrf-b',
};

const lifecycles: ReturnType<typeof createSessionLifecycle>[] = [];
function setup(fetcher: typeof fetch = async () => Response.json(accountB)) {
    const onError = vi.fn();
    const lifecycle = createSessionLifecycle({ fetcher, onError });
    lifecycles.push(lifecycle);
    return { lifecycle, onError };
}

afterEach(() => {
    for (const lifecycle of lifecycles.splice(0)) lifecycle.dispose();
});

describe('Query 与会话生命周期', () => {
    it.each([200, 401])('A 的迟到 %i 不改变退出后安装的 B', async (status) => {
        const pending = deferred<Response>();
        const dispatched = deferred<AbortSignal>();
        const fetcher = vi
            .fn<typeof fetch>()
            .mockImplementationOnce(async (_url, init) => {
                dispatched.resolve(init!.signal!);
                return pending.promise; // 故意忽略 abort，验证旧返回仍被屏蔽。
            })
            .mockImplementation(async () => Response.json(accountB));
        const { lifecycle, onError } = setup(fetcher);
        lifecycle.replaceSession(accountA);
        const aScope = lifecycle.capture();
        const aQuery = lifecycle.queryOptions(currentSessionEndpoint, {});
        const aResult = lifecycle.queryClient.fetchQuery(aQuery).catch((error: unknown) => error);
        const signal = await dispatched.promise;
        const cleanup = vi.fn();
        aScope.registerCleanup(cleanup);
        lifecycle.replaceSession(null);
        lifecycle.replaceSession(accountB);
        const bQuery = lifecycle.queryOptions(currentSessionEndpoint, {});
        await lifecycle.queryClient.fetchQuery(bQuery);
        pending.resolve(
            status === 200
                ? Response.json(accountA)
                : Response.json(
                      {
                          code: 'UNAUTHORIZED',
                          message: '旧会话失效',
                          requestId: 'old-a',
                      },
                      { status },
                  ),
        );
        await aResult;
        await nextTick();
        expect(signal.aborted).toBe(true);
        expect(cleanup).toHaveBeenCalledTimes(1);
        expect(aScope.isCurrent()).toBe(false);
        expect(lifecycle.session.user?.id).toBe(accountB.user.id);
        expect(lifecycle.queryClient.getQueryData(aQuery.queryKey)).toBeUndefined();
        expect(lifecycle.queryClient.getQueryData(bQuery.queryKey)).toMatchObject({
            data: accountB,
        });
        expect(lifecycle.queryClient.getQueryCache().getAll()).toHaveLength(1);
        expect(onError).not.toHaveBeenCalled();
        expect(() => aScope.replaceSession(accountA)).toThrow();
    });

    it('当前会话 401 清除会话和缓存，登录失败不撤销当前账号', async () => {
        const fetcher = vi.fn<typeof fetch>(async () =>
            Response.json(
                {
                    code: 'UNAUTHORIZED',
                    message: '会话失效',
                    requestId: 'current',
                },
                { status: 401 },
            ),
        );
        const { lifecycle } = setup(fetcher);
        lifecycle.replaceSession(accountA);
        await expect(
            lifecycle.capture().request(loginEndpoint, {
                body: { email: 'a@example.org', password: 'bad' },
            }),
        ).rejects.toMatchObject({ status: 401 });
        expect(lifecycle.session.user?.id).toBe(accountA.user.id);
        await expect(lifecycle.capture().request(currentSessionEndpoint, {})).rejects.toMatchObject(
            { status: 401 },
        );
        expect(lifecycle.session.user).toBeNull();
        expect(lifecycle.queryClient.getQueryCache().getAll()).toHaveLength(0);
    });

    it('切换清理全部注册流，即使一个清理抛错；旧注册立即清理', () => {
        const { lifecycle } = setup();
        lifecycle.replaceSession(accountA);
        const scope = lifecycle.capture();
        const cleanup = vi.fn();
        const removed = vi.fn();
        scope.registerCleanup(() => {
            throw new Error('cleanup failed');
        });
        scope.registerCleanup(cleanup);
        scope.registerCleanup(removed)();
        lifecycle.replaceSession(accountB);
        const late = vi.fn();
        scope.registerCleanup(late);
        expect(scope.signal.aborted).toBe(true);
        expect(cleanup).toHaveBeenCalledTimes(1);
        expect(removed).not.toHaveBeenCalled();
        expect(late).toHaveBeenCalledTimes(1);
    });

    it('新客户端注入新 CSRF，旧作用域不能再次派发请求', async () => {
        const fetcher = vi.fn<typeof fetch>(async () => Response.json(accountB));
        const { lifecycle } = setup(fetcher);
        lifecycle.replaceSession(accountA);
        const aScope = lifecycle.capture();
        lifecycle.replaceSession(accountB);
        await expect(aScope.request(currentSessionEndpoint, {})).rejects.toMatchObject({
            kind: 'cancelled',
        });
        await lifecycle.capture().request(updatePreferencesEndpoint, {
            body: { defaultTimezone: 'UTC' },
        });
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(new Headers(fetcher.mock.calls[0]![1]?.headers).get('x-csrf-token')).toBe('csrf-b');
        expect(lifecycle.session).not.toHaveProperty('csrfToken');
    });

    it('卸载查询中止旧请求且不报告失败提示', async () => {
        const dispatched = deferred<AbortSignal>();
        const { lifecycle, onError } = setup(async (_url, init) => {
            dispatched.resolve(init!.signal!);
            return new Promise<Response>(() => {});
        });
        lifecycle.replaceSession(accountA);
        const scope = effectScope();
        scope.run(() => useSessionQuery(currentSessionEndpoint, {}, [], lifecycle));
        const signal = await dispatched.promise;
        scope.stop();
        await nextTick();
        expect(signal.aborted).toBe(true);
        expect(onError).not.toHaveBeenCalled();
    });

    it('在途 Mutation 换号后取消且不报告失败提示', async () => {
        const dispatched = deferred<AbortSignal>();
        const pending = deferred<Response>();
        const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
            dispatched.resolve(init!.signal!);
            return pending.promise;
        });
        const { lifecycle, onError } = setup(fetcher);
        lifecycle.replaceSession(accountA);
        const effect = effectScope();
        const mutation = effect.run(() =>
            useSessionMutation(updatePreferencesEndpoint, lifecycle),
        )!;
        const result = mutation
            .mutateAsync({
                input: { body: { defaultTimezone: 'UTC' } },
            })
            .catch((error: unknown) => error);
        const signal = await dispatched.promise;
        lifecycle.replaceSession(accountB);
        pending.resolve(Response.json(accountA));
        expect(await result).toMatchObject({ kind: 'cancelled' });
        expect(signal.aborted).toBe(true);
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(onError).not.toHaveBeenCalled();
        expect(lifecycle.session.user?.id).toBe(accountB.user.id);
        effect.stop();
    });

    it('活跃 useQuery 随账号切换，旧数据立即移除', async () => {
        let current = accountA;
        const { lifecycle } = setup(async () => Response.json(current));
        lifecycle.replaceSession(accountA);
        const effect = effectScope();
        const query = effect.run(() => useSessionQuery(currentSessionEndpoint, {}, [], lifecycle))!;
        await query.refetch();
        expect(query.data.value?.data.user.id).toBe(accountA.user.id);
        current = accountB;
        lifecycle.replaceSession(accountB);
        await nextTick();
        expect(query.data.value?.data.user.id).not.toBe(accountA.user.id);
        await query.refetch();
        expect(query.data.value?.data.user.id).toBe(accountB.user.id);
        effect.stop();
    });

    it('Mutation 默认只派发一次，显式失效只刷新一次活跃查询', async () => {
        const fetcher = vi.fn<typeof fetch>(async () => Response.json(accountB));
        const { lifecycle, onError } = setup(fetcher);
        lifecycle.replaceSession(accountB);
        const mutationFn = vi.fn(async () => {
            throw new Error('write failed');
        });
        const mutation = new MutationObserver(lifecycle.queryClient, { mutationFn });
        await expect(mutation.mutate(undefined)).rejects.toThrow('write failed');
        expect(mutationFn).toHaveBeenCalledTimes(1);
        expect(onError).toHaveBeenCalledTimes(1);
        const query = lifecycle.queryOptions(currentSessionEndpoint, {});
        const observer = new QueryObserver(lifecycle.queryClient, query);
        const stop = observer.subscribe(() => {});
        await lifecycle.queryClient.fetchQuery(query);
        expect(fetcher).toHaveBeenCalledTimes(1);
        await lifecycle.queryClient.invalidateQueries({ queryKey: query.queryKey });
        expect(fetcher).toHaveBeenCalledTimes(2);
        await nextTick();
        expect(fetcher).toHaveBeenCalledTimes(2);
        stop();
    });

    it('dispose 幂等取消全部作用域并拒绝新请求', async () => {
        const { lifecycle } = setup();
        lifecycle.replaceSession(accountA);
        const scope = lifecycle.capture();
        const cleanup = vi.fn();
        scope.registerCleanup(cleanup);
        lifecycle.dispose();
        lifecycle.dispose();
        expect(cleanup).toHaveBeenCalledTimes(1);
        expect(scope.signal.aborted).toBe(true);
        await expect(lifecycle.capture().request(currentSessionEndpoint, {})).rejects.toMatchObject(
            { kind: 'cancelled' },
        );
    });
});
