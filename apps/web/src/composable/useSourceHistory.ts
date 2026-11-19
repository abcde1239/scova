import {
    computed,
    nextTick,
    onScopeDispose,
    ref,
    toValue,
    watch,
    type MaybeRefOrGetter,
} from 'vue';
import { useQuery } from '@tanstack/vue-query';
import {
    invalidSnapshot,
    sourceHistoryId,
    sourceSnapshotEndpoint,
    sourceSnapshotsEndpoint,
    type SnapshotDetail,
    type SourceSnapshot,
} from '@/api/source-history';
import type { ApiResponse } from '@/api/client';
import { toApiError } from '@/api/errors';
import type { SessionLifecycle } from '@/api/session';
import { useSessionLifecycle } from '@/composable/useSessionQuery';

export interface SnapshotRead extends ApiResponse<SnapshotDetail> {
    receivedWall: number;
    receivedMonotonic: number;
}
interface HistoryClock {
    wall: () => number;
    monotonic: () => number;
}
const browserClock: HistoryClock = { wall: () => Date.now(), monotonic: () => performance.now() };
/** Date is optional. A strict valid header adds a conservative, second-rounded clock bound. */
export function snapshotClockNow(response: SnapshotRead, wall: number, monotonic: number) {
    const elapsed = Math.max(0, monotonic - response.receivedMonotonic);
    const value = response.headers.date;
    const date = value ? Date.parse(value) : NaN;
    const serverBound =
        Number.isFinite(date) && new Date(date).toUTCString() === value
            ? date + 1000 + elapsed
            : -Infinity;
    return Math.max(wall, response.receivedWall + elapsed, serverBound);
}
export function snapshotBody(response: SnapshotRead, wall: number, monotonic: number) {
    const expires = response.data.snapshot.textExpiresAt;
    return response.data.snapshot.bodyStatus === 'available' &&
        (expires === null || Date.parse(expires) > snapshotClockNow(response, wall, monotonic))
        ? response.data.textBody
        : null;
}
export function snapshotPage(
    page: { items: SourceSnapshot[]; nextCursor: string | null },
    sourceId: string,
    cursor?: string,
) {
    if (
        page.items.length > 20 ||
        page.items.some((item) => item.sourceId.toLowerCase() !== sourceId) ||
        new Set(page.items.map((item) => item.id.toLowerCase())).size !== page.items.length ||
        (page.nextCursor !== null &&
            (!page.nextCursor || page.nextCursor === cursor || page.nextCursor.length > 1024))
    )
        invalidSnapshot('来源快照分页、身份或游标不一致');
    return page;
}
export function sourceHistoryError(cause: unknown) {
    const error = toApiError(cause);
    if ([401, 403, 404].includes(error.status ?? 0))
        return '来源或快照不存在，或当前账号无法访问。';
    if (error.status === 409 || ['validation', 'protocol'].includes(error.kind))
        return '来源快照或保存片段校验失败，暂时无法展示。';
    if (error.status === 400) return '分页位置已失效，请从第一页重新读取。';
    return '来源历史暂时无法读取，请重试。';
}
export function unsafeSourceHistory(cause: unknown) {
    const error = toApiError(cause);
    return (
        [401, 403, 404, 409].includes(error.status ?? 0) ||
        ['validation', 'protocol'].includes(error.kind)
    );
}
export function useSourceHistory(
    source: MaybeRefOrGetter<unknown>,
    selected: MaybeRefOrGetter<unknown>,
    lifecycle: SessionLifecycle = useSessionLifecycle(),
    clock: HistoryClock = browserClock,
) {
    const sourceId = computed(() => sourceHistoryId(toValue(source)));
    const snapshotId = computed(() => sourceHistoryId(toValue(selected)));
    const valid = computed(
        () =>
            !!sourceId.value &&
            (toValue(selected) === undefined || toValue(selected) === '' || !!snapshotId.value),
    );
    const cursor = ref<string>();
    const previous = ref<(string | undefined)[]>([]);
    const paginationError = ref('');
    const listOptions = (page?: string) =>
        lifecycle.queryOptions(
            sourceSnapshotsEndpoint,
            {
                params: { sourceId: sourceId.value ?? '' },
                query: { limit: 20, ...(page ? { cursor: page } : {}) },
            },
            ['source-history', sourceId.value, 'page', page],
        );
    const query = useQuery(
        computed(() => {
            const page = cursor.value;
            const id = sourceId.value ?? '';
            const options = listOptions(page);
            return {
                ...options,
                enabled: options.enabled && valid.value,
                async queryFn(context: { signal: AbortSignal }) {
                    const response = await options.queryFn(context);
                    if (response.status !== 200) invalidSnapshot('来源历史 HTTP 状态不一致');
                    snapshotPage(response.data, id, page);
                    return response;
                },
            };
        }),
        lifecycle.queryClient,
    );
    const blocked = computed(() => query.isError.value && unsafeSourceHistory(query.error.value));
    const detailOptions = computed(() =>
        lifecycle.queryOptions(
            sourceSnapshotEndpoint,
            { params: { sourceId: sourceId.value ?? '', snapshotId: snapshotId.value ?? '' } },
            ['source-history', sourceId.value ?? '', 'detail', snapshotId.value ?? ''],
        ),
    );
    const detail = useQuery(
        computed(() => {
            const id = sourceId.value ?? '';
            const snapshot = snapshotId.value ?? '';
            const options = detailOptions.value;
            return {
                ...options,
                enabled: options.enabled && valid.value && !!snapshot && !blocked.value,
                async queryFn(context: { signal: AbortSignal }): Promise<SnapshotRead> {
                    const response = await options.queryFn(context);
                    if (
                        response.status !== 200 ||
                        response.data.snapshot.sourceId.toLowerCase() !== id ||
                        response.data.snapshot.id.toLowerCase() !== snapshot
                    )
                        invalidSnapshot('快照详情与请求目标不一致');
                    return {
                        ...response,
                        receivedWall: clock.wall(),
                        receivedMonotonic: clock.monotonic(),
                    };
                },
            };
        }),
        lifecycle.queryClient,
    );
    watch(blocked, (value) => {
        if (value)
            void lifecycle.queryClient.cancelQueries({
                queryKey: detailOptions.value.queryKey,
                exact: true,
            });
    });
    const pageProblem = computed(() => {
        if (!query.isSuccess.value || !sourceId.value || !query.data.value) return '';
        try {
            const page = snapshotPage(query.data.value.data, sourceId.value, cursor.value);
            const seen = new Set<string>();
            for (const prior of previous.value) {
                const data = lifecycle.queryClient.getQueryData<
                    ApiResponse<{ items: SourceSnapshot[]; nextCursor: string | null }>
                >(listOptions(prior).queryKey);
                for (const item of data?.data.items ?? []) seen.add(item.id.toLowerCase());
            }
            if (page.items.some((item) => seen.has(item.id.toLowerCase())))
                invalidSnapshot('跨页快照重复，请从第一页重新读取');
            return '';
        } catch {
            return '来源分页内容重复或校验失败，请从第一页重新读取。';
        }
    });
    const items = computed(() =>
        valid.value && query.isSuccess.value && !pageProblem.value
            ? (query.data.value?.data.items ?? [])
            : [],
    );
    const snapshot = computed(() =>
        valid.value && !blocked.value && detail.isSuccess.value
            ? detail.data.value?.data
            : undefined,
    );
    const tick = ref(0);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const body = computed(() => {
        void tick.value;
        return snapshot.value && detail.data.value
            ? snapshotBody(detail.data.value, clock.wall(), clock.monotonic())
            : null;
    });
    function clearTimer() {
        if (timer) clearTimeout(timer);
        timer = undefined;
    }
    watch(
        () => detail.dataUpdatedAt.value,
        () => {
            const response = detail.data.value;
            clearTimer();
            tick.value++;
            if (
                !response?.data?.snapshot?.textExpiresAt ||
                response.data.snapshot.bodyStatus !== 'available'
            )
                return;
            const expire = () => {
                tick.value++;
                const remaining =
                    Date.parse(response.data.snapshot.textExpiresAt!) -
                    snapshotClockNow(response, clock.wall(), clock.monotonic());
                if (remaining > 0) timer = setTimeout(expire, Math.min(remaining, 2147483647));
            };
            expire();
        },
        { immediate: true, flush: 'sync' },
    );
    watch(
        () => `${lifecycle.session.epoch}:${sourceId.value ?? ''}`,
        () => {
            cursor.value = undefined;
            previous.value = [];
            paginationError.value = '';
        },
        { flush: 'sync' },
    );
    function next() {
        const nextCursor = query.data.value?.data.nextCursor;
        if (!nextCursor || query.isFetching.value || !query.isSuccess.value || pageProblem.value)
            return;
        if (nextCursor === cursor.value || previous.value.includes(nextCursor)) {
            paginationError.value = '分页游标重复，请从第一页重新读取。';
            return;
        }
        previous.value.push(cursor.value);
        cursor.value = nextCursor;
        paginationError.value = '';
    }
    function back() {
        if (!query.isFetching.value && previous.value.length) {
            cursor.value = previous.value.pop();
            paginationError.value = '';
        }
    }
    async function first() {
        const scope = lifecycle.capture();
        const id = sourceId.value;
        previous.value = [];
        cursor.value = undefined;
        paginationError.value = '';
        await nextTick();
        if (scope.isCurrent() && valid.value && id === sourceId.value)
            await query.refetch({ cancelRefetch: false });
    }
    onScopeDispose(clearTimer);
    if (typeof window !== 'undefined') {
        const refreshClock = () => {
            tick.value++;
        };
        window.addEventListener('focus', refreshClock);
        window.addEventListener('pageshow', refreshClock);
        document.addEventListener('visibilitychange', refreshClock);
        onScopeDispose(() => {
            window.removeEventListener('focus', refreshClock);
            window.removeEventListener('pageshow', refreshClock);
            document.removeEventListener('visibilitychange', refreshClock);
        });
    }
    return {
        sourceId,
        snapshotId,
        valid,
        blocked,
        query,
        detail,
        items,
        snapshot,
        body,
        previous,
        paginationError,
        pageProblem,
        next,
        back,
        first,
    };
}
