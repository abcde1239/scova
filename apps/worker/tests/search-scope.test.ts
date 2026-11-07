import { describe, expect, it } from 'vite-plus/test';
import { DEFAULT_TASK_BUDGET, type TaskConfig } from '@scova/models';
import { searchScope } from '../src/utils/search-scope.ts';

const config: TaskConfig = {
    title: '研究',
    topic: 'AI',
    goal: '研究 AI',
    timezone: 'Asia/Tokyo',
    focusPoints: [],
    exclusions: [],
    sourcePreferences: { preferredUrls: [], excludedUrls: [], officialOnly: false },
    timeRange: { kind: 'rolling', days: 7 },
    schedule: { frequency: 'manual' },
    outputFormat: 'brief',
    budget: { ...DEFAULT_TASK_BUDGET },
    notificationPreference: { mode: 'off', runIssues: false },
};

describe('account and frozen-window search scope', () => {
    it('shares rolling queries within the local day but expires at midnight', () => {
        const start = new Date('2026-11-05T14:59:30Z');
        const first = searchScope('a', config, start, start.getTime());
        expect(first.ttlMs).toBe(30_000);
        expect(first.expiresAt).toBe(Date.parse('2026-11-05T15:00:00Z'));
        expect(
            searchScope('a', config, new Date('2026-11-05T00:00:00Z'), start.getTime()).key,
        ).toBe(first.key);
        expect(searchScope('a', config, start, Date.parse('2026-11-05T15:00:00Z')).ttlMs).toBe(0);
        expect(searchScope('b', config, start, start.getTime()).key).not.toBe(first.key);
        expect(
            searchScope(
                'a',
                config,
                new Date('2026-11-05T15:00:00Z'),
                Date.parse('2026-11-05T15:00:00Z'),
            ).key,
        ).not.toBe(first.key);
    });
    it('uses the timezone day boundary including DST and keeps fixed ranges distinct', () => {
        const dst = { ...config, timezone: 'America/New_York' };
        const now = Date.parse('2026-11-01T04:00:00Z');
        expect(searchScope('a', dst, new Date(now), now).expiresAt).toBe(
            Date.parse('2026-11-02T05:00:00Z'),
        );
        const fixed = {
            ...config,
            timeRange: { kind: 'fixed' as const, start: '2025-01-01', end: '2025-01-31' },
        };
        expect(searchScope('a', fixed, new Date(now), now).expiresAt).toBeUndefined();
        expect(searchScope('a', fixed, new Date(now), now).key).not.toBe(
            searchScope('a', config, new Date(now), now).key,
        );
    });
});
