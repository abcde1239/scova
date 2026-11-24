import { useQuery } from '@tanstack/vue-query';
import { computed, ref, toValue, watch, type MaybeRefOrGetter } from 'vue';
import { toApiError } from '@/api/errors';
import { streamThreadItems, type ThreadConnection } from '@/api/project-thread-events';
import {
    projectThreadsEndpoint,
    threadSnapshotEndpoint,
    type ThreadItem,
    type ThreadSnapshot,
} from '@/api/project-threads';
import type { ApiResponse } from '@/api/client';
import { useSessionLifecycle } from '@/composable/useSessionQuery';

export function useProjectThreads(
    project: MaybeRefOrGetter<string | undefined>,
    lifecycle = useSessionLifecycle(),
) {
    return useQuery(
        computed(() => {
            const projectId = toValue(project) ?? '';
            const options = lifecycle.queryOptions(
                projectThreadsEndpoint,
                { params: { projectId } },
                ['project-threads', projectId],
            );
            return { ...options, enabled: options.enabled && !!projectId, retry: false };
        }),
        lifecycle.queryClient,
    );
}

export function useThreadTimeline(
    projectId: string,
    threadId: string,
    lifecycle = useSessionLifecycle(),
) {
    const options = computed(() => {
        const base = lifecycle.queryOptions(threadSnapshotEndpoint, { params: { threadId } }, [
            'thread',
            threadId,
        ]);
        return {
            ...base,
            staleTime: 0,
            retry: false,
            refetchOnWindowFocus: false,
            refetchOnReconnect: false,
        };
    });
    const query = useQuery(options, lifecycle.queryClient);
    const snapshot = computed(() => {
        if (!query.isFetchedAfterMount.value || query.isError.value) return;
        const data = query.data.value?.data;
        if (data?.thread.id === threadId && data.thread.projectId === projectId) return data;
    });
    const wrongProject = computed(
        () =>
            query.isFetchedAfterMount.value &&
            !query.isError.value &&
            !!query.data.value &&
            !snapshot.value,
    );
    const connection = ref<ThreadConnection>('connecting');
    const streamFailure = ref('');
    const streamBlocked = ref(false);
    const restart = ref(0);
    const loaded = computed(() => !!snapshot.value && !query.isFetching.value);
    watch(
        [loaded, () => lifecycle.session.epoch, restart],
        ([ready], _previous, onCleanup) => {
            if (!ready) return;
            const scope = lifecycle.capture();
            const abort = new AbortController();
            const key = options.value.queryKey;
            const current = () => scope.isCurrent() && !abort.signal.aborted;
            let timer: ReturnType<typeof setTimeout> | undefined;
            let after = snapshot.value!.lastSeq;
            let retries = 0;
            const close = () => {
                abort.abort();
                clearTimeout(timer);
            };
            const unregister = scope.registerCleanup(close);
            onCleanup(() => {
                unregister();
                close();
            });
            connection.value = 'connecting';
            streamFailure.value = '';
            streamBlocked.value = false;

            function append(item: ThreadItem) {
                if (!current() || item.seq <= after) return;
                if (item.seq !== after + 1) throw new Error('会话条目序号不连续');
                after = item.seq;
                retries = 0;
                lifecycle.queryClient.setQueryData<ApiResponse<ThreadSnapshot>>(key, (existing) => {
                    if (!existing || item.seq <= existing.data.lastSeq) return existing;
                    return {
                        ...existing,
                        data: {
                            ...existing.data,
                            items: [...existing.data.items, item],
                            lastSeq: item.seq,
                        },
                    };
                });
            }
            async function connect() {
                if (!current()) return;
                let openedAt = 0;
                try {
                    await streamThreadItems(scope, threadId, after, abort.signal, append, () => {
                        if (!current()) return;
                        connection.value = 'open';
                        openedAt = Date.now();
                    });
                } catch (cause) {
                    if (!current()) return;
                    const error = toApiError(cause);
                    if (error.status === 403 || error.status === 404) {
                        streamBlocked.value = true;
                        streamFailure.value = '此会话已无法访问';
                        connection.value = 'error';
                        return;
                    }
                }
                if (!current()) return;
                if (openedAt && Date.now() - openedAt >= 45_000) retries = 0;
                if (retries >= 6) {
                    streamFailure.value = '实时连接已断开';
                    connection.value = 'error';
                    return;
                }
                connection.value = 'reconnecting';
                timer = setTimeout(() => void connect(), Math.min(500 * 2 ** retries++, 8000));
            }
            void connect();
        },
        { immediate: true },
    );

    function updateThread(thread: ThreadSnapshot['thread']) {
        lifecycle.queryClient.setQueryData<ApiResponse<ThreadSnapshot>>(
            options.value.queryKey,
            (existing) =>
                existing ? { ...existing, data: { ...existing.data, thread } } : existing,
        );
    }
    return {
        query,
        snapshot,
        wrongProject,
        connection,
        streamFailure,
        streamBlocked,
        updateThread,
        reconnect: () => restart.value++,
    };
}

export function invalidateProjectThreads(
    lifecycle: ReturnType<typeof useSessionLifecycle>,
    projectId: string,
) {
    return lifecycle.queryClient.invalidateQueries({
        queryKey: lifecycle.capture().queryKey(['project-threads', projectId]),
    });
}
