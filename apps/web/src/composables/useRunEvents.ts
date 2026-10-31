import { onScopeDispose, shallowRef, toValue, watch, type MaybeRefOrGetter } from 'vue';
import { subscribeRunEvents, type RunEventOptions } from '@/api/run-events';
import { useSessionLifecycle } from '@/composables/useSessionQuery';

/** 参数或会话代次变化释放旧流；页面只消费连接状态，不自行建立网络层。 */
export function useRunEvents(
    runId: MaybeRefOrGetter<string | undefined>,
    options: RunEventOptions = {},
) {
    const lifecycle = useSessionLifecycle();
    const subscription = shallowRef<ReturnType<typeof subscribeRunEvents>>();
    const stopWatch = watch(
        () => [toValue(runId), lifecycle.session.epoch] as const,
        ([id], _, cleanup) => {
            subscription.value = undefined;
            if (!id || !lifecycle.session.user) return;
            const active = subscribeRunEvents(lifecycle, id, options);
            subscription.value = active;
            cleanup(active.stop);
        },
        { immediate: true },
    );
    onScopeDispose(stopWatch);
    return subscription;
}
