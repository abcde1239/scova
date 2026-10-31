import {
    ContractValidationError,
    InstantSchema,
    ScheduleSchema,
    TimezoneSchema,
    parseContract,
    type Schedule,
    type Task,
} from '@scova/models';

export interface ScheduleDraft {
    scheduleFrequency: string;
    scheduleLocalTime: string;
    scheduleWeekday: string;
    timezone: string;
}
export interface SavedSchedule {
    schedule: Schedule;
    timezone: string;
    nextRunAt: Task['nextRunAt'];
    status: Task['status'];
}
export const weekdayOptions = [
    { value: '', label: '请选择星期' },
    ...['周一', '周二', '周三', '周四', '周五', '周六', '周日'].map((label, index) => ({
        value: String(index + 1),
        label,
    })),
];
export function scheduleInput(draft: ScheduleDraft): Schedule {
    const frequency = draft.scheduleFrequency;
    const value =
        frequency === 'manual'
            ? { frequency }
            : frequency === 'weekly'
              ? {
                    frequency,
                    localTime: draft.scheduleLocalTime,
                    weekday: Number(draft.scheduleWeekday),
                }
              : { frequency, localTime: draft.scheduleLocalTime };
    const schema =
        frequency === 'manual'
            ? ScheduleSchema.anyOf[0]
            : frequency === 'daily'
              ? ScheduleSchema.anyOf[1]
              : frequency === 'weekly'
                ? ScheduleSchema.anyOf[2]
                : ScheduleSchema;
    try {
        return parseContract(schema, value) as Schedule;
    } catch (cause) {
        if (cause instanceof ContractValidationError)
            throw new ContractValidationError(
                cause.fieldErrors.map((field) => ({
                    ...field,
                    path: `/config/schedule${field.path === '/' ? '' : field.path}`,
                })),
            );
        throw cause;
    }
}
export function scheduleDescription(schedule: Schedule, timezone: string) {
    parseContract(TimezoneSchema, timezone);
    if (schedule.frequency === 'manual') return '仅手动执行，没有周期计划。';
    return schedule.frequency === 'daily'
        ? `每日 ${schedule.localTime}（任务时区 ${timezone}）`
        : `每${weekdayOptions[schedule.weekday]!.label} ${schedule.localTime}（任务时区 ${timezone}）`;
}
/** 仅格式化给定时刻，不推算或安排下一次执行。 */
export function formatScheduleInstant(instant: string, timezone: string) {
    parseContract(InstantSchema, instant);
    parseContract(TimezoneSchema, timezone);
    const date = new Date(instant);
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
        timeZoneName: 'shortOffset',
    }).formatToParts(date);
    const part = (type: Intl.DateTimeFormatPartTypes) =>
        parts.find((value) => value.type === type)?.value;
    return {
        local: `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}:${part('second')}（${timezone}，${part('timeZoneName')}）`,
        utc: date.toISOString(),
    };
}
export const dstExamples = [
    {
        kind: '跳时',
        requested: '2026-03-08 02:30',
        instant: '2026-03-08T07:00:00Z',
        note: '02:30 不存在，顺延到首个有效时刻 03:00。',
    },
    {
        kind: '回拨',
        requested: '2026-11-01 01:30',
        instant: '2026-11-01T05:30:00Z',
        note: '选择首次 01:30；重复的第二次 01:30 不再执行。',
    },
] as const;
