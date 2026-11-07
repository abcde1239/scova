import {
    computed,
    nextTick,
    onScopeDispose,
    ref,
    shallowRef,
    toValue,
    watch,
    type MaybeRefOrGetter,
} from 'vue';
import { useQuery } from '@tanstack/vue-query';
import type { TaskDetailResponse } from '@scova/models';
import type { ApiResponse } from '@/api/client';
import type { SessionLifecycle } from '@/api/session';
import { toApiError } from '@/api/errors';
import { taskKeys } from '@/api/tasks';
import {
    requestTaskLifecycle,
    requestTaskDeletion,
    taskLifecycleOptions,
    type TaskLifecycleAction,
} from '@/api/task-lifecycle';
import { useCommand } from '@/composables/useCommand';
import { useSessionLifecycle } from '@/composables/useSessionQuery';

export function useTaskLifecycle(
    target: MaybeRefOrGetter<string>,
    lifecycle: SessionLifecycle = useSessionLifecycle(),
) {
    const read = useQuery(
        computed(() => taskLifecycleOptions(lifecycle, toValue(target))),
        lifecycle.queryClient,
    );
    const command = useCommand();
    const message = ref('');
    const blocked = ref(true);
    const refreshing = ref(false);
    const removed = ref(false);
    const confirmation = shallowRef<ApiResponse<TaskDetailResponse>>();
    let generation = 0;
    let controller = new AbortController();
    const snapshot = computed(() => {
        const error = read.error.value ? toApiError(read.error.value) : undefined;
        if (
            !lifecycle.session.user ||
            [401, 403, 404].includes(error?.status ?? 0) ||
            error?.kind === 'validation' ||
            error?.kind === 'protocol'
        )
            return undefined;
        const value = read.data.value;
        return value?.data.task.id === toValue(target) ? value : undefined;
    });
    const disabled = computed(
        () =>
            removed.value ||
            blocked.value ||
            refreshing.value ||
            command.pending.value ||
            !snapshot.value,
    );
    function clear() {
        generation++;
        controller.abort();
        controller = new AbortController();
        confirmation.value = undefined;
        message.value = '';
        blocked.value = true;
        refreshing.value = false;
        removed.value = false;
    }
    async function refresh(keepMessage = false) {
        if (refreshing.value || !lifecycle.session.user || (command.pending.value && !keepMessage))
            return false;
        const current = generation;
        const scope = lifecycle.capture();
        blocked.value = true;
        refreshing.value = true;
        confirmation.value = undefined;
        try {
            await nextTick();
            if (current !== generation || !scope.isCurrent()) return false;
            // refetch强制实际GET；旧摘要缓存或背景替换不能解除冲突/未知锁。
            const result = await read.refetch({ throwOnError: true, cancelRefetch: true });
            if (current !== generation || !scope.isCurrent()) return false;
            if (!result.data || result.data.data.task.id !== toValue(target)) return false;
            blocked.value = false;
            if (!keepMessage) message.value = '已重新读取任务状态，请根据当前状态选择操作。';
            return true;
        } catch (cause) {
            if (current !== generation || !scope.isCurrent()) return false;
            if (toApiError(cause).kind !== 'cancelled')
                message.value = '任务状态读取失败，操作保持锁定。请稍后刷新任务状态。';
            return false;
        } finally {
            if (current === generation) refreshing.value = false;
        }
    }
    watch(
        [() => toValue(target), () => lifecycle.session.epoch],
        () => {
            clear();
            void refresh(true);
        },
        { immediate: true, flush: 'sync' },
    );
    onScopeDispose(() => {
        clear();
        controller.abort();
    });

    function prepareArchive() {
        if (disabled.value || snapshot.value?.data.task.status === 'archived') return false;
        confirmation.value = snapshot.value;
        return true;
    }
    function cancelArchive() {
        confirmation.value = undefined;
    }
    function prepareDelete() {
        if (disabled.value) return false;
        confirmation.value = snapshot.value;
        return true;
    }
    async function remove() {
        if (disabled.value || !confirmation.value) return false;
        const source = confirmation.value;
        const current = generation;
        const scope = lifecycle.capture();
        const signal = controller.signal;
        return command.run(async () => {
            confirmation.value = undefined;
            blocked.value = true;
            message.value = '';
            try {
                await requestTaskDeletion(scope, source, signal);
                if (current !== generation || !scope.isCurrent() || signal.aborted) return false;
                removed.value = true;
                await lifecycle.queryClient.cancelQueries({ queryKey: scope.queryKey([]) });
                lifecycle.queryClient.removeQueries({
                    queryKey: scope.queryKey(taskKeys.detail(source.data.task.id)),
                });
                void lifecycle.queryClient.invalidateQueries({ queryKey: scope.queryKey([]) });
                return true;
            } catch (cause) {
                if (current !== generation || !scope.isCurrent() || signal.aborted) return false;
                const error = toApiError(cause);
                message.value =
                    error.code === 'TASK_RUN_ACTIVE'
                        ? '任务仍有活动执行，请先请求取消，等待执行结束后再清除。'
                        : [409, 412, 428].includes(error.status ?? 0)
                          ? '任务状态已变化，请刷新后重新确认清除。'
                          : !error.status ||
                              error.status >= 500 ||
                              ['validation', 'protocol'].includes(error.kind)
                            ? '尚不能确认清除结果，不会自动重发。请刷新任务列表核对。'
                            : `清除未完成（${error.status}），请刷新后核对任务与权限。`;
                return false;
            }
        });
    }
    async function submit(action: TaskLifecycleAction) {
        if (disabled.value) return;
        const source = action === 'archive' ? confirmation.value : snapshot.value;
        if (!source || source.data.task.id !== toValue(target)) return;
        const status = source.data.task.status;
        if (
            status === 'archived' ||
            (action === 'pause' && status !== 'active') ||
            (action === 'resume' && status !== 'paused')
        )
            return;
        const scope = lifecycle.capture();
        const current = generation;
        const signal = controller.signal;
        await command.run(async () => {
            confirmation.value = undefined;
            message.value = '';
            blocked.value = true;
            try {
                await requestTaskLifecycle(scope, action, source, signal);
                if (current !== generation || !scope.isCurrent() || signal.aborted) return;
                message.value =
                    action === 'pause'
                        ? '未来计划已暂停；在途执行继续，仍可显式手动执行。'
                        : action === 'resume'
                          ? '未来计划已恢复，不补跑暂停期间的历史时点。'
                          : '任务已归档，不再允许新执行；活动执行已请求取消，报告与历史保留。';
                await lifecycle.queryClient.invalidateQueries({
                    queryKey: scope.queryKey(taskKeys.all),
                });
                if (action === 'archive') {
                    void lifecycle.queryClient.invalidateQueries({
                        queryKey: scope.queryKey(['run']),
                    });
                    void lifecycle.queryClient.invalidateQueries({
                        queryKey: scope.queryKey(['runs']),
                    });
                }
                if (current === generation && scope.isCurrent()) await refresh(true);
            } catch (cause) {
                if (current !== generation || !scope.isCurrent() || signal.aborted) return;
                const error = toApiError(cause);
                if (error.kind === 'cancelled') return;
                message.value = [409, 412, 428].includes(error.status ?? 0)
                    ? `任务状态或修订已变化（${error.status}），请刷新任务状态后重新选择操作。`
                    : !error.status ||
                        error.status === 408 ||
                        error.status >= 500 ||
                        error.kind === 'validation' ||
                        error.kind === 'protocol'
                      ? '尚不能确认操作结果，不会直接重发。请刷新任务状态核对后重新选择。'
                      : `操作未完成（${error.status}），请刷新任务状态并核对权限。`;
            }
        });
    }
    return {
        snapshot,
        message,
        blocked,
        refreshing,
        pending: command.pending,
        disabled,
        confirmation,
        prepareArchive,
        cancelArchive,
        submit,
        refresh,
        removed,
        prepareDelete,
        remove,
        read,
    };
}
