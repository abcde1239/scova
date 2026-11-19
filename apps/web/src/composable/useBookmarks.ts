import {
    computed,
    onScopeDispose,
    ref,
    reactive,
    toValue,
    watch,
    type MaybeRefOrGetter,
    type Ref,
} from 'vue';
import { useQuery } from '@tanstack/vue-query';
import {
    BookmarkSchema,
    ContractValidationError,
    UuidSchema,
    parseContract,
    type Report,
} from '@scova/models';
import { bookmarksEndpoint, createBookmarkEndpoint, deleteBookmarkEndpoint } from '@/api/library';
import type { Bookmark } from '@/api/library';
import { toApiError } from '@/api/errors';
import type { SessionLifecycle } from '@/api/session';
import { useSessionLifecycle } from '@/composable/useSessionQuery';

interface BookmarkClientState {
    epoch: number;
    nonce: string;
    pending: Ref<boolean>;
    reset: Ref<number>;
    notice: Ref<string>;
    uncertain: Set<string>;
}
const clients = new WeakMap<SessionLifecycle, BookmarkClientState>();
function clientState(lifecycle: SessionLifecycle) {
    let state = clients.get(lifecycle);
    if (!state || state.epoch !== lifecycle.session.epoch) {
        state = {
            epoch: lifecycle.session.epoch,
            nonce: crypto.randomUUID(),
            pending: ref(false),
            reset: ref(0),
            notice: ref(''),
            uncertain: reactive(new Set<string>()),
        };
        clients.set(lifecycle, state);
    }
    return state;
}
export function bookmarksPending(lifecycle: SessionLifecycle) {
    return clientState(lifecycle).pending.value;
}
function invalid(message: string): never {
    throw new ContractValidationError([{ path: '/bookmarks', message }]);
}
function uuid(value: unknown) {
    try {
        return parseContract(UuidSchema, value).toLowerCase();
    } catch {
        return undefined;
    }
}
export function validateBookmark(value: Bookmark) {
    parseContract(BookmarkSchema, value);
    if (value.sourceId.toLowerCase() !== value.source.id.toLowerCase())
        invalid('收藏来源标识不一致');
    return value;
}
export function validateBookmarkPage(
    page: { items: Bookmark[]; nextCursor: string | null },
    cursor?: string,
) {
    page.items.forEach(validateBookmark);
    if (
        new Set(page.items.map((item) => item.id.toLowerCase())).size !== page.items.length ||
        new Set(page.items.map((item) => item.sourceId.toLowerCase())).size !== page.items.length ||
        (page.nextCursor !== null && (page.nextCursor === cursor || page.nextCursor.length > 1024))
    )
        invalid('收藏分页的条目或游标不一致');
    return page;
}
export function reportBookmarkSources(report: Report) {
    return [
        ...new Map(
            report.evidence.map((item) => [
                item.sourceId.toLowerCase(),
                { id: item.sourceId.toLowerCase(), title: item.title },
            ]),
        ).values(),
    ];
}
function unsafeRead(cause: unknown) {
    const error = toApiError(cause);
    return (
        [401, 403, 404].includes(error.status ?? 0) ||
        ['validation', 'protocol'].includes(error.kind)
    );
}
export function bookmarkReadError(cause: unknown) {
    const error = toApiError(cause);
    if ([401, 403, 404].includes(error.status ?? 0)) return '收藏不存在或当前账号无法访问。';
    if (['validation', 'protocol'].includes(error.kind))
        return '收藏数据或分页校验失败，暂时无法展示。';
    if (error.status === 400) return '分页位置已失效，请从第一页重新读取。';
    return '收藏暂时无法读取，请重试。';
}
function pagePredicate(lifecycle: SessionLifecycle) {
    const scope = lifecycle.capture();
    return (query: { queryKey: readonly unknown[] }) =>
        query.queryKey[0] === 'session' &&
        query.queryKey[1] === scope.accountId &&
        query.queryKey[2] === scope.epoch &&
        query.queryKey[3] === 'bookmarks' &&
        query.queryKey[4] === 'page';
}
export function bookmarkOrigin(lifecycle: SessionLifecycle, reportId: string, sourceId: string) {
    if (!uuid(reportId) || !uuid(sourceId) || !lifecycle.session.user) return undefined;
    return {
        owner: lifecycle.session.user.id,
        epoch: lifecycle.session.epoch,
        nonce: clientState(lifecycle).nonce,
        reportId: uuid(reportId)!,
        sourceId: uuid(sourceId)!,
    };
}
export function readBookmarkOrigin(lifecycle: SessionLifecycle, value: unknown) {
    if (
        !value ||
        typeof value !== 'object' ||
        !('owner' in value) ||
        !('epoch' in value) ||
        !('nonce' in value) ||
        !('reportId' in value) ||
        !('sourceId' in value)
    )
        return undefined;
    const reportId = uuid(value.reportId),
        sourceId = uuid(value.sourceId);
    if (
        value.owner !== lifecycle.session.user?.id ||
        value.epoch !== lifecycle.session.epoch ||
        value.nonce !== clientState(lifecycle).nonce ||
        !reportId ||
        !sourceId
    )
        return undefined;
    return { sourceId, path: `/reports/${reportId}` };
}

