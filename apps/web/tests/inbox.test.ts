import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { effectScope, nextTick, ref } from 'vue';
import type { SessionResponse } from '@scova/models';
import { createSessionLifecycle } from '@/api/session';
import { inboxEndpoint, inboxReadEndpoint, type InboxItem } from '@/api/inbox';
import {
    inboxFilter,
    inboxItems,
    inboxPath,
    inboxReturn,
    useInbox,
    type InboxFilter,
} from '@/composables/useInbox';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function requestUrl(value: Parameters<typeof fetch>[0] | undefined) {
    return value instanceof Request ? value.url : value instanceof URL ? value.href : (value ?? '');
}
function item(n = 1): InboxItem {
    return {
        id: id(n),
        reportId: id(n + 100),
        readAt: null,
        createdAt: '2026-10-31T01:00:00Z',
        report: {
            id: id(n + 100),
            runId: id(200),
            taskId: id(201),
            taskVersionId: id(202),
            title: `报告${n}`,
            summary: '保存的报告摘要',
            format: 'brief',
            mode: 'demo',
            outcome: 'inconclusive',
            publishedAt: '2026-10-31T01:00:00Z',
            coverage: {
                completeness: 'partial',
                gaps: ['资料缺口'],
                searchedQueries: [],
                exhausted: [],
            },
        },
    };
}
const account: SessionResponse = {
    user: {
        id: id(900),
        email: 'inbox@example.test',
        createdAt: '2026-10-31T00:00:00Z',
        preferences: {
            defaultTimezone: 'UTC',
            notificationPreference: { mode: 'summary', runIssues: true },
        },
    },
    csrfToken: 'inbox-csrf',
};
const cleanups: (() => void)[] = [];
function setup(fetcher: typeof fetch, selected: InboxFilter = 'all') {
    const lifecycle = createSessionLifecycle({ fetcher });
    lifecycle.replaceSession(account);
    const filter = ref<InboxFilter>(selected);
    const scope = effectScope();
    const inbox = scope.run(() => useInbox(filter, lifecycle))!;
    cleanups.push(() => {
        scope.stop();
        lifecycle.dispose();
    });
    return { ...inbox, lifecycle, filter, scope };
}
function failure(status: number, code = 'TEST_FAILURE') {
    return Response.json({ code, message: 'sample', requestId: 'sample' }, { status });
}
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { resolve, promise };
}
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

