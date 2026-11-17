import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { effectScope } from 'vue';
import type { SessionResponse, TaskDetailResponse, TaskConfig } from '@scova/models';
import type { ApiResponse } from '@/api/client';
import { createSessionLifecycle } from '@/api/session';
import { taskKeys } from '@/api/tasks';
import {
    editTaskController,
    initialTaskDraft,
    taskDraftFromConfig,
    taskEditOptions,
    taskInput,
    validateTaskEditResponse,
} from '@/composables/useCreateTask';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const account: SessionResponse = {
    user: {
        id: id(1),
        email: 'edit@example.test',
        preferences: {
            defaultTimezone: 'UTC',
            notificationPreference: { mode: 'summary', runIssues: true },
        },
        createdAt: '2026-10-31T00:00:00Z',
    },
    csrfToken: 'edit-csrf',
};
function detail(revision = 1): TaskDetailResponse {
    const config = taskInput({
        ...initialTaskDraft(),
        title: '原标题',
        topic: '研究主题',
        goal: '核验目标',
    }).config;
    Object.assign(config, {
        focusPoints: ['一项内的\n换行', '  原样空格  '],
        exclusions: ['保留\n原条目'],
        timeRange: {
            kind: 'fixed',
            start: '2026-10-01T03:04:05.123456Z',
            end: '2026-10-31T04:05:06.456789Z',
        },
        schedule: { frequency: 'weekly', weekday: 3, localTime: '09:15' },
        timezone: 'Asia/Shanghai',
    });
    return {
        task: {
            id: id(10),
            title: config.title,
            status: 'active',
            revision,
            currentVersionId: id(20 + revision),
            nextRunAt: '2026-11-04T01:15:00Z',
            createdAt: '2026-10-31T00:00:00Z',
            updatedAt: '2026-10-31T00:00:00Z',
        },
        version: {
            id: id(20 + revision),
            taskId: id(10),
            version: revision,
            configSchemaVersion: 1,
            config,
            comparisonScopeHash: 'a'.repeat(64),
            createdAt: '2026-10-31T00:00:00Z',
        },
        baselineResetRequired: false,
    };
}
const api = (data = detail()): ApiResponse<TaskDetailResponse> => ({
    data,
    headers: { etag: `"${data.task.revision}"` },
    status: 200,
    url: `/api/v1/tasks/${id(10)}`,
});
const http = (data = detail()) =>
    Response.json(data, { headers: { etag: `"${data.task.revision}"` } });
const failure = (
    status: number,
    code = 'TEST_FAILURE',
    fieldErrors?: { path: string; message: string }[],
) =>
    Response.json(
        { code, message: 'sample', requestId: 'sample', ...(fieldErrors ? { fieldErrors } : {}) },
        { status },
    );
const cleanups: (() => void)[] = [];
it('round-trips saved search modes without changing legacy configs on unrelated edits', () => {
    const legacy = detail().version.config;
    expect(taskInput(taskDraftFromConfig(legacy), legacy).config.searchMode).toBeUndefined();
    for (const searchMode of ['auto', 'api', 'searxng'] as const) {
        const original = { ...legacy, searchMode };
        expect(taskInput(taskDraftFromConfig(original), original).config.searchMode).toBe(
            searchMode,
        );
    }
});
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));
function setup(fetcher: typeof fetch = async () => http(detail(2)), initial = api()) {
    const lifecycle = createSessionLifecycle({ fetcher });
    lifecycle.replaceSession(account);
    const scope = effectScope();
    const controller = scope.run(() => editTaskController(lifecycle, initial))!;
    cleanups.push(() => {
        controller.dispose();
        scope.stop();
        lifecycle.dispose();
    });
    return { lifecycle, controller };
}
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((complete) => {
        resolve = complete;
    });
    return { resolve, promise };
}

