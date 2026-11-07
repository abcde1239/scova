import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { createSearchStateRepository } from '../src/repo/search.ts';
import { createManagedSearch } from '../src/service/search.ts';
import { ConnectorError, type SearchProvider, type SearchResponse } from '@scova/connectors';

const namespace = `scova-search-test:${randomUUID()}`;
const redis = new Redis(process.env.SCOVA_TEST_REDIS_URL ?? 'redis://127.0.0.1:56379', {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
});
const second = redis.duplicate({ lazyConnect: true });
beforeAll(async () => {
    await redis.connect();
    await second.connect();
});
afterAll(async () => {
    let cursor = '0';
    do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', `${namespace}:*`, 'COUNT', 100);
        cursor = next;
        if (keys.length) await redis.del(...keys);
    } while (cursor !== '0');
    await redis.quit();
    await second.quit();
});

describe('two Worker search scheduling on real shared Redis', () => {
    it('retains the later Retry-After and its state TTL beyond two hours', async () => {
        const repo = createSearchStateRepository(redis, `${namespace}:retry-after`);
        await repo.acquire(['bing'], 'owner');
        await repo.finish(['bing'], 'owner', [
            { engine: 'bing', error: 'rate_limited', retryAfterMs: 10_800_000 },
        ]);
        expect(
            Number(await redis.hget(`${namespace}:retry-after:engine:bing`, 'cooldown')),
        ).toBeGreaterThan(Date.now() + 10_700_000);
        expect(await redis.pttl(`${namespace}:retry-after:engine:bing`)).toBeGreaterThan(
            10_700_000,
        );
        expect((await repo.acquire(['bing'], 'another')).engines).toEqual([]);
    });
    it('atomically permits a single owner and enforces the default 10 second interval', async () => {
        const a = createSearchStateRepository(redis, `${namespace}:rate`);
        const b = createSearchStateRepository(second, `${namespace}:rate`);
        const leases = await Promise.all([a.acquire(['bing'], 'a'), b.acquire(['bing'], 'b')]);
        expect(leases.filter((l) => l.engines.length)).toHaveLength(1);
        const winner = leases[0].engines.length ? 'a' : 'b';
        await a.finish(['bing'], winner, []);
        const blocked = await b.acquire(['bing'], 'c');
        expect(blocked.engines).toEqual([]);
        expect(blocked.waitMs).toBeGreaterThan(9000);
        await redis.hset(`${namespace}:rate:engine:bing`, 'next', 0);
        expect((await b.acquire(['bing'], 'c')).engines).toEqual(['bing']);
        await a.finish(['bing'], 'stale-owner', [{ engine: 'bing', error: 'captcha' }]);
        expect(await redis.hget(`${namespace}:rate:engine:bing`, 'owner')).toBe('c');
    });
    it('persists captcha cooldown across adapters and permits only one half-open probe', async () => {
        const a = createSearchStateRepository(redis, `${namespace}:cool`);
        await a.acquire(['duckduckgo'], 'a');
        await a.finish(['duckduckgo'], 'a', [{ engine: 'duckduckgo', error: 'captcha' }]);
        const b = createSearchStateRepository(second, `${namespace}:cool`);
        expect((await b.status(['duckduckgo'])).engines).toEqual([]);
        expect(
            Number(await redis.hget(`${namespace}:cool:engine:duckduckgo`, 'cooldown')),
        ).toBeGreaterThan(Date.now() + 3_500_000);
        await redis.hset(`${namespace}:cool:engine:duckduckgo`, 'cooldown', 0, 'next', 0);
        const probes = await Promise.all([
            a.acquire(['duckduckgo'], 'a'),
            b.acquire(['duckduckgo'], 'b'),
        ]);
        expect(probes.filter((p) => p.engines.length)).toHaveLength(1);
    });
    it('coalesces across two adapters, isolates accounts, and preserves cooldown on all-failed responses', async () => {
        let count = 0;
        const source: SearchProvider = {
            async search(query) {
                count++;
                await new Promise((resolve) => setTimeout(resolve, 80));
                return {
                    kind: 'search_results',
                    mode: 'live',
                    provider: 'searxng',
                    query,
                    searchedAt: '2026-11-05T00:00:00Z',
                    results: [
                        {
                            kind: 'search_snippet',
                            originalUrl: 'https://example.org',
                            url: 'https://example.org',
                            title: 'Agent',
                            snippet: 'AI agent',
                        },
                    ],
                    coverage: {
                        complete: true,
                        gaps: [],
                        unresponsiveEngines: [],
                        receivedResults: 1,
                        returnedResults: 1,
                        discardedResults: 0,
                        totalResults: 1,
                        truncated: false,
                    },
                } satisfies SearchResponse;
            },
        };
        const a = createManagedSearch({
            source,
            repository: createSearchStateRepository(redis, `${namespace}:merge`, 1),
            scope: 'owner-1',
        });
        const b = createManagedSearch({
            source,
            repository: createSearchStateRepository(second, `${namespace}:merge`, 1),
            scope: 'owner-1',
        });
        const replies = await Promise.all(
            Array.from({ length: 10 }, (_, i) => (i % 2 ? a : b).search('agent')),
        );
        expect(count).toBe(1);
        expect(replies.filter((r) => r.coverage.diagnostics?.cacheHit)).toHaveLength(9);
        await createManagedSearch({
            source,
            repository: createSearchStateRepository(redis, `${namespace}:merge`, 1),
            scope: 'owner-2',
        }).search('agent');
        expect(count).toBe(2);
        const error = new ConnectorError('search_unavailable', 'blocked');
        error.engineFailures = [{ engine: 'duckduckgo', error: 'captcha' }];
        const failing = createManagedSearch({
            source: {
                search: async () => {
                    throw error;
                },
            },
            repository: createSearchStateRepository(redis, `${namespace}:failed`),
            scope: 'owner',
        });
        await expect(failing.search('agent')).rejects.toMatchObject({ code: 'search_unavailable' });
        expect(
            (
                await createSearchStateRepository(second, `${namespace}:failed`).status([
                    'duckduckgo',
                ])
            ).engines,
        ).toEqual([]);
    });
    it('recovers abandoned locks and leases and prevents stale results from overwriting a new owner', async () => {
        const repo = createSearchStateRepository(redis, `${namespace}:recovery`, 1);
        await repo.lock('query', 'old');
        await redis.pexpire(`${namespace}:recovery:lock:query`, 1);
        await repo.acquire(['bing'], 'old');
        await redis.hset(`${namespace}:recovery:engine:bing`, 'lease', 0, 'next', 0);
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(await repo.lock('query', 'new')).toBe(true);
        expect((await repo.acquire(['bing'], 'new')).engines).toEqual(['bing']);
        await repo.publish('query', 'old', 'stale', 1000);
        expect(await repo.cached('query')).toBeNull();
        await repo.publish('query', 'new', 'fresh', 1000);
        await repo.unlock('query', 'old');
        expect(await repo.cached('query')).toBe('fresh');
        expect(await repo.lock('query', 'third')).toBe(false);
    });
});
