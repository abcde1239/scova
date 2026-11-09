import {
    computed,
    onScopeDispose,
    ref,
    shallowRef,
    toValue,
    watch,
    type MaybeRefOrGetter,
} from 'vue';
import type { Task, TaskDetailResponse } from '@scova/models';
import type { ApiResponse } from '@/api/client';
import type { SessionLifecycle } from '@/api/session';
import { toApiError } from '@/api/errors';
import { taskEndpoint, taskKeys } from '@/api/tasks';
import { requestTaskDeletion, validateLifecycleSnapshot } from '@/api/task-lifecycle';
import { useSessionLifecycle } from '@/composables/useSessionQuery';

export const bulkTaskLimit = 50;
type Result = {
    id: string;
    title: string;
    status: 'removed' | 'rejected' | 'unknown' | 'skipped';
    message: string;
};

export function useBulkTaskDeletion(
    tasks: MaybeRefOrGetter<readonly Task[]>,
    lifecycle: SessionLifecycle = useSessionLifecycle(),
) {
    const selected = shallowRef<Task[]>([]);
    const confirmation = shallowRef<ApiResponse<TaskDetailResponse>[]>([]);
    const results = shallowRef<Result[]>([]);
    const preparing = ref(false);
    const pending = ref(false);
    const message = ref('');
    const busy = computed(() => preparing.value || pending.value);
    const phrase = computed(() => `清除 ${confirmation.value.length} 个任务`);
    let generation = 0;
    let controller = new AbortController();

    function reset() {
        generation++;
        controller.abort();
        controller = new AbortController();
        selected.value = [];
        confirmation.value = [];
        results.value = [];
        preparing.value = false;
        pending.value = false;
        message.value = '';
    }
    watch(() => lifecycle.session.epoch, reset, { flush: 'sync' });
    onScopeDispose(() => {
        reset();
        controller.abort();
    });
    watch(
        () => toValue(tasks),
        (current) => {
            if (busy.value) return;
            const kept = selected.value.filter((item) =>
                current.some(
                    (task) =>
                        task.id === item.id &&
                        task.revision === item.revision &&
                        task.title === item.title,
                ),
            );
            if (kept.length !== selected.value.length) {
                selected.value = kept;
                confirmation.value = [];
                message.value = '任务列表已变化，受影响的选择已取消，请重新核对。';
            }
        },
    );
    function toggle(task: Task) {
        if (busy.value || confirmation.value.length) return;
        if (selected.value.some((item) => item.id === task.id))
            selected.value = selected.value.filter((item) => item.id !== task.id);
        else if (
            selected.value.length < bulkTaskLimit &&
            toValue(tasks).some((item) => item.id === task.id)
        )
            selected.value = [...selected.value, { ...task }];
    }
    function selectLoaded() {
        if (busy.value || confirmation.value.length) return;
        selected.value = toValue(tasks)
            .slice(0, bulkTaskLimit)
            .map((task) => ({ ...task }));
    }
    function clearSelection() {
        if (busy.value) return;
        selected.value = [];
        confirmation.value = [];
    }
    function cancel() {
        if (!pending.value) confirmation.value = [];
    }
    async function prepare() {
        if (busy.value || !selected.value.length || !lifecycle.session.user) return false;
        const scope = lifecycle.capture();
        const current = generation;
        const signal = controller.signal;
        const selection = [...selected.value];
        confirmation.value = [];
        results.value = [];
        message.value = '';
        preparing.value = true;
        try {
            const snapshots: ApiResponse<TaskDetailResponse>[] = [];
            for (const task of selection) {
                const response = validateLifecycleSnapshot(
                    await scope.request(taskEndpoint, { params: { taskId: task.id } }, { signal }),
                    task.id,
                );
                if (current !== generation || !scope.isCurrent() || signal.aborted) return false;
                if (
                    response.data.task.revision !== task.revision ||
                    response.data.task.title !== task.title
                ) {
                    selected.value = [];
                    message.value = '所选任务已变化，未执行清除。请刷新任务列表后重新选择。';
                    return false;
                }
                snapshots.push(response);
            }
            confirmation.value = snapshots;
            return true;
        } catch {
            if (current === generation && scope.isCurrent() && !signal.aborted)
                message.value = '无法核对全部所选任务，未执行清除。请刷新任务列表后重试。';
            return false;
        } finally {
            if (current === generation) preparing.value = false;
        }
    }
    async function remove(text: string) {
        if (
            busy.value ||
            !confirmation.value.length ||
            text.trim() !== phrase.value ||
            !lifecycle.session.user
        )
            return;
        const scope = lifecycle.capture();
        const current = generation;
        const signal = controller.signal;
        const snapshots = [...confirmation.value];
        pending.value = true;
        results.value = [];
        message.value = '';
        let stop = false;
        try {
            for (const snapshot of snapshots) {
                if (current !== generation || !scope.isCurrent() || signal.aborted) return;
                const task = snapshot.data.task;
                let result: Result;
                if (stop)
                    result = {
                        id: task.id,
                        title: task.title,
                        status: 'skipped',
                        message: '未发送清除请求，请核对前面的结果后重新选择。',
                    };
                else
                    try {
                        await requestTaskDeletion(scope, snapshot, signal);
                        result = {
                            id: task.id,
                            title: task.title,
                            status: 'removed',
                            message: '已清除',
                        };
                    } catch (cause) {
                        if (current !== generation || !scope.isCurrent() || signal.aborted) return;
                        const error = toApiError(cause);
                        const uncertain =
                            !error.status ||
                            error.status === 408 ||
                            error.status >= 500 ||
                            ['validation', 'protocol', 'cancelled'].includes(error.kind);
                        stop = uncertain || [401, 403, 429].includes(error.status ?? 0);
                        result = {
                            id: task.id,
                            title: task.title,
                            status: uncertain ? 'unknown' : 'rejected',
                            message: uncertain
                                ? '结果待核对，未自动重发；请刷新任务列表确认。'
                                : error.code === 'TASK_RUN_ACTIVE'
                                  ? '仍有活动执行，请取消并等待结束后重新选择。'
                                  : [409, 412, 428].includes(error.status ?? 0)
                                    ? '任务已变化，请刷新后重新选择并确认。'
                                    : error.status === 404
                                      ? '任务不存在或无权访问，请刷新核对。'
                                      : '未清除，请核对权限或稍后重新选择。',
                        };
                    }
                if (current !== generation || !scope.isCurrent() || signal.aborted) return;
                results.value = [...results.value, result];
            }
            const removed = results.value.filter((item) => item.status === 'removed').length;
            message.value = `批量清除结束：已清除 ${removed} 个，其他 ${snapshots.length - removed} 个。请查看逐项结果。`;
            selected.value = [];
            await lifecycle.queryClient.cancelQueries({ queryKey: scope.queryKey([]) });
            if (current !== generation || !scope.isCurrent() || signal.aborted) return;
            for (const item of results.value.filter((item) => item.status === 'removed'))
                lifecycle.queryClient.removeQueries({
                    queryKey: scope.queryKey(taskKeys.detail(item.id)),
                });
            void lifecycle.queryClient.invalidateQueries({ queryKey: scope.queryKey([]) });
        } finally {
            if (current === generation) {
                confirmation.value = [];
                pending.value = false;
            }
        }
    }
    return {
        selected,
        confirmation,
        results,
        preparing,
        pending,
        busy,
        message,
        phrase,
        toggle,
        selectLoaded,
        clearSelection,
        prepare,
        cancel,
        remove,
    };
}
