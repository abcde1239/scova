import { useMutation, useQuery } from '@tanstack/vue-query';
import { computed, inject, toValue, type MaybeRefOrGetter } from 'vue';
import type { Endpoint, EndpointInput, EndpointSpec } from 'requestlane';
import { sessionLifecycleKey, type SessionLifecycle } from '@/api/session';
import type { ApiRequestOptions } from '@/api/client';

export function useSessionLifecycle() {
    const lifecycle = inject(sessionLifecycleKey);
    if (!lifecycle) throw new Error('尚未安装会话生命周期');
    return lifecycle;
}

/** 账号/epoch/input 同时进入 key，Vue Query 的取消 signal 进入统一 HTTP。 */
export function useSessionQuery<S extends EndpointSpec>(
    endpoint: Endpoint<S>,
    input: MaybeRefOrGetter<EndpointInput<S>>,
    key: MaybeRefOrGetter<readonly unknown[]> = [],
    lifecycle: SessionLifecycle = useSessionLifecycle(),
) {
    return useQuery(
        computed(() => lifecycle.queryOptions(endpoint, toValue(input), toValue(key))),
        lifecycle.queryClient,
    );
}

export interface SessionMutationInput<S extends EndpointSpec> {
    input: EndpointInput<S>;
    options?: Omit<ApiRequestOptions, 'csrfToken'>;
}

/** 命令同样绑定 epoch；调用方为同一用户动作复用 options.idempotencyKey。 */
export function useSessionMutation<S extends EndpointSpec>(
    endpoint: Endpoint<S>,
    lifecycle: SessionLifecycle = useSessionLifecycle(),
) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(endpoint.options.method))
        throw new TypeError('Mutation 只用于写入端点');
    return useMutation(
        computed(() => {
            const scope = lifecycle.capture();
            return {
                mutationKey: scope.queryKey([endpoint.identity]),
                retry: false,
                mutationFn: ({ input, options }: SessionMutationInput<S>) =>
                    scope.request(endpoint, input, options),
            };
        }),
        lifecycle.queryClient,
    );
}
