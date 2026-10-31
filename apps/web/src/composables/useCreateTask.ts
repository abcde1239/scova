import { computed, reactive, ref, watch } from 'vue';
import {
    ContractValidationError,
    CreateTaskInputSchema,
    TimeRangeSchema,
    TaskDetailResponseSchema,
    parseRevisionEtag,
    parseContract,
    type TaskConfig,
    type TaskDetailResponse,
    type SessionResponse,
} from '@scova/models';
import { createTaskEndpoint, taskEndpoint, updateTaskEndpoint, taskKeys } from '@/api/tasks';
import type { ApiResponse } from '@/api/client';
import type { SessionLifecycle } from '@/api/session';
import { toApiError } from '@/api/errors';
import { useCommand } from '@/composables/useCommand';
import { useSessionMutation } from '@/composables/useSessionQuery';

export const budgetFields = [
    { key: 'maxSearches', label: '搜索次数上限' },
    { key: 'maxPages', label: '网页读取次数上限' },
    { key: 'maxDurationSeconds', label: '执行时长上限（秒）' },
    { key: 'maxInputTokens', label: '输入 token 上限' },
    { key: 'maxOutputTokens', label: '输出 token 上限' },
] as const;

export function initialTaskDraft(preferences?: SessionResponse['user']['preferences']) {
    return {
        title: '',
        topic: '',
        goal: '',
        focusPoints: '',
        exclusions: '',
        preferredUrls: '',
        excludedUrls: '',
        officialOnly: false,
        rangeKind: 'rolling',
        days: '7',
        start: '',
        end: '',
        timezone: preferences?.defaultTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
        outputFormat: 'brief',
        maxSearches: '10',
        maxPages: '20',
        maxDurationSeconds: '300',
        maxInputTokens: '40000',
        maxOutputTokens: '8000',
        notificationMode: String(preferences?.notificationPreference.mode ?? 'summary'),
        runIssues: preferences?.notificationPreference.runIssues ?? true,
    };
}
export type TaskDraft = ReturnType<typeof initialTaskDraft>;
export type TaskDraftField = keyof TaskDraft;

/** datetime-local uses the browser timezone; untouched instants remain in the original config. */
export function taskDraftFromConfig(config: TaskConfig): TaskDraft {
    const local = (instant: string) => {
        const date = new Date(instant);
        const pad = (part: number, size = 2) => String(part).padStart(size, '0');
        return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
    };
    return {
        title: config.title,
        topic: config.topic,
        goal: config.goal,
        focusPoints: config.focusPoints.join('\n'),
        exclusions: config.exclusions.join('\n'),
        preferredUrls: config.sourcePreferences.preferredUrls.join('\n'),
        excludedUrls: config.sourcePreferences.excludedUrls.join('\n'),
        officialOnly: config.sourcePreferences.officialOnly,
        rangeKind: config.timeRange.kind,
        days: config.timeRange.kind === 'rolling' ? String(config.timeRange.days) : '7',
        start: config.timeRange.kind === 'fixed' ? local(config.timeRange.start) : '',
        end: config.timeRange.kind === 'fixed' ? local(config.timeRange.end) : '',
        timezone: config.timezone,
        outputFormat: config.outputFormat,
        ...(Object.fromEntries(
            budgetFields.map(({ key }) => [key, String(config.budget[key])]),
        ) as Pick<TaskDraft, (typeof budgetFields)[number]['key']>),
        notificationMode: config.notificationPreference.mode,
        runIssues: config.notificationPreference.runIssues,
    };
}
const lines = (value: string) =>
    value
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

