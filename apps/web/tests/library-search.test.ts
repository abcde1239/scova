import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import { createServer, type ViteDevServer } from 'vite-plus';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';
import { createSSRApp, effectScope, h, nextTick, type Component } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { createMemoryHistory, createRouter } from 'vue-router';
import { LibrarySearchResponseSchema, parseContract, type SessionResponse } from '@scova/models';
import { createSessionLifecycle } from '@/api/session';
import {
    librarySearchEndpoint,
    searchHitKey,
    searchInputIssue,
    searchPage,
    searchTarget,
    type SearchHit,
} from '@/api/library-search';
import { librarySearchError, useLibrarySearch } from '@/composables/useLibrarySearch';
import libraryRoutes from '@/router/pages/library';
import { createWorkbenchRouter } from '@/router';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const time = '2026-10-31T00:00:00Z';
function source(n = 1): SearchHit {
    return {
        kind: 'source',
        id: id(n),
        sourceId: id(100),
        snapshotId: id(n),
        reportId: null,
        title: '中文小样本 Robotics',
        excerpt: '<script>字面原文</script>\n保留换行',
        matchedBy: 'substring',
        updatedAt: time,
    };
}
function note(target: 'source' | 'report' = 'source', n = 10): SearchHit {
    return {
        ...source(n),
        kind: 'note',
        snapshotId: null,
        sourceId: target === 'source' ? id(100) : null,
        reportId: target === 'report' ? id(200) : null,
        matchedBy: 'fts',
    };
}
const page = (items: SearchHit[] = [source()], nextCursor: string | null = null) => ({
    items,
    nextCursor,
});
const account: SessionResponse = {
    user: {
        id: id(900),
        email: 'reader@example.test',
        preferences: {
            defaultTimezone: 'UTC',
            notificationPreference: { mode: 'summary', runIssues: true },
        },
        createdAt: time,
    },
    csrfToken: 'sample',
};
const disposals: (() => void)[] = [];
const urlText = (value: RequestInfo | URL) =>
    typeof value === 'string' ? value : value instanceof Request ? value.url : value.toString();
function failure(status: number) {
    return Response.json(
        {
            code: status === 400 ? 'INVALID_CURSOR' : 'TEST_FAILURE',
            message: 'sample',
            requestId: 'sample',
        },
        { status },
    );
}
function mount(fetcher: typeof fetch) {
    const lifecycle = createSessionLifecycle({ fetcher });
    lifecycle.replaceSession(account);
    const scope = effectScope();
    const state = scope.run(() => useLibrarySearch(lifecycle))!;
    disposals.push(lifecycle.dispose, () => scope.stop());
    return { lifecycle, state, stop: () => scope.stop() };
}
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}
afterEach(() => {
    for (const dispose of disposals.splice(0).reverse()) dispose();
    vi.useRealTimers();
});

describe('saved-library search input and typed targets', () => {
    it.each(['', '   ', '\n\t'])('rejects blank %j', (q) =>
        expect(searchInputIssue(q)).not.toBe(''),
    );
    it.each([
        '小样本',
        'Robotics',
        '中文 English',
        '  原样  ',
        '% _',
        '中'.repeat(200),
        '😀'.repeat(100),
        'a b c d e f g h',
    ])('accepts supported query %s', (q) => expect(searchInputIssue(q)).toBe(''));
    it.each(['中'.repeat(201), '😀'.repeat(101), 'a b c d e f g h i'])(
        'rejects length or term limit %s',
        (q) => expect(searchInputIssue(q)).not.toBe(''),
    );
    it('routes source hits by sourceId and the exact snapshot rather than hitId-as-source', () => {
        expect(searchTarget(source(1)).path).toBe(`/library/sources/${id(100)}/snapshots/${id(1)}`);
        expect(searchTarget(source(2)).path).not.toBe(searchTarget(source(1)).path);
        expect(searchPage(page([source(1), source(2)])).items).toHaveLength(2);
    });
    it('routes note hits to actual targets without claiming note selection/editing', () => {
        expect(searchTarget(note()).path).toBe(`/library/sources/${id(100)}/snapshots`);
        expect(searchTarget(note('report')).path).toBe(`/reports/${id(200)}`);
        expect(searchTarget(note('report')).path).not.toContain(id(10));
        expect(searchHitKey(source(10))).not.toBe(searchHitKey(note('source', 10)));
    });
    it.each([
        { ...source(), snapshotId: null },
        { ...source(), sourceId: null },
        { ...source(), snapshotId: id(8) },
        { ...source(), reportId: id(8) },
        { ...note(), snapshotId: id(8) },
        { ...note(), sourceId: null },
        { ...note(), reportId: id(8) },
    ])('rejects impossible typed ID combination %#', (hit) =>
        expect(() => searchTarget(hit as SearchHit)).toThrow(),
    );
    it('rejects repeated kind/id but keeps different tables with the same UUID', () => {
        expect(() => searchPage(page([source(), source()]))).toThrow();
        expect(searchPage(page([source(10), note('source', 10)])).items).toHaveLength(2);
        expect(() =>
            searchPage(page(Array.from({ length: 21 }, (_, n) => source(n + 1)))),
        ).toThrow();
    });
    it('rejects self-loop/empty pagination and oversized excerpt at the shared contract boundary', () => {
        expect(() => searchPage(page([source()], 'same'), 'same')).toThrow();
        expect(() => searchPage(page([], 'next'))).toThrow();
        expect(() =>
            parseContract(
                LibrarySearchResponseSchema,
                page([{ ...source(), excerpt: 'x'.repeat(501) }]),
            ),
        ).toThrow();
    });
    it('adds a secondary search route while keeping exact source history and library routes', () => {
        const router = createWorkbenchRouter(createMemoryHistory(), libraryRoutes);
        expect(router.resolve('/library/search').name).toBe('library-search');
        expect(router.resolve('/library').name).toBe('library');
        expect(
            router.resolve(`/library/sources/${id(100)}/snapshots/${id(1)}`).params.snapshotId,
        ).toBe(id(1));
        expect(
            libraryRoutes.find((entry) => entry.name === 'library-search')?.meta?.navigation,
        ).toBeUndefined();
    });
});

