import {
    ContractValidationError,
    DEFAULT_TASK_BUDGET,
    CreateTaskInputSchema,
    TimeRangeSchema,
    taskTokenAllocation,
    parseContract,
    type TaskConfig,
    type SessionResponse,
} from '@scova/models';
import { scheduleInput } from '@/utils/schedule';

export const budgetFields = [
    { key: 'maxSearches', label: '搜索次数上限' },
    { key: 'maxPages', label: '网页读取次数上限' },
    { key: 'maxDurationSeconds', label: '执行时长上限（秒）' },
    { key: 'maxInputTokens', label: '累计输入 token 上限' },
    { key: 'maxOutputTokens', label: '累计输出 token 上限' },
] as const;

export function initialTaskDraft(preferences?: SessionResponse['user']['preferences']) {
    return {
        title: '',
        topic: '',
        goal: '',
        focusPoints: [] as string[],
        exclusions: [] as string[],
        preferredUrls: [] as string[],
        excludedUrls: [] as string[],
        officialOnly: false,
        rangeKind: 'rolling',
        days: '7',
        start: '',
        end: '',
        timezone:
            preferences?.defaultTimezone ??
            (Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai'),
        scheduleFrequency: 'manual',
        scheduleLocalTime: '',
        scheduleWeekday: '',
        outputFormat: 'brief',
        outputFormats: [] as TaskConfig['outputFormat'][],
        researchMode: 'analysis',
        collectionDateUnknown: 'separate',
        agentProviderId: '',
        searchMode: 'auto',
        maxSearches: String(DEFAULT_TASK_BUDGET.maxSearches),
        maxPages: String(DEFAULT_TASK_BUDGET.maxPages),
        maxDurationSeconds: String(DEFAULT_TASK_BUDGET.maxDurationSeconds),
        maxInputTokens: String(DEFAULT_TASK_BUDGET.maxInputTokens),
        maxOutputTokens: String(DEFAULT_TASK_BUDGET.maxOutputTokens),
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
        focusPoints: [...config.focusPoints],
        exclusions: [...config.exclusions],
        preferredUrls: [...config.sourcePreferences.preferredUrls],
        excludedUrls: [...config.sourcePreferences.excludedUrls],
        officialOnly: config.sourcePreferences.officialOnly,
        rangeKind: config.timeRange.kind,
        days: config.timeRange.kind === 'rolling' ? String(config.timeRange.days) : '7',
        start: config.timeRange.kind === 'fixed' ? local(config.timeRange.start) : '',
        end: config.timeRange.kind === 'fixed' ? local(config.timeRange.end) : '',
        timezone: config.timezone,
        scheduleFrequency: config.schedule.frequency,
        scheduleLocalTime: config.schedule.frequency === 'manual' ? '' : config.schedule.localTime,
        scheduleWeekday:
            config.schedule.frequency === 'weekly' ? String(config.schedule.weekday) : '',
        outputFormat: config.outputFormat,
        outputFormats: config.outputFormats ? [...config.outputFormats] : [],
        researchMode: config.researchMode ?? 'analysis',
        collectionDateUnknown: config.collectionDateUnknown ?? 'separate',
        agentProviderId: config.agentProviderId ?? '',
        searchMode: config.searchMode ?? 'auto',
        ...(Object.fromEntries(
            budgetFields.map(({ key }) => [key, String(config.budget[key])]),
        ) as Pick<TaskDraft, (typeof budgetFields)[number]['key']>),
        notificationMode: config.notificationPreference.mode,
        runIssues: config.notificationPreference.runIssues,
    };
}

export function taskScheduleDescription(config: TaskConfig) {
    const schedule = config.schedule;
    return schedule.frequency === 'manual'
        ? '仅手动执行'
        : schedule.frequency === 'daily'
          ? `每日 ${schedule.localTime}（${config.timezone}）`
          : `每周${['一', '二', '三', '四', '五', '六', '日'][schedule.weekday - 1]} ${schedule.localTime}（${config.timezone}）`;
}

const entries = (values: string[]) => values.filter((value) => value.trim());

/** 表单值转为公开契约；固定日期由明确标注的浏览器当地时间转成 UTC。 */
export function taskInput(draft: TaskDraft, original?: TaskConfig, keepSchedule = true) {
    const initial = original ? taskDraftFromConfig(original) : undefined;
    const preserve = <T>(field: TaskDraftField, previous: T, next: T): T =>
        initial && JSON.stringify(draft[field]) === JSON.stringify(initial[field])
            ? previous
            : next;
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
            : draft.rangeKind === 'unbounded'
              ? { kind: 'unbounded' }
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
    const schedule =
        original &&
        initial &&
        draft.scheduleFrequency === initial.scheduleFrequency &&
        draft.scheduleLocalTime === initial.scheduleLocalTime &&
        draft.scheduleWeekday === initial.scheduleWeekday
            ? original.schedule
            : scheduleInput(draft);
    // 先校验用户选中的共享分支，避免 Union 的另一分支错误误指向正确日期。
    try {
        parseContract(
            TimeRangeSchema.anyOf[
                draft.rangeKind === 'fixed' ? 1 : draft.rangeKind === 'unbounded' ? 2 : 0
            ]!,
            range,
        );
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
    const input = parseContract(CreateTaskInputSchema, {
        config: {
            title: preserve('title', original?.title ?? '', draft.title.trim()),
            topic: preserve('topic', original?.topic ?? '', draft.topic.trim()),
            goal: preserve('goal', original?.goal ?? '', draft.goal.trim()),
            focusPoints: preserve(
                'focusPoints',
                original?.focusPoints ?? [],
                entries(draft.focusPoints),
            ),
            exclusions: preserve(
                'exclusions',
                original?.exclusions ?? [],
                entries(draft.exclusions),
            ),
            sourcePreferences: {
                preferredUrls: preserve(
                    'preferredUrls',
                    original?.sourcePreferences.preferredUrls ?? [],
                    entries(draft.preferredUrls).map((value) => value.trim()),
                ),
                excludedUrls: preserve(
                    'excludedUrls',
                    original?.sourcePreferences.excludedUrls ?? [],
                    entries(draft.excludedUrls).map((value) => value.trim()),
                ),
                officialOnly: draft.officialOnly,
            },
            timeRange: range,
            timezone: preserve('timezone', original?.timezone ?? '', draft.timezone.trim()),
            schedule: keepSchedule ? schedule : { frequency: 'manual' },
            outputFormat: draft.outputFormat,
            ...(draft.outputFormats.length > 1
                ? { outputFormats: draft.outputFormats, outputFormat: draft.outputFormats[0] }
                : {}),
            ...(draft.researchMode === 'collection' || original?.researchMode !== undefined
                ? { researchMode: draft.researchMode }
                : {}),
            ...(draft.researchMode === 'collection' || original?.collectionDateUnknown !== undefined
                ? { collectionDateUnknown: draft.collectionDateUnknown }
                : {}),
            ...(draft.agentProviderId ? { agentProviderId: draft.agentProviderId } : {}),
            ...(draft.searchMode !== 'auto' || original?.searchMode !== undefined
                ? { searchMode: draft.searchMode }
                : {}),
            budget: Object.fromEntries(budgetFields.map(({ key }) => [key, Number(draft[key])])),
            notificationPreference: { mode: draft.notificationMode, runIssues: draft.runIssues },
        },
    });
    const allocation = taskTokenAllocation(input.config.budget);
    if (
        allocation?.overBudget &&
        (!original ||
            original.budget.maxOutputTokens !== input.config.budget.maxOutputTokens ||
            original.budget.maxPages !== input.config.budget.maxPages)
    ) {
        throw new ContractValidationError([
            {
                path: '/config/budget/maxOutputTokens',
                message: '输出总额不足以容纳阶段分配与修复预留，请增加累计输出 token 上限。',
            },
        ]);
    }
    return input;
}
