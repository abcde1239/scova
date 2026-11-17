import { computed, reactive, ref, watch } from 'vue';
import { type TaskConfig, type TaskDetailResponse } from '@scova/models';
import { updateTaskEndpoint, taskKeys } from '@/api/tasks';
import type { ApiResponse } from '@/api/client';
import type { SessionLifecycle } from '@/api/session';
import { toApiError } from '@/api/errors';
import { useCommand } from '@/composables/useCommand';
import { type SavedSchedule } from '@/utils/schedule';
import {
    validateTaskEditResponse,
    taskValidationFields,
    saveNotConfirmed,
    taskEditOptions,
} from './fields.ts';
import { taskDraftFromConfig, type TaskDraftField, initialTaskDraft, taskInput } from './draft.ts';

/** A form-local working copy; background Query updates never overwrite the draft or its ETag. */
export function editTaskController(
    lifecycle: SessionLifecycle,
    initial: ApiResponse<TaskDetailResponse>,
) {
    const taskId = initial.data.task.id;
    validateTaskEditResponse(initial, taskId);
    const owner = lifecycle.capture();
    const draft = reactive(taskDraftFromConfig(initial.data.version.config));
    let original: TaskConfig | undefined;
    let etag: string | undefined;
    let baseline = '';
    const command = useCommand();
    const fields = ref<Partial<Record<TaskDraftField, string>>>({});
    const message = ref('');
    const saved = ref(false);
    const uncertain = ref(false);
    const expired = ref(false);
    const conflict = ref(false);
    const blocked = ref(false);
    const reloadRequested = ref(false);
    const result = ref<TaskDetailResponse>();
    const revision = ref(initial.data.version.version);
    const scheduleDescription = ref('');
    const serverPlan = ref<SavedSchedule>();
    const controller = new AbortController();
    let disposed = false;
    const baselineRevision = ref(0);
    const dirty = computed(() => {
        void baselineRevision.value;
        return JSON.stringify(draft) !== baseline;
    });
    function install(response: ApiResponse<TaskDetailResponse>) {
        validateTaskEditResponse(response, taskId);
        original = JSON.parse(JSON.stringify(response.data.version.config)) as TaskConfig;
        etag = response.headers.etag;
        Object.assign(draft, taskDraftFromConfig(original));
        baseline = JSON.stringify(draft);
        baselineRevision.value++;
        revision.value = response.data.version.version;
        serverPlan.value = {
            schedule: response.data.version.config.schedule,
            timezone: response.data.version.config.timezone,
            nextRunAt: response.data.task.nextRunAt,
            status: response.data.task.status,
        };
        const schedule = original.schedule;
        scheduleDescription.value =
            schedule.frequency === 'manual'
                ? '仅手动执行'
                : schedule.frequency === 'daily'
                  ? `每日 ${schedule.localTime}（任务时区 ${original.timezone}）`
                  : `每周${['一', '二', '三', '四', '五', '六', '日'][schedule.weekday - 1]} ${schedule.localTime}（任务时区 ${original.timezone}）`;
        conflict.value = false;
        blocked.value = response.data.task.status === 'archived';
        uncertain.value = false;
        fields.value = {};
        message.value = blocked.value ? '该任务已归档，不能保存修改。' : '';
    }
    install(initial);
    const stopDirty = watch(
        dirty,
        (value) => {
            if (value) saved.value = false;
        },
        { flush: 'sync' },
    );
    const unregister = owner.registerCleanup(() => {
        expired.value = true;
        controller.abort();
        original = undefined;
        etag = undefined;
        Object.assign(draft, initialTaskDraft());
        fields.value = {};
        message.value = '';
        result.value = undefined;
        scheduleDescription.value = '';
        serverPlan.value = undefined;
        reloadRequested.value = false;
        saved.value = false;
    });
    async function submit(): Promise<TaskDetailResponse | undefined> {
        if (
            disposed ||
            expired.value ||
            !owner.isCurrent() ||
            uncertain.value ||
            conflict.value ||
            blocked.value ||
            !dirty.value
        )
            return;
        return command.run(async () => {
            fields.value = {};
            message.value = '';
            saved.value = false;
            let dispatched = false;
            try {
                if (!original || !etag) return;
                const input = taskInput(draft, original);
                dispatched = true;
                const response = await owner.request(
                    updateTaskEndpoint,
                    { params: { taskId }, body: input },
                    { ifMatch: etag, signal: controller.signal },
                );
                if (disposed || !owner.isCurrent()) return;
                install(response);
                result.value = response.data;
                saved.value = true;
                await lifecycle.queryClient.invalidateQueries({
                    queryKey: owner.queryKey(taskKeys.all),
                });
                return !disposed && owner.isCurrent() ? response.data : undefined;
            } catch (cause) {
                if (disposed || !owner.isCurrent()) return;
                const error = toApiError(cause);
                if (error.kind === 'cancelled') return;
                conflict.value =
                    (error.status === 409 && error.code !== 'TASK_ARCHIVED') ||
                    error.status === 412;
                blocked.value =
                    error.code === 'TASK_ARCHIVED' || error.status === 403 || error.status === 404;
                uncertain.value = dispatched && saveNotConfirmed(error.status);
                if (conflict.value)
                    message.value =
                        '任务已被其他页面修改，当前草稿已保留且可复制。请核对最新版本，手动合并后再保存。';
                else if (error.code === 'TASK_ARCHIVED')
                    message.value = '该任务已归档，不能保存修改。当前草稿已保留。';
                else if (blocked.value)
                    message.value = '当前账号无法修改这项任务。草稿已保留，请检查权限或重新登录。';
                else if (uncertain.value)
                    message.value =
                        '保存结果未确认，当前草稿已保留。请先重新读取核对，避免重复写入。';
                else {
                    fields.value = taskValidationFields(draft.rangeKind, error.fieldErrors);
                    message.value = Object.keys(fields.value).length
                        ? '请检查标出的字段'
                        : error.status === 429
                          ? '保存过于频繁，请稍后重试'
                          : '修改未保存，请稍后重试';
                }
            }
        });
    }
    async function reload() {
        if (!reloadRequested.value || disposed || expired.value || !owner.isCurrent()) return;
        return command.run(async () => {
            try {
                const options = taskEditOptions(lifecycle, taskId);
                const response = await lifecycle.queryClient.fetchQuery({
                    ...options,
                    staleTime: 0,
                    queryFn: (context) =>
                        options.queryFn({
                            signal: AbortSignal.any([context.signal, controller.signal]),
                        }),
                });
                if (disposed || !owner.isCurrent()) return;
                install(response);
                result.value = undefined;
                saved.value = false;
                reloadRequested.value = false;
            } catch (cause) {
                if (disposed || !owner.isCurrent() || toApiError(cause).kind === 'cancelled')
                    return;
                message.value = '重新读取失败，原草稿和修订依据仍保留，请稍后重试。';
            }
        });
    }
    function canLeave(confirm: () => boolean) {
        if (expired.value || !owner.isCurrent()) return true;
        if (command.pending.value) return false;
        return expired.value || (!dirty.value && !uncertain.value) || confirm();
    }
    function dispose() {
        disposed = true;
        controller.abort();
        unregister();
        stopDirty();
        original = undefined;
        etag = undefined;
    }
    return {
        draft,
        dirty,
        pending: command.pending,
        fields,
        message,
        saved,
        uncertain,
        expired,
        submit,
        canLeave,
        dispose,
        conflict,
        blocked,
        reloadRequested,
        reload,
        result,
        revision,
        scheduleDescription,
        serverPlan,
    };
}