describe('unified requestlane transport', () => {
    it('preserves raw q, opaque cursor and false boolean with same-origin GET only', async () => {
        const fetcher = vi.fn<typeof fetch>(async () => Response.json(page()));
        const { lifecycle } = mount(fetcher);
        const cursor = 'opaque:2026-10-31T12:00:00.123456Z/+=';
        await lifecycle.capture().request(librarySearchEndpoint, {
            query: {
                q: '  小样本 Robotics  ',
                kind: 'source',
                bookmarked: false,
                cursor,
                limit: 20,
            },
        });
        const url = new URL(urlText(fetcher.mock.calls[0]![0]), 'https://scova.test');
        expect(url.pathname).toBe('/api/v1/library/search');
        expect(url.searchParams.get('q')).toBe('  小样本 Robotics  ');
        expect(url.searchParams.get('cursor')).toBe(cursor);
        expect(url.searchParams.get('bookmarked')).toBe('false');
        expect(fetcher.mock.calls[0]![1]?.method).toBe('GET');
        expect(fetcher.mock.calls[0]![1]?.credentials).toBe('include');
    });
    it('rejects invalid input before transport and impossible DTO before display', async () => {
        const fetcher = vi.fn<typeof fetch>(async () =>
            Response.json(page([{ ...source(), snapshotId: null }])),
        );
        const { lifecycle } = mount(fetcher);
        await expect(
            lifecycle
                .capture()
                .request(librarySearchEndpoint, { query: { q: 'a b c d e f g h i' } }),
        ).rejects.toThrow();
        expect(fetcher).not.toHaveBeenCalled();
        await expect(
            lifecycle.capture().request(librarySearchEndpoint, { query: { q: '中文' } }),
        ).rejects.toThrow();
    });
});

