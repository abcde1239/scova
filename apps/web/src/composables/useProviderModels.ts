import {
    computed,
    onScopeDispose,
    ref,
    shallowRef,
    watch,
    type MaybeRefOrGetter,
    toValue,
} from 'vue';
import type { AgentModelCatalog, AgentModelCatalogInput } from '@scova/models';
import { providerModelsEndpoint } from '@/api/agent-providers';
import { useSessionLifecycle } from '@/composables/useSessionQuery';
import { toApiError } from '@/api/errors';

/** 临时目录不进入 Query 缓存或存储，避免将未保存密钥放入缓存 key/Mutation variables。 */
export function useProviderModels(input: MaybeRefOrGetter<AgentModelCatalogInput>) {
    const lifecycle = useSessionLifecycle();
    const state = ref<'idle' | 'loading' | 'ready' | 'error'>('idle');
    const result = shallowRef<AgentModelCatalog>();
    const message = ref('');
    let generation = 0,
        controller: AbortController | undefined;
    function clear() {
        generation++;
        controller?.abort();
        result.value = undefined;
        message.value = '';
        state.value = 'idle';
    }
    watch(
        () => [
            toValue(input).baseUrl,
            toValue(input).protocol,
            toValue(input).apiKey,
            toValue(input).providerId,
            toValue(input).revision,
            lifecycle.session.epoch,
        ],
        clear,
        { flush: 'sync' },
    );
    onScopeDispose(clear);
    async function load() {
        if (state.value === 'loading' || !lifecycle.session.user) return;
        clear();
        const current = generation,
            scope = lifecycle.capture();
        controller = new AbortController();
        state.value = 'loading';
        try {
            const response = await scope.request(
                providerModelsEndpoint,
                { body: toValue(input) },
                {
                    signal: controller.signal,
                    timeout: 15_000,
                },
            );
            if (current !== generation || !scope.isCurrent()) return;
            result.value = response.data;
            state.value = 'ready';
        } catch (cause) {
            if (current !== generation || !scope.isCurrent()) return;
            const error = toApiError(cause);
            if (error.kind === 'cancelled') {
                state.value = 'idle';
                return;
            }
            message.value =
                error.code.startsWith('MODEL_') || error.code === 'PROVIDER_CONFLICT'
                    ? error.message
                    : '暂时无法读取模型列表，请检查连接后重试';
            state.value = 'error';
        }
    }
    return { state, result, message, load, loading: computed(() => state.value === 'loading') };
}
