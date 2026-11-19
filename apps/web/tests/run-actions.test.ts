import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { effectScope, nextTick, ref } from 'vue';
import type { Run, SessionResponse } from '@scova/models';
import { createSessionLifecycle } from '@/api/session';
import { useRunActions } from '@/composable/useRunActions';
import type { RunActionTarget } from '@/api/runs';

const taskId = '00000000-0000-4000-8000-000000000001';
const runId = '00000000-0000-4000-8000-000000000002';
const nextId = '00000000-0000-4000-8000-000000000003';
const otherId = '00000000-0000-4000-8000-000000000004';
const instant = '2026-10-31T00:00:00Z';
const account: SessionResponse = {
    user: {
        id: taskId,
        email: 'local@example.test',
        createdAt: instant,
        preferences: {
            defaultTimezone: 'UTC',
            notificationPreference: { mode: 'summary', runIssues: true },
        },
    },
    csrfToken: 'local-only',
};
const run: Run = {
    id: runId,
    taskId,
    taskVersionId: taskId,
    parentRunId: null,
    baselineRunId: null,
    mode: 'live',
    status: 'failed',
    trigger: 'manual',
    outcome: null,
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
    startedAt: instant,
    finishedAt: instant,
    failureCode: null,
};
const queued = {
    ...run,
    id: nextId,
    mode: 'live',
    status: 'queued',
    finishedAt: null,
} satisfies Run;
const cleanups: (() => void)[] = [];
const addressOf = (url: Parameters<typeof fetch>[0]) =>
    url instanceof Request ? url.url : url.toString();
function setup(fetcher: typeof fetch, initial: RunActionTarget = { taskId }) {
    const lifecycle = createSessionLifecycle({ fetcher });
    lifecycle.replaceSession(account);
    const scope = effectScope();
    const target = ref(initial);
    const actions = scope.run(() => useRunActions(target, lifecycle))!;
    cleanups.push(() => {
        scope.stop();
        lifecycle.dispose();
    });
    return { actions, lifecycle, target, scope };
}
const success = (snapshot: Run = queued, reused = false) =>
    Response.json({ run: snapshot, reused }, { status: 202 });
const failure = (status: number, code = 'LOCAL_FAILURE') =>
    Response.json({ code, message: 'local test', requestId: 'local' }, { status });
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

