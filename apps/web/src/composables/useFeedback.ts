import { computed, onScopeDispose, ref, toValue, watch, type MaybeRefOrGetter } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import {
    ContractValidationError,
    UuidSchema,
    parseContract,
    type Feedback,
    type FeedbackInput,
    type Report,
} from '@scova/models';
import { revokeFeedbackEndpoint, setFeedbackEndpoint, taskFeedbackEndpoint } from '@/api/feedback';
import { toApiError } from '@/api/errors';
import type { SessionLifecycle } from '@/api/session';
import { useSessionLifecycle } from '@/composables/useSessionQuery';

export interface FeedbackTarget {
    type: 'source' | 'claim';
    id: string;
    label: string;
}
export const feedbackKinds = [
    { kind: 'irrelevant', label: '不相关', icon: 'close' },
    { kind: 'known', label: '已了解', icon: 'confirm' },
    { kind: 'deeper', label: '希望深入', icon: 'search' },
] as const;
export const feedbackLabels = Object.fromEntries(
    feedbackKinds.map(({ kind, label }) => [kind, label]),
) as Record<Feedback['kind'], string>;
export const targetKey = (target: Pick<FeedbackTarget, 'type' | 'id'>) =>
    `${target.type}:${target.id.toLowerCase()}`;
const recordKey = (item: Feedback) =>
    item.sourceId
        ? `source:${item.sourceId.toLowerCase()}`
        : `claim:${item.claimId?.toLowerCase()}`;

export function reportFeedbackTargets(report: Report): FeedbackTarget[] {
    const sources = new Map<string, FeedbackTarget>();
    for (const evidence of report.evidence) {
        const id = evidence.sourceId.toLowerCase();
        if (!sources.has(id)) sources.set(id, { type: 'source', id, label: evidence.title });
    }
    return [
        ...sources.values(),
        ...report.claims.map((claim) => ({
            type: 'claim' as const,
            id: claim.id.toLowerCase(),
            label: claim.text,
        })),
    ];
}
function invalid(message: string): never {
    throw new ContractValidationError([{ path: '/feedback', message }]);
}
export function validateFeedbackList(items: Feedback[], taskId: string) {
    if (
        items.length > 200 ||
        items.some((item) => item.taskId.toLowerCase() !== taskId || !item.active) ||
        new Set(items.map((item) => item.id.toLowerCase())).size !== items.length ||
        new Set(items.map(recordKey)).size !== items.length
    )
        invalid('当前反馈列表的任务、状态或目标不一致');
    return items;
}
function validId(value: unknown): string | undefined {
    try {
        return parseContract(UuidSchema, value).toLowerCase();
    } catch {
        return undefined;
    }
}

