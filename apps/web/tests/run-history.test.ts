import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { effectScope, nextTick, ref } from 'vue';
import type { Run, SessionResponse } from '@scova/models';
import { createSessionLifecycle } from '@/api/session';
import { useTaskRunHistory, validHistoryTaskId } from '@/composable/useTaskRunHistory';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const instant = '2026-10-31T00:00:00Z';
const account: SessionResponse = {
    user: {
        id: id(100),
        email: 'history@example.test',
        createdAt: instant,
        preferences: {
            defaultTimezone: 'UTC',
            notificationPreference: { mode: 'summary', runIssues: true },
        },
    },
    csrfToken: 'sample-only',
};
function run(n: number, taskId = id(1)): Run {
    return {
        id: id(n),
        taskId,
        taskVersionId: id(200 + n),
        parentRunId: null,
        baselineRunId: null,
        mode: n % 2 ? 'demo' : 'live',
        status: 'failed',
        outcome: null,
        trigger: 'manual',
        budget: {
            maxSearches: 2,
            maxPages: 3,
            maxDurationSeconds: 60,
            maxInputTokens: 1000,
            maxOutputTokens: 500,
        },
        usage: { searches: 0, pages: 0, inputTokens: 0, outputTokens: 0, estimated: false },
        coverage: null,
        queuedAt: instant,
        startedAt: null,
        finishedAt: instant,
        failureCode: 'NO_EVIDENCE',
    };
}
const cleanups: (() => void)[] = [];
function setup(fetcher: typeof fetch, target = ref(id(1))) {
    const lifecycle = createSessionLifecycle({ fetcher });
    lifecycle.replaceSession(account);
    const scope = effectScope();
    const history = scope.run(() => useTaskRunHistory(target, lifecycle))!;
    cleanups.push(() => {
        scope.stop();
        lifecycle.dispose();
    });
    return { ...history, lifecycle, target, scope };
}
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));
const address = (url: Parameters<typeof fetch>[0]) =>
    url instanceof Request ? url.url : url.toString();