describe('draft/committed query, cancellation and owner scope', () => {
    it('debounces300ms, keeps IME partial text off transport and allows explicit Enter-style submit', async () => {
        vi.useFakeTimers();
        const fetcher = vi.fn<typeof fetch>(async () => Response.json(page()));
        const { state } = mount(fetcher);
        state.beginComposition();
        state.draft.value = '中';
        await vi.advanceTimersByTimeAsync(1000);
        expect(fetcher).not.toHaveBeenCalled();
        state.endComposition('中文');
        await vi.advanceTimersByTimeAsync(299);
        expect(fetcher).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(state.committed.value?.q).toBe('中文');
        state.draft.value = 'English';
        state.submit();
        await vi.advanceTimersByTimeAsync(0);
        expect(fetcher).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(500);
        expect(fetcher).toHaveBeenCalledTimes(2);
    });
    it('immediately hides previous words and exact filters during the debounce period', async () => {
        const fetcher = vi.fn<typeof fetch>(async () => Response.json(page()));
        const { state } = mount(fetcher);
        state.draft.value = 'A';
        state.submit();
        await vi.waitFor(() => expect(state.items.value).toHaveLength(1));
        state.draft.value = ' B ';
        expect(state.items.value).toEqual([]);
        expect(state.committed.value).toBeUndefined();
        state.kind.value = 'source';
        state.bookmarked.value = 'false';
        state.submit();
        await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
        const url = new URL(urlText(fetcher.mock.calls[1]![0]), 'https://scova.test');
        expect(url.searchParams.get('q')).toBe(' B ');
        expect(url.searchParams.get('kind')).toBe('source');
        expect(url.searchParams.get('bookmarked')).toBe('false');
        expect(url.searchParams.has('cursor')).toBe(false);
    });
    it('cancels and ignores late A/B responses after A→B→A', async () => {
        const responses = [deferred<Response>(), deferred<Response>(), deferred<Response>()];
        const signals: AbortSignal[] = [];
        const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
            signals.push(init!.signal!);
            return responses[signals.length - 1]!.promise;
        });
        const { state } = mount(fetcher);
        for (const [index, q] of ['A', 'B', 'A'].entries()) {
            state.draft.value = q;
            state.submit();
            await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(index + 1));
        }
        expect(signals[0]!.aborted).toBe(true);
        expect(signals[1]!.aborted).toBe(true);
        responses[2]!.resolve(Response.json(page([source(3)])));
        await vi.waitFor(() => expect(state.items.value[0]?.id).toBe(id(3)));
        responses[0]!.resolve(Response.json(page([source(1)])));
        responses[1]!.resolve(Response.json(page([source(2)])));
        await nextTick();
        expect(state.items.value[0]?.id).toBe(id(3));
    });
    it('cancel preserves input and aborts in-flight; clear and scope disposal stop pending debounce', async () => {
        vi.useFakeTimers();
        const pending = deferred<Response>();
        let signal: AbortSignal | undefined;
        const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
            signal = init?.signal ?? undefined;
            return pending.promise;
        });
        const { state, stop } = mount(fetcher);
        state.draft.value = '中文';
        state.submit();
        await vi.advanceTimersByTimeAsync(0);
        state.cancel();
        expect(signal?.aborted).toBe(true);
        expect(state.draft.value).toBe('中文');
        expect(state.items.value).toEqual([]);
        state.draft.value = 'new';
        state.clear();
        await vi.advanceTimersByTimeAsync(500);
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(state.draft.value).toBe('');
        state.draft.value = 'dispose';
        stop();
        await vi.advanceTimersByTimeAsync(500);
        expect(fetcher).toHaveBeenCalledTimes(1);
        pending.resolve(Response.json(page()));
    });
    it('clears owner input/pages and rejects an old owner late401 without clearing the new account', async () => {
        const pending = deferred<Response>();
        const fetcher = vi.fn<typeof fetch>(async () => pending.promise);
        const { state, lifecycle } = mount(fetcher);
        state.draft.value = 'owner';
        state.submit();
        await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
        lifecycle.replaceSession({ ...account, user: { ...account.user, id: id(901) } });
        expect(state.draft.value).toBe('');
        expect(state.committed.value).toBeUndefined();
        expect(state.previous.value).toEqual([]);
        pending.resolve(failure(401));
        await nextTick();
        expect(lifecycle.session.user?.id).toBe(id(901));
        expect(state.items.value).toEqual([]);
    });
    it('makes no request for blank/invalid query or anonymous owner', async () => {
        const fetcher = vi.fn<typeof fetch>();
        const { state, lifecycle } = mount(fetcher);
        state.draft.value = '  ';
        state.submit();
        await nextTick();
        state.draft.value = 'x'.repeat(201);
        state.submit();
        await nextTick();
        lifecycle.replaceSession(null);
        state.draft.value = 'valid';
        state.submit();
        await nextTick();
        expect(fetcher).not.toHaveBeenCalled();
    });
});

