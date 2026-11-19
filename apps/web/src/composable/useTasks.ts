import { computed, toValue, watch, type MaybeRefOrGetter } from 'vue';
import { useInfiniteQuery } from '@tanstack/vue-query';
import type { Task, TaskListResponse } from '@scova/models';
import type { ApiResponse } from '@/api/client';
import type { SessionLifecycle } from '@/api/session';
import { tasksEndpoint, taskKeys } from '@/api/tasks';
import { useSessionLifecycle } from '@/composable/useSessionQuery';

export const taskFilters = [
    { value: 'active', label: '已启用' },
    { value: 'paused', label: '暂停' },
    { value: 'archived', label: '归档' },
    { value: 'all', label: '全部' },
] as const;
export type TaskFilter = (typeof taskFilters)[number]['value'];
export const readTaskFilter = (value: unknown): TaskFilter =>
    taskFilters.find((item) => item.value === value)?.value ?? 'active';

export function visibleTasks(
    pages: ApiResponse<TaskListResponse>[] | undefined,
    filter: TaskFilter,
) {
    const unique = new Map<string, Task>();
    for (const page of pages ?? [])
        for (const task of page.data.items) if (!unique.has(task.id)) unique.set(task.id, task);
    return [...unique.values()].filter((task) => filter === 'all' || task.status === filter);
}

export function taskListOptions(lifecycle: SessionLifecycle, filter: TaskFilter) {
    const scope = lifecycle.capture();
    return {
        queryKey: scope.queryKey(taskKeys.list(filter)),
        enabled: scope.accountId !== null,
        initialPageParam: undefined as string | undefined,
        queryFn: ({ signal, pageParam }: { signal: AbortSignal; pageParam: string | undefined }) =>
            scope.request(
                tasksEndpoint,
                {
                    query: { limit: 20, ...(pageParam ? { cursor: pageParam } : {}) },
                },
                { signal },
            ),
        getNextPageParam: (
            last: ApiResponse<TaskListResponse>,
            pages: ApiResponse<TaskListResponse>[],
        ) => {
            const next = last.data.nextCursor;
            // 服务端重复游标不应让“加载更多”无限追加相同页。
            return next && !pages.slice(0, -1).some((page) => page.data.nextCursor === next)
                ? next
                : undefined;
        },
    };
}

export function useTasks(
    filter: MaybeRefOrGetter<TaskFilter>,
    lifecycle: SessionLifecycle = useSessionLifecycle(),
    enabled: MaybeRefOrGetter<boolean> = true,
) {
    const query = useInfiniteQuery(
        computed(() => ({
            ...taskListOptions(lifecycle, toValue(filter)),
            enabled: toValue(enabled) && !!lifecycle.session.user,
        })),
        lifecycle.queryClient,
    );
    const items = computed(() => visibleTasks(query.data.value?.pages, toValue(filter)));
    watch(
        () => toValue(enabled),
        (value) => {
            if (!value)
                void lifecycle.queryClient.cancelQueries({
                    queryKey: taskListOptions(lifecycle, toValue(filter)).queryKey,
                    exact: true,
                });
        },
    );
    return { query, items };
}

export function localTaskTime(
    instant: string,
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone,
) {
    return new Intl.DateTimeFormat('zh-CN', {
        timeZone: timezone,
        dateStyle: 'medium',
        timeStyle: 'short',
    }).format(new Date(instant));
}
