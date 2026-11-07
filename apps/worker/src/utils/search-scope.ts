import type { TaskConfig } from '@scova/models';

/** Rolling queries can share candidates within a day; each Run still verifies its exact window. */
export function searchScope(userId: string, config: TaskConfig, startedAt: Date, now = Date.now()) {
    const format = new Intl.DateTimeFormat('en-CA', {
        timeZone: config.timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    });
    const day = format.format(startedAt);
    let ttlMs = 300_000;
    let expiresAt: number | undefined;
    if (config.timeRange.kind === 'rolling') {
        if (format.format(now) !== day) {
            ttlMs = 0;
            expiresAt = now;
        } else {
            let low = now,
                high = now + 27 * 3600_000;
            while (high - low > 1) {
                const middle = Math.floor((low + high) / 2);
                if (format.format(middle) === day) low = middle;
                else high = middle;
            }
            ttlMs = Math.min(ttlMs, high - now);
            expiresAt = high;
        }
    }
    return {
        key: JSON.stringify([
            userId,
            config.timeRange,
            config.timezone,
            config.timeRange.kind === 'rolling' ? day : null,
        ]),
        ttlMs,
        expiresAt,
    };
}
