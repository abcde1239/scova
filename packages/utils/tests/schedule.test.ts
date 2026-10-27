import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vite-plus/test';
import {
    dueSchedule,
    effectiveRunScopeHash,
    nextScheduledAt,
    resolveScheduledDate,
    type SchedulePlan,
} from '../src/index.ts';
const plan = (
    timezone = 'America/New_York',
    localTime = '02:30',
    weekday?: number,
): SchedulePlan => ({
    timezone,
    schedule:
        weekday === undefined
            ? { frequency: 'daily', localTime }
            : { frequency: 'weekly', localTime, weekday },
});
const iso = (date: Date | null) => date?.toISOString() ?? null;

describe('calendar schedule slots', () => {
    it('uses the first valid gap instant and rebuilds the next date at its original local time', () => {
        expect(iso(resolveScheduledDate(plan(), '2026-03-08'))).toBe('2026-03-08T07:00:00.000Z');
        expect(iso(nextScheduledAt(plan(), new Date('2026-03-08T07:00:00Z')))).toBe(
            '2026-03-09T06:30:00.000Z',
        );
        expect(iso(nextScheduledAt(plan(), new Date('2026-03-08T07:15:00Z')))).toBe(
            '2026-03-09T06:30:00.000Z',
        );
    });
    it('selects the early fold instance only and skips the repeated later wall-clock time', () => {
        const fold = plan('America/New_York', '01:30');
        expect(iso(resolveScheduledDate(fold, '2026-11-01'))).toBe('2026-11-01T05:30:00.000Z');
        expect(iso(nextScheduledAt(fold, new Date('2026-11-01T05:30:00Z')))).toBe(
            '2026-11-02T06:30:00.000Z',
        );
        expect(iso(nextScheduledAt(fold, new Date('2026-11-01T06:15:00Z')))).toBe(
            '2026-11-02T06:30:00.000Z',
        );
    });
    it.each([
        ['Australia/Lord_Howe', '02:15', '2026-10-04', '2026-10-03T15:30:00.000Z'],
        ['America/Santiago', '00:30', '2026-09-06', '2026-09-06T04:00:00.000Z'],
        ['Pacific/Apia', '02:30', '2011-12-30', '2011-12-30T10:00:00.000Z'],
    ])('resolves non-hour and cross-midnight gaps %s', (zone, localTime, date, expected) => {
        expect(iso(resolveScheduledDate(plan(zone, localTime), date))).toBe(expected);
    });
    it('uses ISO weekdays and strictly future weekly slots across DST', () => {
        const weekly = plan('America/New_York', '02:30', 7);
        expect(iso(nextScheduledAt(weekly, new Date('2026-03-01T07:30:00Z')))).toBe(
            '2026-03-08T07:00:00.000Z',
        );
        expect(iso(nextScheduledAt(weekly, new Date('2026-03-08T07:00:00Z')))).toBe(
            '2026-03-15T06:30:00.000Z',
        );
        expect(resolveScheduledDate(weekly, '2026-03-09')).toBeNull();
    });
    it('returns null for manual schedules and not-yet-due slots', () => {
        const manual: SchedulePlan = { timezone: 'UTC', schedule: { frequency: 'manual' } };
        expect(nextScheduledAt(manual, new Date())).toBeNull();
        expect(resolveScheduledDate(manual, '2026-10-01')).toBeNull();
        expect(dueSchedule(manual, new Date(), new Date())).toBeNull();
        expect(
            dueSchedule(
                plan('UTC', '12:00'),
                new Date('2026-10-26T12:00:00Z'),
                new Date('2026-10-26T11:59:59Z'),
            ),
        ).toBeNull();
    });
});

describe('latest-slot recovery and missed counts', () => {
    it('only catches up the most recent due slot, counting earlier days across a gap', () => {
        const result = dueSchedule(
            plan(),
            new Date('2026-03-06T07:30:00Z'),
            new Date('2026-03-10T06:31:00Z'),
        )!;
        expect(result).toEqual({
            scheduledAt: new Date('2026-03-10T06:30:00Z'),
            missedCount: 4,
            nextRunAt: new Date('2026-03-11T06:30:00Z'),
        });
    });
    it('does not count the second fold instant as another occurrence', () => {
        const result = dueSchedule(
            plan('America/New_York', '01:30'),
            new Date('2026-11-01T05:30:00Z'),
            new Date('2026-11-01T06:40:00Z'),
        )!;
        expect(result.missedCount).toBe(0);
        expect(iso(result.scheduledAt)).toBe('2026-11-01T05:30:00.000Z');
        expect(iso(result.nextRunAt)).toBe('2026-11-02T06:30:00.000Z');
    });
    it('counts weekly slots by calendar weeks rather than elapsed hours', () => {
        const result = dueSchedule(
            plan('America/New_York', '02:30', 7),
            new Date('2026-03-01T07:30:00Z'),
            new Date('2026-03-22T06:31:00Z'),
        )!;
        expect(result.missedCount).toBe(3);
        expect(iso(result.scheduledAt)).toBe('2026-03-22T06:30:00.000Z');
    });
    it('coalesces skipped-day midnight slots sharing the same UTC instant', () => {
        const apia = plan('Pacific/Apia', '00:00');
        const result = dueSchedule(
            apia,
            new Date('2011-12-29T10:00:00Z'),
            new Date('2011-12-30T10:00:00Z'),
        )!;
        expect(result).toEqual({
            scheduledAt: new Date('2011-12-30T10:00:00Z'),
            missedCount: 1,
            nextRunAt: new Date('2011-12-31T10:00:00Z'),
        });
        expect(dueSchedule(apia, result.scheduledAt, result.scheduledAt)!.missedCount).toBe(0);
    });
    it('counts decades without iterating every scheduled day', () => {
        const result = dueSchedule(
            plan('UTC', '12:00'),
            new Date('2000-01-01T12:00:00Z'),
            new Date('2050-01-01T12:00:00Z'),
        )!;
        expect(result.missedCount).toBe(18263);
        expect(result.nextRunAt).toEqual(new Date('2050-01-02T12:00:00Z'));
    });
    it('rejects invalid inputs, misaligned persisted slots and unbounded recovery ranges', () => {
        expect(() => nextScheduledAt(plan('Mars/Olympus'), new Date())).toThrow();
        expect(() => nextScheduledAt(plan('UTC', '25:00'), new Date())).toThrow();
        expect(() => nextScheduledAt(plan('UTC', '12:00', 8), new Date())).toThrow();
        expect(() => nextScheduledAt(plan(), new Date('invalid'))).toThrow();
        expect(() =>
            dueSchedule(
                plan('UTC', '12:00'),
                new Date('2026-01-01T12:01:00Z'),
                new Date('2026-01-02T12:00:00Z'),
            ),
        ).toThrow(/不一致/);
        expect(() =>
            dueSchedule(
                plan('UTC', '12:00'),
                new Date('1000-01-01T12:00:00Z'),
                new Date('2500-01-01T12:00:00Z'),
            ),
        ).toThrow(/上限/);
    });
});

it('keeps the existing versioned effective Run scope algorithm identical for both producers', () => {
    const expected = createHash('sha256')
        .update(JSON.stringify(['run-scope-v2', 'version-hash', 'live', 'scova-comparison-v1']))
        .digest('hex');
    expect(effectiveRunScopeHash('version-hash', 'live')).toBe(expected);
    expect(effectiveRunScopeHash('version-hash', 'demo')).not.toBe(expected);
});
