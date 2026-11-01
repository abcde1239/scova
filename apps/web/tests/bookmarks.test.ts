import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { effectScope, ref } from 'vue';
import { createMemoryHistory } from 'vue-router';
import type { Report, SessionResponse } from '@scova/models';
import { createSessionLifecycle } from '@/api/session';
import {
    bookmarksEndpoint,
    createBookmarkEndpoint,
    deleteBookmarkEndpoint,
    type Bookmark,
} from '@/api/library';
import {
    bookmarkOrigin,
    readBookmarkOrigin,
    reportBookmarkSources,
    useBookmark,
    useBookmarks,
    validateBookmarkPage,
} from '@/composables/useBookmarks';
import { collectPages, createWorkbenchRouter } from '@/router';
import libraryRoutes from '@/router/pages/library';
import workbenchRoutes from '@/router/pages/workbench';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const sourceId = id(21);
const time = '2026-10-31T01:00:00Z';
function bookmark(n = 1): Bookmark {
    return {
        id: id(n),
        sourceId: n === 1 ? sourceId : id(n + 100),
        createdAt: time,
        source: {
            id: n === 1 ? sourceId : id(n + 100),
            canonicalUrl: 'https://example.test/source',
            title: '<script>招生资料',
            latestSnapshotId: id(22),
            lastObservedAt: time,
        },
    };
}
const account: SessionResponse = {
    user: {
        id: id(1000),
        email: 'sample@example.test',
        preferences: {
            defaultTimezone: 'UTC',
            notificationPreference: { mode: 'summary', runIssues: true },
        },
        createdAt: time,
    },
    csrfToken: 'test-only',
};
const disposals: (() => void)[] = [];
function setup(fetcher: typeof fetch, known?: Bookmark) {
    const lifecycle = createSessionLifecycle({ fetcher });
    lifecycle.replaceSession(account);
    const scope = effectScope();
    const source = ref<unknown>(sourceId);
    const action = scope.run(() => useBookmark(source, known, lifecycle))!;
    disposals.push(() => {
        scope.stop();
        lifecycle.dispose();
    });
    return { lifecycle, scope, source, action };
}
function requestUrl(input: RequestInfo | URL) {
    return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}
function error(status: number) {
    return Response.json({ code: 'TEST_FAILURE', message: 'test', requestId: 'test' }, { status });
}
const page = (items: Bookmark[] = [], nextCursor: string | null = null) =>
    Response.json({ items, nextCursor });
afterEach(() => disposals.splice(0).forEach((dispose) => dispose()));

describe('bookmark contracts and navigation', () => {
    it('replaces only the pending library route and preserves primary navigation', () => {
        const pages = collectPages([workbenchRoutes, libraryRoutes]);
        const router = createWorkbenchRouter(createMemoryHistory(), pages);
        const route = router.resolve('/library');
        expect(route.name).toBe('library');
        expect(route.meta.pending).toBe(false);
        expect(route.meta.navigation).toBe('primary');
    });
    it('deduplicates existing report sources without HTML or image fabrication', () => {
        const report = {
            evidence: [
                { sourceId, title: '<img>资料' },
                { sourceId, title: '同一来源' },
            ],
        } as unknown as Report;
        expect(reportBookmarkSources(report)).toEqual([{ id: sourceId, title: '同一来源' }]);
        expect(report.evidence).toHaveLength(2);
    });
    it.each([
        { items: [bookmark(), bookmark()] },
        { items: [bookmark(), { ...bookmark(), id: id(9) }] },
        { items: [{ ...bookmark(), source: { ...bookmark().source, id: id(99) } }] },
    ])('rejects duplicate or mismatched source summaries', ({ items }) => {
        expect(() => validateBookmarkPage({ items, nextCursor: null })).toThrow();
    });
    it('rejects repeated and oversize next cursors without interpreting cursor contents', () => {
        expect(() => validateBookmarkPage({ items: [], nextCursor: 'opaque' }, 'opaque')).toThrow();
        expect(() => validateBookmarkPage({ items: [], nextCursor: 'a'.repeat(1025) })).toThrow();
        expect(validateBookmarkPage({ items: [], nextCursor: 'opaque+/=%游标' }).nextCursor).toBe(
            'opaque+/=%游标',
        );
    });
    it('validates UUID and query input before transport', async () => {
        const fetcher = vi.fn<typeof fetch>(async () => page());
        const { lifecycle } = setup(fetcher);
        for (const endpoint of [createBookmarkEndpoint, deleteBookmarkEndpoint])
            expect(endpoint.options.cache).toBe(false);
        await expect(
            lifecycle.capture().request(createBookmarkEndpoint, { body: { sourceId: '../bad' } }),
        ).rejects.toThrow();
        await expect(
            lifecycle.capture().request(deleteBookmarkEndpoint, { params: { bookmarkId: 'bad' } }),
        ).rejects.toThrow();
        await expect(
            lifecycle.capture().request(bookmarksEndpoint, { query: { cursor: '' } }),
        ).rejects.toThrow();
        expect(fetcher).not.toHaveBeenCalled();
    });
    it('only accepts same account, epoch and in-memory nonce report-origin context', () => {
        const { lifecycle } = setup(async () => page());
        const context = bookmarkOrigin(lifecycle, id(30), sourceId)!;
        expect(readBookmarkOrigin(lifecycle, context)).toEqual({
            sourceId,
            path: `/reports/${id(30)}`,
        });
        for (const bad of [
            { ...context, reportId: 'https://evil.test' },
            { ...context, sourceId: 'bad' },
            { ...context, owner: id(1001) },
            { ...context, nonce: 'other-page-lifecycle' },
        ])
            expect(readBookmarkOrigin(lifecycle, bad)).toBeUndefined();
        const replacement = createSessionLifecycle();
        replacement.replaceSession(account);
        disposals.push(replacement.dispose);
        expect(replacement.session.epoch).toBe(lifecycle.session.epoch);
        expect(readBookmarkOrigin(replacement, context)).toBeUndefined();
        lifecycle.replaceSession({ ...account, user: { ...account.user, id: id(1001) } });
        expect(readBookmarkOrigin(lifecycle, context)).toBeUndefined();
    });
});

