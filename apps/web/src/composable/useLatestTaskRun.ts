import { computed, toValue, type MaybeRefOrGetter } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { InvalidResponseError } from 'requestlane';
import { type Run } from '@scova/models';
import { taskKeys, taskRunsEndpoint } from '@/api/tasks';
import { useSessionLifecycle } from '@/composable/useSessionQuery';

export function isActiveRun(run?: Run) {
    return !!run && ['queued', 'running', 'recovering', 'cancel_requested'].includes(run.status);
}

/** Summary and start controls share one server snapshot, including when returning from logs. */
export function useLatestTaskRun(
    taskId: MaybeRefOrGetter<string>,
    enabled: MaybeRefOrGetter<boolean> = true,
) {
    const lifecycle = useSessionLifecycle();
    const query = useQuery(
        computed(() => {
            const id = toValue(taskId);
            const options = lifecycle.queryOptions(
                taskRunsEndpoint,
                { params: { taskId: id }, query: { limit: 1 } },
                taskKeys.runs(id),
            );
            return {
                ...options,
                enabled: toValue(enabled) && !!lifecycle.session.user,
                staleTime: 0,
                refetchOnMount: 'always' as const,
                refetchInterval: (current: { state: { data?: { data: { items: Run[] } } } }) =>
                    isActiveRun(current.state.data?.data.items[0]) ? 3000 : false,
                async queryFn(context: { signal: AbortSignal }) {
                    const response = await options.queryFn(context);
                    if (response.data.items.some((run) => run.taskId !== id))
                        throw new InvalidResponseError('执行快照与当前任务不一致');
                    return response;
                },
            };
        }),
        lifecycle.queryClient,
    );
    const latest = computed(() =>
        toValue(enabled) && query.isSuccess.value ? query.data.value?.data.items[0] : undefined,
    );
    return { query, latest };
}
