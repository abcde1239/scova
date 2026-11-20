import { useInfiniteQuery } from '@tanstack/vue-query';
import type { PageQuery } from '@scova/models';
import { computed } from 'vue';
import type { ApiResponse } from '@/api/client';
import type { SessionLifecycle } from '@/api/session';

type Page<T> = { items: T[]; nextCursor: string | null };
type Scope = ReturnType<SessionLifecycle['capture']>;

export function useWorkflowPages<T extends { id: string }>(
    lifecycle: SessionLifecycle,
    key: readonly string[],
    request: (scope: Scope, query: PageQuery, signal: AbortSignal) => Promise<ApiResponse<Page<T>>>,
    enabled = () => true,
) {
    const query = useInfiniteQuery(
        computed(() => {
            const scope = lifecycle.capture();
            return {
                queryKey: scope.queryKey(key),
                enabled: scope.accountId !== null && enabled(),
                initialPageParam: undefined as string | undefined,
                queryFn: ({
                    pageParam,
                    signal,
                }: {
                    pageParam: string | undefined;
                    signal: AbortSignal;
                }) => request(scope, { limit: 20, cursor: pageParam }, signal),
                getNextPageParam: (last: ApiResponse<Page<T>>, pages: ApiResponse<Page<T>>[]) => {
                    const next = last.data.nextCursor;
                    return next && !pages.slice(0, -1).some((page) => page.data.nextCursor === next)
                        ? next
                        : undefined;
                },
            };
        }),
        lifecycle.queryClient,
    );
    const items = computed(() => {
        const unique = new Map<string, T>();
        for (const page of query.data.value?.pages ?? []) {
            for (const item of page.data.items) {
                if (!unique.has(item.id)) unique.set(item.id, item);
            }
        }
        return [...unique.values()];
    });
    return { query, items };
}
