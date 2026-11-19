import { computed, toValue, type MaybeRefOrGetter } from 'vue';
import { useInfiniteQuery } from '@tanstack/vue-query';
import { InvalidResponseError } from 'requestlane';
import { UuidSchema, parseContract, type Run, type RunListResponseSchema } from '@scova/models';
import type { ApiResponse } from '@/api/client';
import type { SessionLifecycle } from '@/api/session';
import { toApiError } from '@/api/errors';
import { taskKeys, taskRunsEndpoint } from '@/api/tasks';
import { useSessionLifecycle } from '@/composable/useSessionQuery';

type RunPage = ApiResponse<typeof RunListResponseSchema.static>;
export function validHistoryTaskId(value: unknown): value is string {
    try {
        parseContract(UuidSchema, value);
        return true;
    } catch {
        return false;
    }
}

export function taskRunHistoryOptions(lifecycle: SessionLifecycle, taskId: string) {
    const scope = lifecycle.capture();
    return {
        queryKey: scope.queryKey([...taskKeys.runs(taskId), 'history']),
        enabled: !!scope.accountId && validHistoryTaskId(taskId),
        initialPageParam: undefined as string | undefined,
        queryFn: async ({
            signal,
            pageParam,
        }: {
            signal: AbortSignal;
            pageParam: string | undefined;
        }) => {
            const response = await scope.request(
                taskRunsEndpoint,
                {
                    params: { taskId },
                    query: { limit: 20, ...(pageParam ? { cursor: pageParam } : {}) },
                },
                { signal },
            );
            if (response.data.items.some((run) => run.taskId !== taskId))
                throw new InvalidResponseError('执行历史与当前任务不一致');
            return response;
        },
        getNextPageParam: (last: RunPage, pages: RunPage[]) => {
            const next = last.data.nextCursor;
            return next && !pages.slice(0, -1).some((page) => page.data.nextCursor === next)
                ? next
                : undefined;
        },
    };
}

export function useTaskRunHistory(
    taskId: MaybeRefOrGetter<string>,
    lifecycle: SessionLifecycle = useSessionLifecycle(),
) {
    const query = useInfiniteQuery(
        computed(() => taskRunHistoryOptions(lifecycle, toValue(taskId))),
        lifecycle.queryClient,
    );
    const items = computed(() => {
        const error = query.error.value ? toApiError(query.error.value) : undefined;
        if (
            !lifecycle.session.user ||
            [401, 403, 404].includes(error?.status ?? 0) ||
            error?.kind === 'validation' ||
            error?.kind === 'protocol'
        )
            return [];
        const unique = new Map<string, Run>();
        for (const page of query.data.value?.pages ?? [])
            for (const run of page.data.items)
                if (run.taskId === toValue(taskId) && !unique.has(run.id)) unique.set(run.id, run);
        return [...unique.values()];
    });
    return { query, items };
}
