import { describe, expect, it, vi } from 'vite-plus/test';
import { ConnectorError, type SearchProvider, type SearchResponse } from '@scova/connectors';
import type { SearchStateRepository } from '../src/repo/search.ts';
import { createManagedSearch } from '../src/service/search.ts';

export function searchFixture() {
    const cache = new Map<string, string>();
    const locks = new Map<string, string>();
    const blocked = new Set<string>();
    const repository: SearchStateRepository = {
        status: async (engines) => ({
            engines: engines.filter((e) => !blocked.has(e)),
            waitMs: 3600_000,
        }),
        acquire: async (engines) => ({ engines, waitMs: 0 }),
        finish: vi.fn<SearchStateRepository['finish']>(async (_engines, _owner, failures) => {
            failures.forEach((f) => blocked.add(f.engine));
        }),
        cached: async (key) => cache.get(key) ?? null,
        lock: async (key, owner) => {
            if (locks.has(key)) return false;
            locks.set(key, owner);
            return true;
        },
        publish: async (key, owner, value) => {
            if (locks.get(key) === owner) cache.set(key, value);
        },
        unlock: async (key, owner) => {
            if (locks.get(key) === owner) locks.delete(key);
        },
    };
    const response: SearchResponse = {
        kind: 'search_results',
        mode: 'live',
        provider: 'searxng',
        query: 'agent',
        searchedAt: '2026-11-05T00:00:00Z',
        results: [
            {
                kind: 'search_snippet',
                originalUrl: 'https://example.org',
                url: 'https://example.org',
                title: 'Agent',
                snippet: 'Agent architecture',
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
    };
    const source = {
        search: vi.fn<SearchProvider['search']>(async (query, context) => {
            await context?.beforeAttempt?.('search');
            await new Promise((resolve) => setTimeout(resolve, 30));
            return { ...structuredClone(response), query };
        }),
    };
    return { repository, source, response, blocked, cache, locks };
}

describe('managed search service', () => {
    it('charges retries separately, rechecks the fence, and reports failed adapter attempts', async () => {
        const f = searchFixture();
        vi.mocked(f.source.search).mockRejectedValue(
            new ConnectorError('network', 'unavailable', true),
        );
        const beforeAttempt = vi.fn();
        const beforeDispatch = vi.fn();
        await expect(
            createManagedSearch({ ...f, scope: 'retry' }).search('agent', {
                beforeAttempt,
                beforeDispatch,
            }),
        ).rejects.toMatchObject({ searchNetworkAttempts: 3 });
        expect(beforeAttempt).toHaveBeenCalledTimes(3);
        expect(beforeDispatch).toHaveBeenCalled();
        expect(f.source.search).toHaveBeenCalledTimes(3);
        expect(f.locks.size).toBe(0);
    });
    it('does not publish or reuse a cache after its absolute window expires', async () => {
        const f = searchFixture();
        const search = createManagedSearch({
            ...f,
            scope: 'midnight',
            cacheExpiresAt: Date.now() - 1,
        });
        await search.search('agent');
        await search.search('agent');
        expect(f.source.search).toHaveBeenCalledTimes(2);
        expect(f.cache.size).toBe(0);
    });
    it('canceling a coalesced waiter leaves the owner and cache usable', async () => {
        const f = searchFixture();
        const search = createManagedSearch({ ...f, scope: 'cancel' });
        const owner = search.search('agent');
        const controller = new AbortController();
        const follower = search.search('agent', { signal: controller.signal });
        controller.abort();
        await expect(follower).rejects.toMatchObject({ code: 'aborted' });
        await owner;
        expect((await search.search('agent')).coverage.diagnostics?.cacheHit).toBe(true);
        expect(f.source.search).toHaveBeenCalledTimes(1);
    });
    it('propagates a longer trusted Retry-After to shared cooldown', async () => {
        const f = searchFixture();
        const error = new ConnectorError('http', 'limited', true, 429);
        error.retryAfterMs = 7_200_000;
        const finish = vi.fn<SearchStateRepository['finish']>(async () => {});
        f.repository.finish = finish;
        vi.mocked(f.source.search).mockRejectedValueOnce(error);
        await expect(
            createManagedSearch({ ...f, scope: '429' }).search('agent'),
        ).rejects.toMatchObject({ status: 429 });
        expect(finish).toHaveBeenCalledWith(
            expect.any(Array),
            expect.any(String),
            expect.arrayContaining([
                { engine: 'bing', error: 'rate_limited', retryAfterMs: 7_200_000 },
            ]),
        );
        expect(f.source.search).toHaveBeenCalledTimes(1);
    });
    it('coalesces ten requests but bills each logical call once and retains original search time', async () => {
        const fixture = searchFixture();
        const service = createManagedSearch({ ...fixture, scope: 'owner-1' });
        const beforeAttempt = vi.fn();
        const responses = await Promise.all(
            Array.from({ length: 10 }, () => service.search('agent', { beforeAttempt })),
        );
        expect(fixture.source.search).toHaveBeenCalledTimes(1);
        expect(beforeAttempt).toHaveBeenCalledTimes(10);
        expect(responses.filter((r) => r.coverage.diagnostics?.cacheHit)).toHaveLength(9);
        expect(responses.every((r) => r.searchedAt === fixture.response.searchedAt)).toBe(true);
        await createManagedSearch({ ...fixture, scope: 'owner-2' }).search('agent');
        expect(fixture.source.search).toHaveBeenCalledTimes(2);
    });
    it('excludes a captcha engine on the next call even after service recreation', async () => {
        const f = searchFixture();
        vi.mocked(f.source.search).mockResolvedValueOnce({
            ...f.response,
            coverage: {
                ...f.response.coverage,
                complete: false,
                unresponsiveEngines: [{ engine: 'duckduckgo', error: 'captcha' }],
            },
        });
        await createManagedSearch({ ...f, scope: 'owner' }).search('agent');
        await createManagedSearch({ ...f, scope: 'owner' }).search('other');
        expect(vi.mocked(f.source.search).mock.calls[1][1]?.engines).toEqual([
            'bing',
            'google cse',
        ]);
    });
    it('fails closed on Redis failure and makes no source call after cancellation', async () => {
        const f = searchFixture();
        f.repository.status = async () => {
            throw new Error('redis secret');
        };
        await expect(
            createManagedSearch({ ...f, scope: 'owner' }).search('agent'),
        ).rejects.toMatchObject({ code: 'search_unavailable' });
        expect(f.source.search).not.toHaveBeenCalled();
        const controller = new AbortController();
        controller.abort();
        await expect(
            createManagedSearch({ ...f, scope: 'owner' }).search('agent', {
                signal: controller.signal,
            }),
        ).rejects.toBeDefined();
        expect(f.source.search).not.toHaveBeenCalled();
    });
    it('retains captcha metadata even when every engine has failed', async () => {
        const f = searchFixture();
        const error = new ConnectorError('search_unavailable', 'blocked');
        error.engineFailures = [{ engine: 'duckduckgo', error: 'captcha' }];
        vi.mocked(f.source.search).mockRejectedValueOnce(error);
        await expect(
            createManagedSearch({ ...f, scope: 'owner' }).search('agent'),
        ).rejects.toMatchObject({ code: 'search_unavailable' });
        expect(f.blocked.has('duckduckgo')).toBe(true);
        expect(f.locks.size).toBe(0);
    });
});
