import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { effectScope } from 'vue';
import type { SessionResponse, TaskDetailResponse } from '@scova/models';
import { createSessionLifecycle } from '@/api/session';
import { taskKeys } from '@/api/tasks';
import {
    createTaskController,
    initialTaskDraft,
    taskInput,
    taskField,
} from '@/composables/useCreateTask';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const account: SessionResponse = {
    user: {
        id: id(1),
        email: 'a@example.test',
        preferences: {
            defaultTimezone: 'Asia/Shanghai',
            notificationPreference: { mode: 'important_change', runIssues: false },
        },
        createdAt: '2026-10-31T00:00:00Z',
    },
    csrfToken: 'test-csrf',
};
const validDraft = () => ({
    ...initialTaskDraft(account.user.preferences),
    title: '政策变化',
    topic: '招生政策',
    goal: '保留可核验来源',
});
function detail(): TaskDetailResponse {
    const config = taskInput(validDraft()).config;
    return {
        task: {
            id: id(11),
            title: config.title,
            status: 'active',
            revision: 1,
            currentVersionId: id(12),
            nextRunAt: null,
            createdAt: '2026-10-31T00:00:00Z',
            updatedAt: '2026-10-31T00:00:00Z',
        },
        version: {
            id: id(12),
            taskId: id(11),
            version: 1,
            configSchemaVersion: 1,
            config,
            comparisonScopeHash: 'a'.repeat(64),
            createdAt: '2026-10-31T00:00:00Z',
        },
        baselineResetRequired: false,
    };
}
const cleanups: (() => void)[] = [];
afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
});
function setup(fetcher: typeof fetch) {
    const lifecycle = createSessionLifecycle({ fetcher });
    lifecycle.replaceSession(account);
    const scope = effectScope();
    const controller = scope.run(() => createTaskController(lifecycle))!;
    Object.assign(controller.draft, validDraft());
    cleanups.push(() => {
        controller.dispose();
        scope.stop();
        lifecycle.dispose();
    });
    return { controller, lifecycle };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('手工任务配置', () => {
    it('拒绝新填写的超额阶段分配，保留未改的历史低预算', () => {
        expect(() => taskInput({ ...validDraft(), maxOutputTokens: '1' })).toThrow();
        const original = {
            ...taskInput(validDraft()).config,
            budget: { ...taskInput(validDraft()).config.budget, maxOutputTokens: 1 },
        };
        expect(
            taskInput({ ...validDraft(), maxOutputTokens: '1' }, original).config.budget
                .maxOutputTokens,
        ).toBe(1);
    });
    it('本地预算分配超额时不发送创建请求', async () => {
        const fetcher = vi.fn<typeof fetch>();
        const { controller } = setup(fetcher);
        controller.draft.maxOutputTokens = '1';
        await controller.submit();
        expect(fetcher).not.toHaveBeenCalled();
        expect(controller.fields.value.maxOutputTokens).toContain('输出总额不足');
    });
    it('新任务使用可完成综合的累计预算，显式配置保留原值', () => {
        expect(initialTaskDraft()).toMatchObject({
            maxDurationSeconds: '600',
            maxInputTokens: '1000000',
            maxOutputTokens: '128000',
        });
        const input = taskInput({
            ...validDraft(),
            maxDurationSeconds: '300',
            maxInputTokens: '40000',
            maxOutputTokens: '8000',
        });
        expect(input.config.budget).toMatchObject({
            maxDurationSeconds: 300,
            maxInputTokens: 40000,
            maxOutputTokens: 8000,
        });
    });
    it('完整公开config可编辑，明确manual且不夹带inputText或owner', () => {
        const draft = {
            ...validDraft(),
            focusPoints: ['费用', '资格'],
            exclusions: ['广告'],
            preferredUrls: ['https://example.test/a', 'https://example.org/b'],
            excludedUrls: ['http://example.test/no'],
            officialOnly: true,
            outputFormat: 'comparison',
            maxSearches: '3',
            maxPages: '4',
            maxDurationSeconds: '60',
            maxInputTokens: '1000',
            maxOutputTokens: '500',
        };
        const input = taskInput(draft);
        expect(Object.keys(input)).toEqual(['config']);
        expect(input.config).toMatchObject({
            focusPoints: ['费用', '资格'],
            exclusions: ['广告'],
            sourcePreferences: {
                preferredUrls: ['https://example.test/a', 'https://example.org/b'],
                officialOnly: true,
            },
            timezone: 'Asia/Shanghai',
            schedule: { frequency: 'manual' },
            outputFormat: 'comparison',
            notificationPreference: { mode: 'important_change', runIssues: false },
            budget: {
                maxSearches: 3,
                maxPages: 4,
                maxDurationSeconds: 60,
                maxInputTokens: 1000,
                maxOutputTokens: 500,
            },
        });
    });
    it.each([
        { goal: '   ' },
        { title: '字'.repeat(201) },
        { preferredUrls: ['ftp://example.test'] },
        { preferredUrls: ['https://user:pass@example.test'] },
        { excludedUrls: ['bad'] },
        { preferredUrls: ['https://example.test', 'https://example.test'] },
        { maxSearches: '0' },
        { maxPages: '-1' },
        { maxDurationSeconds: '1.5' },
        { maxInputTokens: '' },
        { maxOutputTokens: '9007199254740992' },
        { timezone: 'Not/A_Zone' },
        { days: '0' },
    ])('共享schema拒绝非法输入 %j', (patch) =>
        expect(() => taskInput({ ...validDraft(), ...patch })).toThrow(),
    );
    it('固定日期校验顺序与真实当地日期，输出为UTC', () => {
        const draft = {
            ...validDraft(),
            rangeKind: 'fixed',
            start: '2026-10-30T08:00',
            end: '2026-10-31T09:00',
        };
        const range = taskInput(draft).config.timeRange;
        expect(range.kind).toBe('fixed');
        if (range.kind === 'fixed') expect(range.start).toBe(new Date(draft.start).toISOString());
        expect(() => taskInput({ ...draft, end: '2026-10-29T08:00' })).toThrow();
        expect(() => taskInput({ ...draft, start: '2026-02-30T08:00' })).toThrow();
        expect(() => taskInput({ ...draft, end: '' })).toThrow();
    });
    it('字段错误回到可编辑字段，不把无效输入发送到网络', async () => {
        const fetcher = vi.fn<typeof fetch>();
        const { controller } = setup(fetcher);
        controller.draft.goal = '';
        await controller.submit();
        expect(controller.fields.value.goal).toBeTruthy();
        expect(fetcher).not.toHaveBeenCalled();
        expect(taskField('/body/config/sourcePreferences/preferredUrls/0')).toBe('preferredUrls');
        expect(taskField('/config/budget/maxSearches')).toBe('maxSearches');
    });
    it('保存只POST任务，CSRF/幂等头正确，双击只派发一次并定向失效列表', async () => {
        let release!: (response: Response) => void;
        const requests: { url: string; init?: RequestInit }[] = [];
        const { controller, lifecycle } = setup(
            async (url, init) =>
                new Promise((resolve) => {
                    requests.push({
                        url:
                            typeof url === 'string' ? url : url instanceof URL ? url.href : url.url,
                        init,
                    });
                    release = resolve;
                }),
        );
        const key = lifecycle.capture().queryKey(taskKeys.list('all'));
        lifecycle.queryClient.setQueryData(key, { old: true });
        const pending = controller.submit();
        await tick();
        expect(controller.pending.value).toBe(true);
        expect(await controller.submit()).toBeUndefined();
        expect(requests).toHaveLength(1);
        expect(controller.canLeave(() => true)).toBe(false);
        const headers = new Headers(requests[0]!.init!.headers);
        expect(headers.get('x-csrf-token')).toBe('test-csrf');
        expect(headers.get('idempotency-key')).toMatch(/^[\da-f-]{36}$/);
        expect(requests[0]!.url).toBe('/api/v1/tasks');
        expect(requests[0]!.init!.method).toBe('POST');
        release(Response.json(detail(), { status: 201 }));
        expect(await pending).toMatchObject({ task: { id: id(11) } });
        expect(controller.dirty.value).toBe(false);
        expect(lifecycle.queryClient.getQueryState(key)?.isInvalidated).toBe(true);
        expect(controller.canLeave(() => false)).toBe(true);
        expect(await controller.submit()).toBeUndefined();
        expect(requests).toHaveLength(1);
    });
    it('明确失败保留内容，同一动作重试复用key，修改后创建新动作key', async () => {
        const keys: (string | null)[] = [];
        const { controller } = setup(async (_url, init) => {
            keys.push(new Headers(init!.headers).get('idempotency-key'));
            return Response.json(
                {
                    code: 'LIMIT',
                    message: '上限',
                    requestId: 'test',
                    fieldErrors: [{ path: '/config/budget/maxSearches', message: '部署上限为10' }],
                },
                { status: 422 },
            );
        });
        await controller.submit();
        expect(controller.draft.goal).toBe('保留可核验来源');
        expect(controller.fields.value.maxSearches).toBe('部署上限为10');
        await controller.submit();
        expect(keys[1]).toBe(keys[0]);
        controller.draft.maxSearches = '2';
        await controller.submit();
        expect(keys[2]).not.toBe(keys[0]);
    });
    it.each(['network', 'server', 'request-timeout', 'invalid-response'])(
        '不确定保存%s不直接重发，保留内容并引导核对列表',
        async (kind) => {
            const fetcher = vi.fn<typeof fetch>(async () => {
                if (kind === 'network') throw new TypeError('offline');
                if (kind === 'request-timeout')
                    return Response.json(
                        { code: 'TIMEOUT', message: 'test', requestId: 'test' },
                        { status: 408 },
                    );
                return kind === 'server'
                    ? Response.json(
                          { code: 'FAIL', message: 'test', requestId: 'test' },
                          { status: 503 },
                      )
                    : Response.json({ wrong: true }, { status: 201 });
            });
            const { controller } = setup(fetcher);
            await controller.submit();
            expect(controller.uncertain.value).toBe(true);
            expect(controller.draft.title).toBe('政策变化');
            expect(controller.message.value).toContain('核对');
            await controller.submit();
            expect(fetcher).toHaveBeenCalledTimes(1);
        },
    );
    it('离开确认可取消并保持草稿，接受后才允许路由离开', () => {
        const { controller } = setup(async () => Response.json(detail()));
        expect(controller.dirty.value).toBe(true);
        expect(controller.canLeave(() => false)).toBe(false);
        expect(controller.draft.topic).toBe('招生政策');
        expect(controller.canLeave(() => true)).toBe(true);
    });
    it('固定范围结束早于开始时，只将错误关联结束字段', async () => {
        const { controller } = setup(async () => Response.json(detail()));
        Object.assign(controller.draft, {
            rangeKind: 'fixed',
            start: '2026-10-31T08:00',
            end: '2026-10-30T08:00',
        });
        await controller.submit();
        expect(controller.fields.value.end).toContain('结束');
        expect(controller.fields.value.start).toBeUndefined();
        expect(controller.fields.value.days).toBeUndefined();
    });
    it.each([201, 401])('换号取消在途保存，A迟到%s不能跳转或污染B，A内容被清理', async (status) => {
        let release!: (response: Response) => void;
        let signal!: AbortSignal;
        const { controller, lifecycle } = setup(
            async (_url, init) =>
                new Promise((resolve) => {
                    signal = init!.signal!;
                    release = resolve;
                }),
        );
        const pending = controller.submit();
        await tick();
        lifecycle.replaceSession({
            ...account,
            user: { ...account.user, id: id(2), email: 'b@example.test' },
        });
        release(
            status === 201
                ? Response.json(detail(), { status })
                : Response.json(
                      { code: 'UNAUTHORIZED', message: 'test', requestId: 'test' },
                      { status },
                  ),
        );
        expect(await pending).toBeUndefined();
        expect(signal.aborted).toBe(true);
        expect(controller.expired.value).toBe(true);
        expect(controller.draft.title).toBe('');
        expect(controller.message.value).toBe('');
        expect(lifecycle.session.user?.id).toBe(id(2));
        expect(lifecycle.queryClient.getQueryCache().getAll()).toHaveLength(0);
    });
    it('卸载中止请求，迟到成功不能变成已保存', async () => {
        let signal!: AbortSignal;
        const { controller } = setup(async (_url, init) => {
            signal = init!.signal!;
            return new Promise(() => {});
        });
        const pending = controller.submit();
        await tick();
        controller.dispose();
        expect(await pending).toBeUndefined();
        expect(signal.aborted).toBe(true);
        expect(controller.saved.value).toBe(false);
    });
});