describe('bookmark actions', () => {
    it('does not seed the next account source cache with the previous account known bookmark', async () => {
        const { action, lifecycle } = setup(async () => page(), bookmark());
        expect(action.bookmark.value?.id).toBe(id(1));
        lifecycle.replaceSession({ ...account, user: { ...account.user, id: id(1001) } });
        await vi.waitFor(() => expect(action.bookmark.value).toBeUndefined());
        expect(
            lifecycle.queryClient
                .getQueryCache()
                .getAll()
                .every((query) => query.queryKey[1] === id(1001)),
        ).toBe(true);
    });
    it.each([false, true])(
        'confirms POST reused=%s with exact status, CSRF and no speculative GET',
        async (reused) => {
            const calls: RequestInit[] = [];
            const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
                calls.push(init!);
                return Response.json(
                    { bookmark: bookmark(), reused },
                    { status: reused ? 200 : 201 },
                );
            });
            const { action } = setup(fetcher);
            expect(fetcher).not.toHaveBeenCalled();
            expect(action.bookmark.value).toBeUndefined();
            await action.write();
            expect(action.bookmark.value?.sourceId).toBe(sourceId);
            expect(action.notice.value).toContain(reused ? '复用' : '已收藏');
            expect(calls[0]?.credentials).toBe('same-origin');
            expect(new Headers(calls[0]?.headers).get('x-csrf-token')).toBe('test-only');
            expect(calls[0]?.body).toBe(JSON.stringify({ sourceId }));
            expect(fetcher).toHaveBeenCalledTimes(1);
        },
    );
    it('cancels only the bookmark with 204 and retains report cache', async () => {
        const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
        const { action, lifecycle } = setup(fetcher, bookmark());
        lifecycle.queryClient.setQueryData(['report-retained'], {
            claim: 'unchanged',
            evidence: 'unchanged',
        });
        await action.write(true);
        expect(requestUrl(fetcher.mock.calls[0]![0])).toBe(`/api/v1/bookmarks/${id(1)}`);
        expect(fetcher.mock.calls[0]![1]?.method).toBe('DELETE');
        expect(action.bookmark.value).toBeUndefined();
        expect(action.notice.value).toContain('报告和证据仍保留');
        expect(lifecycle.queryClient.getQueryData(['report-retained'])).toEqual({
            claim: 'unchanged',
            evidence: 'unchanged',
        });
        expect(lifecycle.queryClient.getQueryState(['report-retained'])?.isInvalidated).toBe(false);
    });
    it.each([403, 409, 422])('keeps confirmed data after known HTTP %i', async (status) => {
        const { action } = setup(async () => error(status), bookmark());
        await action.write(true);
        expect(action.bookmark.value?.id).toBe(id(1));
        expect(action.uncertain.value).toBe(false);
        expect(action.notice.value).toContain('保留');
    });
    it.each([
        { status: 200, reused: false, value: bookmark() },
        { status: 201, reused: true, value: bookmark() },
        { status: 201, reused: false, value: bookmark(2) },
    ])(
        'does not install inconsistent success status or source',
        async ({ status, reused, value }) => {
            const { action } = setup(async () =>
                Response.json({ bookmark: value, reused }, { status }),
            );
            await action.write();
            expect(action.bookmark.value).toBeUndefined();
            expect(action.uncertain.value).toBe(true);
        },
    );
    it('treats repeated DELETE 404 conservatively until a complete actual reread', async () => {
        const { action } = setup(
            async (_url, init) => (init?.method === 'DELETE' ? error(404) : page()),
            bookmark(),
        );
        await action.write(true);
        expect(action.bookmark.value?.id).toBe(id(1));
        expect(action.uncertain.value).toBe(true);
        await action.verify();
        expect(action.uncertain.value).toBe(false);
        expect(action.bookmark.value).toBeUndefined();
        expect(action.notice.value).toContain('完整收藏列表');
    });
    it('blocks simultaneous pointer or keyboard commands while keeping old data', async () => {
        let release!: (value: Response) => void;
        const fetcher = vi.fn<typeof fetch>(
            async () =>
                new Promise<Response>((resolve) => {
                    release = resolve;
                }),
        );
        const { action } = setup(fetcher, bookmark());
        const first = action.write(true);
        await action.write(true);
        expect(action.pending.value).toBe(true);
        expect(action.bookmark.value?.id).toBe(id(1));
        await vi.waitFor(() => expect(release).toBeDefined());
        release(new Response(null, { status: 204 }));
        await first;
        expect(fetcher).toHaveBeenCalledTimes(1);
    });
    it('finds a source on a deeper page before unlocking an unknown POST', async () => {
        const cursors: (string | null)[] = [];
        const nextCursor = 'opaque+/=%游标';
        const { action } = setup(async (url, init) => {
            if (init?.method === 'POST') throw new TypeError('response lost');
            const cursor = new URL(requestUrl(url), 'https://app.test').searchParams.get('cursor');
            cursors.push(cursor);
            return cursor ? page([bookmark()], 'unused-next') : page([bookmark(2)], nextCursor);
        });
        await action.write();
        expect(action.uncertain.value).toBe(true);
        await action.verify();
        expect(cursors).toEqual([null, nextCursor]);
        expect(action.bookmark.value?.id).toBe(id(1));
        expect(action.uncertain.value).toBe(false);
    });
    it('does not infer absence from the first page and keeps lock after deep-page failure', async () => {
        let succeed = false;
        const { action } = setup(async (url, init) => {
            if (init?.method === 'POST') throw new TypeError('response lost');
            return requestUrl(url).includes('cursor=')
                ? succeed
                    ? page([])
                    : error(503)
                : page([bookmark(2)], 'next');
        });
        await action.write();
        await action.verify();
        expect(action.uncertain.value).toBe(true);
        expect(action.canWrite.value).toBe(false);
        succeed = true;
        await action.verify();
        expect(action.uncertain.value).toBe(false);
        expect(action.bookmark.value).toBeUndefined();
        expect(action.notice.value).toContain('完整收藏列表');
    });
    it('keeps unknown state on a repeated scan cursor', async () => {
        const { action } = setup(async (_url, init) =>
            init?.method === 'POST' ? error(503) : page([bookmark(2)], 'repeat'),
        );
        await action.write();
        await action.verify();
        expect(action.uncertain.value).toBe(true);
        expect(action.query.isError.value).toBe(true);
    });
    it('keeps lock when an actual verification is canceled back to successful cache', async () => {
        let release!: (response: Response) => void;
        const { action, lifecycle } = setup(
            async (_url, init) =>
                init?.method === 'POST'
                    ? error(503)
                    : new Promise<Response>((resolve) => {
                          release = resolve;
                      }),
            bookmark(),
        );
        await action.write();
        const verify = action.verify();
        await vi.waitFor(() => expect(release).toBeDefined());
        const query = lifecycle.queryClient
            .getQueryCache()
            .getAll()
            .find((entry) => entry.queryKey[4] === 'source')!;
        await lifecycle.queryClient.cancelQueries({ queryKey: query.queryKey, exact: true });
        await verify;
        release(page());
        expect(action.query.isSuccess.value).toBe(true);
        expect(action.uncertain.value).toBe(true);
        expect(action.bookmark.value?.id).toBe(id(1));
    });
    it('preserves unknown lock across remount until an actual full scan', async () => {
        const { action, lifecycle, scope } = setup(async (_url, init) =>
            init?.method === 'POST' ? error(503) : page([bookmark()]),
        );
        await action.write();
        scope.stop();
        const replacementScope = effectScope();
        const replacement = replacementScope.run(() =>
            useBookmark(sourceId, undefined, lifecycle),
        )!;
        disposals.push(() => replacementScope.stop());
        expect(replacement.uncertain.value).toBe(true);
        expect(replacement.canWrite.value).toBe(false);
        await replacement.verify();
        expect(replacement.uncertain.value).toBe(false);
        expect(replacement.bookmark.value?.id).toBe(id(1));
    });
    it.each([200, 401])('isolates late old-account POST HTTP %i', async (status) => {
        let release!: (response: Response) => void;
        let signal: AbortSignal | null | undefined;
        const { action, lifecycle } = setup(async (_url, init) => {
            signal = init?.signal;
            return new Promise<Response>((resolve) => {
                release = resolve;
            });
        });
        const write = action.write();
        await vi.waitFor(() => expect(release).toBeDefined());
        lifecycle.replaceSession({ ...account, user: { ...account.user, id: id(1001) } });
        release(
            status === 200 ? Response.json({ bookmark: bookmark(), reused: true }) : error(status),
        );
        await write;
        expect(signal?.aborted).toBe(true);
        expect(lifecycle.session.user?.id).toBe(id(1001));
        expect(action.bookmark.value).toBeUndefined();
        expect(action.notice.value).toBe('');
    });
    it('cancels source changes and restores the old source unknown lock when revisited', async () => {
        let release!: (response: Response) => void;
        const { action, source } = setup(
            async () =>
                new Promise<Response>((resolve) => {
                    release = resolve;
                }),
        );
        const write = action.write();
        await vi.waitFor(() => expect(release).toBeDefined());
        source.value = id(99);
        release(Response.json({ bookmark: bookmark(), reused: false }, { status: 201 }));
        await write;
        expect(action.bookmark.value).toBeUndefined();
        source.value = sourceId;
        expect(action.uncertain.value).toBe(true);
    });
    it('shares pending protection between different source actions without disabling future actions', async () => {
        let release!: (response: Response) => void;
        const fetcher = vi.fn<typeof fetch>(
            async () =>
                new Promise<Response>((resolve) => {
                    release = resolve;
                }),
        );
        const { lifecycle, scope, action } = setup(fetcher);
        const other = scope.run(() => useBookmark(id(99), undefined, lifecycle))!;
        const writing = action.write();
        await vi.waitFor(() => expect(release).toBeDefined());
        expect(other.pending.value).toBe(true);
        expect(other.canWrite.value).toBe(false);
        await other.write();
        expect(fetcher).toHaveBeenCalledTimes(1);
        release(Response.json({ bookmark: bookmark(), reused: false }, { status: 201 }));
        await writing;
        expect(other.pending.value).toBe(false);
        expect(other.canWrite.value).toBe(true);
        expect(other.bookmark.value).toBeUndefined();
    });
    it('reconciles a DELETE404 to a newly created record for the same source, then deletes the new id', async () => {
        const deletes: string[] = [];
        const fresh = { ...bookmark(), id: id(9) };
        const { action } = setup(async (url, init) => {
            if (init?.method === 'DELETE') {
                deletes.push(requestUrl(url));
                return deletes.length === 1 ? error(404) : new Response(null, { status: 204 });
            }
            return page([fresh]);
        }, bookmark());
        await action.write(true);
        expect(action.uncertain.value).toBe(true);
        expect(action.bookmark.value?.id).toBe(id(1));
        await action.verify();
        expect(action.uncertain.value).toBe(false);
        expect(action.bookmark.value?.id).toBe(id(9));
        await action.write(true);
        expect(deletes).toEqual([`/api/v1/bookmarks/${id(1)}`, `/api/v1/bookmarks/${id(9)}`]);
        expect(action.bookmark.value).toBeUndefined();
    });
});

