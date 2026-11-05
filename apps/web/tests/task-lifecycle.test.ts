import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { effectScope, nextTick, ref } from 'vue';
import type { SessionResponse, TaskDetailResponse } from '@scova/models';
import type { ApiResponse } from '@/api/client';
import { createSessionLifecycle } from '@/api/session';
import { taskLifecycleOptions, validateLifecycleSnapshot } from '@/api/task-lifecycle';
import { useTaskLifecycle } from '@/composables/useTaskLifecycle';
import { initialTaskDraft, taskInput } from '@/composables/useCreateTask';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const instant = '2026-10-31T00:00:00Z';
const account: SessionResponse = {
    user: {
        id: id(1),
        email: 'lifecycle@example.test',
        createdAt: instant,
        preferences: {
            defaultTimezone: 'UTC',
            notificationPreference: { mode: 'summary', runIssues: true },
        },
    },
    csrfToken: 'local-csrf',
};
function detail(
    status: 'active' | 'paused' | 'archived' = 'active',
    revision = 1,
    taskId = id(10),
): TaskDetailResponse {
    const config = taskInput({
        ...initialTaskDraft(),
        title: '计划任务',
        topic: '政策',
        goal: '核验',
        timezone: 'UTC',
    }).config;
    config.schedule = { frequency: 'daily', localTime: '09:00' };
    return {
        task: {
            id: taskId,
            title: config.title,
            status,
            revision,
            currentVersionId: id(20),
            nextRunAt: status === 'active' ? '2026-11-01T09:00:00Z' : null,
            createdAt: instant,
            updatedAt: instant,
        },
        version: {
            id: id(20),
            taskId,
            version: 1,
            configSchemaVersion: 1,
            config,
            comparisonScopeHash: 'a'.repeat(64),
            createdAt: instant,
        },
        baselineResetRequired: false,
    };
}
const api = (data = detail()): ApiResponse<TaskDetailResponse> => ({
    data,
    status: 200,
    url: `/api/v1/tasks/${data.task.id}`,
    headers: { etag: `"${data.task.revision}"` },
});
const http = (data = detail()) =>
    Response.json(data, { headers: { etag: `"${data.task.revision}"` } });
const failure = (status: number, code = 'LOCAL_FAILURE') =>
    Response.json({ code, message: 'local', requestId: 'local' }, { status });
const addressOf = (url: Parameters<typeof fetch>[0]) =>
    url instanceof Request ? url.url : url.toString();
const cleanups: (() => void)[] = [];
function setup(fetcher: typeof fetch) {
    const lifecycle = createSessionLifecycle({ fetcher });
    lifecycle.replaceSession(account);
    const scope = effectScope();
    const target = ref(id(10));
    const actions = scope.run(() => useTaskLifecycle(target, lifecycle))!;
    cleanups.push(() => {
        scope.stop();
        lifecycle.dispose();
    });
    return { actions, lifecycle, target, scope };
}
const ready = async (actions: ReturnType<typeof useTaskLifecycle>) =>
    vi.waitFor(() => expect(actions.disabled.value).toBe(false));
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

