import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { effectScope, ref } from 'vue';
import type { SessionResponse, TaskDetailResponse } from '@scova/models';
import { createSessionLifecycle } from '@/api/session';
import { initialTaskDraft, taskInput } from '@/composable/useCreateTask';
import { bulkTaskLimit, useBulkTaskDeletion } from '@/composable/useBulkTaskDeletion';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const instant = '2026-11-09T00:00:00Z';
const account: SessionResponse = {
    user: {
        id: id(1),
        email: 'bulk@example.test',
        createdAt: instant,
        preferences: {
            defaultTimezone: 'UTC',
            notificationPreference: { mode: 'off', runIssues: false },
        },
    },
    csrfToken: 'bulk-csrf',
};
function detail(n: number, revision = 1): TaskDetailResponse {
    const config = taskInput({
        ...initialTaskDraft(),
        title: `任务${n}`,
        topic: '资料',
        goal: '收集',
        timezone: 'UTC',
    }).config;
    return {
        task: {
            id: id(n),
            title: config.title,
            status: 'active',
            revision,
            currentVersionId: id(n + 100),
            nextRunAt: null,
            createdAt: instant,
            updatedAt: instant,
        },
        version: {
            id: id(n + 100),
            taskId: id(n),
            version: 1,
            configSchemaVersion: 1,
            config,
            comparisonScopeHash: 'a'.repeat(64),
            createdAt: instant,
        },
        baselineResetRequired: false,
    };
}
const cleanups: (() => void)[] = [];
const failure = (status: number, code: string) =>
    Response.json({ code, message: 'sample', requestId: 'sample' }, { status });
