import { afterEach, describe, expect, it } from 'vite-plus/test';
import { effectScope, nextTick, ref } from 'vue';
import { InfiniteQueryObserver } from '@tanstack/vue-query';
import type { SessionResponse, Task } from '@scova/models';
import { createSessionLifecycle } from '@/api/session';
import { taskListOptions, visibleTasks, useTasks, localTaskTime } from '@/composable/useTasks';

const session: SessionResponse = {
    user: {
        id: '00000000-0000-4000-8000-000000000001',
        email: 'a@example.test',
        preferences: {
            defaultTimezone: 'UTC',
            notificationPreference: { mode: 'summary', runIssues: true },
        },
        createdAt: '2026-10-31T00:00:00Z',
    },
    csrfToken: 'test',
};
const task: Task = {
    id: '00000000-0000-4000-8000-000000000011',
    title: '真实摘要测试',
    status: 'active',
    revision: 1,
    currentVersionId: '00000000-0000-4000-8000-000000000021',
    nextRunAt: null,
    createdAt: '2026-10-31T00:00:00Z',
    updatedAt: '2026-10-31T00:00:00Z',
};
const cleanups: (() => void)[] = [];
function setup(fetcher: typeof fetch) {
    const lifecycle = createSessionLifecycle({ fetcher });
    lifecycle.replaceSession(session);
    cleanups.push(() => lifecycle.dispose());
    return lifecycle;
}
afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
});