describe('task run history', () => {
    it('uses the exact server cursor and preserves order, same-time runs, modes and versions while deduplicating', async () => {
        const fetcher = vi.fn<typeof fetch>(async (url) =>
            Response.json(
                address(url).includes('cursor=opaque%2F%2B%3D')
                    ? { items: [run(10), run(9)], nextCursor: null }
                    : { items: [run(11), run(10)], nextCursor: 'opaque/+=' },
            ),
        );
        const { query, items, lifecycle } = setup(fetcher);
        await vi.waitFor(() => expect(items.value).toHaveLength(2));
        await query.fetchNextPage();
        expect(items.value.map((item) => item.id)).toEqual([id(11), id(10), id(9)]);
        expect(items.value.map((item) => item.taskVersionId)).toEqual([id(211), id(210), id(209)]);
        expect(items.value.map((item) => item.mode)).toEqual(['demo', 'live', 'demo']);
        expect(
            new URL(address(fetcher.mock.calls[1]![0]), 'https://local.test').searchParams.get(
                'cursor',
            ),
        ).toBe('opaque/+=');
        expect(lifecycle.queryClient.getQueryCache().getAll()[0]?.queryKey.slice(3, 7)).toEqual([
            'runs',
            'task',
            id(1),
            'history',
        ]);
    });
    it('stops repeating server cursors', async () => {
        const { query } = setup(async () =>
            Response.json({ items: [run(10)], nextCursor: 'repeat' }),
        );
        await vi.waitFor(() => expect(query.hasNextPage.value).toBe(true));
        await query.fetchNextPage();
        expect(query.hasNextPage.value).toBe(false);
    });
    it.each([403, 404, 500])(
        'handles HTTP %i after successful history without leaking denied records',
        async (status) => {
            let fail = false;
            const { query, items } = setup(async () =>
                fail
                    ? Response.json(
                          { code: 'TEST_FAILURE', message: 'sample', requestId: 'sample' },
                          { status },
                      )
                    : Response.json({ items: [run(10)], nextCursor: null }),
            );
            await vi.waitFor(() => expect(items.value).toHaveLength(1));
            fail = true;
            await query.refetch();
            expect(query.isError.value).toBe(true);
            expect(items.value).toHaveLength(status === 500 ? 1 : 0);
        },
    );
    it.each([403, 404, 503])(
        'handles later-page HTTP %i and retries the same opaque cursor without duplicating rows',
        async (status) => {
            let fail = true;
            const cursors: (string | null)[] = [];
            const { query, items } = setup(async (url) => {
                const cursor = new URL(address(url), 'https://local.test').searchParams.get(
                    'cursor',
                );
                cursors.push(cursor);
                if (!cursor)
                    return Response.json({ items: [run(11), run(10)], nextCursor: 'opaque/+=' });
                return fail
                    ? Response.json(
                          { code: 'TEST_FAILURE', message: 'sample', requestId: 'sample' },
                          { status },
                      )
                    : Response.json({ items: [run(10), run(9)], nextCursor: null });
            });
            await vi.waitFor(() => expect(items.value).toHaveLength(2));
            await query.fetchNextPage();
            expect(query.isFetchNextPageError.value).toBe(true);
            expect(items.value).toHaveLength(status === 503 ? 2 : 0);
            fail = false;
            await query.fetchNextPage();
            expect(cursors).toEqual([null, 'opaque/+=', 'opaque/+=']);
            expect(items.value.map((item) => item.id)).toEqual([id(11), id(10), id(9)]);
            expect(query.hasNextPage.value).toBe(false);
        },
    );
    it('rejects a page from another task and never requests invalid task ids', async () => {
        const mismatch = setup(async () =>
            Response.json({ items: [run(10, id(2))], nextCursor: null }),
        );
        await vi.waitFor(() => expect(mismatch.query.isError.value).toBe(true));
        expect(mismatch.items.value).toEqual([]);
        const fetcher = vi.fn<typeof fetch>();
        const invalid = setup(fetcher, ref('../invalid'));
        await nextTick();
        expect(validHistoryTaskId('../invalid')).toBe(false);
        expect(invalid.items.value).toEqual([]);
        expect(fetcher).not.toHaveBeenCalled();
    });
    it('cancels a previous task read and ignores its late response', async () => {
        let release!: (response: Response) => void;
        let oldSignal: AbortSignal | undefined;
        const { target, items } = setup(async (url, options) => {
            if (address(url).includes(`/tasks/${id(1)}/`)) {
                oldSignal = options?.signal ?? undefined;
                return new Promise<Response>((resolve) => {
                    release = resolve;
                });
            }
            return Response.json({ items: [run(20, id(2))], nextCursor: null });
        });
        await vi.waitFor(() => expect(release).toBeTypeOf('function'));
        target.value = id(2);
        await vi.waitFor(() => expect(items.value[0]?.id).toBe(id(20)));
        release(Response.json({ items: [run(10)], nextCursor: null }));
        await nextTick();
        expect(oldSignal?.aborted).toBe(true);
        expect(items.value.map((item) => item.id)).toEqual([id(20)]);
    });
    it.each([200, 401])(
        'ignores late old-account HTTP %i and clears its cache on switch',
        async (status) => {
            let release!: (response: Response) => void;
            let calls = 0;
            const { lifecycle, items } = setup(async () =>
                ++calls === 1
                    ? new Promise<Response>((resolve) => {
                          release = resolve;
                      })
                    : Response.json({ items: [], nextCursor: null }),
            );
            await vi.waitFor(() => expect(release).toBeTypeOf('function'));
            lifecycle.replaceSession({ ...account, user: { ...account.user, id: id(101) } });
            release(
                status === 200
                    ? Response.json({ items: [run(10)], nextCursor: null })
                    : Response.json(
                          { code: 'SESSION_REQUIRED', message: 'sample', requestId: 'sample' },
                          { status },
                      ),
            );
            await vi.waitFor(() => expect(calls).toBe(2));
            expect(items.value).toEqual([]);
            expect(lifecycle.session.user?.id).toBe(id(101));
            expect(
                lifecycle.queryClient
                    .getQueryCache()
                    .getAll()
                    .every((entry) => entry.queryKey[1] === id(101)),
            ).toBe(true);
        },
    );
    it('aborts history when its scope is disposed', async () => {
        let signal: AbortSignal | undefined;
        const { scope } = setup(async (_url, options) => {
            signal = options?.signal ?? undefined;
            return new Promise<Response>(() => {});
        });
        await vi.waitFor(() => expect(signal).toBeDefined());
        scope.stop();
        await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    });
});
