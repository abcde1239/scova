import { computed, onScopeDispose, ref, toValue, watch, type MaybeRefOrGetter } from 'vue';
import { useInfiniteQuery, type InfiniteData } from '@tanstack/vue-query';
import { ContractValidationError, UuidSchema, parseContract } from '@scova/models';
import { inboxEndpoint, inboxReadEndpoint, type InboxItem, type InboxPage } from '@/api/inbox';
import type { SessionLifecycle } from '@/api/session';
import { toApiError } from '@/api/errors';
import { shouldReportQueryError } from '@/api/query';
import { useSessionLifecycle } from '@/composables/useSessionQuery';

export type InboxFilter = 'all' | 'unread' | 'read';
type InboxData = InfiniteData<InboxPage, string | undefined>;

export function inboxFilter(value: unknown): InboxFilter {
    return value === 'unread' || value === 'read' ? value : 'all';
}
export function inboxPath(filter: InboxFilter) {
    return filter === 'all' ? '/inbox' : `/inbox?read=${filter}`;
}
export function inboxError(cause: unknown) {
    const error = toApiError(cause);
    const invalid = error.kind === 'validation' || error.kind === 'protocol';
    const hidden = [401, 403, 404].includes(error.status ?? 0) || invalid;
    return {
        hidden,
        message:
            error.status === 403
                ? '当前账号无权读取收件箱。'
                : error.status === 404
                  ? '收件箱当前不可用，请重新读取。'
                  : error.code === 'INVALID_CURSOR'
                    ? '分页位置已失效，请刷新收件箱重新读取。'
                    : invalid
                      ? '收件箱内容校验未通过，请重新读取。'
                      : '收件箱暂时无法读取，请检查连接后重试。',
    };
}
export function inboxItems(pages: InboxPage[]) {
    const ids = new Set<string>();
    const reports = new Set<string>();
    return pages
        .flatMap((page) => page.items)
        .filter((item) => {
            if (ids.has(item.id) || reports.has(item.reportId)) return false;
            ids.add(item.id);
            reports.add(item.reportId);
            return true;
        });
}
function assertItem(item: InboxItem) {
    if (item.reportId !== item.report.id)
        throw new ContractValidationError([{ path: '/reportId', message: '报告标识不一致' }]);
}

export interface InboxReturn {
    path: string;
    scroll: number;
    focusId: string;
    accountId: string;
}
/** History state is untrusted input; only canonical, same-account inbox locations are accepted. */
export function inboxReturn(
    value: unknown,
    accountId: string | undefined,
): InboxReturn | undefined {
    if (!value || typeof value !== 'object') return;
    const state = value as Record<string, unknown>;
    if (
        state.accountId !== accountId ||
        !accountId ||
        !['/inbox', '/inbox?read=unread', '/inbox?read=read'].includes(String(state.path)) ||
        typeof state.scroll !== 'number' ||
        !Number.isFinite(state.scroll) ||
        state.scroll < 0 ||
        typeof state.focusId !== 'string'
    )
        return;
    try {
        parseContract(UuidSchema, state.focusId);
    } catch {
        return;
    }
    return { path: String(state.path), scroll: state.scroll, focusId: state.focusId, accountId };
}