describe('完整任务编辑与草稿保护', () => {
    it.each(['daily', 'weekly'] as const)(
        'title-only preserves %s schedule and every untouched config field exactly',
        (frequency) => {
            const config = detail().version.config;
            config.schedule =
                frequency === 'daily'
                    ? { frequency, localTime: '23:59' }
                    : { frequency, weekday: 7, localTime: '00:01' };
            const draft = taskDraftFromConfig(config);
            draft.title = '新标题';
            expect(taskInput(draft, config).config).toEqual({ ...config, title: '新标题' });
            expect(taskInput(draft, config)).not.toHaveProperty('inputText');
            expect(taskInput(draft, config).config.timeRange).toEqual(config.timeRange);
        },
    );
    it('round-trips all form fields and only converts dates that were actually edited', () => {
        const config = detail().version.config;
        const draft = taskDraftFromConfig(config);
        draft.end = '2026-11-01T10:11:12.345';
        const next = taskInput(draft, config).config;
        expect(next.timeRange).toEqual({
            kind: 'fixed',
            start: config.timeRange.kind === 'fixed' ? config.timeRange.start : '',
            end: new Date(draft.end).toISOString(),
        });
        draft.start = '2026-02-30T01:00';
        expect(() => taskInput(draft, config)).toThrow();
    });
    it('sends the complete replacement and original quoted If-Match and CSRF, invalidates tasks, retains PATCH baseline result', async () => {
        let body: { config: TaskConfig } | undefined;
        let headers: Headers | undefined;
        const { lifecycle, controller } = setup(async (_url, init) => {
            body = JSON.parse(init?.body as string) as { config: TaskConfig };
            headers = new Headers(init?.headers);
            const next = detail(2);
            next.version.config = body.config;
            next.baselineResetRequired = true;
            return http(next);
        });
        const key = lifecycle.capture().queryKey(taskKeys.all);
        lifecycle.queryClient.setQueryData(key, 'cached');
        controller.draft.title = '新标题';
        expect(await controller.submit()).toMatchObject({ baselineResetRequired: true });
        expect(body?.config).toEqual({ ...detail().version.config, title: '新标题' });
        expect(headers?.get('if-match')).toBe('"1"');
        expect(headers?.get('x-csrf-token')).toBe(account.csrfToken);
        expect(lifecycle.queryClient.getQueryState(key)?.isInvalidated).toBe(true);
        expect(controller.result.value?.baselineResetRequired).toBe(true);
        expect(controller.saved.value).toBe(true);
        expect(controller.dirty.value).toBe(false);
    });
    it.each([409, 412])(
        'HTTP %i keeps copyable draft and prevents automatic or repeated save',
        async (status) => {
            const fetcher = vi.fn<typeof fetch>(async () => failure(status, 'REVISION_CONFLICT'));
            const { controller } = setup(fetcher);
            controller.draft.goal = '保留我的目标';
            await controller.submit();
            expect(controller.conflict.value).toBe(true);
            expect(controller.draft.goal).toBe('保留我的目标');
            expect(controller.dirty.value).toBe(true);
            expect(controller.message.value).toContain('可复制');
            await controller.submit();
            expect(fetcher).toHaveBeenCalledTimes(1);
        },
    );
    it('cancelled reread performs no GET; failed reread preserves draft and ETag; confirmed successful reread installs config+ETag atomically', async () => {
        const next = detail(3);
        next.version.config.title = '服务器新标题';
        let readFails = true;
        const patchEtags: string[] = [];
        const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
            if (init?.method === 'PATCH') {
                patchEtags.push(new Headers(init.headers).get('if-match')!);
                return failure(409, 'REVISION_CONFLICT');
            }
            return readFails ? failure(503) : http(next);
        });
        const { controller } = setup(fetcher);
        controller.draft.title = '本地草稿';
        controller.reloadRequested.value = true;
        controller.reloadRequested.value = false;
        await controller.reload();
        expect(fetcher).not.toHaveBeenCalled();
        controller.reloadRequested.value = true;
        await controller.reload();
        expect(controller.draft.title).toBe('本地草稿');
        expect(controller.message.value).toContain('原草稿和修订依据仍保留');
        controller.reloadRequested.value = false;
        await controller.submit();
        expect(patchEtags).toEqual(['"1"']);
        readFails = false;
        controller.reloadRequested.value = true;
        await controller.reload();
        expect(controller.draft.title).toBe('服务器新标题');
        expect(controller.conflict.value).toBe(false);
        expect(controller.dirty.value).toBe(false);
        controller.draft.title = '合并后标题';
        await controller.submit();
        expect(patchEtags).toEqual(['"1"', '"3"']);
    });
    it('treats archived conflicts differently from revision conflicts', async () => {
        const { controller } = setup(async () => failure(409, 'TASK_ARCHIVED'));
        controller.draft.title = '草稿';
        await controller.submit();
        expect(controller.blocked.value).toBe(true);
        expect(controller.conflict.value).toBe(false);
        expect(controller.message.value).toContain('已归档');
        expect(controller.draft.title).toBe('草稿');
    });
    it.each([403, 404])('retains draft but blocks unauthorized HTTP %i saves', async (status) => {
        const { controller } = setup(async () => failure(status));
        controller.draft.title = '草稿';
        await controller.submit();
        expect(controller.draft.title).toBe('草稿');
        expect(controller.blocked.value).toBe(true);
        expect(controller.uncertain.value).toBe(false);
    });
    it('maps shared field validation and explicit 422/429 without marking a definite failure uncertain', async () => {
        const fetcher = vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(
                failure(422, 'VALIDATION_ERROR', [
                    { path: '/config/budget/maxPages', message: '超过上限' },
                ]),
            )
            .mockResolvedValueOnce(failure(429));
        const { controller } = setup(fetcher);
        controller.draft.title = '';
        await controller.submit();
        expect(fetcher).not.toHaveBeenCalled();
        expect(controller.fields.value.title).toBeTruthy();
        controller.draft.title = '草稿';
        await controller.submit();
        expect(controller.fields.value.maxPages).toBe('超过上限');
        expect(controller.uncertain.value).toBe(false);
        await controller.submit();
        expect(controller.message.value).toContain('频繁');
    });
    it.each([408, 503, 'network', 'invalid-json', 'invalid-etag'] as const)(
        'blocks retry after uncertain %s write until explicit reread',
        async (kind) => {
            const fetcher = vi.fn<typeof fetch>(async () => {
                if (kind === 'network') throw new TypeError('Failed to fetch');
                if (kind === 'invalid-json') return Response.json({ wrong: true });
                if (kind === 'invalid-etag') return Response.json(detail(2));
                return failure(kind);
            });
            const { controller } = setup(fetcher);
            controller.draft.title = '未确认草稿';
            await controller.submit();
            expect(controller.uncertain.value).toBe(true);
            expect(controller.draft.title).toBe('未确认草稿');
            await controller.submit();
            expect(fetcher).toHaveBeenCalledTimes(1);
            expect(controller.canLeave(() => false)).toBe(false);
        },
    );
    it('locks duplicate saves and pending route leave, allows cancelled dirty leave, unmount aborts', async () => {
        const response = deferred<Response>();
        let signal: AbortSignal | undefined;
        const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
            signal = init?.signal ?? undefined;
            return response.promise;
        });
        const { controller } = setup(fetcher);
        controller.draft.title = '草稿';
        expect(controller.canLeave(() => false)).toBe(false);
        expect(controller.canLeave(() => true)).toBe(true);
        const request = controller.submit();
        await vi.waitFor(() => expect(signal).toBeDefined());
        await controller.submit();
        expect(controller.canLeave(() => true)).toBe(false);
        controller.dispose();
        response.resolve(http(detail(2)));
        expect(await request).toBeUndefined();
        expect(signal?.aborted).toBe(true);
        expect(fetcher).toHaveBeenCalledTimes(1);
    });
    it.each([200, 401, 403])(
        'clears draft on account switch and ignores late old HTTP %i',
        async (status) => {
            const response = deferred<Response>();
            let dispatched = false;
            const { lifecycle, controller } = setup(async () => {
                dispatched = true;
                return response.promise;
            });
            controller.draft.title = '旧账号草稿';
            const request = controller.submit();
            await vi.waitFor(() => expect(dispatched).toBe(true));
            lifecycle.replaceSession({ ...account, user: { ...account.user, id: id(2) } });
            expect(controller.canLeave(() => false)).toBe(true);
            response.resolve(status === 200 ? http(detail(2)) : failure(status));
            await request;
            expect(controller.draft.title).toBe('');
            expect(controller.result.value).toBeUndefined();
            expect(controller.message.value).toBe('');
            expect(controller.expired.value).toBe(true);
            expect(lifecycle.session.user?.id).toBe(id(2));
        },
    );
    it('rejects unknown config fields, missing/malformed ETag and mismatched resource/version before editing', () => {
        const unknown = api();
        Object.assign(unknown.data.version.config, { unrecognized: 'keep safe' });
        expect(() => validateTaskEditResponse(unknown, id(10))).toThrow();
        for (const etag of ['', '1', 'W/"1"', '"9"'])
            expect(() =>
                validateTaskEditResponse({ ...api(), headers: { etag } }, id(10)),
            ).toThrow();
        expect(() => validateTaskEditResponse(api(), id(99))).toThrow();
        const mismatch = api();
        mismatch.data.version.taskId = id(99);
        expect(() => validateTaskEditResponse(mismatch, id(10))).toThrow();
    });
    it('current-account 401 clears its draft and lets the global login redirect leave', async () => {
        const { lifecycle, controller } = setup(async () => failure(401, 'SESSION_REQUIRED'));
        controller.draft.title = '会话失效前的草稿';
        expect(await controller.submit()).toBeUndefined();
        expect(lifecycle.session.user).toBeNull();
        expect(controller.expired.value).toBe(true);
        expect(controller.draft.title).toBe('');
        expect(controller.result.value).toBeUndefined();
        expect(controller.message.value).toBe('');
        expect(controller.canLeave(() => false)).toBe(true);
    });
    it.each([200, 401])(
        'aborts a confirmed reread on account change and ignores its late HTTP %i',
        async (status) => {
            const response = deferred<Response>();
            let signal: AbortSignal | undefined;
            const { lifecycle, controller } = setup(async (_url, init) => {
                signal = init?.signal ?? undefined;
                return response.promise;
            });
            controller.draft.title = '旧账号待合并草稿';
            controller.reloadRequested.value = true;
            const pending = controller.reload();
            await vi.waitFor(() => expect(signal).toBeDefined());
            lifecycle.replaceSession({ ...account, user: { ...account.user, id: id(2) } });
            response.resolve(status === 200 ? http(detail(9)) : failure(status));
            await pending;
            expect(signal?.aborted).toBe(true);
            expect(controller.draft.title).toBe('');
            expect(controller.message.value).toBe('');
            expect(controller.result.value).toBeUndefined();
            expect(controller.expired.value).toBe(true);
            expect(lifecycle.session.user?.id).toBe(id(2));
            expect(lifecycle.queryClient.getQueryCache().getAll()).toHaveLength(0);
        },
    );
    it('uses session Query for reads with ETag validation and no silent background draft hydration', async () => {
        const { lifecycle, controller } = setup(async () => http(detail(5)));
        controller.draft.goal = '保留编辑';
        const read = await lifecycle.queryClient.fetchQuery(taskEditOptions(lifecycle, id(10)));
        expect(read.headers.etag).toBe('"5"');
        expect(controller.draft.goal).toBe('保留编辑');
        expect(controller.revision.value).toBe(1);
    });
});