describe('inbox', () => {
    it('validates query and write input before requesting shared same-origin endpoints', async () => {
        const fetcher = vi.fn<typeof fetch>(async () => Response.json(item()));
        const lifecycle = createSessionLifecycle({ fetcher });
        cleanups.push(lifecycle.dispose);
        lifecycle.replaceSession(account);
        await expect(
            lifecycle.capture().request(inboxReadEndpoint, {
                params: { inboxId: '../bad' },
                body: { read: true },
            }),
        ).rejects.toThrow();
        await expect(
            lifecycle.capture().request(inboxEndpoint, { query: { limit: 0 } }),
        ).rejects.toThrow();
        expect(fetcher).not.toHaveBeenCalled();
    });
    it('preserves opaque cursor bytes and server ordering with same timestamps and report deduplication', async () => {
        const cursor = 'opaque+cursor/=._';
        const fetcher = vi.fn<typeof fetch>(async (url) => {
            const query = new URL(requestUrl(url), 'https://same.test').searchParams;
            return Response.json(
                query.has('cursor')
                    ? {
                          items: [
                              item(1),
                              { ...item(2), reportId: item(1).reportId, report: item(1).report },
                              item(3),
                          ],
                          nextCursor: null,
                      }
                    : { items: [item(1)], nextCursor: cursor },
            );
        });
        const inbox = setup(fetcher);
        await vi.waitFor(() => expect(inbox.items.value).toHaveLength(1));
        await inbox.query.fetchNextPage();
        expect(
            new URL(requestUrl(fetcher.mock.calls[1]?.[0]), 'https://same.test').searchParams.get(
                'cursor',
            ),
        ).toBe(cursor);
        expect(inbox.items.value.map((entry) => entry.id)).toEqual([id(1), id(3)]);
        expect(inbox.query.hasNextPage.value).toBe(false);
    });
    it('keeps pending readAt unchanged, sends Cookie/CSRF and installs confirmed state', async () => {
        const pending = deferred<Response>();
        let stored = item();
        const fetcher = vi.fn<typeof fetch>(async (_url, init) =>
            init?.method === 'PATCH'
                ? pending.promise
                : Response.json({ items: [stored], nextCursor: null }),
        );
        const inbox = setup(fetcher);
        await vi.waitFor(() => expect(inbox.items.value).toHaveLength(1));
        const operation = inbox.setRead(item(), true);
        await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
        expect(inbox.items.value[0]?.readAt).toBeNull();
        expect(inbox.pendingId.value).toBe(id(1));
        expect(await inbox.setRead(item(), true)).toBe(false);
        const init = fetcher.mock.calls[1]?.[1];
        expect(init?.credentials).toBe('same-origin');
        expect(new Headers(init?.headers).get('x-csrf-token')).toBe(account.csrfToken);
        expect(JSON.parse(typeof init?.body === 'string' ? init.body : '')).toEqual({ read: true });
        stored = { ...stored, readAt: '2026-10-31T02:00:00Z' };
        pending.resolve(Response.json(stored));
        expect(await operation).toBe(true);
        expect(inbox.items.value[0]?.readAt).toBe(stored.readAt);
        expect(inbox.announcement.value).toContain('已标记');
    });
    it('leaves read state intact on write failure and retries only by explicit action', async () => {
        const fetcher = vi.fn<typeof fetch>(async (_url, init) =>
            init?.method === 'PATCH'
                ? failure(503)
                : Response.json({ items: [item()], nextCursor: null }),
        );
        const inbox = setup(fetcher);
        await vi.waitFor(() => expect(inbox.items.value).toHaveLength(1));
        expect(await inbox.setRead(item(), true)).toBe(false);
        expect(inbox.items.value[0]?.readAt).toBeNull();
        expect(inbox.actionError.value).toContain('原状态已保留');
        expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(1);
    });
    it('removes confirmed read items from unread and invalidates only inbox caches', async () => {
        let read = false;
        const inbox = setup(async (_url, init) => {
            if (init?.method === 'PATCH') {
                read = true;
                return Response.json({ ...item(), readAt: '2026-10-31T02:00:00Z' });
            }
            return Response.json({ items: read ? [] : [item()], nextCursor: null });
        }, 'unread');
        const notificationKey = inbox.lifecycle.capture().queryKey(['notifications']);
        inbox.lifecycle.queryClient.setQueryData(notificationKey, { readAt: null });
        await vi.waitFor(() => expect(inbox.items.value).toHaveLength(1));
        expect(await inbox.setRead(item(), true)).toBe(true);
        expect(inbox.items.value).toEqual([]);
        expect(inbox.lifecycle.queryClient.getQueryData(notificationKey)).toEqual({ readAt: null });
        expect(inbox.lifecycle.queryClient.getQueryState(notificationKey)?.isInvalidated).toBe(
            false,
        );
    });
    it('cancels an older in-flight list before installing confirmed read state', async () => {
        const pending = deferred<Response>();
        let gets = 0;
        let read = false;
        let staleSignal: AbortSignal | undefined;
        const inbox = setup(async (_url, init) => {
            if (init?.method === 'PATCH') {
                read = true;
                return Response.json({ ...item(), readAt: '2026-10-31T02:00:00Z' });
            }
            gets++;
            if (gets === 2) {
                staleSignal = init?.signal ?? undefined;
                return pending.promise;
            }
            return Response.json({
                items: [{ ...item(), readAt: read ? '2026-10-31T02:00:00Z' : null }],
                nextCursor: null,
            });
        });
        await vi.waitFor(() => expect(inbox.items.value).toHaveLength(1));
        const refreshing = inbox.query.refetch();
        await vi.waitFor(() => expect(staleSignal).toBeDefined());
        expect(await inbox.setRead(item(), true)).toBe(true);
        expect(staleSignal?.aborted).toBe(true);
        pending.resolve(Response.json({ items: [item()], nextCursor: null }));
        await refreshing;
        expect(inbox.items.value[0]?.readAt).toBe('2026-10-31T02:00:00Z');
    });
    it.each([403, 404])('hides stale cached content after a refresh %i', async (status) => {
        let failed = false;
        const inbox = setup(async () =>
            failed ? failure(status) : Response.json({ items: [item()], nextCursor: null }),
        );
        await vi.waitFor(() => expect(inbox.items.value).toHaveLength(1));
        failed = true;
        await inbox.query.refetch();
        expect(inbox.items.value).toEqual([]);
        expect(inbox.error.value.hidden).toBe(true);
    });
    it('preserves previous pages on a transient next-page failure and retries the same cursor', async () => {
        let fail = true;
        const cursors: (string | null)[] = [];
        const inbox = setup(async (url) => {
            const cursor = new URL(requestUrl(url), 'https://same.test').searchParams.get('cursor');
            cursors.push(cursor);
            if (cursor && fail) return failure(503);
            return Response.json({
                items: [item(cursor ? 2 : 1)],
                nextCursor: cursor ? null : 'original-cursor',
            });
        });
        await vi.waitFor(() => expect(inbox.items.value).toHaveLength(1));
        await inbox.query.fetchNextPage();
        expect(inbox.query.isFetchNextPageError.value).toBe(true);
        expect(inbox.items.value).toHaveLength(1);
        fail = false;
        await inbox.query.fetchNextPage();
        expect(cursors).toEqual([null, 'original-cursor', 'original-cursor']);
        expect(inbox.items.value).toHaveLength(2);
    });
    it('isolates a late all response from unread filter', async () => {
        const pending = deferred<Response>();
        const inbox = setup(async (url) =>
            new URL(requestUrl(url), 'https://same.test').searchParams.get('unread') === 'true'
                ? Response.json({ items: [item(2)], nextCursor: null })
                : pending.promise,
        );
        inbox.filter.value = 'unread';
        await vi.waitFor(() => expect(inbox.items.value[0]?.id).toBe(id(2)));
        pending.resolve(Response.json({ items: [item(1)], nextCursor: null }));
        await nextTick();
        expect(inbox.items.value[0]?.id).toBe(id(2));
    });
    it.each([200, 401])('ignores old account late %i list responses', async (status) => {
        const pending = deferred<Response>();
        let switched = false;
        const inbox = setup(async () =>
            switched ? Response.json({ items: [item(2)], nextCursor: null }) : pending.promise,
        );
        switched = true;
        inbox.lifecycle.replaceSession({ ...account, user: { ...account.user, id: id(901) } });
        await vi.waitFor(() => expect(inbox.items.value[0]?.id).toBe(id(2)));
        pending.resolve(
            status === 200 ? Response.json({ items: [item(1)], nextCursor: null }) : failure(401),
        );
        await nextTick();
        expect(inbox.lifecycle.session.user?.id).toBe(id(901));
        expect(inbox.items.value[0]?.id).toBe(id(2));
    });
    it('refuses mismatched reports and writes without installing them', async () => {
        const inbox = setup(async (_url, init) =>
            init?.method === 'PATCH'
                ? Response.json({ ...item(2), readAt: '2026-10-31T02:00:00Z' })
                : Response.json({ items: [item()], nextCursor: null }),
        );
        await vi.waitFor(() => expect(inbox.items.value).toHaveLength(1));
        expect(await inbox.setRead(item(), true)).toBe(false);
        expect(inbox.items.value[0]?.readAt).toBeNull();
        expect(inboxItems([{ items: [item(), item()], nextCursor: null }])).toHaveLength(1);
    });
    it('updates every same-account filter after a late PATCH without stealing current feedback', async () => {
        const pending = deferred<Response>();
        let stored = item();
        const inbox = setup(async (url, init) => {
            if (init?.method === 'PATCH') return pending.promise;
            const unread = new URL(requestUrl(url), 'https://same.test').searchParams.get('unread');
            return Response.json({
                items: unread === 'true' && stored.readAt ? [] : [stored],
                nextCursor: null,
            });
        });
        await vi.waitFor(() => expect(inbox.items.value).toHaveLength(1));
        const writing = inbox.setRead(item(), true);
        inbox.filter.value = 'unread';
        await nextTick();
        expect(inbox.pendingId.value).toBe(item().id);
        stored = { ...stored, readAt: '2026-10-31T02:00:00Z' };
        pending.resolve(Response.json(stored));
        expect(await writing).toBe(false); // Success belongs to a previous UI generation.
        expect(inbox.announcement.value).toBe('');
        expect(inbox.pendingId.value).toBeUndefined();
        inbox.filter.value = 'all';
        await vi.waitFor(() => expect(inbox.items.value[0]?.readAt).toBe(stored.readAt));
    });
    it('marks cache stale if leaving during an uncertain write', async () => {
        const pending = deferred<Response>();
        const inbox = setup(async (_url, init) =>
            init?.method === 'PATCH'
                ? pending.promise
                : Response.json({ items: [item()], nextCursor: null }),
        );
        await vi.waitFor(() => expect(inbox.items.value).toHaveLength(1));
        const writing = inbox.setRead(item(), true);
        inbox.scope.stop();
        pending.resolve(Response.json({ ...item(), readAt: '2026-10-31T02:00:00Z' }));
        expect(await writing).toBe(false);
        const state = inbox.lifecycle.queryClient.getQueryState(
            inbox.lifecycle.capture().queryKey(['inbox', 'all']),
        );
        expect(state?.isInvalidated).toBe(true);
    });
    it('hides old content on a malformed response during refresh', async () => {
        let invalid = false;
        const inbox = setup(async () =>
            invalid
                ? new Response('<html>bad</html>', {
                      headers: { 'content-type': 'application/json' },
                  })
                : Response.json({ items: [item()], nextCursor: null }),
        );
        await vi.waitFor(() => expect(inbox.items.value).toHaveLength(1));
        invalid = true;
        await inbox.query.refetch();
        expect(inbox.items.value).toEqual([]);
        expect(inbox.error.value.hidden).toBe(true);
    });
    it('accepts only canonical same-account inbox return positions', () => {
        const valid = {
            path: '/inbox?read=unread',
            scroll: 900,
            focusId: id(1),
            accountId: account.user.id,
        };
        expect(inboxReturn(valid, account.user.id)).toEqual(valid);
        for (const changes of [
            { path: '//evil.test' },
            { path: '/inbox?read=unread&next=evil' },
            { scroll: Infinity },
            { scroll: -1 },
            { focusId: 'bad' },
            { accountId: id(901) },
        ])
            expect(inboxReturn({ ...valid, ...changes }, account.user.id)).toBeUndefined();
        expect(inboxFilter(['unread'])).toBe('all');
        expect(inboxPath('read')).toBe('/inbox?read=read');
    });
    it('同一nextCursor未前进时隐藏旧页且不无限自动读取', async () => {
        const fetcher = vi.fn<typeof fetch>(async (url) => {
            const next = new URL(requestUrl(url), 'https://same.test').searchParams.has('cursor');
            return Response.json({ items: [item(next ? 2 : 1)], nextCursor: 'same-cursor' });
        });
        const inbox = setup(fetcher);
        await vi.waitFor(() => expect(inbox.items.value).toHaveLength(1));
        await inbox.query.fetchNextPage();
        expect(inbox.query.isFetchNextPageError.value).toBe(true);
        expect(inbox.error.value.hidden).toBe(true);
        expect(inbox.items.value).toEqual([]);
        expect(fetcher).toHaveBeenCalledTimes(2);
    });
    it('多页游标循环不重复追加已经访问的页面', async () => {
        const cursors: (string | null)[] = [];
        const inbox = setup(async (url) => {
            const cursor = new URL(requestUrl(url), 'https://same.test').searchParams.get('cursor');
            cursors.push(cursor);
            return Response.json({
                items: [item(cursor === 'second' ? 3 : cursor ? 2 : 1)],
                nextCursor: cursor === 'first' ? 'second' : 'first',
            });
        });
        await vi.waitFor(() => expect(inbox.items.value).toHaveLength(1));
        await inbox.query.fetchNextPage();
        await inbox.query.fetchNextPage();
        expect(inbox.items.value.map((value) => value.id)).toEqual([id(1), id(2), id(3)]);
        expect(inbox.query.hasNextPage.value).toBe(false);
        expect(cursors).toEqual([null, 'first', 'second']);
    });
    it('结构合法但reportId绑定错误的列表重读隐藏旧报告', async () => {
        let invalid = false;
        const inbox = setup(async () =>
            Response.json({
                items: [invalid ? { ...item(), reportId: id(999) } : item()],
                nextCursor: null,
            }),
        );
        await vi.waitFor(() => expect(inbox.items.value).toHaveLength(1));
        invalid = true;
        await inbox.query.refetch();
        expect(inbox.items.value).toEqual([]);
        expect(inbox.error.value.hidden).toBe(true);
    });
    it.each([200, 401])('旧账号迟到PATCH %s不改新账号读状态或清空新会话', async (status) => {
        const pending = deferred<Response>();
        let switched = false;
        let signal: AbortSignal | undefined;
        const inbox = setup(async (_url, init) => {
            if (init?.method === 'PATCH') {
                signal = init.signal ?? undefined;
                return pending.promise;
            }
            return Response.json({ items: [item(switched ? 2 : 1)], nextCursor: null });
        });
        await vi.waitFor(() => expect(inbox.items.value).toHaveLength(1));
        const writing = inbox.setRead(item(), true);
        await vi.waitFor(() => expect(signal).toBeDefined());
        switched = true;
        inbox.lifecycle.replaceSession({ ...account, user: { ...account.user, id: id(901) } });
        await vi.waitFor(() => expect(inbox.items.value[0]?.id).toBe(id(2)));
        pending.resolve(
            status === 200
                ? Response.json({ ...item(), readAt: '2026-10-31T02:00:00Z' })
                : failure(401),
        );
        expect(await writing).toBe(false);
        expect(signal?.aborted).toBe(true);
        expect(inbox.lifecycle.session.user?.id).toBe(id(901));
        expect(inbox.items.value[0]?.readAt).toBeNull();
        expect(inbox.actionError.value).toBe('');
        expect(inbox.announcement.value).toBe('');
    });
    it('失败PATCH将既有收件箱缓存标为stale，不使通知缓存失效', async () => {
        const inbox = setup(async (_url, init) =>
            init?.method === 'PATCH'
                ? failure(503)
                : Response.json({ items: [item()], nextCursor: null }),
        );
        const prefix = inbox.lifecycle.capture();
        const inactiveKey = prefix.queryKey(['inbox', 'read']);
        const notificationKey = prefix.queryKey(['notifications']);
        inbox.lifecycle.queryClient.setQueryData(inactiveKey, {
            pages: [{ items: [], nextCursor: null }],
            pageParams: [undefined],
        });
        inbox.lifecycle.queryClient.setQueryData(notificationKey, { readAt: null });
        await vi.waitFor(() => expect(inbox.items.value).toHaveLength(1));
        await inbox.setRead(item(), true);
        expect(inbox.items.value[0]?.readAt).toBeNull();
        expect(inbox.lifecycle.queryClient.getQueryState(inactiveKey)?.isInvalidated).toBe(true);
        expect(inbox.lifecycle.queryClient.getQueryState(notificationKey)?.isInvalidated).toBe(
            false,
        );
    });
    it('恢复未读仅在服务端确认后从read筛选移除，保持独立布尔写入', async () => {
        let stored = { ...item(), readAt: '2026-10-31T02:00:00Z' } as InboxItem;
        let body: unknown;
        const inbox = setup(async (_url, init) => {
            if (init?.method === 'PATCH') {
                body = JSON.parse(init.body as string);
                stored = { ...stored, readAt: null };
                return Response.json(stored);
            }
            return Response.json({ items: stored.readAt ? [stored] : [], nextCursor: null });
        }, 'read');
        await vi.waitFor(() => expect(inbox.items.value).toHaveLength(1));
        expect(await inbox.setRead(stored, false)).toBe(true);
        expect(body).toEqual({ read: false });
        expect(inbox.items.value).toEqual([]);
    });
});
