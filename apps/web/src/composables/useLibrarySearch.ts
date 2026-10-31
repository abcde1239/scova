import { computed, nextTick, onScopeDispose, ref, watch } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import type { LibrarySearchQuery } from '@scova/models';
import {
    invalidSearch,
    librarySearchEndpoint,
    searchHitKey,
    searchInputIssue,
    searchPage,
} from '@/api/library-search';
import { toApiError } from '@/api/errors';
import type { SessionLifecycle } from '@/api/session';
import { useSessionLifecycle } from '@/composables/useSessionQuery';

type SearchScope = Pick<LibrarySearchQuery, 'q' | 'kind' | 'bookmarked'>;
export function librarySearchError(cause: unknown) {
    const error = toApiError(cause);
    if (error.status === 400) return '分页位置已失效，请从第一页重新读取。';
    if (error.status === 422) return '搜索条件未通过校验，请检查关键词与筛选条件。';
    if (error.status === 401) return '会话已失效，请重新登录。';
    if ([403, 404].includes(error.status ?? 0)) return '当前账号无法读取这些搜索结果。';
    if (['validation', 'protocol'].includes(error.kind)) return '搜索结果校验失败，请重新读取。';
    if (error.status === 503) return '资料检索暂时不可用，请稍后重新读取。';
    return '资料检索失败，请检查连接后重试。';
}
export function useLibrarySearch(lifecycle: SessionLifecycle = useSessionLifecycle()) {
    const draft = ref('');
    const kind = ref<'all' | 'source' | 'note'>('all');
    const bookmarked = ref<'all' | 'true' | 'false'>('all');
    const composing = ref(false);
    const committed = ref<SearchScope>();
    const generation = ref(0);
    const cursor = ref<string>();
    const previous = ref<{ cursor: string | undefined; keys: string[] }[]>([]);
    const notice = ref('');
    const attempted = ref(false);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const inputIssue = computed(() => searchInputIssue(draft.value));
    const valid = computed(() => !inputIssue.value);
    const exactScope = (): SearchScope => ({
        q: draft.value,
        ...(kind.value !== 'all' ? { kind: kind.value } : {}),
        ...(bookmarked.value !== 'all' ? { bookmarked: bookmarked.value === 'true' } : {}),
    });
    const options = computed(() => {
        const scope = committed.value;
        const page = cursor.value;
        const intent = generation.value;
        const base = lifecycle.queryOptions(
            librarySearchEndpoint,
            { query: { ...(scope ?? { q: '' }), limit: 20, ...(page ? { cursor: page } : {}) } },
            ['library-search', generation.value, scope, page],
        );
        return {
            ...base,
            enabled: base.enabled && !!scope && !composing.value,
            staleTime: 0,
            async queryFn(context: { signal: AbortSignal }) {
                const response = await base.queryFn(context);
                if (response.status !== 200) invalidSearch('搜索 HTTP 状态不一致');
                searchPage(response.data, page);
                if (scope?.kind && response.data.items.some((item) => item.kind !== scope.kind))
                    invalidSearch('搜索结果与类型筛选不一致');
                if (
                    scope?.bookmarked === true &&
                    response.data.items.some((item) => item.kind === 'note' && item.reportId)
                )
                    invalidSearch('已收藏来源筛选返回了报告笔记');
                return { ...response, intent, pageCursor: page };
            },
        };
    });
    const query = useQuery(options, lifecycle.queryClient);
    function stopTimer() {
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
    }
    function invalidate() {
        stopTimer();
        void lifecycle.queryClient.cancelQueries({ queryKey: options.value.queryKey, exact: true });
        committed.value = undefined;
        generation.value++;
        cursor.value = undefined;
        previous.value = [];
        notice.value = '';
    }
    function submit() {
        if (composing.value) return;
        invalidate();
        attempted.value = true;
        if (valid.value && lifecycle.session.user) committed.value = exactScope();
    }
    function schedule() {
        invalidate();
        attempted.value = false;
        if (!valid.value || composing.value || !lifecycle.session.user) return;
        const scope = lifecycle.capture();
        timer = setTimeout(() => {
            timer = undefined;
            if (scope.isCurrent()) submit();
        }, 300);
    }
    watch([draft, kind, bookmarked], schedule, { flush: 'sync' });
    watch(
        () => lifecycle.session.epoch,
        () => {
            invalidate();
            draft.value = '';
            kind.value = 'all';
            bookmarked.value = 'all';
            composing.value = false;
            attempted.value = false;
        },
        { flush: 'sync' },
    );
    function beginComposition() {
        composing.value = true;
        invalidate();
    }
    function endComposition(value: string) {
        draft.value = value;
        composing.value = false;
        schedule();
    }
    function cancel() {
        invalidate();
        attempted.value = false;
        notice.value = '已取消本次检索，输入内容保留。';
    }
    function clear() {
        invalidate();
        draft.value = '';
        attempted.value = false;
    }
    const pageProblem = computed(() => {
        if (
            !committed.value ||
            !query.isSuccess.value ||
            !query.data.value ||
            query.data.value.intent !== generation.value ||
            query.data.value.pageCursor !== cursor.value
        )
            return '';
        try {
            const page = searchPage(query.data.value.data, cursor.value);
            const seen = new Set(previous.value.flatMap((entry) => entry.keys));
            if (page.items.some((item) => seen.has(searchHitKey(item))))
                invalidSearch('搜索结果跨页重复');
            if (page.nextCursor && previous.value.some((entry) => entry.cursor === page.nextCursor))
                invalidSearch('搜索游标形成循环');
            return '';
        } catch {
            return '搜索分页内容重复或校验失败，请从第一页重新读取。';
        }
    });
    const ready = computed(
        () =>
            !!committed.value &&
            query.data.value?.intent === generation.value &&
            query.data.value?.pageCursor === cursor.value &&
            query.isSuccess.value &&
            !query.isFetching.value &&
            !pageProblem.value,
    );
    const items = computed(() => (ready.value ? (query.data.value?.data.items ?? []) : []));
    const canNext = computed(() => ready.value && !!query.data.value?.data.nextCursor);
    function next() {
        if (!canNext.value) return;
        previous.value.push({ cursor: cursor.value, keys: items.value.map(searchHitKey) });
        cursor.value = query.data.value!.data.nextCursor!;
    }
    function back() {
        if (!committed.value || query.isFetching.value || !previous.value.length) return;
        cursor.value = previous.value.pop()!.cursor;
    }
    async function first() {
        if (!committed.value) return;
        const scope = lifecycle.capture();
        const intent = generation.value;
        previous.value = [];
        cursor.value = undefined;
        await nextTick();
        if (scope.isCurrent() && committed.value && generation.value === intent)
            await query.refetch({ cancelRefetch: false });
    }
    onScopeDispose(() => {
        stopTimer();
        void lifecycle.queryClient.cancelQueries({ queryKey: options.value.queryKey, exact: true });
    });
    return {
        draft,
        kind,
        bookmarked,
        composing,
        committed,
        cursor,
        previous,
        notice,
        attempted,
        inputIssue,
        valid,
        query,
        ready,
        items,
        canNext,
        pageProblem,
        submit,
        beginComposition,
        endComposition,
        cancel,
        clear,
        next,
        back,
        first,
    };
}