function setup(
    handler?: (n: number, init?: RequestInit) => Response | Promise<Response>,
    count = 3,
) {
    const calls: { n: number; method: string; headers: Headers }[] = [];
    const lifecycle = createSessionLifecycle({
        fetcher: async (url, init) => {
            const address = url instanceof Request ? url.url : String(url);
            const n = Number(address.split('/').at(-1)!.slice(-12));
            calls.push({ n, method: init?.method ?? 'GET', headers: new Headers(init?.headers) });
            return handler
                ? handler(n, init)
                : init?.method === 'DELETE'
                  ? new Response(null, { status: 204 })
                  : Response.json(detail(n), { headers: { etag: '"1"' } });
        },
    });
    lifecycle.replaceSession(account);
    const tasks = ref(Array.from({ length: count }, (_, i) => detail(i + 10).task));
    const scope = effectScope();
    const actions = scope.run(() => useBulkTaskDeletion(tasks, lifecycle))!;
    cleanups.push(() => {
        scope.stop();
        lifecycle.dispose();
    });
    return { actions, calls, lifecycle, tasks, scope };
}
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));
describe('批量清除安全边界', () => {
    it('未确认、取消和错误文字均不派发，预检实际GET且删除冻结ETag和CSRF', async () => {
        const { actions, tasks, calls } = setup();
        actions.selectLoaded();
        await actions.remove('清除 3 个任务');
        expect(calls).toEqual([]);
        expect(await actions.prepare()).toBe(true);
        expect(calls.map((call) => call.method)).toEqual(['GET', 'GET', 'GET']);
        actions.cancel();
        await actions.remove('清除 3 个任务');
        expect(calls).toHaveLength(3);
        actions.clearSelection();
        actions.toggle(tasks.value[0]);
        expect(await actions.prepare()).toBe(true);
        await actions.remove('清除 3 个任务');
        expect(calls).toHaveLength(4);
        await actions.remove('清除 1 个任务');
        expect(calls.filter((call) => call.method === 'DELETE')).toMatchObject([{ n: 10 }]);
        expect(calls.at(-1)!.headers.get('if-match')).toBe('"1"');
        expect(calls.at(-1)!.headers.get('x-csrf-token')).toBe('bulk-csrf');
        expect(actions.results.value[0].status).toBe('removed');
        expect(actions.message.value).toBe('');
        expect(actions.selected.value).toEqual([]);
    });
    it('预检一项失败不删除任何任务', async () => {
        const { actions, calls } = setup((n) =>
            n === 11
                ? failure(404, 'NOT_FOUND')
                : Response.json(detail(n), { headers: { etag: '"1"' } }),
        );
        actions.selectLoaded();
        expect(await actions.prepare()).toBe(false);
        expect(actions.confirmation.value).toEqual([]);
        expect(actions.message.value).toContain('未执行清除');
        expect(calls.every((call) => call.method === 'GET')).toBe(true);
    });
    it.each(['revision', 'title', 'etag', 'identity'] as const)(
        '预检拒绝%s变化或无效快照',
        async (field) => {
            const value = detail(10);
            if (field === 'revision') value.task.revision = 2;
            if (field === 'title') value.task.title = '新标题';
            if (field === 'identity') value.task.id = id(99);
            const { actions, calls } = setup(() =>
                Response.json(value, {
                    headers: { etag: field === 'etag' ? '"2"' : `"${value.task.revision}"` },
                }),
            );
            actions.selectLoaded();
            expect(await actions.prepare()).toBe(false);
            expect(actions.confirmation.value).toEqual([]);
            expect(calls.every((call) => call.method === 'GET')).toBe(true);
        },
    );
    it('活动执行/修订冲突逐项保留，其他任务可删除，不能双击重发', async () => {
        let release!: (value: Response) => void;
        const { actions, calls } = setup((n, init) =>
            init?.method !== 'DELETE'
                ? Response.json(detail(n), { headers: { etag: '"1"' } })
                : n === 10
                  ? new Promise((resolve) => {
                        release = resolve;
                    })
                  : n === 11
                    ? failure(409, 'REVISION_CONFLICT')
                    : new Response(null, { status: 204 }),
        );
        actions.selectLoaded();
        await actions.prepare();
        const pending = actions.remove(actions.phrase.value);
        await vi.waitFor(() =>
            expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(1),
        );
        await actions.remove(actions.phrase.value);
        actions.cancel();
        expect(actions.confirmation.value).toHaveLength(3);
        release(failure(409, 'TASK_RUN_ACTIVE'));
        await pending;
        expect(actions.results.value.map((item) => item.status)).toEqual([
            'rejected',
            'rejected',
            'removed',
        ]);
        expect(actions.results.value[0].message).toContain('活动执行');
        expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(3);
        expect(await actions.prepare()).toBe(false);
    });
    it.each([503, 408, 429, 403])('响应%d停止后续清除且不自动重发', async (status) => {
        const { actions, calls } = setup((n, init) =>
            init?.method === 'DELETE'
                ? failure(status, 'SAMPLE')
                : Response.json(detail(n), { headers: { etag: '"1"' } }),
        );
        actions.selectLoaded();
        await actions.prepare();
        await actions.remove(actions.phrase.value);
        expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(1);
        expect(actions.results.value.map((item) => item.status)).toEqual([
            status >= 500 || status === 408 ? 'unknown' : 'rejected',
            'skipped',
            'skipped',
        ]);
        expect(actions.confirmation.value).toEqual([]);
    });
    it('网络结果不明保留已成功项并停止剩余项', async () => {
        const { actions, calls } = setup((n, init) => {
            if (init?.method === 'DELETE') {
                if (n === 11) throw new TypeError('network lost');
                return new Response(null, { status: 204 });
            }
            return Response.json(detail(n), { headers: { etag: '"1"' } });
        });
        actions.selectLoaded();
        await actions.prepare();
        await actions.remove(actions.phrase.value);
        expect(actions.results.value.map((item) => item.status)).toEqual([
            'removed',
            'unknown',
            'skipped',
        ]);
        expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(2);
    });
    it.each(['logout', 'dispose'] as const)(
        '%s中止后续请求，迟到响应不恢复旧选择或结果',
        async (mode) => {
            let release!: (value: Response) => void;
            const { actions, calls, lifecycle, scope } = setup((n, init) =>
                init?.method === 'DELETE'
                    ? new Promise((resolve) => {
                          release = resolve;
                      })
                    : Response.json(detail(n), { headers: { etag: '"1"' } }),
            );
            actions.selectLoaded();
            await actions.prepare();
            const pending = actions.remove(actions.phrase.value);
            await vi.waitFor(() =>
                expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(1),
            );
            if (mode === 'logout') lifecycle.replaceSession(null);
            else scope.stop();
            release(new Response(null, { status: 204 }));
            await pending;
            expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(1);
            expect(actions.results.value).toEqual([]);
            expect(actions.confirmation.value).toEqual([]);
            expect(actions.pending.value).toBe(false);
        },
    );
    it('仅选择已加载任务且受批次上限约束，新增页不自动选中，列表变更取消旧选择', async () => {
        const { actions, tasks } = setup(undefined, bulkTaskLimit + 1);
        actions.selectLoaded();
        expect(actions.selected.value).toHaveLength(bulkTaskLimit);
        actions.toggle(tasks.value.at(-1)!);
        expect(actions.selected.value).toHaveLength(bulkTaskLimit);
        actions.clearSelection();
        actions.toggle(tasks.value[0]);
        tasks.value = [...tasks.value, detail(90).task];
        await vi.waitFor(() => expect(actions.selected.value).toHaveLength(1));
        tasks.value = tasks.value.map((task) =>
            task.id === id(10) ? { ...task, revision: 2 } : task,
        );
        await vi.waitFor(() => expect(actions.selected.value).toEqual([]));
    });
});
