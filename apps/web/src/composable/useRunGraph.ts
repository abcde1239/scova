import { computed, shallowRef, toValue, watch, type MaybeRefOrGetter } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { UuidSchema, parseContract } from '@scova/models';
import { runGraphQueryOptions } from '@/api/run-graph';
import { toApiError } from '@/api/errors';
import { useSessionLifecycle } from '@/composable/useSessionQuery';

const fallbackId = '00000000-0000-4000-8000-000000000000';
export function useRunGraph(
    target: MaybeRefOrGetter<string | undefined>,
    lifecycle = useSessionLifecycle(),
) {
    const id = computed(() => {
        try {
            return parseContract(UuidSchema, toValue(target));
        } catch {
            return undefined;
        }
    });
    const requiredSeq = shallowRef(0);
    const synchronizationError = shallowRef(false);
    let catchUpRequests = 0;
    watch(
        () => [id.value, lifecycle.session.epoch],
        () => {
            requiredSeq.value = 0;
            catchUpRequests = 0;
            synchronizationError.value = false;
        },
        { flush: 'sync' },
    );
    const query = useQuery(
        computed(() => ({
            ...runGraphQueryOptions(lifecycle, id.value ?? fallbackId),
            enabled: !!id.value && !!lifecycle.session.user,
        })),
        lifecycle.queryClient,
    );
    const snapshot = computed(() => {
        if (!id.value || !lifecycle.session.user) return undefined;
        const error = query.error.value ? toApiError(query.error.value) : undefined;
        if (
            [401, 403, 404].includes(error?.status ?? 0) ||
            error?.kind === 'protocol' ||
            error?.kind === 'validation'
        )
            return undefined;
        const value = query.data.value?.data;
        return value?.runId === id.value ? value : undefined;
    });
    function requireSeq(seq: number) {
        if (!id.value || !Number.isSafeInteger(seq) || seq < 0 || seq <= requiredSeq.value) return;
        requiredSeq.value = seq;
        catchUpRequests = 0;
        synchronizationError.value = false;
    }
    // Invalidating during the first request may retain that in-flight GET.
    // Catch up once it settles, including when a terminal/reset event is last.
    watch(
        () => [
            snapshot.value?.seq,
            query.isFetching.value,
            query.isPaused.value,
            requiredSeq.value,
        ],
        () => {
            if (!snapshot.value || query.isFetching.value || query.isPaused.value) return;
            if (snapshot.value.seq >= requiredSeq.value) {
                synchronizationError.value = false;
                return;
            }
            if (catchUpRequests >= 2) {
                synchronizationError.value = true;
                return;
            }
            catchUpRequests++;
            void query.refetch({ cancelRefetch: false });
        },
        { flush: 'post' },
    );
    const stale = computed(
        () =>
            query.isError.value ||
            query.isPaused.value ||
            synchronizationError.value ||
            (!!snapshot.value && snapshot.value.seq < requiredSeq.value),
    );
    function refresh() {
        catchUpRequests = 0;
        synchronizationError.value = false;
        return query.refetch();
    }
    return { query, snapshot, requireSeq, requiredSeq, stale, refresh };
}