describe('library pagination', () => {
    it('does not erase confirmed source state when the ordinary current page omits it', async () => {
        const { action, lifecycle, scope } = setup(async () => page([bookmark(2)]), bookmark());
        const list = scope.run(() => useBookmarks(lifecycle))!;
        await vi.waitFor(() => expect(list.query.isSuccess.value).toBe(true));
        expect(list.items.value[0]?.sourceId).not.toBe(sourceId);
        expect(action.bookmark.value?.id).toBe(id(1));
        expect(action.canWrite.value).toBe(true);
    });
    it('does not clear an unknown command lock merely because a normal page seeds the source detail', async () => {
        const { lifecycle, scope, action } = setup(async (_url, init) =>
            init?.method === 'POST' ? error(503) : page([bookmark()]),
        );
        await action.write();
        const list = scope.run(() => useBookmarks(lifecycle))!;
        await vi.waitFor(() => expect(list.query.isSuccess.value).toBe(true));
        expect(action.bookmark.value?.id).toBe(id(1));
        expect(action.uncertain.value).toBe(true);
        expect(action.canWrite.value).toBe(false);
        await action.verify();
        expect(action.uncertain.value).toBe(false);
    });
    it.each([null, { ...bookmark(), id: id(8) }])(
        'installs the actual list record over old source detail and deletes the new id',
        async (oldValue) => {
            const fresh = { ...bookmark(), id: id(9) };
            let removed = false;
            const deletes: string[] = [];
            const { lifecycle, scope, action } = setup(async (url, init) => {
                if (init?.method === 'DELETE') {
                    deletes.push(requestUrl(url));
                    removed = true;
                    return new Response(null, { status: 204 });
                }
                return page(removed ? [] : [fresh]);
            });
            const key = lifecycle.capture().queryKey(['bookmarks', 'source', sourceId]);
            lifecycle.queryClient.setQueryData(key, { bookmark: oldValue });
            const list = scope.run(() => useBookmarks(lifecycle))!;
            await vi.waitFor(() => expect(list.query.isSuccess.value).toBe(true));
            expect(action.bookmark.value?.id).toBe(id(9));
            await action.write(true);
            expect(deletes).toEqual([`/api/v1/bookmarks/${id(9)}`]);
            expect(action.bookmark.value).toBeUndefined();
        },
    );
    it('keeps opaque cursors exact on next, retry and back without accumulating entries', async () => {
        const cursor = 'opaque+/=%游标';
        let fail = false;
        const seen: (string | null)[] = [];
        const { lifecycle, scope } = setup(async (url) => {
            const value = new URL(requestUrl(url), 'https://app.test').searchParams.get('cursor');
            seen.push(value);
            return value ? (fail ? error(503) : page([bookmark(2)])) : page([bookmark()], cursor);
        });
        const list = scope.run(() => useBookmarks(lifecycle))!;
        await vi.waitFor(() => expect(list.items.value).toHaveLength(1));
        fail = true;
        list.next();
        await vi.waitFor(() => expect(list.query.isError.value).toBe(true));
        expect(list.cursor.value).toBe(cursor);
        fail = false;
        await list.query.refetch();
        expect(list.items.value[0]?.id).toBe(id(2));
        expect(seen).toEqual([null, cursor, cursor]);
        list.back();
        expect(list.cursor.value).toBeUndefined();
        await vi.waitFor(() => expect(list.items.value[0]?.id).toBe(id(1)));
    });
    it.each([403, 404, 200])(
        'hides cached list on authorization or malformed protocol HTTP %i',
        async (status) => {
            let fail = false;
            const { lifecycle, scope } = setup(async () =>
                fail
                    ? status === 200
                        ? new Response('{broken', {
                              headers: { 'content-type': 'application/json' },
                          })
                        : error(status)
                    : page([bookmark()]),
            );
            const list = scope.run(() => useBookmarks(lifecycle))!;
            await vi.waitFor(() => expect(list.items.value).toHaveLength(1));
            fail = true;
            await list.query.refetch();
            expect(list.items.value).toEqual([]);
        },
    );
    it('resets the active later page after cancellation and preserves other domains', async () => {
        let removed = false;
        const requests: (string | null)[] = [];
        const { lifecycle, scope, action } = setup(async (url, init) => {
            if (init?.method === 'DELETE') {
                removed = true;
                return new Response(null, { status: 204 });
            }
            const cursor = new URL(requestUrl(url), 'https://app.test').searchParams.get('cursor');
            requests.push(cursor);
            return removed
                ? page([bookmark(3)])
                : cursor
                  ? page([bookmark(2)])
                  : page([bookmark()], 'next');
        }, bookmark());
        const list = scope.run(() => useBookmarks(lifecycle))!;
        await vi.waitFor(() => expect(list.items.value).toHaveLength(1));
        list.next();
        await vi.waitFor(() => expect(list.items.value[0]?.id).toBe(id(2)));
        lifecycle.queryClient.setQueryData(['unrelated'], 'retained');
        await action.write(true);
        expect(list.cursor.value).toBeUndefined();
        expect(list.previous.value).toEqual([]);
        expect(list.items.value[0]?.id).toBe(id(3));
        expect(requests.at(-1)).toBeNull();
        expect(list.notice.value).toContain('已取消收藏');
        expect(lifecycle.queryClient.getQueryState(['unrelated'])?.isInvalidated).toBe(false);
    });
});
