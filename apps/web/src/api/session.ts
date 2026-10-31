import { createPinia } from 'pinia';
import { reactive, readonly, toRef, type InjectionKey } from 'vue';
import { SessionResponseSchema, parseContract, type SessionResponse } from '@scova/models';
import { cancelled, type Endpoint, type EndpointInput, type EndpointSpec } from 'requestlane';
import type { Fetcher } from 'requestlane/fetch';
import { createApi, type ApiRequestOptions } from '@/api/client';
import { ApiRequestError, toApiError } from '@/api/errors';
import { createQueryClient } from '@/api/query';
import { useSessionStore } from '@/store/session';

export function createSessionLifecycle(
    options: {
        fetcher?: Fetcher;
        onError?: (error: unknown) => void;
    } = {},
) {
    const pinia = createPinia();
    const store = useSessionStore(pinia);
    const queryClient = createQueryClient(options.onError);
    let api = createApi({ fetcher: options.fetcher });
    let csrfToken: string | undefined;
    let controller = new AbortController();
    let cleanups = new Set<() => void>();
    let disposed = false;

    const staleError = () => toApiError(cancelled());

    function replaceSession(session: SessionResponse | null) {
        if (disposed) throw staleError();
        if (session) parseContract(SessionResponseSchema, session);
        // 先推进代次，令同步清理回调和所有迟到 continuation 立即失去旧身份。
        store.advance();
        controller.abort();
        void queryClient.cancelQueries();
        api.dispose();
        const previousCleanups = cleanups;
        cleanups = new Set();
        for (const cleanup of previousCleanups) {
            try {
                cleanup();
            } catch {
                // 一个订阅清理失败不能阻止其他订阅或账号缓存释放。
            }
        }
        queryClient.clear();
        csrfToken = session?.csrfToken;
        controller = new AbortController();
        api = createApi({ fetcher: options.fetcher });
        store.install(session?.user ?? null);
    }

    function capture() {
        const epoch = store.epoch;
        const accountId = store.user?.id ?? null;
        const currentApi = api;
        const currentController = controller;
        const currentCsrf = csrfToken;
        const currentCleanups = cleanups;
        const isCurrent = () => !disposed && store.epoch === epoch;
        const assertCurrent = () => {
            if (!isCurrent()) throw staleError();
        };

        return {
            epoch,
            accountId,
            signal: currentController.signal,
            transport: currentApi.transport,
            isCurrent,
            replaceSession(session: SessionResponse | null) {
                assertCurrent();
                replaceSession(session);
            },
            queryKey(key: readonly unknown[]) {
                return ['session', accountId, epoch, ...key] as const;
            },
            registerCleanup(cleanup: () => void) {
                if (!isCurrent()) {
                    cleanup();
                    return () => {};
                }
                currentCleanups.add(cleanup);
                return () => currentCleanups.delete(cleanup);
            },
            async request<S extends EndpointSpec>(
                endpoint: Endpoint<S>,
                input: EndpointInput<S>,
                requestOptions: Omit<ApiRequestOptions, 'csrfToken'> = {},
            ) {
                assertCurrent();
                try {
                    const response = await currentApi.request(endpoint, input, {
                        ...requestOptions,
                        csrfToken: currentCsrf,
                        signal: AbortSignal.any([
                            currentController.signal,
                            ...(requestOptions.signal ? [requestOptions.signal] : []),
                        ]),
                    });
                    assertCurrent();
                    return response;
                } catch (error) {
                    assertCurrent();
                    if (
                        !endpoint.options.anonymous &&
                        error instanceof ApiRequestError &&
                        error.status === 401
                    )
                        replaceSession(null);
                    throw error;
                }
            },
        };
    }

    function queryOptions<S extends EndpointSpec>(
        endpoint: Endpoint<S>,
        input: EndpointInput<S>,
        key: readonly unknown[] = [],
    ) {
        const scope = capture();
        if (endpoint.options.method !== 'GET') throw new TypeError('Query 只用于读取端点');
        return {
            queryKey: scope.queryKey([...key, endpoint.identity, input]),
            enabled: scope.accountId !== null,
            queryFn: async ({ signal }: { signal: AbortSignal }) =>
                scope.request(endpoint, input, { signal }),
        };
    }

    function dispose() {
        if (disposed) return;
        replaceSession(null);
        disposed = true;
        controller.abort();
        api.dispose();
        queryClient.clear();
    }

    return {
        pinia,
        session: readonly(reactive({ epoch: toRef(store, 'epoch'), user: toRef(store, 'user') })),
        queryClient,
        replaceSession,
        capture,
        queryOptions,
        dispose,
    };
}

export type SessionLifecycle = ReturnType<typeof createSessionLifecycle>;
export const sessionLifecycleKey: InjectionKey<SessionLifecycle> = Symbol('session-lifecycle');
