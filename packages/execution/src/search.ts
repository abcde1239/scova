export interface SearchStateRepository {
    status(engines: string[]): Promise<{ engines: string[]; waitMs: number }>;
    acquire(engines: string[], owner: string): Promise<{ engines: string[]; waitMs: number }>;
    finish(
        engines: string[],
        owner: string,
        failures: { engine: string; error: string; retryAfterMs?: number }[],
    ): Promise<void>;
    cached(key: string): Promise<string | null>;
    lock(key: string, owner: string): Promise<boolean>;
    publish(key: string, owner: string, value: string, ttlMs: number): Promise<void>;
    unlock(key: string, owner: string): Promise<void>;
}

export function searchCooldown(failure?: { error: string; retryAfterMs?: number }) {
    const error = failure?.error;
    const baseline =
        error === 'captcha'
            ? 3_600_000
            : error === 'rate_limited' || error === 'access_denied'
              ? 1_800_000
              : 0;
    return Math.max(baseline, Math.min(failure?.retryAfterMs ?? 0, 7 * 86_400_000));
}
