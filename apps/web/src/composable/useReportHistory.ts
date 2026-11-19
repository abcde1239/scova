import { computed, toValue, type MaybeRefOrGetter } from 'vue';
import { useInfiniteQuery } from '@tanstack/vue-query';
import { ContractValidationError, UuidSchema, parseContract } from '@scova/models';
import { reportHistoryEndpoint, type ReportHistoryPage } from '@/api/reports';
import type { SessionLifecycle } from '@/api/session';
import { toApiError } from '@/api/errors';
import { useSessionLifecycle } from '@/composable/useSessionQuery';

export function reportHistoryTask(value: unknown): string | undefined | null {
    if (value === undefined || value === '') return undefined;
    try {
        return parseContract(UuidSchema, value).toLowerCase();
    } catch {
        return null;
    }
}
export function reportHistoryPath(taskId: string | undefined) {
    return taskId ? `/tasks/reports?taskId=${encodeURIComponent(taskId)}` : '/tasks/reports';
}
export function reportHistoryError(cause: unknown) {
    const error = toApiError(cause);
    const invalid = error.kind === 'protocol' || error.kind === 'validation';
    return {
        hidden: invalid || [401, 403, 404].includes(error.status ?? 0),
        restart:
            invalid ||
            error.code === 'INVALID_CURSOR' ||
            [401, 403, 404].includes(error.status ?? 0),
        message:
            error.status === 403
                ? '当前账号无权读取这些报告。'
                : error.status === 404
                  ? '任务不存在或当前账号无法访问。'
                  : invalid
                    ? '报告历史校验未通过，请重新读取。'
                    : error.code === 'INVALID_CURSOR'
                      ? '分页位置已失效，请刷新报告历史。'
                      : '报告历史暂时无法读取，请检查连接后重试。',
    };
}
export function historyItems(pages: ReportHistoryPage[]) {
    const seen = new Set<string>();
    return pages
        .flatMap((page) => page.items)
        .filter((item) => {
            if (seen.has(item.id)) return false;
            seen.add(item.id);
            return true;
        });
}
export function reportHistoryOptions(
    lifecycle: SessionLifecycle,
    taskId: string | undefined | null,
) {
    const scope = lifecycle.capture();
    return {
        queryKey: scope.queryKey([
            'reports',
            'history',
            taskId === null ? 'invalid' : (taskId ?? 'all'),
        ]),
        enabled: scope.accountId !== null && taskId !== null,
        initialPageParam: undefined as string | undefined,
        async queryFn({
            pageParam,
            signal,
        }: {
            pageParam: string | undefined;
            signal: AbortSignal;
        }) {
            const response = await scope.request(
                reportHistoryEndpoint,
                {
                    query: {
                        limit: 20,
                        ...(taskId ? { taskId } : {}),
                        ...(pageParam === undefined ? {} : { cursor: pageParam }),
                    },
                },
                { signal },
            );
            if (taskId && response.data.items.some((item) => item.taskId !== taskId))
                throw new ContractValidationError([
                    { path: '/items', message: '报告不属于当前筛选任务' },
                ]);
            if (pageParam !== undefined && response.data.nextCursor === pageParam)
                throw new ContractValidationError([
                    { path: '/nextCursor', message: '报告分页位置未前进' },
                ]);
            return response.data;
        },
        getNextPageParam(
            page: ReportHistoryPage,
            _pages: ReportHistoryPage[],
            _last: string | undefined,
            params: (string | undefined)[],
        ) {
            return page.nextCursor && !params.includes(page.nextCursor)
                ? page.nextCursor
                : undefined;
        },
    };
}
export function useReportHistory(
    selected: MaybeRefOrGetter<string | undefined | null>,
    lifecycle: SessionLifecycle = useSessionLifecycle(),
) {
    const taskId = computed(() => toValue(selected));
    const valid = computed(() => taskId.value !== null);
    const query = useInfiniteQuery(
        computed(() => reportHistoryOptions(lifecycle, taskId.value)),
        lifecycle.queryClient,
    );
    const error = computed(() =>
        valid.value
            ? reportHistoryError(query.error.value)
            : { hidden: true, restart: false, message: '任务筛选地址无效，请重新选择任务。' },
    );
    const items = computed(() =>
        valid.value && lifecycle.session.user && !(query.isError.value && error.value.hidden)
            ? historyItems(query.data.value?.pages ?? [])
            : [],
    );
    async function prepareFilter(next: string | undefined) {
        const scope = lifecycle.capture();
        await lifecycle.queryClient.cancelQueries({
            queryKey: reportHistoryOptions(lifecycle, taskId.value).queryKey,
            exact: true,
        });
        if (!scope.isCurrent()) return false;
        const key = reportHistoryOptions(lifecycle, next).queryKey;
        await lifecycle.queryClient.cancelQueries({ queryKey: key, exact: true });
        if (!scope.isCurrent()) return false;
        lifecycle.queryClient.removeQueries({ queryKey: key, exact: true });
        return true;
    }
    return { query, items, error, valid, prepareFilter };
}

export interface ReportHistoryPosition {
    path: string;
    accountId: string;
    scroll: number;
    focusId: string;
}
export function reportHistoryPosition(
    value: unknown,
    accountId: string | undefined,
): ReportHistoryPosition | undefined {
    if (!value || typeof value !== 'object' || !accountId) return;
    const state = value as Record<string, unknown>;
    if (
        state.accountId !== accountId ||
        typeof state.path !== 'string' ||
        typeof state.scroll !== 'number' ||
        !Number.isFinite(state.scroll) ||
        state.scroll < 0
    )
        return;
    try {
        const url = new URL(state.path, 'https://scova.invalid');
        const task = reportHistoryTask(url.searchParams.get('taskId') ?? undefined);
        if (task === null || state.path !== reportHistoryPath(task)) return;
        const focusId = parseContract(UuidSchema, state.focusId);
        return { path: state.path, accountId, scroll: state.scroll, focusId };
    } catch {
        return;
    }
}