describe('任务生命周期命令', () => {
    it('先实际GET后允许动作；暂停使用原quoted ETag、Cookie/CSRF、无body/key且不调用Run', async () => {
        let finish!: (value: Response) => void;
        let state = detail();
        const calls: { path: string; init?: RequestInit }[] = [];
        const { actions } = setup(async (url, init) => {
            calls.push({ path: addressOf(url), init });
            if (calls.length === 1)
                return new Promise((resolve) => {
                    finish = resolve;
                });
            if (init?.method === 'POST') state = detail('paused', 2);
            return http(state);
        });
        await actions.submit('pause');
        await vi.waitFor(() => expect(calls).toHaveLength(1));
        expect(actions.disabled.value).toBe(true);
        finish(http());
        await ready(actions);
        await actions.submit('pause');
        const post = calls.find((call) => call.init?.method === 'POST')!;
        expect(post.path).toContain(`/tasks/${id(10)}/pause`);
        expect(new Headers(post.init?.headers).get('if-match')).toBe('"1"');
        expect(new Headers(post.init?.headers).get('x-csrf-token')).toBe('local-csrf');
        expect(new Headers(post.init?.headers).get('idempotency-key')).toBeNull();
        expect(post.init?.credentials).toBe('include');
        expect(post.init?.body).toBeUndefined();
        expect(calls.every((call) => !call.path.includes('/runs'))).toBe(true);
        expect(actions.snapshot.value?.data.task.status).toBe('paused');
        expect(actions.message.value).toContain('在途执行继续');
    });
    it('恢复只显示服务端未来计划，不产生补跑命令，后续命令使用新读取ETag', async () => {
        let state = detail('paused', 4);
        const paths: string[] = [];
        const etags: (string | null)[] = [];
        const { actions } = setup(async (url, init) => {
            paths.push(addressOf(url));
            if (init?.method === 'POST') {
                etags.push(new Headers(init.headers).get('if-match'));
                state = state.task.status === 'paused' ? detail('active', 5) : detail('paused', 6);
            }
            return http(state);
        });
        await ready(actions);
        await actions.submit('resume');
        expect(actions.message.value).toContain('不补跑');
        expect(actions.snapshot.value?.data.task.nextRunAt).toBe('2026-11-01T09:00:00Z');
        await actions.submit('pause');
        expect(etags).toEqual(['"4"', '"5"']);
        expect(paths.some((path) => path.includes('/runs'))).toBe(false);
    });
    it('双击与键盘重复只发一个命令', async () => {
        let finish!: (value: Response) => void;
        const posts: string[] = [];
        const { actions } = setup(async (url, init) => {
            if (init?.method === 'POST') {
                posts.push(addressOf(url));
                return new Promise((resolve) => {
                    finish = resolve;
                });
            }
            return http();
        });
        await ready(actions);
        const first = actions.submit('pause');
        await actions.submit('pause');
        await actions.submit('resume');
        await vi.waitFor(() => expect(posts).toHaveLength(1));
        finish(http(detail('paused', 2)));
        await first;
        expect(posts).toHaveLength(1);
    });
    it('归档必须确认，取消确认无请求；确认后保留历史语义且无删除', async () => {
        let state = detail();
        const posts: string[] = [];
        const { actions } = setup(async (url, init) => {
            if (init?.method === 'POST') {
                posts.push(addressOf(url));
                state = detail('archived', 2);
            }
            return http(state);
        });
        await ready(actions);
        await actions.submit('archive');
        expect(posts).toHaveLength(0);
        expect(actions.prepareArchive()).toBe(true);
        actions.cancelArchive();
        await actions.submit('archive');
        expect(posts).toHaveLength(0);
        actions.prepareArchive();
        await actions.submit('archive');
        expect(posts).toEqual([`/api/v1/tasks/${id(10)}/archive`]);
        expect(actions.snapshot.value?.data.task.status).toBe('archived');
        expect(actions.message.value).toContain('活动执行已请求取消');
        expect(actions.message.value).toContain('报告与历史保留');
        await actions.submit('resume');
        await actions.submit('pause');
        expect(actions.prepareArchive()).toBe(false);
        expect(posts).toHaveLength(1);
    });
    it.each([409, 412, 428])(
        '%s冲突保持上下文与锁，背景缓存更新不能解锁；显式GET后新操作使用新ETag',
        async (status) => {
            let reads = 0;
            const etags: (string | null)[] = [];
            const { actions, lifecycle } = setup(async (_url, init) => {
                if (init?.method === 'POST') {
                    etags.push(new Headers(init.headers).get('if-match'));
                    return failure(status);
                }
                return http(detail('active', ++reads === 1 ? 1 : 8));
            });
            await ready(actions);
            await actions.submit('pause');
            expect(actions.message.value).toContain(String(status));
            expect(actions.snapshot.value?.data.task.id).toBe(id(10));
            lifecycle.queryClient.setQueryData(
                taskLifecycleOptions(lifecycle, id(10)).queryKey,
                api(detail('active', 7)),
            );
            await nextTick();
            expect(actions.disabled.value).toBe(true);
            await actions.submit('pause');
            expect(etags).toHaveLength(1);
            await actions.refresh();
            expect(actions.disabled.value).toBe(false);
            expect(reads).toBe(2);
            await actions.submit('pause');
            expect(etags).toEqual(['"1"', '"8"']);
        },
    );
    it('归档确认冻结ETag，背景替换不静默采用新修订', async () => {
        let etag: string | null = null;
        const { actions, lifecycle } = setup(async (_url, init) => {
            if (init?.method === 'POST') {
                etag = new Headers(init.headers).get('if-match');
                return failure(409);
            }
            return http();
        });
        await ready(actions);
        actions.prepareArchive();
        lifecycle.queryClient.setQueryData(
            taskLifecycleOptions(lifecycle, id(10)).queryKey,
            api(detail('paused', 2)),
        );
        await nextTick();
        await actions.submit('archive');
        expect(etag).toBe('"1"');
        expect(actions.blocked.value).toBe(true);
    });
    it.each([408, 503, 0])('%s未知结果不盲重发；刷新失败保留上下文且锁定', async (status) => {
        let reads = 0;
        let posts = 0;
        const { actions } = setup(async (_url, init) => {
            if (init?.method === 'POST') {
                posts++;
                if (!status) throw new TypeError('network');
                return failure(status);
            }
            return ++reads === 1 ? http() : failure(503);
        });
        await ready(actions);
        await actions.submit('pause');
        expect(actions.message.value).toContain('尚不能确认');
        await actions.submit('pause');
        expect(posts).toBe(1);
        await actions.refresh();
        expect(actions.snapshot.value?.data.task.status).toBe('active');
        expect(actions.disabled.value).toBe(true);
        expect(actions.message.value).toContain('读取失败');
    });
    it.each(['etag', 'task', 'version', 'status', 'revision'] as const)(
        '命令响应%s不一致不当成功，必须重读',
        async (kind) => {
            const { actions } = setup(async (_url, init) => {
                if (init?.method !== 'POST') return http();
                const value = detail('paused', 2);
                if (kind === 'task') value.task.id = id(99);
                if (kind === 'version') {
                    value.version.id = id(99);
                    value.task.currentVersionId = id(99);
                }
                if (kind === 'status') value.task.status = 'archived';
                if (kind === 'revision') value.task.revision = 3;
                return Response.json(value, {
                    headers: { etag: kind === 'etag' ? '"99"' : `"${value.task.revision}"` },
                });
            });
            await ready(actions);
            await actions.submit('pause');
            expect(actions.disabled.value).toBe(true);
            expect(actions.message.value).toContain('尚不能确认');
        },
    );
    it('无效读取ETag或版本绑定不能用于动作', () => {
        expect(() => validateLifecycleSnapshot({ ...api(), headers: {} }, id(10))).toThrow();
        const wrong = detail();
        wrong.version.taskId = id(99);
        expect(() => validateLifecycleSnapshot(api(wrong), id(10))).toThrow();
        expect(() =>
            validateLifecycleSnapshot({ ...api(), headers: { etag: '1' } }, id(10)),
        ).toThrow();
    });
    it('初始有缓存仍必须等待实际读取，不使用旧修订直接动作', async () => {
        let finish!: (response: Response) => void;
        const lifecycle = createSessionLifecycle({
            fetcher: async () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        });
        lifecycle.replaceSession(account);
        lifecycle.queryClient.setQueryData(taskLifecycleOptions(lifecycle, id(10)).queryKey, api());
        const scope = effectScope();
        const actions = scope.run(() => useTaskLifecycle(id(10), lifecycle))!;
        cleanups.push(() => {
            scope.stop();
            lifecycle.dispose();
        });
        expect(actions.disabled.value).toBe(true);
        await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
        finish(http(detail('paused', 2)));
        await ready(actions);
        expect(actions.snapshot.value?.headers.etag).toBe('"2"');
    });
    it.each(['route', 'account', 'dispose'] as const)(
        '%s变化中止迟到命令，不显示旧成功或清新账号',
        async (change) => {
            let finish!: (response: Response) => void;
            let signal: AbortSignal | undefined;
            const { actions, lifecycle, target, scope } = setup(async (_url, init) => {
                if (init?.method === 'POST') {
                    signal = init.signal ?? undefined;
                    return new Promise((resolve) => {
                        finish = resolve;
                    });
                }
                return http(detail('active', 1, target?.value ?? id(10)));
            });
            await ready(actions);
            const pending = actions.submit('pause');
            await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
            if (change === 'route') target.value = id(11);
            if (change === 'account')
                lifecycle.replaceSession({ ...account, user: { ...account.user, id: id(2) } });
            if (change === 'dispose') scope.stop();
            finish(change === 'account' ? failure(401) : http(detail('paused', 2)));
            await pending;
            expect(signal?.aborted).toBe(true);
            expect(actions.message.value).toBe('');
            if (change === 'account') expect(lifecycle.session.user?.id).toBe(id(2));
        },
    );
    it('路由改变后的实际GET绑定新目标，不沿用旧Query', async () => {
        const paths: string[] = [];
        const { actions, target } = setup(async (url) => {
            const path = addressOf(url);
            paths.push(path);
            return http(detail('active', 1, path.endsWith(id(11)) ? id(11) : id(10)));
        });
        await ready(actions);
        target.value = id(11);
        await vi.waitFor(() => expect(actions.snapshot.value?.data.task.id).toBe(id(11)));
        await ready(actions);
        expect(paths).toHaveLength(2);
        expect(paths[1]).toContain(id(11));
    });
    it('服务端写入成功但重新读取失败仍锁定，显式读取后按新ETag选择下一动作', async () => {
        let state = detail();
        let failRead = false;
        const etags: (string | null)[] = [];
        const { actions } = setup(async (_url, init) => {
            if (init?.method === 'POST') {
                etags.push(new Headers(init.headers).get('if-match'));
                state = detail(
                    state.task.status === 'active' ? 'paused' : 'active',
                    state.task.revision + 1,
                );
                failRead = true;
                return http(state);
            }
            return failRead ? failure(503) : http(state);
        });
        await ready(actions);
        await actions.submit('pause');
        expect(state.task.status).toBe('paused');
        expect(actions.snapshot.value?.data.task.status).toBe('active');
        expect(actions.message.value).toContain('读取失败');
        expect(actions.disabled.value).toBe(true);
        await actions.submit('pause');
        expect(etags).toEqual(['"1"']);
        failRead = false;
        await actions.refresh();
        await ready(actions);
        expect(actions.snapshot.value?.data.task.status).toBe('paused');
        await actions.submit('resume');
        expect(etags).toEqual(['"1"', '"2"']);
    });
    it.each([403, 404])('实际读取%s时隐藏旧快照并保留锁，不能从缓存提交', async (status) => {
        let fail = false;
        let posts = 0;
        const { actions } = setup(async (_url, init) => {
            if (init?.method === 'POST') posts++;
            return fail ? failure(status) : http();
        });
        await ready(actions);
        fail = true;
        await actions.refresh();
        expect(actions.snapshot.value).toBeUndefined();
        expect(actions.disabled.value).toBe(true);
        expect(actions.prepareArchive()).toBe(false);
        await actions.submit('pause');
        expect(posts).toBe(0);
    });
    it('在途写命令禁止直接刷新，不能借读取绕开命令锁', async () => {
        let reads = 0;
        let finish!: (response: Response) => void;
        let state = detail();
        const { actions } = setup(async (_url, init) => {
            if (init?.method === 'POST')
                return new Promise((resolve) => {
                    finish = resolve;
                });
            reads++;
            return http(state);
        });
        await ready(actions);
        const pending = actions.submit('pause');
        await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
        expect(await actions.refresh()).toBe(false);
        expect(reads).toBe(1);
        state = detail('paused', 2);
        finish(http(state));
        await pending;
        expect(reads).toBe(2);
        expect(actions.snapshot.value?.data.task.status).toBe('paused');
    });
    it.each(['route', 'account'] as const)('%s变化清除尚未提交的归档确认', async (change) => {
        let posts = 0;
        const { actions, lifecycle, target } = setup(async (url, init) => {
            if (init?.method === 'POST') posts++;
            return http(detail('active', 1, addressOf(url).includes(id(11)) ? id(11) : id(10)));
        });
        await ready(actions);
        expect(actions.prepareArchive()).toBe(true);
        if (change === 'route') target.value = id(11);
        else lifecycle.replaceSession({ ...account, user: { ...account.user, id: id(2) } });
        await ready(actions);
        expect(actions.confirmation.value).toBeUndefined();
        await actions.submit('archive');
        expect(posts).toBe(0);
    });
    it('仅手动执行任务可恢复为active且无周期时点，客户端不伪造下次计划', async () => {
        let state = detail('paused');
        state.version.config.schedule = { frequency: 'manual' };
        const { actions } = setup(async (_url, init) => {
            if (init?.method === 'POST') {
                state = { ...state, task: { ...state.task, status: 'active', revision: 2 } };
            }
            return http(state);
        });
        await ready(actions);
        await actions.submit('resume');
        expect(actions.snapshot.value?.data.task.status).toBe('active');
        expect(actions.snapshot.value?.data.task.nextRunAt).toBeNull();
        expect(actions.disabled.value).toBe(false);
    });
});
