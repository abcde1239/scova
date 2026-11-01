import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { effectScope, nextTick, ref } from 'vue';
import { createMemoryHistory } from 'vue-router';
import type { Notification, SessionResponse } from '@scova/models';
import { createSessionLifecycle } from '@/api/session';
import { notificationsEndpoint, notificationReadEndpoint } from '@/api/notifications';
import {
    assertNotification,
    notificationLabel,
    notificationMessage,
    notificationTarget,
    notificationsError,
    readNotificationFilters,
    useNotifications,
    visibleNotifications,
    type NotificationFilters,
} from '@/composables/useNotifications';
import { createWorkbenchRouter } from '@/router';
import notificationRoutes from '@/router/pages/notifications';
import workbenchRoutes from '@/router/pages/workbench';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function item(n = 1, kind: Notification['kind'] = 'summary'): Notification {
    return {
        id: id(n),
        runId: id(n + 100),
        taskId: id(200),
        reportId: kind === 'run_issue' ? null : id(n + 300),
        kind,
        readAt: null,
        createdAt: '2026-10-31T02:00:00Z',
        runStatus: kind === 'run_issue' ? 'failed' : 'succeeded',
        mode: 'demo',
        failureCode: kind === 'run_issue' ? 'NO_EVIDENCE' : null,
    };
}
const account: SessionResponse = {
    user: {
        id: id(900),
        email: 'notification@example.test',
        createdAt: '2026-10-31T00:00:00Z',
        preferences: {
            defaultTimezone: 'UTC',
            notificationPreference: { mode: 'summary', runIssues: true },
        },
    },
    csrfToken: 'notification-csrf',
};
function requestUrl(value: Parameters<typeof fetch>[0] | undefined) {
    return value instanceof Request ? value.url : value instanceof URL ? value.href : (value ?? '');
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
const disposals: (() => void)[] = [];
function setup(fetcher: typeof fetch, initial: NotificationFilters = { kind: 'all', read: 'all' }) {
    const lifecycle = createSessionLifecycle({ fetcher });
    lifecycle.replaceSession(account);
    const filters = ref(initial);
    const scope = effectScope();
    const notifications = scope.run(() => useNotifications(filters, lifecycle))!;
    disposals.push(() => {
        scope.stop();
        lifecycle.dispose();
    });
    return { ...notifications, lifecycle, filters, scope };
}
afterEach(() => disposals.splice(0).forEach((dispose) => dispose()));

describe('notifications', () => {
    it.each([200, 401])(
        'isolates old account late PATCH %i from the new account',
        async (status) => {
            const pending = deferred<Response>();
            let switched = false;
            const notifications = setup(async (_url, init) =>
                init?.method === 'PATCH'
                    ? pending.promise
                    : Response.json({ items: [item(switched ? 2 : 1)], nextCursor: null }),
            );
            await vi.waitFor(() => expect(notifications.items.value).toHaveLength(1));
            const writing = notifications.setRead(item(), true);
            switched = true;
            notifications.lifecycle.replaceSession({
                ...account,
                user: { ...account.user, id: id(901) },
            });
            await vi.waitFor(() => expect(notifications.items.value[0]?.id).toBe(id(2)));
            pending.resolve(
                status === 200
                    ? Response.json({ ...item(), readAt: '2026-10-31T03:00:00Z' })
                    : failure(401),
            );
            expect(await writing).toBe(false);
            expect(notifications.lifecycle.session.user?.id).toBe(id(901));
            expect(notifications.items.value[0]?.id).toBe(id(2));
            expect(notifications.pendingId.value).toBeUndefined();
            expect(notifications.actionError.value).toBe('');
        },
    );
    it('unknown write marks only notification caches stale, retaining Inbox and report caches', async () => {
        const notifications = setup(async (_url, init) =>
            init?.method === 'PATCH'
                ? failure(503)
                : Response.json({ items: [item()], nextCursor: null }),
        );
        const inbox = notifications.lifecycle.capture().queryKey(['inbox', 'all']);
        const report = notifications.lifecycle.capture().queryKey(['report', id(301)]);
        for (const key of [inbox, report])
            notifications.lifecycle.queryClient.setQueryData(key, { saved: true });
        await vi.waitFor(() => expect(notifications.items.value).toHaveLength(1));
        expect(await notifications.setRead(item(), true)).toBe(false);
        expect(
            notifications.lifecycle.queryClient.getQueryState(
                notifications.lifecycle.capture().queryKey(['notifications', 'all', 'all']),
            )?.isInvalidated,
        ).toBe(true);
        for (const key of [inbox, report]) {
            expect(notifications.lifecycle.queryClient.getQueryData(key)).toEqual({ saved: true });
            expect(notifications.lifecycle.queryClient.getQueryState(key)?.isInvalidated).toBe(
                false,
            );
        }
    });
    it('preserves distinct notice IDs sharing a report and rejects repeated page cursors', async () => {
        const notices = [item(), { ...item(2), reportId: item().reportId }];
        expect(
            visibleNotifications([{ items: [...notices, notices[0]!], nextCursor: null }]),
        ).toEqual(notices);
        const notifications = setup(async () =>
            Response.json({ items: [item()], nextCursor: 'same' }),
        );
        await vi.waitFor(() => expect(notifications.items.value).toHaveLength(1));
        await notifications.query.fetchNextPage();
        expect(notifications.query.isFetchNextPageError.value).toBe(true);
        expect(notifications.error.value.hidden).toBe(true);
        expect(notifications.items.value).toEqual([]);
    });
    it('restoring unread removes an item from the read filter only after confirmation', async () => {
        const pending = deferred<Response>();
        let stored = { ...item(), readAt: '2026-10-31T03:00:00Z' as string | null };
        const notifications = setup(
            async (_url, init) =>
                init?.method === 'PATCH'
                    ? pending.promise
                    : Response.json({ items: stored.readAt ? [stored] : [], nextCursor: null }),
            { kind: 'summary', read: 'read' },
        );
        await vi.waitFor(() => expect(notifications.items.value).toHaveLength(1));
        const writing = notifications.setRead(stored, false);
        expect(notifications.items.value[0]?.readAt).not.toBeNull();
        stored = { ...stored, readAt: null };
        pending.resolve(Response.json(stored));
        expect(await writing).toBe(true);
        expect(notifications.items.value).toEqual([]);
    });
    it('keeps notifications in global tools and replaces the pending route', () => {
        const router = createWorkbenchRouter(createMemoryHistory(), notificationRoutes);
        expect(router.resolve('/notifications').name).toBe('notifications');
        expect(notificationRoutes[0]?.meta.navigation).toBe('tool');
        expect(
            workbenchRoutes.find((route) => route.name === 'notifications')?.meta.navigation,
        ).toBe('tool');
    });
    it('presents all three types without treating summary as no change or partial as important', () => {
        expect(notificationLabel(item())).toBe('普通汇总');
        expect(notificationMessage(item())).not.toContain('没有变化');
        expect(notificationLabel(item(2, 'important_change'))).toBe('重要变化');
        expect(notificationLabel(item(3, 'run_issue'))).toBe('运行问题');
        expect(notificationMessage({ ...item(3, 'run_issue'), runStatus: 'partial' })).toContain(
            '部分交付',
        );
        expect(notificationMessage(item(3, 'run_issue'))).toContain('执行失败');
        expect(notificationLabel({ ...item(2, 'important_change'), runStatus: 'partial' })).toBe(
            '运行问题',
        );
    });
    it('routes any available report to report and report-less notices to the actual Run', () => {
        expect(notificationTarget(item())).toEqual({
            name: 'report-detail',
            params: { reportId: id(301) },
        });
        expect(notificationTarget(item(2, 'run_issue'))).toEqual({
            name: 'run-detail',
            params: { runId: id(102) },
        });
        expect(notificationTarget({ ...item(2, 'run_issue'), reportId: id(302) }).name).toBe(
            'report-detail',
        );
    });
    it('enforces current Worker terminal-kind invariants without inventing failure-report constraints', () => {
        // Worker terminalNotificationKind + atomic delivery; notification_report_required DB CHECK.
        for (const entry of [
            item(),
            item(2, 'important_change'),
            item(3, 'run_issue'),
            { ...item(4, 'run_issue'), runStatus: 'partial' as const, reportId: id(304) },
            { ...item(5, 'run_issue'), reportId: id(305) },
        ])
            expect(() => assertNotification(entry)).not.toThrow();
        for (const entry of [
            { ...item(), reportId: null },
            { ...item(2, 'important_change'), runStatus: 'partial' as const },
            { ...item(3, 'run_issue'), runStatus: 'succeeded' as const },
        ])
            expect(() => assertNotification(entry)).toThrow();
    });
    it('validates IDs and filters before issuing any network request', async () => {
        const fetcher = vi.fn<typeof fetch>(async () => Response.json(item()));
        const lifecycle = createSessionLifecycle({ fetcher });
        lifecycle.replaceSession(account);
        disposals.push(lifecycle.dispose);
        await expect(
            lifecycle.capture().request(notificationReadEndpoint, {
                params: { notificationId: '../bad' },
                body: { read: true },
            }),
        ).rejects.toThrow();
        await expect(
            lifecycle.capture().request(notificationsEndpoint, { query: { limit: 0 } }),
        ).rejects.toThrow();
        expect(fetcher).not.toHaveBeenCalled();
        expect(readNotificationFilters(['run_issue'], 'other')).toEqual({
            kind: 'all',
            read: 'all',
        });
    });
    it('passes kind/read filters and original cursor without sorting or duplicating same-time rows', async () => {
        const cursor = 'opaque+cursor/=._';
        const fetcher = vi.fn<typeof fetch>(async (url) => {
            const query = new URL(requestUrl(url), 'https://same.test').searchParams;
            expect(query.get('kind')).toBe('run_issue');
            expect(query.get('unread')).toBe('true');
            return Response.json(
                query.has('cursor')
                    ? { items: [item(1, 'run_issue'), item(2, 'run_issue')], nextCursor: null }
                    : { items: [item(1, 'run_issue')], nextCursor: cursor },
            );
        });
        const notifications = setup(fetcher, { kind: 'run_issue', read: 'unread' });
        await vi.waitFor(() => expect(notifications.items.value).toHaveLength(1));
        await notifications.query.fetchNextPage();
        expect(
            new URL(requestUrl(fetcher.mock.calls[1]?.[0]), 'https://same.test').searchParams.get(
                'cursor',
            ),
        ).toBe(cursor);
        expect(notifications.items.value.map((entry) => entry.id)).toEqual([id(1), id(2)]);
        expect(notifications.query.hasNextPage.value).toBe(false);
    });
    it('retains pending state, uses Cookie and CSRF, installs actual readAt and leaves Inbox untouched', async () => {
        const pending = deferred<Response>();
        let stored = item();
        const fetcher = vi.fn<typeof fetch>(async (_url, init) =>
            init?.method === 'PATCH'
                ? pending.promise
                : Response.json({ items: [stored], nextCursor: null }),
        );
        const notifications = setup(fetcher);
        const inboxKey = notifications.lifecycle.capture().queryKey(['inbox', 'all']);
        notifications.lifecycle.queryClient.setQueryData(inboxKey, { readAt: null });
        await vi.waitFor(() => expect(notifications.items.value).toHaveLength(1));
        const writing = notifications.setRead(item(), true);
        await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
        expect(notifications.items.value[0]?.readAt).toBeNull();
        expect(await notifications.setRead(item(), true)).toBe(false);
        expect(fetcher.mock.calls[1]?.[1]?.credentials).toBe('same-origin');
        expect(new Headers(fetcher.mock.calls[1]?.[1]?.headers).get('x-csrf-token')).toBe(
            account.csrfToken,
        );
        stored = { ...stored, readAt: '2026-10-31T03:00:00Z' };
        pending.resolve(Response.json(stored));
        expect(await writing).toBe(true);
        expect(notifications.items.value[0]?.readAt).toBe(stored.readAt);
        expect(notifications.lifecycle.queryClient.getQueryData(inboxKey)).toEqual({
            readAt: null,
        });
        expect(notifications.lifecycle.queryClient.getQueryState(inboxKey)?.isInvalidated).toBe(
            false,
        );
    });
    it('keeps the previous display on failed write without automatic retry', async () => {
        const fetcher = vi.fn<typeof fetch>(async (_url, init) =>
            init?.method === 'PATCH'
                ? failure(503)
                : Response.json({ items: [item()], nextCursor: null }),
        );
        const notifications = setup(fetcher);
        await vi.waitFor(() => expect(notifications.items.value).toHaveLength(1));
        expect(await notifications.setRead(item(), true)).toBe(false);
        expect(notifications.items.value[0]?.readAt).toBeNull();
        expect(notifications.actionError.value).toContain('保留原显示状态');
        expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(1);
    });
    it('updates all cached same-account filters after late PATCH and does not steal new filter feedback', async () => {
        const pending = deferred<Response>();
        let stored = item();
        const notifications = setup(async (url, init) => {
            if (init?.method === 'PATCH') return pending.promise;
            const query = new URL(requestUrl(url), 'https://same.test').searchParams;
            return Response.json({
                items: query.get('unread') === 'true' && stored.readAt ? [] : [stored],
                nextCursor: null,
            });
        });
        await vi.waitFor(() => expect(notifications.items.value).toHaveLength(1));
        const writing = notifications.setRead(item(), true);
        notifications.filters.value = { kind: 'summary', read: 'unread' };
        await nextTick();
        expect(notifications.pendingId.value).toBe(item().id);
        stored = { ...stored, readAt: '2026-10-31T03:00:00Z' };
        pending.resolve(Response.json(stored));
        expect(await writing).toBe(false);
        expect(notifications.announcement.value).toBe('');
        expect(notifications.items.value).toEqual([]);
        notifications.filters.value = { kind: 'all', read: 'all' };
        await vi.waitFor(() => expect(notifications.items.value[0]?.readAt).toBe(stored.readAt));
    });
    it('cancels older reads before installing confirmed write state', async () => {
        const pending = deferred<Response>();
        let gets = 0;
        let stored = item();
        let staleSignal: AbortSignal | undefined;
        const notifications = setup(async (_url, init) => {
            if (init?.method === 'PATCH') {
                stored = { ...stored, readAt: '2026-10-31T03:00:00Z' };
                return Response.json(stored);
            }
            gets++;
            if (gets === 2) {
                staleSignal = init?.signal ?? undefined;
                return pending.promise;
            }
            return Response.json({ items: [stored], nextCursor: null });
        });
        await vi.waitFor(() => expect(notifications.items.value).toHaveLength(1));
        const refreshing = notifications.query.refetch();
        await vi.waitFor(() => expect(staleSignal).toBeDefined());
        expect(await notifications.setRead(item(), true)).toBe(true);
        expect(staleSignal?.aborted).toBe(true);
        pending.resolve(Response.json({ items: [item()], nextCursor: null }));
        await refreshing;
        expect(notifications.items.value[0]?.readAt).toBe(stored.readAt);
    });
    it.each([403, 404, 503])(
        'handles refresh %i with the right retained content policy',
        async (status) => {
            let failed = false;
            const notifications = setup(async () =>
                failed ? failure(status) : Response.json({ items: [item()], nextCursor: null }),
            );
            await vi.waitFor(() => expect(notifications.items.value).toHaveLength(1));
            failed = true;
            await notifications.query.refetch();
            expect(notifications.items.value).toHaveLength(status === 503 ? 1 : 0);
        },
    );
    it.each(['protocol', 'semantic'])(
        'hides old content after a %s response error',
        async (kind) => {
            let invalid = false;
            const notifications = setup(async () =>
                !invalid
                    ? Response.json({ items: [item()], nextCursor: null })
                    : kind === 'protocol'
                      ? new Response('<html>', { headers: { 'content-type': 'application/json' } })
                      : Response.json({
                            items: [{ ...item(2, 'important_change'), runStatus: 'partial' }],
                            nextCursor: null,
                        }),
            );
            await vi.waitFor(() => expect(notifications.items.value).toHaveLength(1));
            invalid = true;
            await notifications.query.refetch();
            expect(notifications.items.value).toEqual([]);
            expect(notifications.error.value.hidden).toBe(true);
        },
    );
    it('retries the exact failed later page and retains first-page context', async () => {
        let fail = true;
        const cursors: (string | null)[] = [];
        const notifications = setup(async (url) => {
            const cursor = new URL(requestUrl(url), 'https://same.test').searchParams.get('cursor');
            cursors.push(cursor);
            if (cursor && fail) return failure(503);
            return Response.json({
                items: [item(cursor ? 2 : 1)],
                nextCursor: cursor ? null : 'original-cursor',
            });
        });
        await vi.waitFor(() => expect(notifications.items.value).toHaveLength(1));
        await notifications.query.fetchNextPage();
        expect(notifications.items.value).toHaveLength(1);
        expect(notifications.query.isFetchNextPageError.value).toBe(true);
        fail = false;
        await notifications.query.fetchNextPage();
        expect(cursors).toEqual([null, 'original-cursor', 'original-cursor']);
        expect(notifications.items.value).toHaveLength(2);
    });
    it('does not let old category reads overwrite new selection', async () => {
        const pending = deferred<Response>();
        const notifications = setup(async (url) =>
            new URL(requestUrl(url), 'https://same.test').searchParams.has('kind')
                ? Response.json({ items: [item(2, 'run_issue')], nextCursor: null })
                : pending.promise,
        );
        notifications.filters.value = { kind: 'run_issue', read: 'all' };
        await vi.waitFor(() => expect(notifications.items.value[0]?.id).toBe(id(2)));
        pending.resolve(Response.json({ items: [item()], nextCursor: null }));
        await nextTick();
        expect(notifications.items.value[0]?.id).toBe(id(2));
    });
    it.each([200, 401])('isolates old account late %i responses', async (status) => {
        const pending = deferred<Response>();
        let switched = false;
        const notifications = setup(async () =>
            switched ? Response.json({ items: [item(2)], nextCursor: null }) : pending.promise,
        );
        switched = true;
        notifications.lifecycle.replaceSession({
            ...account,
            user: { ...account.user, id: id(901) },
        });
        await vi.waitFor(() => expect(notifications.items.value[0]?.id).toBe(id(2)));
        pending.resolve(
            status === 200 ? Response.json({ items: [item()], nextCursor: null }) : failure(401),
        );
        await nextTick();
        expect(notifications.lifecycle.session.user?.id).toBe(id(901));
        expect(notifications.items.value[0]?.id).toBe(id(2));
    });
    it('marks unknown writes stale on unmount, without installing late data', async () => {
        const pending = deferred<Response>();
        const notifications = setup(async (_url, init) =>
            init?.method === 'PATCH'
                ? pending.promise
                : Response.json({ items: [item()], nextCursor: null }),
        );
        await vi.waitFor(() => expect(notifications.items.value).toHaveLength(1));
        const writing = notifications.setRead(item(), true);
        notifications.scope.stop();
        pending.resolve(Response.json({ ...item(), readAt: '2026-10-31T03:00:00Z' }));
        expect(await writing).toBe(false);
        expect(
            notifications.lifecycle.queryClient.getQueryState(
                notifications.lifecycle.capture().queryKey(['notifications', 'all', 'all']),
            )?.isInvalidated,
        ).toBe(true);
    });
    it('rejects mismatched write identity and keeps server order during deduplication', async () => {
        const notifications = setup(async (_url, init) =>
            init?.method === 'PATCH'
                ? Response.json({ ...item(2), readAt: '2026-10-31T03:00:00Z' })
                : Response.json({ items: [item()], nextCursor: null }),
        );
        await vi.waitFor(() => expect(notifications.items.value).toHaveLength(1));
        expect(await notifications.setRead(item(), true)).toBe(false);
        expect(notifications.items.value[0]?.readAt).toBeNull();
        expect(
            visibleNotifications([{ items: [item(2), item(1), item(2)], nextCursor: null }]).map(
                (entry) => entry.id,
            ),
        ).toEqual([id(2), id(1)]);
        expect(notificationsError(new Error('temporary')).hidden).toBe(false);
    });
});