describe('任务中心读取与分页', () => {
    it('真实分页参数不发送后端不支持的状态，重复任务去重，状态筛选仅作用已加载数据', async () => {
        const urls: string[] = [];
        const lifecycle = setup(async (url) => {
            urls.push(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url);
            return Response.json(
                urls.length === 1
                    ? { items: [task], nextCursor: 'page-2' }
                    : {
                          items: [
                              task,
                              {
                                  ...task,
                                  id: '00000000-0000-4000-8000-000000000012',
                                  status: 'paused',
                              },
                          ],
                          nextCursor: null,
                      },
            );
        });
        const observer = new InfiniteQueryObserver(
            lifecycle.queryClient,
            taskListOptions(lifecycle, 'all'),
        );
        const stop = observer.subscribe(() => {});
        cleanups.push(stop);
        await observer.refetch();
        await observer.fetchNextPage();
        const pages = observer.getCurrentResult().data?.pages;
        expect(visibleTasks(pages, 'all')).toHaveLength(2);
        expect(visibleTasks(pages, 'paused')).toHaveLength(1);
        expect(urls).toHaveLength(2);
        expect(urls[0]).toContain('limit=20');
        expect(urls[1]).toContain('cursor=page-2');
        expect(urls.join()).not.toContain('status=');
        expect(observer.getCurrentResult().hasNextPage).toBe(false);
    });
    it('加载、空态、失败后显式重试，不自动重发', async () => {
        let resolve!: (response: Response) => void;
        let count = 0;
        const lifecycle = setup(async () => {
            count++;
            return count === 1
                ? new Promise((done) => {
                      resolve = done;
                  })
                : Response.json({ items: [], nextCursor: null });
        });
        const observer = new InfiniteQueryObserver(
            lifecycle.queryClient,
            taskListOptions(lifecycle, 'active'),
        );
        const stop = observer.subscribe(() => {});
        cleanups.push(stop);
        await new Promise((done) => setTimeout(done, 0));
        expect(observer.getCurrentResult().isPending).toBe(true);
        resolve(
            Response.json({ code: 'FAILED', message: 'test', requestId: 'test' }, { status: 503 }),
        );
        await new Promise((done) => setTimeout(done, 0));
        expect(observer.getCurrentResult().isError).toBe(true);
        expect(count).toBe(1);
        await observer.refetch();
        expect(visibleTasks(observer.getCurrentResult().data?.pages, 'active')).toEqual([]);
        expect(observer.getCurrentResult().isSuccess).toBe(true);
    });
    it('筛选切换与卸载取消旧请求，迟到返回不覆盖当前筛选', async () => {
        const requests: { signal: AbortSignal; resolve: (response: Response) => void }[] = [];
        const lifecycle = setup(
            async (_url, init) =>
                new Promise((resolve) => requests.push({ signal: init!.signal!, resolve })),
        );
        const filter = ref<'active' | 'paused'>('active');
        const scope = effectScope();
        cleanups.push(() => scope.stop());
        const result = scope.run(() => useTasks(filter, lifecycle))!;
        await new Promise((done) => setTimeout(done, 0));
        filter.value = 'paused';
        await nextTick();
        await new Promise((done) => setTimeout(done, 0));
        expect(requests[0]!.signal.aborted).toBe(true);
        requests[0]!.resolve(Response.json({ items: [task], nextCursor: null }));
        requests[1]!.resolve(
            Response.json({ items: [{ ...task, status: 'paused' }], nextCursor: null }),
        );
        await new Promise((done) => setTimeout(done, 0));
        expect(result.items.value.map((item) => item.status)).toEqual(['paused']);
        filter.value = 'active';
        await nextTick();
        await new Promise((done) => setTimeout(done, 0));
        scope.stop();
        expect(requests.at(-1)!.signal.aborted).toBe(true);
    });
    it('换号取消A，B使用独立epoch与缓存', async () => {
        let release!: (response: Response) => void;
        let signal!: AbortSignal;
        let count = 0;
        const lifecycle = setup(async (_url, init) =>
            ++count === 1
                ? new Promise((resolve) => {
                      release = resolve;
                      signal = init!.signal!;
                  })
                : Response.json({ items: [], nextCursor: null }),
        );
        const a = taskListOptions(lifecycle, 'all');
        const pending = lifecycle.queryClient.fetchInfiniteQuery(a).catch(() => undefined);
        await new Promise((done) => setTimeout(done, 0));
        lifecycle.replaceSession({
            ...session,
            user: { ...session.user, id: '00000000-0000-4000-8000-000000000002' },
        });
        const b = taskListOptions(lifecycle, 'all');
        await lifecycle.queryClient.fetchInfiniteQuery(b);
        release(Response.json({ items: [task], nextCursor: null }));
        await pending;
        expect(signal.aborted).toBe(true);
        expect(a.queryKey).not.toEqual(b.queryKey);
        expect(lifecycle.queryClient.getQueryData(a.queryKey)).toBeUndefined();
        expect(lifecycle.queryClient.getQueryData(b.queryKey)).toMatchObject({
            pages: [{ data: { items: [] } }],
        });
    });
    it('当地时间使用明确时区，不把无计划或更新时间当执行时间', () => {
        expect(localTaskTime('2026-10-31T00:00:00Z', 'Asia/Shanghai')).toContain('08:00');
        expect(localTaskTime('2026-10-31T00:00:00Z', 'UTC')).toContain('00:00');
        expect(visibleTasks(undefined, 'all')).toEqual([]);
    });
    it('进入摘要停止列表请求，返回后可以重新读取', async () => {
        const requests: { signal: AbortSignal; resolve: (response: Response) => void }[] = [];
        const lifecycle = setup(
            async (_url, init) =>
                new Promise((resolve) => {
                    requests.push({ signal: init!.signal!, resolve });
                }),
        );
        const enabled = ref(true);
        const scope = effectScope();
        cleanups.push(() => scope.stop());
        const result = scope.run(() => useTasks('all', lifecycle, enabled))!;
        await new Promise((done) => setTimeout(done, 0));
        enabled.value = false;
        await nextTick();
        expect(requests[0]!.signal.aborted).toBe(true);
        requests[0]!.resolve(Response.json({ items: [task], nextCursor: null }));
        enabled.value = true;
        await nextTick();
        await new Promise((done) => setTimeout(done, 0));
        requests[1]!.resolve(Response.json({ items: [], nextCursor: null }));
        await new Promise((done) => setTimeout(done, 0));
        expect(result.items.value).toEqual([]);
    });
    it('重复游标终止分页链，不无限追加相同页', async () => {
        const lifecycle = setup(async () => Response.json({ items: [task], nextCursor: 'same' }));
        const observer = new InfiniteQueryObserver(
            lifecycle.queryClient,
            taskListOptions(lifecycle, 'all'),
        );
        cleanups.push(observer.subscribe(() => {}));
        await observer.refetch();
        expect(observer.getCurrentResult().hasNextPage).toBe(true);
        await observer.fetchNextPage();
        expect(observer.getCurrentResult().hasNextPage).toBe(false);
        expect(visibleTasks(observer.getCurrentResult().data?.pages, 'all')).toHaveLength(1);
    });
});
