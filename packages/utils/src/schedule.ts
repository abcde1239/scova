import { Temporal } from '@js-temporal/polyfill';

export interface SchedulePlan {
    timezone: string;
    schedule:
        | { frequency: 'manual' }
        | { frequency: 'daily'; localTime: string }
        | { frequency: 'weekly'; localTime: string; weekday: number };
}
export interface DueSchedule {
    scheduledAt: Date;
    missedCount: number;
    nextRunAt: Date;
}
type PeriodicPlan = { timezone: string; time: Temporal.PlainTime; period: 1 | 7; weekday?: number };
const MAX_TRANSITIONS = 2048;
const MAX_DAYS = 366_000;

function periodic(plan: SchedulePlan): PeriodicPlan | null {
    if (plan.schedule.frequency === 'manual') return null;
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(plan.schedule.localTime))
        throw new RangeError('计划当地时间无效');
    if (
        plan.schedule.frequency === 'weekly' &&
        (!Number.isInteger(plan.schedule.weekday) ||
            plan.schedule.weekday < 1 ||
            plan.schedule.weekday > 7)
    )
        throw new RangeError('计划星期无效');
    Temporal.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO(plan.timezone);
    return {
        timezone: plan.timezone,
        time: Temporal.PlainTime.from(plan.schedule.localTime),
        period: plan.schedule.frequency === 'weekly' ? 7 : 1,
        ...(plan.schedule.frequency === 'weekly' ? { weekday: plan.schedule.weekday } : {}),
    };
}
function zoned(plan: PeriodicPlan, localDate: Temporal.PlainDate): Temporal.ZonedDateTime {
    const requested = localDate.toPlainDateTime(plan.time);
    const earlier = requested.toZonedDateTime(plan.timezone, { disambiguation: 'earlier' });
    if (earlier.toPlainDateTime().equals(requested)) return earlier;
    const later = requested.toZonedDateTime(plan.timezone, { disambiguation: 'later' });
    const transition = earlier.getTimeZoneTransition('next');
    if (
        !transition ||
        Temporal.ZonedDateTime.compare(transition, later) > 0 ||
        Temporal.PlainDateTime.compare(transition.toPlainDateTime(), requested) < 0
    )
        throw new RangeError('无法解析计划时区跃迁');
    return transition;
}
const asDate = (value: Temporal.ZonedDateTime) => new Date(Number(value.epochMilliseconds));
function instant(value: Date): Temporal.Instant {
    if (!Number.isFinite(value.getTime())) throw new RangeError('计划时刻无效');
    return Temporal.Instant.fromEpochMilliseconds(value.getTime());
}
function matchingDate(
    plan: PeriodicPlan,
    local: Temporal.PlainDate,
    direction: 'before' | 'after',
) {
    if (plan.weekday === undefined) return local;
    return direction === 'before'
        ? local.subtract({ days: (local.dayOfWeek - plan.weekday + 7) % 7 })
        : local.add({ days: (plan.weekday - local.dayOfWeek + 7) % 7 });
}
function latest(plan: PeriodicPlan, at: Temporal.Instant) {
    let date = matchingDate(plan, at.toZonedDateTimeISO(plan.timezone).toPlainDate(), 'before');
    for (let attempt = 0; attempt < 4; attempt++) {
        const value = zoned(plan, date);
        if (Temporal.Instant.compare(value.toInstant(), at) <= 0) return { date, value };
        date = date.subtract({ days: plan.period });
    }
    throw new RangeError('计划时区跨度超出支持范围');
}

/** Resolve one nominal local date. Missing times choose the first valid transition; folds choose earlier. */
export function resolveScheduledDate(plan: SchedulePlan, localDate: string): Date | null {
    const parsed = periodic(plan);
    if (!parsed) return null;
    const date = Temporal.PlainDate.from(localDate);
    if (parsed.weekday !== undefined && parsed.weekday !== date.dayOfWeek) return null;
    return asDate(zoned(parsed, date));
}