describe('opaque paging, recovery and explicit failures', () => {
    it('pages with opaque cursor and back, clearing cursor on filter change', async () => {
        const cursor = 'opaque-microseconds.123456';
        const fetcher = vi.fn<typeof fetch>(async (url) =>
            Response.json(
                new URL(urlText(url), 'https://scova.test').searchParams.has('cursor')
                    ? page([source(2)])
                    : page([source(1)], cursor),
            ),
        );
        const { state } = mount(fetcher);
        state.draft.value = '中文';
        state.submit();
        await vi.waitFor(() => expect(state.canNext.value).toBe(true));
        state.next();
        await vi.waitFor(() => expect(state.items.value[0]?.id).toBe(id(2)));
        expect(
            new URL(urlText(fetcher.mock.calls[1]![0]), 'https://scova.test').searchParams.get(
                'cursor',
            ),
        ).toBe(cursor);
        state.back();
        await vi.waitFor(() => expect(state.items.value[0]?.id).toBe(id(1)));
        state.kind.value = 'source';
        expect(state.cursor.value).toBeUndefined();
        expect(state.previous.value).toEqual([]);
        expect(state.items.value).toEqual([]);
    });
    it('first-page recovery after400 performs a new real GET despite cached first page', async () => {
        let firstReads = 0;
        const fetcher = vi.fn<typeof fetch>(async (url) => {
            if (new URL(urlText(url), 'https://scova.test').searchParams.has('cursor'))
                return failure(400);
            firstReads++;
            return Response.json(page([source(firstReads)], 'invalidated-cursor'));
        });
        const { state } = mount(fetcher);
        state.draft.value = 'English';
        state.submit();
        await vi.waitFor(() => expect(state.canNext.value).toBe(true));
        state.next();
        await vi.waitFor(() => expect(state.query.isError.value).toBe(true));
        expect(firstReads).toBe(1);
        expect(state.items.value).toEqual([]);
        await state.first();
        await vi.waitFor(() => expect(state.items.value[0]?.id).toBe(id(2)));
        expect(firstReads).toBe(2);
    });
    it.each(['duplicate', 'cycle'] as const)(
        'blocks cross-page %s instead of displaying unsafe results',
        async (variant) => {
            let reads = 0;
            const fetcher = vi.fn<typeof fetch>(async () =>
                Response.json(
                    ++reads === 1
                        ? page([source(1)], 'next')
                        : variant === 'duplicate'
                          ? page([source(1)])
                          : page([source(2)], 'next'),
                ),
            );
            const { state } = mount(fetcher);
            state.draft.value = 'q';
            state.submit();
            await vi.waitFor(() => expect(state.canNext.value).toBe(true));
            state.next();
            await vi.waitFor(() =>
                expect(state.pageProblem.value || state.query.isError.value).toBeTruthy(),
            );
            expect(state.items.value).toEqual([]);
            expect(state.canNext.value).toBe(false);
        },
    );
    it.each([422, 503, 403, 404, 409])(
        'keeps HTTP%s as error rather than empty success',
        async (status) => {
            const { state } = mount(async () => failure(status));
            state.draft.value = 'q';
            state.submit();
            await vi.waitFor(() => expect(state.query.isError.value).toBe(true));
            expect(state.ready.value).toBe(false);
            expect(state.items.value).toEqual([]);
            expect(librarySearchError(state.query.error.value)).not.toBe('');
        },
    );
    it('accepts a genuine empty page and refuses wrong kind/bookmarked target responses', async () => {
        const { state } = mount(async () => Response.json(page([])));
        state.draft.value = 'empty';
        state.submit();
        await vi.waitFor(() => expect(state.ready.value).toBe(true));
        expect(state.items.value).toEqual([]);
        const other = mount(async () => Response.json(page([note('report')])));
        other.state.draft.value = 'q';
        other.state.bookmarked.value = 'true';
        other.state.submit();
        await vi.waitFor(() => expect(other.state.query.isError.value).toBe(true));
        expect(other.state.items.value).toEqual([]);
        other.state.bookmarked.value = 'all';
        other.state.kind.value = 'source';
        other.state.submit();
        await vi.waitFor(() => expect(other.state.query.isError.value).toBe(true));
    });
});

describe('actual results SFC plain excerpt', () => {
    let server: ViteDevServer;
    let component: Component;
    beforeAll(async () => {
        server = await createServer({
            configFile: false,
            root: fileURLToPath(new URL('..', import.meta.url)),
            plugins: [vue()],
            optimizeDeps: { noDiscovery: true, include: [] },
            resolve: { alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) } },
            server: { middlewareMode: true, watch: null, hmr: false },
            appType: 'custom',
        });
        component = (await server.ssrLoadModule('/src/components/library/LibrarySearchResults.vue'))
            .default as Component;
    });
    afterAll(async () => server?.close());
    it('escapes hostile text without truncating500-code-unit excerpt or changing exact targets', async () => {
        const hit = {
            ...source(),
            title: '<img src=x onerror=bad()>',
            excerpt: '<script>bad()</script>\n' + '中'.repeat(477),
        };
        expect(hit.excerpt).toHaveLength(500);
        const router = createRouter({
            history: createMemoryHistory(),
            routes: [{ path: '/:pathMatch(.*)*', component: { render: () => null } }],
        });
        const output = await renderToString(
            createSSRApp({ render: () => h(component, { items: [hit, note('report')] }) }).use(
                router,
            ),
        );
        expect(output).not.toContain('<script>');
        expect(output).not.toContain('<img src=x');
        expect(output).toContain('&lt;script&gt;bad()&lt;/script&gt;\n' + '中'.repeat(477));
        expect(output).toContain(`href="/library/sources/${id(100)}/snapshots/${id(1)}"`);
        expect(output).toContain(`href="/reports/${id(200)}"`);
        expect(output).not.toContain('bodyStatus');
    });
});
