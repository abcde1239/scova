import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import {
    ConnectorError,
    SEARXNG_ENGINES,
    withDeadline,
    searchLanguage,
    type SearchProvider,
    type SearchResponse,
} from '@scova/connectors';
import type { SearchStateRepository } from '@/repo/search.ts';

export function createManagedSearch(options: {
    source: SearchProvider;
    repository: SearchStateRepository;
    scope: string;
    cacheTtlMs?: number;
    cacheExpiresAt?: number;
}): SearchProvider {
    const { source, repository } = options;
    return {
        async search(query, context = {}) {
            const language = searchLanguage(context);
            let attempts = 0;
            const cacheTtl = () =>
                Math.max(
                    0,
                    Math.min(
                        options.cacheTtlMs ?? 300_000,
                        options.cacheExpiresAt === undefined
                            ? Infinity
                            : options.cacheExpiresAt - Date.now(),
                    ),
                );
            return withDeadline(
                Math.min(context.timeoutMs ?? 15_000, 15_000),
                context.signal,
                async (signal) => {
                    const started = Date.now();
                    let networkMs = 0;
                    let previousFailure: ConnectorError | undefined;
                    let lastState = '';
                    const report = async (state: 'waiting' | 'cooldown' | 'cache_hit') => {
                        if (state !== lastState) {
                            lastState = state;
                            await context.onSearchState?.(state);
                        }
                    };
                    // A cache hit is still one bounded logical tool operation in the PG ledger.
                    await context.beforeAttempt?.('search');
                    const check = async () => {
                        if (signal.aborted) throw new ConnectorError('aborted', '搜索等待已停止');
                        await context.beforeDispatch?.();
                        if (signal.aborted) throw new ConnectorError('aborted', '搜索等待已停止');
                    };
                    while (true) {
                        await check();
                        let status;
                        try {
                            status = await repository.status([...SEARXNG_ENGINES]);
                        } catch {
                            throw new ConnectorError('search_unavailable', '共享搜索控制暂不可用');
                        }
                        if (!status.engines.length) {
                            await report('cooldown');
                            if (status.waitMs >= 15_000 - (Date.now() - started))
                                throw new ConnectorError(
                                    'search_unavailable',
                                    '所有搜索引擎暂处于冷却',
                                );
                            await pause(Math.max(20, status.waitMs), undefined, { signal });
                            continue;
                        }
                        const key = createHash('sha256')
                            .update(
                                JSON.stringify([
                                    options.scope,
                                    query,
                                    status.engines,
                                    ...(language ? [language] : []),
                                ]),
                            )
                            .digest('hex');
                        let cached: string | null;
                        try {
                            cached = cacheTtl() === 0 ? null : await repository.cached(key);
                        } catch {
                            throw new ConnectorError('search_unavailable', '共享搜索控制暂不可用');
                        }
                        if (cached) {
                            let result: SearchResponse;
                            try {
                                result = JSON.parse(cached) as SearchResponse;
                            } catch {
                                throw new ConnectorError('invalid_response', '搜索缓存格式无效');
                            }
                            if (
                                result.kind !== 'search_results' ||
                                result.mode !== 'live' ||
                                result.query !== query ||
                                !Array.isArray(result.results) ||
                                result.results.length > 10 ||
                                !result.coverage
                            )
                                throw new ConnectorError('invalid_response', '搜索缓存结构无效');
                            await check();
                            await report('cache_hit');
                            return {
                                ...result,
                                coverage: {
                                    ...result.coverage,
                                    diagnostics: {
                                        cacheHit: true,
                                        networkAttempts: 0,
                                        waitedMs: Date.now() - started,
                                        skippedEngines: SEARXNG_ENGINES.filter(
                                            (engine) => !status.engines.includes(engine),
                                        ),
                                    },
                                },
                            };
                        }
                        const owner = randomUUID();
                        let locked = false;
                        let engines: string[] = [];
                        let failures: { engine: string; error: string; retryAfterMs?: number }[] =
                            [];
                        try {
                            locked = await repository.lock(key, owner);
                            if (!locked) {
                                await report('waiting');
                                await pause(50, undefined, { signal });
                                continue;
                            }
                            const lease = await repository.acquire(status.engines, owner);
                            engines = lease.engines;
                            if (!engines.length) {
                                await report('waiting');
                                await pause(Math.min(250, Math.max(20, lease.waitMs)), undefined, {
                                    signal,
                                });
                                continue;
                            }
                            await check();
                            if (previousFailure) {
                                await context.beforeAttempt?.('search', previousFailure);
                                previousFailure = undefined;
                            }
                            attempts++;
                            const dispatchedAt = Date.now();
                            let result: SearchResponse;
                            try {
                                result = await source.search(query, {
                                    ...context,
                                    signal,
                                    engines,
                                    beforeAttempt: async () => check(),
                                });
                            } finally {
                                networkMs += Date.now() - dispatchedAt;
                            }
                            failures = result.coverage.unresponsiveEngines;
                            await check();
                            const skipped = SEARXNG_ENGINES.filter(
                                (engine) => !engines.includes(engine),
                            );
                            const response = {
                                ...result,
                                coverage: {
                                    ...result.coverage,
                                    complete: result.coverage.complete && skipped.length === 0,
                                    gaps: [
                                        ...result.coverage.gaps,
                                        ...(skipped.length
                                            ? ['部分引擎冷却或等待额度，本次使用其余来源']
                                            : []),
                                    ],
                                    diagnostics: {
                                        cacheHit: false,
                                        networkAttempts: attempts,
                                        waitedMs: Math.max(0, Date.now() - started - networkMs),
                                        skippedEngines: skipped,
                                    },
                                },
                            };
                            if (
                                result.results.length &&
                                cacheTtl() > 0 &&
                                engines.length === status.engines.length
                            )
                                await repository.publish(
                                    key,
                                    owner,
                                    JSON.stringify(response),
                                    Math.min(
                                        cacheTtl(),
                                        response.coverage.complete ? 300_000 : 60_000,
                                    ),
                                );
                            return response;
                        } catch (error) {
                            if (error instanceof ConnectorError) {
                                failures =
                                    error.engineFailures ??
                                    (error.status === 429 || error.status === 403
                                        ? engines.map((engine) => ({
                                              engine,
                                              error:
                                                  error.status === 429
                                                      ? 'rate_limited'
                                                      : 'access_denied',
                                              retryAfterMs: error.retryAfterMs,
                                          }))
                                        : []);
                                if (
                                    error.retryable &&
                                    !failures.length &&
                                    attempts > 0 &&
                                    attempts < 3
                                ) {
                                    previousFailure = error;
                                    continue;
                                }
                            }
                            throw error instanceof ConnectorError
                                ? error
                                : new ConnectorError(
                                      'search_unavailable',
                                      '共享搜索或上游暂不可用',
                                  );
                        } finally {
                            // If Redis is unavailable, the 20s lease remains: never fall back to unthrottled traffic.
                            if (engines.length)
                                await repository
                                    .finish(engines, owner, failures)
                                    .catch(() => undefined);
                            if (locked) await repository.unlock(key, owner).catch(() => undefined);
                        }
                    }
                },
            ).catch((error: unknown) => {
                if (error instanceof ConnectorError) error.searchNetworkAttempts = attempts;
                throw error;
            });
        },
    };
}