/** 表单值转为公开契约；固定日期由明确标注的浏览器当地时间转成 UTC。 */
export function taskInput(draft: TaskDraft, original?: TaskConfig) {
    const initial = original ? taskDraftFromConfig(original) : undefined;
    const preserve = <T>(field: TaskDraftField, previous: T, next: T): T =>
        initial && draft[field] === initial[field] ? previous : next;
    const instant = (value: string) => {
        const date = new Date(value);
        const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(
            value,
        );
        if (!parts || !Number.isFinite(date.getTime())) return '';
        const local = [
            date.getFullYear(),
            date.getMonth() + 1,
            date.getDate(),
            date.getHours(),
            date.getMinutes(),
            date.getSeconds(),
        ];
        if (local.some((part, index) => part !== Number(parts[index + 1] ?? 0))) return '';
        return date.toISOString();
    };
    const editedRange =
        draft.rangeKind === 'fixed'
            ? {
                  kind: 'fixed',
                  start: preserve(
                      'start',
                      original?.timeRange.kind === 'fixed' ? original.timeRange.start : '',
                      instant(draft.start),
                  ),
                  end: preserve(
                      'end',
                      original?.timeRange.kind === 'fixed' ? original.timeRange.end : '',
                      instant(draft.end),
                  ),
              }
            : { kind: 'rolling', days: Number(draft.days) };
    const range =
        original &&
        initial &&
        draft.rangeKind === initial.rangeKind &&
        (draft.rangeKind === 'fixed'
            ? draft.start === initial.start && draft.end === initial.end
            : draft.days === initial.days)
            ? original.timeRange
            : editedRange;
    // 先校验用户选中的共享分支，避免 Union 的另一分支错误误指向正确日期。
    try {
        parseContract(TimeRangeSchema.anyOf[draft.rangeKind === 'fixed' ? 1 : 0]!, range);
    } catch (cause) {
        if (cause instanceof ContractValidationError)
            throw new ContractValidationError(
                cause.fieldErrors.map((error) => ({
                    ...error,
                    path: `/config/timeRange${error.path === '/' ? '' : error.path}`,
                })),
            );
        throw cause;
    }
    return parseContract(CreateTaskInputSchema, {
        config: {
            title: preserve('title', original?.title ?? '', draft.title.trim()),
            topic: preserve('topic', original?.topic ?? '', draft.topic.trim()),
            goal: preserve('goal', original?.goal ?? '', draft.goal.trim()),
            focusPoints: preserve(
                'focusPoints',
                original?.focusPoints ?? [],
                lines(draft.focusPoints),
            ),
            exclusions: preserve('exclusions', original?.exclusions ?? [], lines(draft.exclusions)),
            sourcePreferences: {
                preferredUrls: preserve(
                    'preferredUrls',
                    original?.sourcePreferences.preferredUrls ?? [],
                    lines(draft.preferredUrls),
                ),
                excludedUrls: preserve(
                    'excludedUrls',
                    original?.sourcePreferences.excludedUrls ?? [],
                    lines(draft.excludedUrls),
                ),
                officialOnly: draft.officialOnly,
            },
            timeRange: range,
            timezone: preserve('timezone', original?.timezone ?? '', draft.timezone.trim()),
            schedule: original?.schedule ?? { frequency: 'manual' },
            outputFormat: draft.outputFormat,
            budget: Object.fromEntries(budgetFields.map(({ key }) => [key, Number(draft[key])])),
            notificationPreference: { mode: draft.notificationMode, runIssues: draft.runIssues },
        },
    });
}