export function useFeedback(
    task: MaybeRefOrGetter<unknown>,
    target: MaybeRefOrGetter<FeedbackTarget | undefined>,
    lifecycle: SessionLifecycle = useSessionLifecycle(),
) {
    const taskId = computed(() => validId(toValue(task)));
    const selected = computed(() => {
        const value = toValue(target);
        const id = validId(value?.id);
        return value && id && ['source', 'claim'].includes(value.type)
            ? { ...value, id }
            : undefined;
    });
    const pending = ref(false);
    const needsRecheck = ref(false);
    const notice = ref('');
    let operation: AbortController | undefined;
    let operationKey: readonly unknown[] | undefined;
    let alive = true;
    let readRevision = 0;
    const context = () =>
        `${lifecycle.session.epoch}/${taskId.value}/${selected.value ? targetKey(selected.value) : ''}`;
    const queryOptions = computed(() => {
        const id = taskId.value ?? '';
        const options = lifecycle.queryOptions(taskFeedbackEndpoint, { params: { taskId: id } }, [
            'feedback',
            id,
        ]);
        return {
            ...options,
            enabled: options.enabled && !!taskId.value,
            async queryFn(input: { signal: AbortSignal }) {
                const response = await options.queryFn(input);
                if (response.status !== 200) invalid('反馈列表没有返回确认的读取结果');
                validateFeedbackList(response.data.items, id);
                input.signal.throwIfAborted();
                readRevision++;
                return response;
            },
        };
    });
    const query = useQuery(queryOptions, lifecycle.queryClient);
    function requireFreshRead(key: readonly unknown[] = queryOptions.value.queryKey) {
        // A remounted panel must also fetch after an unconfirmed write, rather than reuse fresh cache.
        void lifecycle.queryClient.invalidateQueries({
            queryKey: key,
            exact: true,
            refetchType: 'none',
        });
    }
    const itemsKnown = computed(() => {
        const error = toApiError(query.error.value);
        return (
            !!query.data.value &&
            !(
                [401, 403, 404].includes(error.status ?? 0) ||
                ['validation', 'protocol'].includes(error.kind)
            )
        );
    });
    const items = computed(() => (itemsKnown.value ? (query.data.value?.data.items ?? []) : []));
    const current = computed(() =>
        selected.value
            ? items.value.find((item) => recordKey(item) === targetKey(selected.value!))
            : undefined,
    );
    const canWrite = computed(
        () =>
            !!taskId.value &&
            !!lifecycle.session.user &&
            query.isSuccess.value &&
            !query.isFetching.value &&
            !pending.value &&
            !needsRecheck.value,
    );
    const readError = computed(() => {
        const error = toApiError(query.error.value);
        if (error.status === 404) return '任务不存在或当前账号无法访问反馈。';
        if (error.status === 403) return '当前账号无权读取反馈。';
        if (['validation', 'protocol'].includes(error.kind))
            return '反馈列表结构或归属校验失败，暂时无法操作。';
        return '反馈暂时无法读取，请重新读取后再操作。';
    });

    watch(
        () => [lifecycle.session.epoch, taskId.value] as const,
        () => {
            if (operation && operationKey) requireFreshRead(operationKey);
            operation?.abort();
            operation = undefined;
            pending.value = false;
            needsRecheck.value = false;
            notice.value = '';
        },
        { flush: 'sync' },
    );
    watch(
        () => (selected.value ? targetKey(selected.value) : ''),
        () => {
            if (operation) {
                requireFreshRead(operationKey);
                operation.abort();
                operation = undefined;
                pending.value = false;
                needsRecheck.value = true;
            }
            notice.value = '';
        },
        { flush: 'sync' },
    );
    onScopeDispose(() => {
        if (operation || needsRecheck.value) requireFreshRead(operationKey);
        alive = false;
        operation?.abort();
    });

    async function reload() {
        if (pending.value || query.isFetching.value || !taskId.value) return;
        const captured = context();
        const revision = readRevision;
        const result = await query.refetch();
        if (!alive || context() !== captured) return;
        if (result.isSuccess && readRevision > revision) {
            needsRecheck.value = false;
            notice.value = '已重新读取当前生效反馈。';
        }
    }
    async function write(kind: FeedbackInput['kind'] | null, item?: Feedback) {
        const chosen = selected.value;
        if (!canWrite.value || (kind !== null && !chosen)) return;
        if (kind === null && (!item || !items.value.some((entry) => entry.id === item.id))) return;
        if (kind !== null && current.value?.kind === kind) return;
        const id = taskId.value!;
        const scope = lifecycle.capture();
        const captured = context();
        const controller = new AbortController();
        operation = controller;
        pending.value = true;
        notice.value = '';
        const stillCurrent = () =>
            alive && scope.isCurrent() && context() === captured && operation === controller;
        const expectedKey = kind === null ? recordKey(item!) : targetKey(chosen!);
        const existingId = kind === null ? item!.id : current.value?.id;
        const options = queryOptions.value;
        operationKey = options.queryKey;
        try {
            await lifecycle.queryClient.cancelQueries({ queryKey: options.queryKey, exact: true });
            if (!stillCurrent()) return;
            const response =
                kind === null
                    ? await scope.request(
                          revokeFeedbackEndpoint,
                          { params: { feedbackId: item!.id } },
                          { signal: controller.signal },
                      )
                    : await scope.request(
                          setFeedbackEndpoint,
                          {
                              body: {
                                  taskId: id,
                                  ...(chosen!.type === 'source'
                                      ? { sourceId: chosen!.id }
                                      : { claimId: chosen!.id }),
                                  kind,
                              },
                          },
                          { signal: controller.signal },
                      );
            if (!stillCurrent()) return;
            const record = response.data;
            if (
                response.status !== 200 ||
                record.taskId.toLowerCase() !== id ||
                recordKey(record) !== expectedKey ||
                record.active !== (kind !== null) ||
                (existingId !== undefined &&
                    record.id.toLowerCase() !== existingId.toLowerCase()) ||
                (kind !== null && record.kind !== kind) ||
                (kind === null && record.id !== item!.id)
            )
                invalid('反馈写入响应与请求的任务、目标或状态不一致');
            await lifecycle.queryClient.cancelQueries({ queryKey: options.queryKey, exact: true });
            if (!stillCurrent()) return;
            const nextItems = items.value.filter((entry) => recordKey(entry) !== expectedKey);
            if (record.active) nextItems.push(record);
            validateFeedbackList(nextItems, id);
            lifecycle.queryClient.setQueryData(options.queryKey, {
                ...response,
                data: { items: nextItems },
            });
            await lifecycle.queryClient.invalidateQueries({
                queryKey: options.queryKey,
                exact: true,
            });
            if (!stillCurrent()) return;
            notice.value = kind === null ? '已撤销反馈。' : `已设置为“${feedbackLabels[kind]}”。`;
            if (query.isError.value) notice.value += '当前列表尚未读取确认，请重新读取反馈。';
        } catch (cause) {
            if (!stillCurrent()) return;
            const error = toApiError(cause);
            if (error.status === 409 && error.code === 'FEEDBACK_LIMIT')
                notice.value = '最多同时生效 200 条反馈，请先撤销已有反馈。';
            else if (error.status === 404)
                notice.value = '任务或反馈目标不存在，或不属于当前账号与任务。';
            else if ([400, 403, 409, 422].includes(error.status ?? 0))
                notice.value = '反馈未能提交，当前显示保持原状。请核对权限或目标后重试。';
            else {
                needsRecheck.value = true;
                requireFreshRead(options.queryKey);
                notice.value = '提交结果尚未确认，当前显示保留上次读取值。请重新读取反馈后再操作。';
            }
        } finally {
            if (operation === controller) {
                operation = undefined;
                pending.value = false;
            }
        }
    }
    return {
        query,
        items,
        itemsKnown,
        current,
        canWrite,
        pending,
        needsRecheck,
        notice,
        readError,
        reload,
        write,
    };
}