export function useInbox(
    selected: MaybeRefOrGetter<InboxFilter>,
    lifecycle: SessionLifecycle = useSessionLifecycle(),
) {
    const filter = computed(() => toValue(selected));
    const pendingId = ref<string>();
    const actionError = ref('');
    const announcement = ref('');
    let generation = 0;
    let controller = new AbortController();
    const query = useInfiniteQuery(
        computed(() => {
            const scope = lifecycle.capture();
            const currentFilter = filter.value;
            return {
                queryKey: scope.queryKey(['inbox', currentFilter]),
                enabled: scope.accountId !== null,
                initialPageParam: undefined as string | undefined,
                async queryFn({
                    signal,
                    pageParam,
                }: {
                    signal: AbortSignal;
                    pageParam: string | undefined;
                }) {
                    const response = await scope.request(
                        inboxEndpoint,
                        {
                            query: {
                                limit: 20,
                                ...(currentFilter === 'all'
                                    ? {}
                                    : { unread: currentFilter === 'unread' }),
                                ...(pageParam === undefined ? {} : { cursor: pageParam }),
                            },
                        },
                        { signal },
                    );
                    response.data.items.forEach(assertItem);
                    if (pageParam !== undefined && response.data.nextCursor === pageParam)
                        throw new ContractValidationError([
                            { path: '/nextCursor', message: '分页位置未前进' },
                        ]);
                    return response.data;
                },
                getNextPageParam(
                    page: InboxPage,
                    _pages: InboxPage[],
                    _last: string | undefined,
                    params: (string | undefined)[],
                ) {
                    return page.nextCursor && !params.includes(page.nextCursor)
                        ? page.nextCursor
                        : undefined;
                },
            };
        }),
        lifecycle.queryClient,
    );
    watch(
        () => lifecycle.session.epoch,
        () => {
            generation++;
            controller.abort();
            controller = new AbortController();
            pendingId.value = undefined;
            actionError.value = '';
            announcement.value = '';
        },
        { flush: 'sync' },
    );
    watch(
        filter,
        () => {
            generation++;
            actionError.value = '';
            announcement.value = '';
        },
        { flush: 'sync' },
    );
    onScopeDispose(() => {
        generation++;
        controller.abort();
        if (pendingId.value)
            void lifecycle.queryClient.invalidateQueries({
                queryKey: lifecycle.capture().queryKey(['inbox']),
                refetchType: 'none',
            });
    });
    const error = computed(() => inboxError(query.error.value));
    const items = computed(() =>
        lifecycle.session.user && !(query.isError.value && error.value.hidden)
            ? inboxItems(query.data.value?.pages ?? [])
            : [],
    );
    async function setRead(item: InboxItem, read: boolean) {
        if (pendingId.value || !lifecycle.session.user) return false;
        const scope = lifecycle.capture();
        const current = generation;
        const signal = controller.signal;
        const prefix = scope.queryKey(['inbox']);
        pendingId.value = item.id;
        actionError.value = '';
        announcement.value = '';
        try {
            const response = await scope.request(
                inboxReadEndpoint,
                {
                    params: { inboxId: item.id },
                    body: { read },
                },
                { signal },
            );
            assertItem(response.data);
            if (
                response.data.id !== item.id ||
                response.data.reportId !== item.reportId ||
                (response.data.readAt !== null) !== read
            )
                throw new ContractValidationError([
                    { path: '/id', message: '已读响应与操作不一致' },
                ]);
            if (!scope.isCurrent() || signal.aborted) return false;
            // Stop older list reads before installing the write result in the sole server cache.
            await lifecycle.queryClient.cancelQueries({ queryKey: prefix });
            if (!scope.isCurrent() || signal.aborted) return false;
            for (const [key, data] of lifecycle.queryClient.getQueriesData<InboxData>({
                queryKey: prefix,
            })) {
                if (!data) continue;
                const cachedFilter = key[4];
                lifecycle.queryClient.setQueryData<InboxData>(key, {
                    ...data,
                    pages: data.pages.map((page) => ({
                        ...page,
                        items: page.items
                            .map((entry) => (entry.id === item.id ? response.data : entry))
                            .filter(
                                (entry) =>
                                    cachedFilter === 'all' ||
                                    (cachedFilter === 'unread'
                                        ? entry.readAt === null
                                        : entry.readAt !== null),
                            ),
                    })),
                });
            }
            if (current === generation)
                announcement.value = read ? '已标记为已读。' : '已恢复为未读。';
            await lifecycle.queryClient.invalidateQueries({ queryKey: prefix });
            return scope.isCurrent() && !signal.aborted && current === generation;
        } catch (cause) {
            // A failed/aborted response does not prove the server rejected the write.
            if (scope.isCurrent())
                void lifecycle.queryClient.invalidateQueries({
                    queryKey: prefix,
                    refetchType: 'none',
                });
            if (
                scope.isCurrent() &&
                !signal.aborted &&
                current === generation &&
                shouldReportQueryError(cause)
            )
                actionError.value = '已读状态未能更新，原状态已保留，请重试。';
            return false;
        } finally {
            if (controller.signal === signal) pendingId.value = undefined;
        }
    }
    return { query, items, error, pendingId, actionError, announcement, setRead };
}
