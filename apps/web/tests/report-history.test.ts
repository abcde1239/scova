import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { effectScope, nextTick, ref } from 'vue';
import { createMemoryHistory } from 'vue-router';
import type { SessionResponse } from '@scova/models';
import { createSessionLifecycle } from '@/api/session';
import { reportHistoryEndpoint, type ReportHistoryItem } from '@/api/reports';
import {
    historyItems,
    reportHistoryError,
    reportHistoryOptions,
    reportHistoryPath,
    reportHistoryPosition,
    reportHistoryTask,
    useReportHistory,
} from '@/composables/useReportHistory';
import { createWorkbenchRouter } from '@/router';
import historyRoutes from '@/router/pages/report-history';
import taskRoutes from '@/router/pages/tasks';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function item(n = 1, taskId = id(100)): ReportHistoryItem {
    return {
        id: id(n),
        runId: id(n + 200),
        taskId,
        taskVersionId: id(300),
        title: `报告${n}`,
        summary: '已保存的历史报告摘要',
        format: 'brief',
        mode: 'demo',
        outcome: 'inconclusive',
        coverage: {
            completeness: 'partial',
            searchedQueries: [],
            gaps: ['仍有资料缺口'],
            exhausted: [],
        },
        publishedAt: '2026-10-31T02:00:00Z',
    };
}
const account: SessionResponse = {
    user: {
        id: id(900),
        email: 'history@example.test',
        createdAt: '2026-10-31T00:00:00Z',
        preferences: {
            defaultTimezone: 'UTC',
            notificationPreference: { mode: 'summary', runIssues: true },
        },
    },
    csrfToken: 'history-csrf',
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
function setup(fetcher: typeof fetch, initial?: string | null) {
    const lifecycle = createSessionLifecycle({ fetcher });
    lifecycle.replaceSession(account);
    const taskId = ref<string | undefined | null>(initial);
    const scope = effectScope();
    const history = scope.run(() => useReportHistory(taskId, lifecycle))!;
    disposals.push(() => {
        scope.stop();
        lifecycle.dispose();
    });
    return { ...history, lifecycle, taskId, scope };
}
afterEach(() => disposals.splice(0).forEach((dispose) => dispose()));

describe('report history', () => {
    it('aborts an in-flight history read on scope disposal and rejects its late content', async () => {
        const pending = deferred<Response>();
        let signal: AbortSignal | undefined;
        const history = setup(async (_url, init) => {
            signal = init?.signal ?? undefined;
            return pending.promise;
        });
        await vi.waitFor(() => expect(signal).toBeDefined());
        const key = reportHistoryOptions(history.lifecycle, undefined).queryKey;
        history.scope.stop();
        expect(signal?.aborted).toBe(true);
        pending.resolve(Response.json({ items: [item()], nextCursor: null }));
        await nextTick();
        expect(history.lifecycle.queryClient.getQueryData(key)).toBeUndefined();
    });
    it('stops a cyclic opaque cursor chain without repeating an older page', async () => {
        const cursors: (string | null)[] = [];
        const history = setup(async (url) => {
            const cursor = new URL(requestUrl(url), 'https://same.test').searchParams.get('cursor');
            cursors.push(cursor);
            return Response.json({
                items: [item(cursor === null ? 1 : cursor === 'A' ? 2 : 3)],
                nextCursor: cursor === 'A' ? 'B' : 'A',
            });
        });
        await vi.waitFor(() => expect(history.items.value).toHaveLength(1));
        await history.query.fetchNextPage();
        await history.query.fetchNextPage();
        expect(history.items.value.map((entry) => entry.id)).toEqual([id(1), id(2), id(3)]);
        expect(history.query.hasNextPage.value).toBe(false);
        expect(cursors).toEqual([null, 'A', 'B']);
    });
    it('resolves the authorized static route before task IDs and adds no navigation item', () => {
        const router = createWorkbenchRouter(createMemoryHistory(), [
            ...taskRoutes,
            ...historyRoutes,
        ]);
        expect(router.resolve('/tasks/reports').name).toBe('report-history');
        expect(router.resolve(`/tasks/${id(100)}`).name).toBe('task-summary');
        expect(historyRoutes[0]?.meta.section).toBe('tasks');
        expect('navigation' in historyRoutes[0]!.meta).toBe(false);
    });
    it('validates task UUIDs without silently treating invalid addresses as all tasks', async () => {
        for (const value of ['bad', `../${id(1)}`, [id(1)], null])
            expect(reportHistoryTask(value)).toBeNull();
        expect(reportHistoryTask(id(100))).toBe(id(100));
        expect(reportHistoryTask('ABCDEFAB-1234-4ABC-8DEF-ABCDEF123456')).toBe(
            'abcdefab-1234-4abc-8def-abcdef123456',
        );
        expect(reportHistoryTask(undefined)).toBeUndefined();
        const fetcher = vi.fn<typeof fetch>(async () =>
            Response.json({ items: [item()], nextCursor: null }),
        );
        const history = setup(fetcher, null);
        await nextTick();
        expect(history.valid.value).toBe(false);
        expect(history.items.value).toEqual([]);
        expect(fetcher).not.toHaveBeenCalled();
        await expect(
            history.lifecycle
                .capture()
                .request(reportHistoryEndpoint, { query: { taskId: 'bad' } }),
        ).rejects.toThrow();
        expect(fetcher).not.toHaveBeenCalled();
    });
    it('sends the selected task and opaque cursor exactly, preserving same-time order and IDs', async () => {
        const cursor = 'opaque+history/=._';
        const fetcher = vi.fn<typeof fetch>(async (url) => {
            const query = new URL(requestUrl(url), 'https://same.test').searchParams;
            expect(query.get('taskId')).toBe(id(100));
            expect(query.get('limit')).toBe('20');
            return Response.json(
                query.has('cursor')
                    ? { items: [item(2), item(3)], nextCursor: null }
                    : { items: [item(1), item(2)], nextCursor: cursor },
            );
        });
        const history = setup(fetcher, id(100));
        await vi.waitFor(() => expect(history.items.value).toHaveLength(2));
        await history.query.fetchNextPage();
        expect(
            new URL(requestUrl(fetcher.mock.calls[1]?.[0]), 'https://same.test').searchParams.get(
                'cursor',
            ),
        ).toBe(cursor);
        expect(history.items.value.map((entry) => entry.id)).toEqual([id(1), id(2), id(3)]);
        expect(history.query.hasNextPage.value).toBe(false);
    });
    it('retains both live and demo reports as separate rows without inventing a common baseline', () => {
        const live = { ...item(2), mode: 'live' as const };
        const rows = historyItems([{ items: [item(), live, item()], nextCursor: null }]);
        expect(rows.map((entry) => entry.mode)).toEqual(['demo', 'live']);
        expect(rows.map((entry) => entry.coverage.completeness)).toEqual(['partial', 'partial']);
        expect(rows.every((entry) => !('baselineRunId' in entry))).toBe(true);
    });
    it('uses separate keys per account/task and sends the same-origin transport', async () => {
        const fetcher = vi.fn<typeof fetch>(async () =>
            Response.json({ items: [item()], nextCursor: null }),
        );
        const history = setup(fetcher);
        await vi.waitFor(() => expect(history.items.value).toHaveLength(1));
        expect(fetcher.mock.calls[0]?.[1]?.credentials).toBe('include');
        const all = reportHistoryOptions(history.lifecycle, undefined);
        const task = reportHistoryOptions(history.lifecycle, id(100));
        expect(all.queryKey).not.toEqual(task.queryKey);
        expect(all.queryKey.slice(0, 3)).toEqual([
            'session',
            account.user.id,
            history.lifecycle.session.epoch,
        ]);
        expect(
            fetcher.mock.calls.every(
                ([url]) =>
                    new URL(requestUrl(url), 'https://same.test').pathname === '/api/v1/reports',
            ),
        ).toBe(true);
    });
    it('cancels the old filter and starts the replacement at its first page', async () => {
        const pending = deferred<Response>();
        let oldSignal: AbortSignal | undefined;
        const queries: URLSearchParams[] = [];
        const history = setup(async (url, init) => {
            const query = new URL(requestUrl(url), 'https://same.test').searchParams;
            queries.push(query);
            if (!query.has('taskId')) {
                oldSignal = init?.signal ?? undefined;
                return pending.promise;
            }
            return Response.json({ items: [item(2, id(101))], nextCursor: null });
        });
        await vi.waitFor(() => expect(oldSignal).toBeDefined());
        expect(await history.prepareFilter(id(101))).toBe(true);
        history.taskId.value = id(101);
        await vi.waitFor(() => expect(history.items.value[0]?.id).toBe(id(2)));
        expect(oldSignal?.aborted).toBe(true);
        expect(queries[1]?.has('cursor')).toBe(false);
        pending.resolve(Response.json({ items: [item()], nextCursor: null }));
        await nextTick();
        expect(history.items.value[0]?.id).toBe(id(2));
    });
    it('resets a previously loaded destination filter only for an explicit filter action', async () => {
        const queries: URLSearchParams[] = [];
        const history = setup(async (url) => {
            const query = new URL(requestUrl(url), 'https://same.test').searchParams;
            queries.push(query);
            return Response.json({
                items: [item(query.has('cursor') ? 2 : 1, query.get('taskId') ?? id(100))],
                nextCursor: query.has('cursor') ? null : 'second-page',
            });
        }, id(100));
        await vi.waitFor(() => expect(history.items.value).toHaveLength(1));
        await history.query.fetchNextPage();
        history.taskId.value = id(101);
        await vi.waitFor(() => expect(history.items.value[0]?.taskId).toBe(id(101)));
        expect(await history.prepareFilter(id(100))).toBe(true);
        history.taskId.value = id(100);
        await vi.waitFor(() => expect(history.items.value).toHaveLength(1));
        expect(queries.at(-1)?.has('cursor')).toBe(false);
    });
    it('keeps loaded pages in the sole Query cache when a history view is unmounted for reading', async () => {
        const fetcher = vi.fn<typeof fetch>(async (url) => {
            const query = new URL(requestUrl(url), 'https://same.test').searchParams;
            return Response.json({
                items: [item(query.has('cursor') ? 2 : 1)],
                nextCursor: query.has('cursor') ? null : 'second-page',
            });
        });
        const history = setup(fetcher, id(100));
        await vi.waitFor(() => expect(history.items.value).toHaveLength(1));
        await history.query.fetchNextPage();
        history.scope.stop();
        const returning = effectScope();
        const restored = returning.run(() => useReportHistory(id(100), history.lifecycle))!;
        disposals.push(() => returning.stop());
        expect(restored.items.value).toHaveLength(2);
        expect(fetcher).toHaveBeenCalledTimes(2);
    });
    it.each([403, 404, 503])(
        'applies correct content retention for a refresh %i',
        async (status) => {
            let failed = false;
            const history = setup(async () =>
                failed ? failure(status) : Response.json({ items: [item()], nextCursor: null }),
            );
            await vi.waitFor(() => expect(history.items.value).toHaveLength(1));
            failed = true;
            await history.query.refetch();
            expect(history.items.value).toHaveLength(status === 503 ? 1 : 0);
            expect(history.error.value.hidden).toBe(status !== 503);
        },
    );
    it.each(['protocol', 'mismatched-task'])(
        'hides previous content after a %s response',
        async (kind) => {
            let invalid = false;
            const history = setup(
                async () =>
                    !invalid
                        ? Response.json({ items: [item()], nextCursor: null })
                        : kind === 'protocol'
                          ? new Response('<html>', {
                                headers: { 'content-type': 'application/json' },
                            })
                          : Response.json({ items: [item(2, id(101))], nextCursor: null }),
                id(100),
            );
            await vi.waitFor(() => expect(history.items.value).toHaveLength(1));
            invalid = true;
            await history.query.refetch();
            expect(history.items.value).toEqual([]);
            expect(history.error.value.hidden).toBe(true);
        },
    );
    it('retains old pages after later-page failure and retries the exact cursor', async () => {
        let fail = true;
        const cursors: (string | null)[] = [];
        const history = setup(async (url) => {
            const cursor = new URL(requestUrl(url), 'https://same.test').searchParams.get('cursor');
            cursors.push(cursor);
            if (cursor && fail) return failure(503);
            return Response.json({
                items: [item(cursor ? 2 : 1)],
                nextCursor: cursor ? null : 'original',
            });
        });
        await vi.waitFor(() => expect(history.items.value).toHaveLength(1));
        await history.query.fetchNextPage();
        expect(history.items.value).toHaveLength(1);
        expect(history.query.isFetchNextPageError.value).toBe(true);
        fail = false;
        await history.query.fetchNextPage();
        expect(history.items.value).toHaveLength(2);
        expect(cursors).toEqual([null, 'original', 'original']);
    });
    it('stops repeated cursors instead of appending the same page forever', async () => {
        const history = setup(async () =>
            Response.json({ items: [item()], nextCursor: 'repeated' }),
        );
        await vi.waitFor(() => expect(history.items.value).toHaveLength(1));
        await history.query.fetchNextPage();
        expect(history.query.isFetchNextPageError.value).toBe(true);
        expect(history.items.value).toEqual([]);
        expect(history.error.value.restart).toBe(true);
    });
    it.each([200, 401])('isolates late old-account %i responses', async (status) => {
        const pending = deferred<Response>();
        let switched = false;
        const history = setup(async () =>
            switched ? Response.json({ items: [item(2)], nextCursor: null }) : pending.promise,
        );
        switched = true;
        history.lifecycle.replaceSession({ ...account, user: { ...account.user, id: id(901) } });
        await vi.waitFor(() => expect(history.items.value[0]?.id).toBe(id(2)));
        pending.resolve(
            status === 200 ? Response.json({ items: [item()], nextCursor: null }) : failure(401),
        );
        await nextTick();
        expect(history.lifecycle.session.user?.id).toBe(id(901));
        expect(history.items.value[0]?.id).toBe(id(2));
    });
    it('disables stale content immediately for an invalid replacement filter', async () => {
        const history = setup(async () => Response.json({ items: [item()], nextCursor: null }));
        await vi.waitFor(() => expect(history.items.value).toHaveLength(1));
        history.taskId.value = null;
        await nextTick();
        expect(history.valid.value).toBe(false);
        expect(history.items.value).toEqual([]);
    });
    it('validates same-account canonical history state before restoring client position', () => {
        const valid = {
            path: reportHistoryPath(id(100)),
            accountId: account.user.id,
            scroll: 812,
            focusId: id(1),
        };
        expect(reportHistoryPosition(valid, account.user.id)).toEqual(valid);
        expect(
            reportHistoryPosition({ ...valid, path: '/tasks/reports' }, account.user.id)?.path,
        ).toBe('/tasks/reports');
        for (const patch of [
            { path: '//evil.test' },
            { path: '/tasks/reports?taskId=bad' },
            { path: `${valid.path}&next=evil` },
            { scroll: Infinity },
            { scroll: -1 },
            { focusId: 'bad' },
            { accountId: id(901) },
        ])
            expect(reportHistoryPosition({ ...valid, ...patch }, account.user.id)).toBeUndefined();
        expect(reportHistoryError(new Error('temporary')).hidden).toBe(false);
    });
});