/** Strictly after `after`, including between the two instances of a folded wall-clock time. */
export function nextScheduledAt(plan: SchedulePlan, after: Date): Date | null {
    const parsed = periodic(plan);
    if (!parsed) return null;
    const afterInstant = instant(after);
    let date = matchingDate(
        parsed,
        afterInstant.toZonedDateTimeISO(parsed.timezone).toPlainDate(),
        'after',
    );
    for (let attempt = 0; attempt < 4; attempt++) {
        const candidate = zoned(parsed, date);
        if (Temporal.Instant.compare(candidate.toInstant(), afterInstant) > 0)
            return asDate(candidate);
        date = date.add({ days: parsed.period });
    }
    throw new RangeError('计划时区跨度超出支持范围');
}

/** Count nominal slots in a local interval, clipped to the processed first/last nominal dates. */
function localSlotCount(
    plan: PeriodicPlan,
    lower: Temporal.PlainDateTime,
    upper: Temporal.PlainDateTime,
    first: Temporal.PlainDate,
    last: Temporal.PlainDate,
) {
    let start = matchingDate(plan, lower.toPlainDate(), 'after');
    if (Temporal.PlainDateTime.compare(start.toPlainDateTime(plan.time), lower) < 0)
        start = start.add({ days: plan.period });
    let end = matchingDate(plan, upper.toPlainDate(), 'before');
    if (Temporal.PlainDateTime.compare(end.toPlainDateTime(plan.time), upper) > 0)
        end = end.subtract({ days: plan.period });
    if (Temporal.PlainDate.compare(start, first) < 0) start = first;
    if (Temporal.PlainDate.compare(end, last) > 0) end = last;
    return Temporal.PlainDate.compare(end, start) < 0
        ? 0
        : Math.floor(start.until(end).days / plan.period) + 1;
}

/** Coalesce equal actual instants caused by a skipped date (for example Apia midnight). */
function duplicateInstants(
    plan: PeriodicPlan,
    first: ReturnType<typeof latest>,
    last: ReturnType<typeof latest>,
) {
    let cursor = first.value,
        duplicate = 0;
    for (let count = 0; count < MAX_TRANSITIONS; count++) {
        const transition = cursor.getTimeZoneTransition('next');
        if (!transition || Temporal.ZonedDateTime.compare(transition, last.value) > 0)
            return duplicate;
        const before = transition.subtract({ nanoseconds: 1 });
        if (transition.offsetNanoseconds > before.offsetNanoseconds) {
            const gapStart = before.toPlainDateTime().add({ nanoseconds: 1 });
            const total = localSlotCount(
                plan,
                gapStart,
                transition.toPlainDateTime(),
                first.date,
                last.date,
            );
            duplicate += Math.max(0, total - 1);
        }
        cursor = transition;
    }
    throw new RangeError('计划时区跃迁数量超过安全上限');
}

/** Latest due slot only. Older distinct slots are counted, never replayed as a backlog. */
export function dueSchedule(plan: SchedulePlan, firstDueAt: Date, now: Date): DueSchedule | null {
    const parsed = periodic(plan);
    if (!parsed) return null;
    const firstInstant = instant(firstDueAt),
        current = instant(now);
    if (Temporal.Instant.compare(firstInstant, current) > 0) return null;
    const first = latest(parsed, firstInstant),
        last = latest(parsed, current);
    if (Temporal.Instant.compare(first.value.toInstant(), firstInstant) !== 0)
        throw new RangeError('持久化计划时点与当前计划不一致');
    const days = first.date.until(last.date).days;
    if (days < 0 || days > MAX_DAYS) throw new RangeError('待补计划跨度超过安全上限');
    const missedCount = Math.floor(days / parsed.period) - duplicateInstants(parsed, first, last);
    const nextRunAt = nextScheduledAt(plan, now);
    if (!nextRunAt || missedCount < 0) throw new RangeError('待补计划计数无效');
    return { scheduledAt: asDate(last.value), missedCount, nextRunAt };
}
