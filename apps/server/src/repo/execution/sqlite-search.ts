import type { SqliteState } from '@scova/db/sqlite-state';
import { searchCooldown, type SearchStateRepository } from '@scova/execution/search';

type Engine = { owner?: string; leaseUntil: number; nextAt: number; cooldownUntil: number };
const engineLifetime = 7_200_000;
const lockLifetime = 20_000;

export function createSqliteSearchStateRepository(
    state: SqliteState,
    namespace: string,
    intervalMs: number,
): SearchStateRepository {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > 60_000)
        throw new Error('搜索间隔必须为1至60000毫秒');
    const engineKey = (engine: string) => `${namespace}:engine:${engine}`;
    function select(engines: string[], owner?: string) {
        return state.transaction((store, now) => {
            let waitMs = 15_000;
            const ready: string[] = [];
            for (const engine of engines) {
                const key = engineKey(engine);
                const existing = store.get<Engine>(key, now)?.value;
                const cooldownUntil = existing?.cooldownUntil ?? 0;
                const at = owner
                    ? Math.max(cooldownUntil, existing?.nextAt ?? 0, existing?.leaseUntil ?? 0)
                    : cooldownUntil;
                if (at > now) {
                    waitMs = Math.min(waitMs, at - now);
                    continue;
                }
                ready.push(engine);
                if (owner)
                    store.set(
                        key,
                        {
                            owner,
                            cooldownUntil,
                            leaseUntil: now + lockLifetime,
                            nextAt: now + intervalMs,
                        },
                        now + engineLifetime,
                    );
            }
            return { waitMs, engines: ready };
        });
    }
    const lockKey = (key: string) => `${namespace}:lock:${key}`;
    const cacheKey = (key: string) => `${namespace}:cache:${key}`;
    return {
        async status(engines) {
            return select(engines);
        },
        async acquire(engines, owner) {
            return select(engines, owner);
        },
        async finish(engines, owner, failures) {
            state.transaction((store, now) => {
                for (const engine of engines) {
                    const key = engineKey(engine);
                    const existing = store.get<Engine>(key, now)?.value;
                    if (existing?.owner !== owner) continue;
                    const cooldown = searchCooldown(
                        failures.find((failure) => failure.engine === engine),
                    );
                    store.set(
                        key,
                        {
                            leaseUntil: 0,
                            nextAt: existing.nextAt,
                            cooldownUntil: cooldown ? now + cooldown : existing.cooldownUntil,
                        },
                        now + Math.max(engineLifetime, cooldown + lockLifetime),
                    );
                }
            });
        },
        async cached(key) {
            return state.get<string>(cacheKey(key), Date.now())?.value ?? null;
        },
        async lock(key, owner) {
            return state.transaction((store, now) => {
                const lock = lockKey(key);
                if (store.get(lock, now)) return false;
                store.set(lock, owner, now + lockLifetime);
                return true;
            });
        },
        async publish(key, owner, value, ttlMs) {
            state.transaction((store, now) => {
                if (store.get(lockKey(key), now)?.value === owner)
                    store.set(cacheKey(key), value, now + Math.max(1, ttlMs));
            });
        },
        async unlock(key, owner) {
            state.transaction((store, now) => {
                const lock = lockKey(key);
                if (store.get(lock, now)?.value === owner) store.delete(lock);
            });
        },
    };
}
