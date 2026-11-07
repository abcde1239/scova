import type { Redis } from 'ioredis';

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

const clock = "local t=redis.call('TIME'); local now=t[1]*1000+math.floor(t[2]/1000); ";
const eligible = `${clock}
local out={}; local wait=15000
for i,key in ipairs(KEYS) do
 local cooldown=tonumber(redis.call('HGET',key,'cooldown') or 0)
 local nextAt=tonumber(redis.call('HGET',key,'next') or 0)
 local lease=tonumber(redis.call('HGET',key,'lease') or 0)
 local at=cooldown
 if ARGV[1]=='acquire' then at=math.max(at,nextAt,lease) end
 if at<=now then
  table.insert(out,i)
  if ARGV[1]=='acquire' then
   redis.call('HSET',key,'owner',ARGV[2],'lease',now+20000,'next',now+tonumber(ARGV[3]))
   redis.call('PEXPIRE',key,7200000)
  end
 else wait=math.min(wait,at-now) end
end
table.insert(out,1,wait); return out`;

/** Shared Redis server time and atomic leases; constructing this adapter does not connect. */
export function createSearchStateRepository(
    redis: Redis,
    namespace: string,
    intervalMs = 10_000,
): SearchStateRepository {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > 60_000)
        throw new Error('搜索间隔必须为1至60000毫秒');
    const engineKey = (engine: string) => `${namespace}:engine:${engine}`;
    async function select(engines: string[], operation: string, owner = '') {
        const result = (await redis.eval(
            eligible,
            engines.length,
            ...engines.map(engineKey),
            operation,
            owner,
            intervalMs,
        )) as number[];
        return { waitMs: result[0], engines: result.slice(1).map((index) => engines[index - 1]) };
    }
    return {
        status: (engines) => select(engines, 'status'),
        acquire: (engines, owner) => select(engines, 'acquire', owner),
        async finish(engines, owner, failures) {
            for (const engine of engines) {
                const failure = failures.find((failure) => failure.engine === engine);
                const error = failure?.error;
                const baseline =
                    error === 'captcha'
                        ? 3_600_000
                        : error === 'rate_limited' || error === 'access_denied'
                          ? 1_800_000
                          : 0;
                const cooldown = Math.max(
                    baseline,
                    Math.min(failure?.retryAfterMs ?? 0, 7 * 86_400_000),
                );
                await redis.eval(
                    `${clock}
if redis.call('HGET',KEYS[1],'owner')~=ARGV[1] then return 0 end
redis.call('HDEL',KEYS[1],'owner','lease')
if tonumber(ARGV[2])>0 then redis.call('HSET',KEYS[1],'cooldown',now+tonumber(ARGV[2])) end
redis.call('PEXPIRE',KEYS[1],math.max(7200000,tonumber(ARGV[2])+20000)); return 1`,
                    1,
                    engineKey(engine),
                    owner,
                    cooldown,
                );
            }
        },
        cached: (key) => redis.get(`${namespace}:cache:${key}`),
        lock: async (key, owner) =>
            (await redis.set(`${namespace}:lock:${key}`, owner, 'PX', 20_000, 'NX')) === 'OK',
        async publish(key, owner, value, ttlMs) {
            await redis.eval(
                `if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end
redis.call('SET',KEYS[2],ARGV[2],'PX',ARGV[3]); return 1`,
                2,
                `${namespace}:lock:${key}`,
                `${namespace}:cache:${key}`,
                owner,
                value,
                Math.max(1, ttlMs),
            );
        },
        async unlock(key, owner) {
            await redis.eval(
                `if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0`,
                1,
                `${namespace}:lock:${key}`,
                owner,
            );
        },
    };
}