export function useBookmarks(lifecycle: SessionLifecycle = useSessionLifecycle()) {
    const cursor = ref<string>();
    const previous = ref<(string | undefined)[]>([]);
    const paginationError = ref('');
    const client = computed(() => clientState(lifecycle));
    watch(
        () => [lifecycle.session.epoch, client.value.reset.value],
        () => {
            cursor.value = undefined;
            previous.value = [];
            paginationError.value = '';
        },
        { flush: 'sync' },
    );
    const options = computed(() => {
        const currentCursor = cursor.value;
        const scope = lifecycle.capture();
        const result = lifecycle.queryOptions(
            bookmarksEndpoint,
            { query: { limit: 25, ...(currentCursor ? { cursor: currentCursor } : {}) } },
            ['bookmarks', 'page'],
        );
        return {
            ...result,
            async queryFn(context: { signal: AbortSignal }) {
                const response = await result.queryFn(context);
                if (response.status !== 200) invalid('收藏列表未返回确认的读取结果');
                validateBookmarkPage(response.data, currentCursor);
                context.signal.throwIfAborted();
                if (scope.isCurrent()) {
                    // A real list item supersedes an older derived detail; page absence proves nothing.
                    for (const item of response.data.items)
                        lifecycle.queryClient.setQueryData(
                            scope.queryKey(['bookmarks', 'source', item.sourceId.toLowerCase()]),
                            { bookmark: item },
                        );
                }
                return response;
            },
        };
    });
    const query = useQuery(options, lifecycle.queryClient);
    const items = computed(() =>
        unsafeRead(query.error.value) ? [] : (query.data.value?.data.items ?? []),
    );
    const pending = computed(() => client.value.pending.value);
    const canPage = computed(
        () => query.isSuccess.value && !query.isFetching.value && !pending.value,
    );
    function next() {
        const nextCursor = query.data.value?.data.nextCursor;
        if (!canPage.value || !nextCursor) return;
        if (nextCursor === cursor.value || previous.value.includes(nextCursor)) {
            paginationError.value = '分页游标重复，请从第一页重新读取。';
            return;
        }
        previous.value.push(cursor.value);
        cursor.value = nextCursor;
        paginationError.value = '';
    }
    function back() {
        if (!canPage.value || !previous.value.length) return;
        cursor.value = previous.value.pop();
        paginationError.value = '';
    }
    async function first() {
        if (pending.value || query.isFetching.value) return;
        cursor.value = undefined;
        previous.value = [];
        paginationError.value = '';
        await lifecycle.queryClient.invalidateQueries({ predicate: pagePredicate(lifecycle) });
    }
    async function reload() {
        if (pending.value || query.isFetching.value) return;
        await query.refetch();
    }
    const notice = computed(() => client.value.notice.value);
    return {
        query,
        items,
        cursor,
        previous,
        paginationError,
        pending,
        notice,
        canPage,
        next,
        back,
        first,
        reload,
    };
}

