import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { effectScope } from 'vue';
import type { SessionResponse, TaskDetailResponse, Schedule } from '@scova/models';
import type { ApiResponse } from '@/api/client';
import { createSessionLifecycle, type SessionLifecycle } from '@/api/session';
import {
    createTaskController,
    editTaskController,
    initialTaskDraft,
    taskDraftFromConfig,
    taskInput,
    taskField,
} from '@/composables/useCreateTask';
import {
    dstExamples,
    formatScheduleInstant,
    scheduleDescription,
    scheduleInput,
    weekdayOptions,
} from '@/utils/schedule';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const instant = '2026-10-31T00:00:00Z';
const account: SessionResponse = {
    user: {
        id: id(1),
        email: 'schedule@example.test',
        createdAt: instant,
        preferences: {
            defaultTimezone: 'UTC',
            notificationPreference: { mode: 'summary', runIssues: true },
        },
    },
    csrfToken: 'schedule-csrf',
};
function detail(
    schedule: Schedule = { frequency: 'weekly', localTime: '09:15', weekday: 3 },
    revision = 1,
    timezone = 'Asia/Shanghai',
): TaskDetailResponse {
    const config = taskInput({
        ...initialTaskDraft(),
        title: '任务标题',
        topic: '政策',
        goal: '核验',
    }).config;
    Object.assign(config, {
        schedule,
        timezone,
        focusPoints: ['一项内的\n换行', '  保留空白  '],
        exclusions: ['排除\n一项'],
        timeRange: {
            kind: 'fixed',
            start: '2026-10-01T03:04:05.123456Z',
            end: '2026-10-31T04:05:06.456789Z',
        },
    });
    return {
        task: {
            id: id(10),
            title: config.title,
            status: 'active',
            revision,
            currentVersionId: id(20 + revision),
            nextRunAt: schedule.frequency === 'manual' ? null : '2026-11-04T01:15:00Z',
            createdAt: instant,
            updatedAt: instant,
        },
        version: {
            id: id(20 + revision),
            taskId: id(10),
            version: revision,
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
    headers: { etag: `"${data.task.revision}"` },
    url: `/api/v1/tasks/${id(10)}`,
});
const http = (data = detail()) =>
    Response.json(data, { headers: { etag: `"${data.task.revision}"` } });
const failure = (status: number) =>
    Response.json(
        { code: 'REVISION_CONFLICT', message: 'local sample', requestId: 'local' },
        { status },
    );
const cleanups: (() => void)[] = [];
function setup(
    fetcher: typeof fetch,
    initial: ApiResponse<TaskDetailResponse>,
): { task: ReturnType<typeof editTaskController>; lifecycle: SessionLifecycle };
function setup(fetcher: typeof fetch): {
    task: ReturnType<typeof createTaskController>;
    lifecycle: SessionLifecycle;
};
function setup(
    fetcher: typeof fetch,
    initial?: ApiResponse<TaskDetailResponse>,
): {
    task: ReturnType<typeof createTaskController> | ReturnType<typeof editTaskController>;
    lifecycle: SessionLifecycle;
} {
    const lifecycle = createSessionLifecycle({ fetcher });
    lifecycle.replaceSession(account);
    const scope = effectScope();
    const task = scope.run(() =>
        initial ? editTaskController(lifecycle, initial) : createTaskController(lifecycle),
    )!;
    cleanups.push(() => {
        task.dispose();
        scope.stop();
        lifecycle.dispose();
    });
    return { task, lifecycle };
}
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

describe('计划字段与完整配置', () => {
    it('新建默认manual，不静默选择当地时间/星期，隐藏字段不会进入manual body', () => {
        const draft = initialTaskDraft();
        expect(draft.scheduleFrequency).toBe('manual');
        expect(draft.scheduleLocalTime).toBe('');
        expect(draft.scheduleWeekday).toBe('');
        draft.scheduleLocalTime = '09:15';
        draft.scheduleWeekday = '7';
        expect(scheduleInput(draft)).toEqual({ frequency: 'manual' });
    });
    it.each([1, 2, 3, 4, 5, 6, 7])('星期%s按ISO weekday直接输出，无Date.getDay偏移', (weekday) => {
        const draft = {
            ...initialTaskDraft(),
            scheduleFrequency: 'weekly',
            scheduleLocalTime: '09:15',
            scheduleWeekday: String(weekday),
        };
        expect(scheduleInput(draft)).toEqual({ frequency: 'weekly', localTime: '09:15', weekday });
        expect(weekdayOptions[weekday]?.value).toBe(String(weekday));
    });
    it.each(['', '0', '8', '1.5', 'NaN'])('非法星期%s不得保存', (weekday) => {
        expect(() =>
            scheduleInput({
                ...initialTaskDraft(),
                scheduleFrequency: 'weekly',
                scheduleLocalTime: '09:15',
                scheduleWeekday: weekday,
            }),
        ).toThrow();
    });
    it.each(['', '24:00', '09:60', '9:15', '09:15:30'])(
        '非法当地时间%s不得静默修正',
        (localTime) => {
            expect(() =>
                scheduleInput({
                    ...initialTaskDraft(),
                    scheduleFrequency: 'daily',
                    scheduleLocalTime: localTime,
                }),
            ).toThrow();
        },
    );
    it('未知频率与非法IANA时区被共享契约拒绝，字段错误映射到实际控件', () => {
        const draft = {
            ...initialTaskDraft(),
            title: '标题',
            topic: '主题',
            goal: '目标',
            scheduleFrequency: 'daily',
            scheduleLocalTime: '09:15',
            timezone: 'Mars/Olympus',
        };
        expect(() => taskInput(draft)).toThrow();
        expect(() => scheduleInput({ ...draft, scheduleFrequency: 'hourly' })).toThrow();
        expect(taskField('/config/schedule/localTime')).toBe('scheduleLocalTime');
        expect(taskField('/body/config/schedule/weekday')).toBe('scheduleWeekday');
        expect(taskField('/config/schedule/frequency')).toBe('scheduleFrequency');
    });
    it.each(['manual', 'daily', 'weekly'] as const)(
        '%s配置往返保持原未改字段、数组边界与时间微秒',
        (frequency) => {
            const schedule: Schedule =
                frequency === 'manual'
                    ? { frequency }
                    : frequency === 'daily'
                      ? { frequency, localTime: '23:59' }
                      : { frequency, localTime: '00:00', weekday: 7 };
            const original = detail(schedule).version.config;
            const draft = taskDraftFromConfig(original);
            expect(taskInput(draft, original).config).toEqual(original);
            draft.title = '仅改标题';
            expect(taskInput(draft, original).config).toEqual({ ...original, title: '仅改标题' });
        },
    );
    it('编辑计划只改变明确schedule/timezone，其余完整config保持原样；保存携quotedIfMatch', async () => {
        const initial = detail();
        let body: unknown;
        let headers = new Headers();
        const paths: string[] = [];
        const { task } = setup(async (url, init) => {
            paths.push(url instanceof Request ? url.url : url.toString());
            body = JSON.parse(init?.body as string);
            headers = new Headers(init?.headers);
            const updated = detail(
                { frequency: 'daily', localTime: '02:30' },
                2,
                'America/New_York',
            );
            return http(updated);
        }, api(initial));
        task.draft.scheduleFrequency = 'daily';
        task.draft.scheduleLocalTime = '02:30';
        task.draft.timezone = 'America/New_York';
        await task.submit();
        expect(body).toEqual({
            config: {
                ...initial.version.config,
                schedule: { frequency: 'daily', localTime: '02:30' },
                timezone: 'America/New_York',
            },
        });
        expect(headers.get('if-match')).toBe('"1"');
        expect(headers.get('x-csrf-token')).toBe('schedule-csrf');
        expect(paths).toEqual([`/api/v1/tasks/${id(10)}`]);
    });
    it('新建weekly显式保存完整body，修改字段和预览本身零请求，保存不请求Run', async () => {
        const calls: { path: string; body: unknown }[] = [];
        const { task } = setup(async (url, init) => {
            calls.push({
                path: url instanceof Request ? url.url : url.toString(),
                body: JSON.parse(init?.body as string),
            });
            return http(detail({ frequency: 'weekly', weekday: 7, localTime: '08:00' }));
        });
        Object.assign(task.draft, {
            title: '周日任务',
            topic: '政策',
            goal: '核验',
            scheduleFrequency: 'weekly',
            scheduleWeekday: '7',
            scheduleLocalTime: '08:00',
            timezone: 'Asia/Tokyo',
        });
        expect(scheduleDescription(scheduleInput(task.draft), task.draft.timezone)).toContain(
            '周日',
        );
        expect(calls).toHaveLength(0);
        const expected = taskInput(task.draft);
        await task.submit();
        expect(calls).toEqual([{ path: '/api/v1/tasks', body: expected }]);
    });
    it('失败校验关联当地时间与星期，原内容保留且无网络写入', async () => {
        const fetcher = vi.fn<typeof fetch>(async () => http());
        const { task } = setup(fetcher);
        Object.assign(task.draft, {
            title: '标题',
            topic: '主题',
            goal: '目标',
            scheduleFrequency: 'weekly',
        });
        await task.submit();
        expect(task.fields.value.scheduleLocalTime).toBeTruthy();
        expect(task.fields.value.scheduleWeekday).toBeTruthy();
        expect(task.draft.scheduleFrequency).toBe('weekly');
        expect(fetcher).not.toHaveBeenCalled();
    });
    it('编辑daily→manual会移除localTime/weekday，不带隐藏字段', () => {
        const original = detail({ frequency: 'daily', localTime: '09:15' }).version.config;
        const draft = taskDraftFromConfig(original);
        draft.scheduleFrequency = 'manual';
        draft.scheduleWeekday = '7';
        expect(taskInput(draft, original).config.schedule).toEqual({ frequency: 'manual' });
    });
});

describe('当地/UTC展示与服务端事实', () => {
    it('同一时刻按明确任务时区格式化，不依赖浏览器时区，UTC独立展示', () => {
        const shanghai = formatScheduleInstant('2026-11-04T01:15:00Z', 'Asia/Shanghai');
        const tokyo = formatScheduleInstant('2026-11-04T01:15:00Z', 'Asia/Tokyo');
        expect(shanghai.local).toContain('2026-11-04 09:15:00');
        expect(shanghai.local).toContain('Asia/Shanghai');
        expect(tokyo.local).toContain('2026-11-04 10:15:00');
        expect(shanghai.utc).toBe('2026-11-04T01:15:00.000Z');
        expect(tokyo.utc).toBe(shanghai.utc);
    });
    it('纽约跳时固定例为首个有效03:00，并非02:30加一小时至03:30', () => {
        const example = dstExamples[0];
        const value = formatScheduleInstant(example.instant, 'America/New_York');
        expect(example.requested).toBe('2026-03-08 02:30');
        expect(value.local).toContain('2026-03-08 03:00:00');
        expect(value.utc).toBe('2026-03-08T07:00:00.000Z');
    });
    it('纽约回拨固定例选择首次01:30，UTC时刻与重复第二次不同', () => {
        const first = formatScheduleInstant(dstExamples[1].instant, 'America/New_York');
        const repeated = formatScheduleInstant('2026-11-01T06:30:00Z', 'America/New_York');
        expect(first.local).toContain('2026-11-01 01:30:00');
        expect(first.local).toContain('GMT-4');
        expect(repeated.local).toContain('GMT-5');
        expect(first.utc).toBe('2026-11-01T05:30:00.000Z');
        expect(dstExamples[1].note).toContain('不再执行');
    });
    it('已保存nextRunAt与保存时区绑定，未保存修改不改变服务端预览', async () => {
        const { task } = setup(async () => http(), api());
        if (!('serverPlan' in task)) throw new Error('需要编辑控制器');
        expect(task.serverPlan.value?.timezone).toBe('Asia/Shanghai');
        task.draft.timezone = 'America/New_York';
        task.draft.scheduleLocalTime = '02:30';
        expect(task.serverPlan.value?.timezone).toBe('Asia/Shanghai');
        expect(task.serverPlan.value?.nextRunAt).toBe('2026-11-04T01:15:00Z');
        expect(task.serverPlan.value?.schedule).toEqual({
            frequency: 'weekly',
            localTime: '09:15',
            weekday: 3,
        });
    });
    it('明确重新读取服务端后nextRunAt/timezone一起更新，原quoted修订依据同步', async () => {
        const next = detail({ frequency: 'daily', localTime: '02:30' }, 3, 'America/New_York');
        next.task.nextRunAt = '2026-11-02T07:30:00Z';
        const { task } = setup(async () => http(next), api());
        if (!('serverPlan' in task)) throw new Error('需要编辑控制器');
        task.reloadRequested.value = true;
        await task.reload();
        expect(task.serverPlan.value).toEqual({
            schedule: next.version.config.schedule,
            timezone: 'America/New_York',
            status: 'active',
            nextRunAt: '2026-11-02T07:30:00Z',
        });
        expect(task.draft.scheduleFrequency).toBe('daily');
        expect(task.dirty.value).toBe(false);
    });
    it('409保留当前计划草稿，停止直接重发且已保存计划不伪更新', async () => {
        const fetcher = vi.fn<typeof fetch>(async () => failure(409));
        const { task } = setup(fetcher, api());
        task.draft.scheduleLocalTime = '02:30';
        await task.submit();
        await task.submit();
        expect(task.draft.scheduleLocalTime).toBe('02:30');
        expect(fetcher).toHaveBeenCalledTimes(1);
        if (!('serverPlan' in task)) throw new Error('需要编辑控制器');
        expect(task.conflict.value).toBe(true);
        expect(task.serverPlan.value?.nextRunAt).toBe('2026-11-04T01:15:00Z');
    });
    it('非法instant/时区不能被格式化成伪事实', () => {
        expect(() => formatScheduleInstant('not-time', 'UTC')).toThrow();
        expect(() => formatScheduleInstant(instant, 'Mars/Olympus')).toThrow();
    });
    it('UTC午夜与四十五分钟偏移跨日显示正确，不把00显示成24或舍弃偏移', () => {
        const value = formatScheduleInstant('2026-10-31T18:15:00Z', 'Asia/Kathmandu');
        expect(value.local).toContain('2026-11-01 00:00:00');
        expect(value.local).toContain('GMT+5:45');
        expect(value.utc).toBe('2026-10-31T18:15:00.000Z');
    });
    it('重新读取ETag不一致时，草稿与已保存时区/时刻不部分更新', async () => {
        const next = detail({ frequency: 'daily', localTime: '02:30' }, 8, 'America/New_York');
        next.task.nextRunAt = '2026-11-02T07:30:00Z';
        const { task } = setup(
            async () => Response.json(next, { headers: { etag: '"99"' } }),
            api(),
        );
        task.draft.timezone = 'Asia/Tokyo';
        const before = structuredClone(JSON.parse(JSON.stringify(task.serverPlan.value)));
        task.reloadRequested.value = true;
        await task.reload();
        expect(task.message.value).toContain('重新读取失败');
        expect(task.draft.timezone).toBe('Asia/Tokyo');
        expect(task.serverPlan.value).toEqual(before);
        expect(task.revision.value).toBe(1);
    });
    it('计划保存结果不确定时保留旧服务端计划并阻止直接重发', async () => {
        const fetcher = vi.fn<typeof fetch>(async () => failure(503));
        const { task } = setup(fetcher, api());
        const before = JSON.parse(JSON.stringify(task.serverPlan.value));
        task.draft.scheduleLocalTime = '02:30';
        task.draft.timezone = 'America/New_York';
        await task.submit();
        expect(task.uncertain.value).toBe(true);
        expect(task.serverPlan.value).toEqual(before);
        expect(task.draft.scheduleLocalTime).toBe('02:30');
        await task.submit();
        expect(fetcher).toHaveBeenCalledTimes(1);
    });
    it('账号变化清空已保存计划，迟到PATCH不会把旧时区时刻带入新账号', async () => {
        let finish!: (response: Response) => void;
        let signal: AbortSignal | undefined;
        const { task, lifecycle } = setup(async (_url, init) => {
            signal = init?.signal ?? undefined;
            return new Promise((resolve) => {
                finish = resolve;
            });
        }, api());
        task.draft.timezone = 'America/New_York';
        const pending = task.submit();
        await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
        lifecycle.replaceSession({ ...account, user: { ...account.user, id: id(2) } });
        expect(task.serverPlan.value).toBeUndefined();
        finish(http(detail({ frequency: 'daily', localTime: '02:30' }, 2, 'America/New_York')));
        await pending;
        expect(signal?.aborted).toBe(true);
        expect(task.serverPlan.value).toBeUndefined();
        expect(task.result.value).toBeUndefined();
        expect(lifecycle.session.user?.id).toBe(id(2));
    });
});