describe('显式 Run 命令与冻结重发', () => {
    it.each(['queued', 'running', 'recovering', 'cancel_requested'] as const)(
        '最新执行为%s时不发送启动命令',
        async (status) => {
            const fetcher = vi.fn<typeof fetch>(async () => success());
            const { actions } = setup(fetcher, { taskId, latestRun: { ...run, status } });
            await actions.submit('start');
            expect(fetcher).not.toHaveBeenCalled();
        },
    );
    it('状态未读完禁止启动，已确认的执行结束后可再次启动', async () => {
        const fetcher = vi.fn<typeof fetch>(async () => success());
        const { actions, target } = setup(fetcher, { taskId, startBlocked: true });
        await actions.submit('start');
        expect(fetcher).not.toHaveBeenCalled();
        target.value.startBlocked = false;
        await actions.submit('start');
        expect(fetcher).toHaveBeenCalledTimes(1);
        target.value.latestRun = { ...queued, status: 'running' };
        await nextTick();
        expect(actions.locked.value).toBe(true);
        target.value.latestRun = { ...queued, status: 'failed', finishedAt: instant };
        await nextTick();
        expect(actions.locked.value).toBe(false);
        expect(actions.phase.value).toBe('success');
        expect(actions.result.value?.run.id).toBe(queued.id);
        await actions.submit('start');
        expect(fetcher).toHaveBeenCalledTimes(2);
    });
    it('freezes search override for uncertain replay and never sends it on cancellation', async () => {
        const bodies: string[] = [];
        const { actions, target } = setup(
            async (_url, init) => {
                bodies.push(init?.body as string);
                if (bodies.length === 1) throw new TypeError('network');
                return success();
            },
            { taskId, searchMode: 'searxng' },
        );
        await actions.submit('start');
        target.value.searchMode = 'api';
        await actions.replay();
        expect(bodies[1]).toBe(bodies[0]);
        expect(JSON.parse(bodies[1]!)).toEqual({ mode: 'live', searchMode: 'searxng' });
        const canceled = setup(
            async (_url, init) => {
                expect(init?.body).toBeUndefined();
                return success({ ...run, status: 'cancel_requested' });
            },
            { taskId, run: { ...run, status: 'running' }, searchMode: 'api' },
        );
        await canceled.actions.submit('cancel');
        expect(canceled.actions.phase.value).toBe('success');
    });
    it('未知结果重发保留提交时的多选数组，页面修改不能改写原命令', async () => {
        const bodies: string[] = [];
        const { actions, target } = setup(
            async (_url, init) => {
                bodies.push(init?.body as string);
                if (bodies.length === 1) throw new TypeError('network');
                return success();
            },
            { taskId, outputFormats: ['brief', 'comparison'] },
        );
        await actions.submit('start');
        target.value.outputFormats!.splice(0, 2, 'list');
        await actions.replay();
        expect(bodies[1]).toBe(bodies[0]);
        expect(JSON.parse(bodies[1]!)).toEqual({
            mode: 'live',
            outputFormats: ['brief', 'comparison'],
        });
    });
    it('freezes the selected output format for replay and excludes it from cancellation', async () => {
        const bodies: string[] = [];
        const { actions, target } = setup(
            async (_url, init) => {
                bodies.push(init?.body as string);
                if (bodies.length === 1) throw new TypeError('network');
                return success();
            },
            { taskId, outputFormat: 'comparison' },
        );
        await actions.submit('start');
        target.value.outputFormat = 'brief';
        await actions.replay();
        expect(bodies[0]).toBe(bodies[1]);
        expect(JSON.parse(bodies[1]!)).toEqual({ mode: 'live', outputFormat: 'comparison' });
        const canceled = setup(
            async (_url, init) => {
                expect(init?.body).toBeUndefined();
                return success({ ...run, status: 'cancel_requested' });
            },
            { taskId, run: { ...run, status: 'running' }, outputFormat: 'list' },
        );
        await canceled.actions.submit('cancel');
        expect(canceled.actions.phase.value).toBe('success');
    });
    it('未知结果重发冻结原Agent选择，更改页面选择不会改变原请求', async () => {
        const calls: { body: string; key: string | null }[] = [];
        const { actions, target } = setup(
            async (_url, init) => {
                calls.push({
                    body: init?.body as string,
                    key: new Headers(init?.headers).get('idempotency-key'),
                });
                if (calls.length === 1) throw new TypeError('network');
                return success();
            },
            { taskId, agentProviderId: otherId },
        );
        await actions.submit('start');
        expect(actions.phase.value).toBe('uncertain');
        target.value.agentProviderId = null;
        await actions.replay();
        expect(calls[1]).toEqual(calls[0]);
        expect(JSON.parse(calls[0]!.body)).toEqual({ mode: 'live', agentProviderId: otherId });
    });
    it('显式账号默认以null覆盖任务配置，省略选择仍兼容原请求', async () => {
        const fetcher = vi.fn<typeof fetch>(async () => success());
        const { actions } = setup(fetcher, { taskId, agentProviderId: null });
        await actions.submit('start');
        expect(JSON.parse(fetcher.mock.calls[0]![1]?.body as string)).toEqual({
            mode: 'live',
            agentProviderId: null,
        });
    });
    it.each(['archived', 'paused'] as const)('任务%s按真实权限决定手动执行', async (taskStatus) => {
        const fetcher = vi.fn<typeof fetch>(async () => success());
        const { actions } = setup(fetcher, { taskId, taskStatus });
        await actions.submit('start');
        expect(fetcher).toHaveBeenCalledTimes(taskStatus === 'archived' ? 0 : 1);
    });
    it('安装不会启动，统一真实执行，写请求带Cookie/CSRF/key；双击或键盘重复只派发一次', async () => {
        let finish!: (value: Response) => void;
        const fetcher = vi.fn<typeof fetch>(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        const { actions } = setup(fetcher);
        await nextTick();
        expect(fetcher).not.toHaveBeenCalled();
        const first = actions.submit('start');
        await actions.submit('start');
        await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
        const [url, init] = fetcher.mock.calls[0]!;
        expect(addressOf(url!)).toContain(`/tasks/${taskId}/runs`);
        expect(init?.credentials).toBe('include');
        expect(new Headers(init?.headers).get('x-csrf-token')).toBe('local-only');
        expect(new Headers(init?.headers).get('idempotency-key')).toBe(actions.attempt.value?.key);
        expect(JSON.parse(init?.body as string)).toEqual({ mode: 'live' });
        finish(success());
        await first;
        await actions.submit('start');
        expect(fetcher).toHaveBeenCalledTimes(1);
    });
    it('未知结果显式重发冻结原mode/key/endpoint；同Run对象刷新不清冻结动作', async () => {
        const calls: { url: string; body: unknown; key: string | null }[] = [];
        const { actions, target } = setup(
            async (url, init) => {
                calls.push({
                    url: addressOf(url),
                    body: JSON.parse(init?.body as string),
                    key: new Headers(init?.headers).get('idempotency-key'),
                });
                if (calls.length === 1) throw new TypeError('network');
                return success({ ...queued, trigger: 'retry', parentRunId: runId });
            },
            { taskId, run },
        );
        await actions.submit('retry');
        expect(actions.phase.value).toBe('uncertain');
        const frozen = actions.attempt.value;
        target.value = { taskId, run: { ...run } };
        await nextTick();
        expect(actions.attempt.value).toBe(frozen);
        await actions.replay();
        expect(calls).toHaveLength(2);
        expect(calls[1]).toEqual(calls[0]);
        expect(calls[0]?.body).toEqual({ mode: 'live' });
        expect(actions.result.value?.run.parentRunId).toBe(runId);
    });
    it('重试使用真实研究并创建原版本关联新Run', async () => {
        const calls: string[] = [];
        const { actions } = setup(
            async (_url, init) => {
                calls.push(init?.body as string);
                return success({ ...queued, mode: 'live', trigger: 'retry', parentRunId: runId });
            },
            { taskId, run },
        );
        await actions.submit('retry');
        expect(JSON.parse(calls[0]!)).toEqual({ mode: 'live' });
        expect(actions.result.value?.run.id).toBe(nextId);
        expect(actions.result.value?.run.taskVersionId).toBe(run.taskVersionId);
    });
    it.each(['failed', 'canceled'] as const)(
        '重发可以复用%s终态，不能称活动执行',
        async (status) => {
            let count = 0;
            const { actions } = setup(async () => {
                if (++count === 1) return failure(503);
                return success({ ...run, status }, true);
            });
            await actions.submit('start');
            await actions.replay();
            expect(actions.result.value?.run.status).toBe(status);
            expect(actions.message.value).toContain('复用已有执行');
            expect(actions.message.value).not.toContain('活动');
        },
    );
    it('活动复用接受不同历史mode/version/parent，以真实返回为准', async () => {
        const snapshot: Run = {
            ...queued,
            mode: 'demo',
            taskVersionId: otherId,
            parentRunId: otherId,
            budget: { ...queued.budget, maxPages: 99 },
        };
        const { actions } = setup(async () => success(snapshot, true), { taskId, run });
        await actions.submit('retry');
        expect(actions.phase.value).toBe('success');
        expect(actions.result.value?.run).toEqual(snapshot);
        expect(actions.message.value).toContain('已有活动执行');
    });
    it.each([408, 500, 503])('%s未知结果没有自动重试', async (status) => {
        const fetcher = vi.fn<typeof fetch>(async () => failure(status));
        const { actions } = setup(fetcher);
        await actions.submit('start');
        expect(actions.phase.value).toBe('uncertain');
        expect(fetcher).toHaveBeenCalledTimes(1);
    });
    it.each(['missing-run', 'invalid-json', 'wrong-mode'] as const)(
        '%s成功响应不发布结果，保留原命令供显式核对重发',
        async (kind) => {
            const fetcher = vi.fn<typeof fetch>(async () => {
                if (kind === 'missing-run')
                    return Response.json({ reused: false }, { status: 202 });
                if (kind === 'invalid-json')
                    return new Response('{not-json', {
                        status: 202,
                        headers: { 'content-type': 'application/json' },
                    });
                return success({ ...queued, mode: 'demo' });
            });
            const { actions } = setup(fetcher);
            await actions.submit('start');
            const attempt = actions.attempt.value;
            expect(actions.phase.value).toBe('uncertain');
            expect(actions.result.value).toBeUndefined();
            expect(actions.attempt.value?.mode).toBe('live');
            expect(fetcher).toHaveBeenCalledTimes(1);
            await actions.replay();
            expect(actions.attempt.value).toBe(attempt);
            expect(new Headers(fetcher.mock.calls[1]![1]?.headers).get('idempotency-key')).toBe(
                new Headers(fetcher.mock.calls[0]![1]?.headers).get('idempotency-key'),
            );
        },
    );
    it.each(['IDEMPOTENCY_PAYLOAD_MISMATCH', 'RUN_ALREADY_ACTIVE'])(
        '409 %s不轮换key绕过冲突',
        async (code) => {
            const fetcher = vi.fn<typeof fetch>(async () => failure(409, code));
            const { actions } = setup(fetcher);
            await actions.submit('start');
            const key = actions.attempt.value?.key;
            await actions.replay();
            await actions.submit('start');
            expect(actions.phase.value).toBe('rejected');
            expect(actions.message.value).toContain('409');
            expect(actions.attempt.value?.key).toBe(key);
            expect(fetcher).toHaveBeenCalledTimes(1);
        },
    );
    it('409 pending允许用户显式重发同key', async () => {
        const keys: (string | null)[] = [];
        const { actions } = setup(async (_url, init) => {
            keys.push(new Headers(init?.headers).get('idempotency-key'));
            return keys.length === 1 ? failure(409, 'IDEMPOTENCY_PENDING') : success();
        });
        await actions.submit('start');
        expect(actions.phase.value).toBe('uncertain');
        await actions.replay();
        expect(keys[0]).toBe(keys[1]);
        expect(actions.phase.value).toBe('success');
    });
    it.each([403, 404, 422, 428])('%s明确拒绝不会自动重发', async (status) => {
        const fetcher = vi.fn<typeof fetch>(async () => failure(status));
        const { actions } = setup(fetcher);
        await actions.submit('start');
        await actions.replay();
        expect(actions.phase.value).toBe('rejected');
        expect(fetcher).toHaveBeenCalledTimes(1);
    });
    it.each(['task', 'parent', 'version', 'id', 'mode', 'trigger'] as const)(
        '合法schema但%s绑定错误不能发布结果',
        async (field) => {
            const snapshot: Run = {
                ...queued,
                parentRunId: runId,
                trigger: 'retry',
                ...(field === 'task' ? { taskId: otherId } : {}),
                ...(field === 'parent' ? { parentRunId: otherId } : {}),
                ...(field === 'version' ? { taskVersionId: otherId } : {}),
                ...(field === 'id' ? { id: runId } : {}),
                ...(field === 'mode' ? { mode: 'demo' } : {}),
                ...(field === 'trigger' ? { trigger: 'manual' } : {}),
            };
            const { actions } = setup(async () => success(snapshot), { taskId, run });
            await actions.submit('retry');
            expect(actions.phase.value).toBe('uncertain');
            expect(actions.result.value).toBeUndefined();
        },
    );
    it.each([
        'succeeded',
        'partial',
        'cancel_requested',
        'queued',
        'running',
        'recovering',
    ] as const)('%s不提供失败重试', async (status) => {
        const fetcher = vi.fn<typeof fetch>(async () => success());
        const { actions } = setup(fetcher, { taskId, run: { ...run, status } });
        await actions.submit('retry');
        expect(fetcher).not.toHaveBeenCalled();
    });
    it('取消只调用无body命令并定向失效，迟到cancel_requested不覆盖终态缓存', async () => {
        let finish!: (response: Response) => void;
        const fetcher = vi.fn<typeof fetch>(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        const { actions, lifecycle } = setup(fetcher, {
            taskId,
            run: { ...run, status: 'running' },
        });
        const scope = lifecycle.capture();
        const key = scope.queryKey(['run', runId, 'snapshot']);
        lifecycle.queryClient.setQueryData(key, { ...run, status: 'running' });
        const pending = actions.submit('cancel');
        await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
        lifecycle.queryClient.setQueryData(key, { ...run, status: 'canceled' });
        finish(success({ ...run, status: 'cancel_requested' }));
        await pending;
        expect(addressOf(fetcher.mock.calls[0]![0])).toContain(`/runs/${runId}/cancel`);
        expect(fetcher.mock.calls[0]?.[1]?.body).toBeUndefined();
        expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get('idempotency-key')).toBeNull();
        expect(lifecycle.queryClient.getQueryData(key)).toMatchObject({ status: 'canceled' });
        expect(lifecycle.queryClient.getQueryState(key)?.isInvalidated).toBe(true);
        expect(actions.message.value).toContain('取消请求已提交');
        expect(actions.message.value).not.toContain('已取消');
    });
    it('取消竞争返回终态不误称取消已完成，错误Run不发布', async () => {
        const { actions } = setup(async () => success({ ...run, status: 'failed' }, true), {
            taskId,
            run: { ...run, status: 'running' },
        });
        await actions.submit('cancel');
        expect(actions.phase.value).toBe('success');
        expect(actions.message.value).toContain('执行可能已结束');
        const wrong = setup(async () => success(queued), {
            taskId,
            run: { ...run, status: 'running' },
        });
        await wrong.actions.submit('cancel');
        expect(wrong.actions.result.value).toBeUndefined();
    });
    it('已确认取消后同Run权威终态允许新的显式retry，不需要刷新页面', async () => {
        const urls: string[] = [];
        const { actions, target } = setup(
            async (url) => {
                urls.push(addressOf(url));
                return urls.length === 1
                    ? success({ ...run, status: 'cancel_requested' })
                    : success({ ...queued, trigger: 'retry', parentRunId: runId });
            },
            { taskId, run: { ...run, status: 'running' } },
        );
        await actions.submit('cancel');
        expect(actions.locked.value).toBe(true);
        target.value = { taskId, run: { ...run, status: 'canceled' } };
        expect(actions.locked.value).toBe(false);
        await actions.submit('retry');
        expect(urls).toHaveLength(2);
        expect(urls[1]).toContain(`/runs/${runId}/retry`);
        expect(actions.result.value?.run.parentRunId).toBe(runId);
    });
    it('未知取消不误标demo/key，也不因权威终态放开冻结动作', async () => {
        const { actions, target } = setup(
            async () => {
                throw new TypeError('network');
            },
            { taskId, run: { ...run, status: 'running' } },
        );
        await actions.submit('cancel');
        target.value = { taskId, run: { ...run, status: 'canceled' } };
        expect(actions.phase.value).toBe('uncertain');
        expect(actions.locked.value).toBe(true);
        expect(actions.message.value).toContain('取消结果');
        expect(actions.message.value).not.toMatch(/demo|key|模式/);
    });
    it('非复用retry返回不同预算不能发布，源预算变化不改变冻结验证', async () => {
        let count = 0;
        const { actions, target } = setup(
            async () => {
                if (++count === 1) throw new TypeError('network');
                return success({
                    ...queued,
                    parentRunId: runId,
                    trigger: 'retry',
                    budget: { ...run.budget, maxPages: 4 },
                });
            },
            { taskId, run },
        );
        await actions.submit('retry');
        target.value = { taskId, run: { ...run, budget: { ...run.budget, maxPages: 4 } } };
        await actions.replay();
        expect(actions.phase.value).toBe('uncertain');
        expect(actions.result.value).toBeUndefined();
    });
    it.each([
        ['route', 200],
        ['route', 401],
        ['account', 200],
        ['account', 401],
        ['dispose', 200],
        ['dispose', 401],
    ] as const)('%s变更中止旧命令，忽略迟到HTTP %i', async (change, status) => {
        let finish!: (response: Response) => void;
        let signal: AbortSignal | undefined;
        const { actions, lifecycle, target, scope } = setup(async (_url, init) => {
            signal = init?.signal ?? undefined;
            return new Promise((resolve) => {
                finish = resolve;
            });
        });
        const pending = actions.submit('start');
        await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
        if (change === 'route') target.value = { taskId: otherId };
        if (change === 'account')
            lifecycle.replaceSession({ ...account, user: { ...account.user, id: otherId } });
        if (change === 'dispose') scope.stop();
        finish(status === 401 ? failure(401) : success());
        await pending;
        expect(signal?.aborted).toBe(true);
        expect(actions.result.value).toBeUndefined();
        expect(actions.message.value).toBe('');
        expect(lifecycle.session.user?.id).toBe(change === 'account' ? otherId : taskId);
    });
});