const fieldPaths: Partial<Record<string, TaskDraftField>> = {
    title: 'title',
    topic: 'topic',
    goal: 'goal',
    focusPoints: 'focusPoints',
    exclusions: 'exclusions',
    'sourcePreferences/preferredUrls': 'preferredUrls',
    'sourcePreferences/excludedUrls': 'excludedUrls',
    'sourcePreferences/officialOnly': 'officialOnly',
    'timeRange/days': 'days',
    'timeRange/start': 'start',
    'timeRange/end': 'end',
    timezone: 'timezone',
    outputFormat: 'outputFormat',
    'notificationPreference/mode': 'notificationMode',
    'notificationPreference/runIssues': 'runIssues',
    ...Object.fromEntries(budgetFields.map(({ key }) => [`budget/${key}`, key])),
};
export function taskField(path: string): TaskDraftField | undefined {
    const key = path.replace(/^\/(?:body\/)?config\//, '').replace(/\/\d+$/, '');
    return fieldPaths[key];
}

export function createTaskController(lifecycle: SessionLifecycle) {
    const owner = lifecycle.capture();
    const draft = reactive(initialTaskDraft(lifecycle.session.user?.preferences));
    const initial = JSON.stringify(draft);
    const command = useCommand();
    const mutation = useSessionMutation(createTaskEndpoint, lifecycle);
    const fields = ref<Partial<Record<TaskDraftField, string>>>({});
    const message = ref('');
    const saved = ref(false);
    const uncertain = ref(false);
    const expired = ref(false);
    const controller = new AbortController();
    let disposed = false;
    let attempt: { body: string; key: string } | undefined;
    const dirty = computed(() => !saved.value && JSON.stringify(draft) !== initial);
    const unregister = owner.registerCleanup(() => {
        expired.value = true;
        controller.abort();
        Object.assign(draft, initialTaskDraft());
        fields.value = {};
        message.value = '';
    });

    async function submit(): Promise<TaskDetailResponse | undefined> {
        if (disposed || saved.value || expired.value || !owner.isCurrent() || uncertain.value)
            return;
        return command.run(async () => {
            fields.value = {};
            message.value = '';
            let config: TaskConfig | undefined;
            try {
                const input = taskInput(draft);
                config = input.config;
                const body = JSON.stringify(input);
                if (!attempt || attempt.body !== body) attempt = { body, key: crypto.randomUUID() };
                const result = await mutation.mutateAsync({
                    input: { body: input },
                    options: { idempotencyKey: attempt.key, signal: controller.signal },
                });
                if (disposed || !owner.isCurrent()) return;
                saved.value = true;
                await lifecycle.queryClient.invalidateQueries({
                    queryKey: owner.queryKey(taskKeys.all),
                });
                return owner.isCurrent() && !disposed ? result.data : undefined;
            } catch (cause) {
                if (disposed || !owner.isCurrent()) return;
                const error = toApiError(cause);
                if (error.kind === 'cancelled') return;
                uncertain.value =
                    !!config &&
                    !(
                        error.status &&
                        error.status >= 400 &&
                        error.status < 500 &&
                        error.status !== 408
                    );
                if (uncertain.value) {
                    message.value = '保存结果未确认，请先返回任务列表核对，避免重复创建。';
                    return;
                }
                const details =
                    cause instanceof ContractValidationError
                        ? cause.fieldErrors
                        : error.fieldErrors;
                // Union 的不匹配分支会返回额外字段，只关联当前可见时间范围。
                for (const detail of details ?? []) {
                    const field = taskField(detail.path);
                    if (
                        !field ||
                        (draft.rangeKind === 'fixed'
                            ? field === 'days'
                            : field === 'start' || field === 'end')
                    )
                        continue;
                    fields.value[field] ??= detail.message;
                }
                if (Object.keys(fields.value).length) message.value = '请检查标出的字段';
                else {
                    message.value =
                        error.status === 403
                            ? '没有保存权限，请检查账号或重新登录'
                            : error.status === 429
                              ? '保存过于频繁，请稍后重试'
                              : '任务未保存，请稍后重试';
                }
            }
        });
    }
    function canLeave(confirm: () => boolean) {
        if (command.pending.value) return false;
        return !dirty.value || expired.value || confirm();
    }
    function dispose() {
        disposed = true;
        controller.abort();
        unregister();
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
    };
}

/** Keep the response ETag verbatim; validate consistency without deriving a replacement. */
export function validateTaskEditResponse(
    response: ApiResponse<TaskDetailResponse>,
    taskId: string,
) {
    const value = parseContract(TaskDetailResponseSchema, response.data);
    const etag = response.headers.etag;
    if (
        !etag ||
        parseRevisionEtag(etag) !== value.task.revision ||
        value.task.id !== taskId ||
        value.version.taskId !== taskId ||
        value.task.currentVersionId !== value.version.id
    )
        throw new ContractValidationError([
            { path: '/', message: '任务配置、版本或 ETag 不一致，请重新读取' },
        ]);
    return response;
}

export function taskEditOptions(lifecycle: SessionLifecycle, taskId: string) {
    const options = lifecycle.queryOptions(taskEndpoint, { params: { taskId } }, [
        ...taskKeys.detail(taskId),
        'edit',
    ]);
    return {
        ...options,
        staleTime: 0,
        async queryFn(context: { signal: AbortSignal }) {
            return validateTaskEditResponse(await options.queryFn(context), taskId);
        },
    };
}

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
                uncertain.value =
                    dispatched &&
                    !(
                        error.status &&
                        error.status >= 400 &&
                        error.status < 500 &&
                        error.status !== 408
                    );
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
                    for (const detail of error.fieldErrors ?? []) {
                        const field = taskField(detail.path);
                        if (
                            field &&
                            !(draft.rangeKind === 'fixed'
                                ? field === 'days'
                                : field === 'start' || field === 'end')
                        )
                            fields.value[field] ??= detail.message;
                    }
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
    };
}