export function useBookmark(
    source: MaybeRefOrGetter<unknown>,
    known?: MaybeRefOrGetter<Bookmark | undefined>,
    lifecycle: SessionLifecycle = useSessionLifecycle(),
) {
    const knownScope = lifecycle.capture();
    const sourceId = computed(() => uuid(toValue(source)));
    const client = computed(() => clientState(lifecycle));
    const pending = computed(() => client.value.pending.value);
    const uncertain = computed(
        () => !!sourceId.value && client.value.uncertain.has(sourceId.value),
    );
    const notice = ref('');
    let readRevision = 0;
    let alive = true;
    let operation: AbortController | undefined;
    let operationState: BookmarkClientState | undefined;
    let operationSource: string | undefined;
    let operationPages: ReturnType<typeof pagePredicate> | undefined;
    let operationConfirmed = false;
    const context = () => `${lifecycle.session.epoch}/${sourceId.value}`;
    const options = computed(() => {
        const id = sourceId.value ?? '';
        const scope = lifecycle.capture();
        const value = knownScope.isCurrent() ? toValue(known) : undefined;
        if (value && validateBookmark(value).sourceId.toLowerCase() !== id)
            invalid('收藏按钮与来源目标不一致');
        return {
            queryKey: scope.queryKey(['bookmarks', 'source', id]),
            enabled: false,
            initialData: value ? { bookmark: value as Bookmark | null } : undefined,
            async queryFn({ signal }: { signal: AbortSignal }) {
                if (!uuid(id)) invalid('来源标识无效');
                const cursors = new Set<string>();
                const ids = new Set<string>();
                const sources = new Set<string>();
                let cursor: string | undefined;
                for (let page = 0; page < 1000; page++) {
                    const response = await scope.request(
                        bookmarksEndpoint,
                        { query: { limit: 100, ...(cursor ? { cursor } : {}) } },
                        { signal },
                    );
                    if (response.status !== 200) invalid('收藏核对未返回确认的读取结果');
                    const result = validateBookmarkPage(response.data, cursor);
                    for (const item of result.items) {
                        if (
                            ids.has(item.id.toLowerCase()) ||
                            sources.has(item.sourceId.toLowerCase())
                        )
                            invalid('收藏核对遇到重复条目');
                        ids.add(item.id.toLowerCase());
                        sources.add(item.sourceId.toLowerCase());
                    }
                    const found = result.items.find((item) => item.sourceId.toLowerCase() === id);
                    signal.throwIfAborted();
                    if (found || result.nextCursor === null) {
                        readRevision++;
                        return { bookmark: found ?? null };
                    }
                    if (cursors.has(result.nextCursor)) invalid('收藏核对遇到循环游标');
                    cursors.add(result.nextCursor);
                    cursor = result.nextCursor;
                }
                invalid('收藏核对达到安全批次上限，尚未确认目标状态');
            },
        };
    });
    const query = useQuery(options, lifecycle.queryClient);
    const bookmark = computed(() =>
        unsafeRead(query.error.value) ? undefined : (query.data.value?.bookmark ?? undefined),
    );
    const canWrite = computed(
        () =>
            !!sourceId.value &&
            !!lifecycle.session.user &&
            !pending.value &&
            !uncertain.value &&
            !query.isFetching.value &&
            !query.isError.value,
    );
    function abandon() {
        if (operation) {
            if (!operationConfirmed) {
                operationState?.uncertain.add(operationSource!);
                if (operationPages)
                    void lifecycle.queryClient.invalidateQueries({
                        predicate: operationPages,
                        refetchType: 'none',
                    });
            }
            operation.abort();
            operation = undefined;
            if (operationState) operationState.pending.value = false;
        }
    }
    watch(
        context,
        () => {
            abandon();
            notice.value = '';
        },
        { flush: 'sync' },
    );
    onScopeDispose(() => {
        abandon();
        alive = false;
    });
    async function verify() {
        if (pending.value || query.isFetching.value || !sourceId.value || !lifecycle.session.user)
            return;
        const captured = context(),
            revision = readRevision;
        const state = client.value,
            id = sourceId.value;
        const result = await query.refetch();
        if (!alive || captured !== context()) return;
        if (result.isSuccess && readRevision > revision) {
            state.uncertain.delete(id);
            notice.value = result.data.bookmark
                ? '已核对：来源已收藏。'
                : '已核对完整收藏列表：来源当前未收藏。';
        } else notice.value = '尚未完成收藏核对，请重试；未知结果仍未解除。';
    }
    async function write(remove = false) {
        if (!canWrite.value || (remove && !bookmark.value)) return;
        const id = sourceId.value!,
            previousBookmark = bookmark.value;
        const state = client.value,
            scope = lifecycle.capture(),
            captured = context();
        const controller = new AbortController();
        operation = controller;
        operationState = state;
        operationSource = id;
        operationPages = pagePredicate(lifecycle);
        operationConfirmed = false;
        state.pending.value = true;
        notice.value = '';
        state.notice.value = '';
        const stillCurrent = () =>
            alive && scope.isCurrent() && context() === captured && operation === controller;
        const key = options.value.queryKey;
        try {
            await lifecycle.queryClient.cancelQueries({ queryKey: key, exact: true });
            if (!stillCurrent()) return;
            let result: Bookmark | null;
            let reused = false;
            if (remove) {
                const response = await scope.request(
                    deleteBookmarkEndpoint,
                    { params: { bookmarkId: previousBookmark!.id } },
                    { signal: controller.signal },
                );
                if (response.status !== 204) invalid('取消收藏没有返回确认结果');
                result = null;
            } else {
                const response = await scope.request(
                    createBookmarkEndpoint,
                    { body: { sourceId: id } },
                    { signal: controller.signal },
                );
                const record = validateBookmark(response.data.bookmark);
                if (
                    record.sourceId.toLowerCase() !== id ||
                    response.status !== (response.data.reused ? 200 : 201)
                )
                    invalid('收藏命令响应的来源或状态不一致');
                result = record;
                reused = response.data.reused;
            }
            if (!stillCurrent()) return;
            await lifecycle.queryClient.cancelQueries({ queryKey: key, exact: true });
            if (!stillCurrent()) return;
            lifecycle.queryClient.setQueryData(key, { bookmark: result });
            operationConfirmed = true;
            const success = remove
                ? '已取消收藏，来源、报告和证据仍保留。'
                : reused
                  ? '来源已在收藏中，已复用现有收藏。'
                  : '已收藏来源。';
            notice.value = success;
            state.notice.value = success;
            await lifecycle.queryClient.cancelQueries({ predicate: pagePredicate(lifecycle) });
            if (!stillCurrent()) return;
            state.reset.value++;
            await lifecycle.queryClient.invalidateQueries({ predicate: pagePredicate(lifecycle) });
            if (!stillCurrent()) return;
            notice.value = remove
                ? '已取消收藏，来源、报告和证据仍保留。'
                : reused
                  ? '来源已在收藏中，已复用现有收藏。'
                  : '已收藏来源。';
        } catch (cause) {
            if (!stillCurrent()) return;
            const error = toApiError(cause);
            if ([403, 409, 422].includes(error.status ?? 0))
                notice.value = '操作未能完成，保留之前的收藏状态。请核对权限后重试。';
            else {
                state.uncertain.add(id);
                void lifecycle.queryClient.invalidateQueries({
                    predicate: operationPages,
                    refetchType: 'none',
                });
                notice.value =
                    error.status === 404
                        ? '收藏或来源已不可访问，请核对收藏状态后继续。'
                        : '操作结果尚未确认，保留上次读取状态；请核对收藏状态后继续。';
            }
        } finally {
            if (operation === controller) {
                operation = undefined;
                state.pending.value = false;
            }
        }
    }
    return { query, bookmark, pending, uncertain, notice, canWrite, verify, write };
}
