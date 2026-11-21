import type { ProjectDetailResponse, ProjectListResponse } from '@scova/models';
import type { ApiResponse } from '@/api/client';
import { useInfiniteQuery } from '@tanstack/vue-query';
import { computed, toValue, type MaybeRefOrGetter } from 'vue';
import type { SessionLifecycle } from '@/api/session';
import { projectEndpoint, projectsEndpoint } from '@/api/projects';
import { useSessionLifecycle } from '@/composable/useSessionQuery';

type PageRequest = { signal: AbortSignal; pageParam: string | undefined };

const nextPage = (next: string | null, preceding: (string | null)[]) =>
    next && !preceding.includes(next) ? next : undefined;

export function useProjects(
    lifecycle = useSessionLifecycle(),
    enabled: MaybeRefOrGetter<boolean> = true,
) {
    const query = useInfiniteQuery(
        computed(() => {
            const scope = lifecycle.capture();
            return {
                queryKey: scope.queryKey(['projects', 'list']),
                enabled: scope.accountId !== null && toValue(enabled),
                initialPageParam: undefined as string | undefined,
                queryFn: ({ signal, pageParam }: PageRequest) =>
                    scope.request(
                        projectsEndpoint,
                        { query: { limit: 20, cursor: pageParam } },
                        { signal },
                    ),
                getNextPageParam: (
                    last: ApiResponse<ProjectListResponse>,
                    pages: ApiResponse<ProjectListResponse>[],
                ) =>
                    nextPage(
                        last.data.nextCursor,
                        pages.slice(0, -1).map((page) => page.data.nextCursor),
                    ),
            };
        }),
        lifecycle.queryClient,
    );
    const items = computed(() => query.data.value?.pages.flatMap((page) => page.data.items) ?? []);
    return { query, items };
}

export function useProject(projectId: MaybeRefOrGetter<string>, lifecycle = useSessionLifecycle()) {
    const query = useInfiniteQuery(
        computed(() => {
            const scope = lifecycle.capture();
            const id = toValue(projectId);
            return {
                queryKey: scope.queryKey(['projects', id]),
                refetchInterval: (query: {
                    state: { data?: { pages: ApiResponse<ProjectDetailResponse>[] } };
                }) =>
                    query.state.data?.pages[0]?.data.recentRuns.some(
                        ({ status }) =>
                            status === 'queued' ||
                            status === 'running' ||
                            status === 'recovering' ||
                            status === 'cancel_requested',
                    )
                        ? 3000
                        : false,
                enabled: scope.accountId !== null && id !== '',
                initialPageParam: undefined as string | undefined,
                queryFn: ({ signal, pageParam }: PageRequest) =>
                    scope.request(
                        projectEndpoint,
                        {
                            params: { projectId: id },
                            query: { limit: 20, cursor: pageParam },
                        },
                        { signal },
                    ),
                getNextPageParam: (
                    last: ApiResponse<ProjectDetailResponse>,
                    pages: ApiResponse<ProjectDetailResponse>[],
                ) =>
                    nextPage(
                        last.data.tasks.nextCursor,
                        pages.slice(0, -1).map((page) => page.data.tasks.nextCursor),
                    ),
            };
        }),
        lifecycle.queryClient,
    );
    const detail = computed(() => query.data.value?.pages[0]?.data);
    const tasks = computed(
        () => query.data.value?.pages.flatMap((page) => page.data.tasks.items) ?? [],
    );
    return { query, detail, tasks };
}

export async function invalidateProjects(
    lifecycle: SessionLifecycle,
    scope: ReturnType<SessionLifecycle['capture']>,
) {
    if (scope.isCurrent())
        await lifecycle.queryClient.invalidateQueries({ queryKey: scope.queryKey(['projects']) });
}
