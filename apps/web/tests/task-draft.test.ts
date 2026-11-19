import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { effectScope } from 'vue';
import type {
    SessionResponse,
    TaskConfig,
    TaskDraftResponse,
    TaskDraftScope,
    TaskDraftQuestionsResponse,
} from '@scova/models';
import { createSessionLifecycle } from '@/api/session';
import { validateDraftInput } from '@/api/task-drafts';
import {
    createTaskController,
    initialTaskDraft,
    taskDraftFromConfig,
    taskInput,
} from '@/composable/useCreateTask';
import { useNaturalLanguageDraft } from '@/composable/useNaturalLanguageDraft';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const instant = '2026-10-31T00:00:00Z';
const originalText = '  每周三09:15核验政策来源\n保留原文空格。  ';
const account: SessionResponse = {
    user: {
        id: id(1),
        email: 'draft@example.test',
        createdAt: instant,
        preferences: {
            defaultTimezone: 'UTC',
            notificationPreference: { mode: 'summary', runIssues: true },
        },
    },
    csrfToken: 'draft-csrf',
};
function config(): TaskConfig {
    return {
        ...taskInput({
            ...initialTaskDraft(),
            title: '解析标题',
            topic: '政策来源',
            goal: '核验变化',
        }).config,
        focusPoints: ['一项内的\n换行', '  保留空格  '],
        exclusions: ['排除\n一项'],
        timeRange: {
            kind: 'fixed',
            start: '2026-10-01T03:04:05.123456Z',
            end: '2026-10-31T04:05:06.456789Z',
        },
        timezone: 'Asia/Shanghai',
        schedule: { frequency: 'weekly', weekday: 3, localTime: '09:15' },
    };
}
function response(mode: 'model' | 'manual' = 'model', inputText = originalText): TaskDraftResponse {
    return {
        inputText,
        config: config(),
        mode,
        requiresConfirmation: true,
        manualReason: mode === 'manual' ? 'model_unavailable' : null,
        warnings: [{ path: '/config/schedule', message: '周期计划待确认，尚未启用。' }],
        parsingUsage: {
            attempts: mode === 'model' ? 1 : 0,
            inputTokens: mode === 'model' ? 80 : 0,
            outputTokens: mode === 'model' ? 40 : 0,
            estimated: false,
        },
    };
}
const addressOf = (url: Parameters<typeof fetch>[0]) =>
    url instanceof Request ? url.url : url.toString();
const failure = (status: number) =>
    Response.json({ code: 'LOCAL_FAILURE', message: 'local', requestId: 'local' }, { status });
const cleanups: (() => void)[] = [];
function setup(fetcher: typeof fetch, timeout?: number) {
    const lifecycle = createSessionLifecycle({ fetcher });
    lifecycle.replaceSession(account);
    const scope = effectScope();
    const value = scope.run(() => {
        const task = createTaskController(lifecycle);
        const natural = useNaturalLanguageDraft(task, lifecycle, { timeout });
        return { task, natural };
    })!;
    value.task.inputText.value = originalText;
    cleanups.push(() => {
        scope.stop();
        value.task.dispose();
        lifecycle.dispose();
    });
    return { ...value, lifecycle, scope };
}
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

describe('自然语言草稿与显式应用', () => {
    it('调用AI生成问题，回答后继续澄清，确认范围及对话完整发送到草稿接口', async () => {
        const calls: { path: string; body: Record<string, unknown> }[] = [];
        const { goal, focusPoints, exclusions, sourcePreferences, timeRange, outputFormat } =
            config();
        const proposed = {
            goal,
            focusPoints,
            exclusions,
            sourcePreferences,
            timeRange,
            outputFormat,
            researchMode: 'analysis' as const,
        };
        const { task, natural } = setup(async (url, init) => {
            const path = addressOf(url);
            const body = JSON.parse(init?.body as string);
            calls.push({ path, body });
            if (path.endsWith('/questions'))
                return Response.json({
                    inputText: body.inputText,
                    round: body.round,
                    summary: '需要确认范围',
                    scope: proposed,
                    questions:
                        body.round === 0
                            ? [
                                  {
                                      id: 'q1',
                                      question: '查哪个城市？',
                                      reason: '影响搜索范围',
                                      options: ['上海', '杭州'],
                                  },
                              ]
                            : [],
                    mode: 'model',
                    manualReason: null,
                    parsingUsage: {
                        attempts: 1,
                        inputTokens: 100,
                        outputTokens: 50,
                        estimated: false,
                    },
                } satisfies TaskDraftQuestionsResponse);
            return Response.json({ ...response(), config: { ...config(), ...proposed } });
        });
        await natural.clarify();
        expect(natural.clarificationResult.value?.questions[0]?.question).toBe('查哪个城市？');
        expect(natural.canApply.value).toBe(false);
        expect(task.draft.title).toBe('');
        await natural.clarify({ q1: '' });
        expect(calls).toHaveLength(1);
        await natural.clarify({ q1: '上海，仅线下' });
        const transcript = [{ question: '查哪个城市？', answer: '上海，仅线下' }];
        expect(calls[1]?.body.clarifications).toEqual(transcript);
        expect(calls[1]?.body.round).toBe(1);
        expect(natural.clarificationResult.value?.questions).toEqual([]);
        expect(natural.clarificationUsage.value).toEqual({
            attempts: 2,
            inputTokens: 200,
            outputTokens: 100,
            estimated: false,
        });
        natural.searchScope.value = proposed;
        await natural.parse();
        expect(calls[2]?.body.clarifications).toEqual(transcript);
        expect(natural.apply()).toBe(true);
        expect(task.draft.goal).toBe(goal);
        expect(calls.every((call) => call.path.startsWith('/api/v1/task-drafts'))).toBe(true);
    });
    it.each(['cancel', 'edit', 'session'] as const)(
        'AI提问在途%s后迟到结果不能恢复对话或覆盖配置',
        async (change) => {
            let finish!: (value: Response) => void;
            const { task, natural, lifecycle } = setup(
                async () =>
                    new Promise((resolve) => {
                        finish = resolve;
                    }),
            );
            const pending = natural.clarify();
            await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
            if (change === 'cancel') natural.cancel();
            else if (change === 'edit') task.inputText.value = '另一项需求';
            else lifecycle.replaceSession({ ...account, user: { ...account.user, id: id(2) } });
            const { goal, focusPoints, exclusions, sourcePreferences, timeRange, outputFormat } =
                config();
            finish(
                Response.json({
                    inputText: originalText,
                    round: 0,
                    summary: '建议范围',
                    scope: {
                        goal,
                        focusPoints,
                        exclusions,
                        sourcePreferences,
                        timeRange,
                        outputFormat,
                        researchMode: 'analysis',
                    },
                    questions: [],
                    mode: 'model',
                    manualReason: null,
                    parsingUsage: {
                        attempts: 1,
                        inputTokens: 100,
                        outputTokens: 50,
                        estimated: false,
                    },
                }),
            );
            await pending;
            expect(natural.clarificationResult.value).toBeUndefined();
            expect(natural.clarifications.value).toEqual([]);
            expect(task.draft.title).toBe('');
            expect(natural.clarifying.value).toBe(false);
        },
    );
    it.each([false, true])('确认范围被完整发送，错配响应不能覆盖选择=%s', async (mismatch) => {
        const scope: TaskDraftScope = { ...config(), researchMode: 'collection' };
        const {
            goal,
            focusPoints,
            exclusions,
            sourcePreferences,
            timeRange,
            outputFormat,
            researchMode,
        } = scope;
        const confirmed = {
            goal,
            focusPoints,
            exclusions,
            sourcePreferences,
            timeRange,
            outputFormat,
            researchMode,
        };
        let body: unknown;
        const { natural, task } = setup(async (_url, init) => {
            body = JSON.parse(init?.body as string);
            return Response.json({
                ...response(),
                config: {
                    ...config(),
                    ...confirmed,
                    ...(mismatch ? { goal: '被扩大的目标' } : {}),
                },
            });
        });
        natural.searchScope.value = confirmed;
        await natural.parse();
        expect(body).toEqual({ inputText: originalText, timezone: 'UTC', searchScope: confirmed });
        expect(natural.canApply.value).toBe(!mismatch);
        if (!mismatch) {
            natural.apply();
            expect(task.draft.researchMode).toBe('collection');
        } else expect(task.draft.title).toBe('');
    });
    it('更新搜索范围会使旧解析失效，修改原文清除上次范围', async () => {
        const { natural, task } = setup(async () => Response.json(response()));
        await natural.parse();
        natural.searchScope.value = { ...config(), researchMode: 'analysis' };
        expect(natural.stale.value).toBe(true);
        expect(natural.apply()).toBe(false);
        task.inputText.value = '新的需求';
        expect(natural.searchScope.value).toBeUndefined();
    });
    it('显式分析模式应用后保存保真，旧配置仍保留省略的缺省语义', () => {
        const original = { ...config(), researchMode: 'analysis' as const };
        expect(taskInput(taskDraftFromConfig(original), original).config.researchMode).toBe(
            'analysis',
        );
        const legacy = config();
        expect(taskInput(taskDraftFromConfig(legacy), legacy).config.researchMode).toBeUndefined();
    });
    it('解析401使会话过期时，在途保存不能阻止登录跳转', async () => {
        let finishParse!: (value: Response) => void;
        let savingStarted = false;
        const { task, natural, lifecycle } = setup(async (url) => {
            if (addressOf(url).endsWith('/task-drafts'))
                return new Promise((resolve) => {
                    finishParse = resolve;
                });
            savingStarted = true;
            return new Promise(() => {});
        });
        Object.assign(task.draft, initialTaskDraft(), {
            title: '手工任务',
            topic: '政策',
            goal: '核验',
        });
        const parsing = natural.parse();
        await vi.waitFor(() => expect(finishParse).toBeTypeOf('function'));
        const saving = task.submit();
        await vi.waitFor(() => expect(savingStarted).toBe(true));
        let allowedDuringCleanup = false;
        let pendingDuringCleanup = false;
        lifecycle.capture().registerCleanup(() => {
            pendingDuringCleanup = task.pending.value;
            allowedDuringCleanup = task.canLeave(() => false);
        });
        finishParse(failure(401));
        await Promise.all([parsing, saving]);
        expect(pendingDuringCleanup).toBe(true);
        expect(allowedDuringCleanup).toBe(true);
        expect(lifecycle.session.user).toBeNull();
    });
    it.each(['model', 'manual'] as const)(
        '%s保留原文、警告和独立用量，解析/应用均零Task或Run写入',
        async (mode) => {
            const calls: { path: string; init?: RequestInit }[] = [];
            const { task, natural } = setup(async (url, init) => {
                calls.push({ path: addressOf(url), init });
                return Response.json(response(mode));
            });
            expect(task.dirty.value).toBe(true);
            await natural.parse();
            expect(calls).toHaveLength(1);
            expect(calls[0]?.path).toBe('/api/v1/task-drafts');
            expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({
                inputText: originalText,
                timezone: 'UTC',
            });
            expect(calls[0]?.init?.credentials).toBe('include');
            expect(new Headers(calls[0]?.init?.headers).get('x-csrf-token')).toBe('draft-csrf');
            expect(new Headers(calls[0]?.init?.headers).get('idempotency-key')).toBeNull();
            expect(natural.result.value?.mode).toBe(mode);
            expect(natural.result.value?.warnings).toEqual(response(mode).warnings);
            expect(natural.result.value?.parsingUsage).toEqual(response(mode).parsingUsage);
            expect(task.draft.title).toBe('');
            expect(natural.canApply.value).toBe(true);
            expect(natural.apply()).toBe(true);
            expect(task.draft.title).toBe('解析标题');
            expect(natural.applied.value).toBe(true);
            expect(natural.stale.value).toBe(false);
            expect(natural.message.value).toContain('已应用');
            expect(natural.canApply.value).toBe(false);
            expect(natural.apply()).toBe(false);
            expect(calls).toHaveLength(1);
        },
    );
    it('显式IANA时区原样进入请求，不默认覆盖原文时区', async () => {
        const bodies: unknown[] = [];
        const { natural } = setup(async (_url, init) => {
            bodies.push(JSON.parse(init?.body as string));
            return Response.json(response());
        });
        natural.timezone.value = 'Asia/Tokyo';
        await natural.parse();
        expect(bodies).toEqual([{ inputText: originalText, timezone: 'Asia/Tokyo' }]);
    });
    it('应用后仅修改标题并显式保存，精确时间、含换行数组、周期与预算完整保真，原文透传', async () => {
        const calls: { path: string; body: unknown }[] = [];
        const { task, natural } = setup(async (url, init) => {
            const path = addressOf(url);
            const body = JSON.parse(init?.body as string);
            calls.push({ path, body });
            if (path.endsWith('/task-drafts')) return Response.json(response());
            return Response.json(
                {
                    task: {
                        id: id(10),
                        title: body.config.title,
                        status: 'active',
                        revision: 1,
                        currentVersionId: id(20),
                        nextRunAt: '2026-11-04T01:15:00Z',
                        createdAt: instant,
                        updatedAt: instant,
                    },
                    version: {
                        id: id(20),
                        taskId: id(10),
                        version: 1,
                        configSchemaVersion: 1,
                        config: body.config,
                        comparisonScopeHash: 'a'.repeat(64),
                        createdAt: instant,
                    },
                    baselineResetRequired: false,
                },
                { status: 201 },
            );
        });
        await natural.parse();
        natural.apply();
        task.draft.title = '用户改标题';
        expect(await task.submit()).toBeDefined();
        expect(calls).toHaveLength(2);
        expect(calls[1]?.path).toBe('/api/v1/tasks');
        expect(calls[1]?.body).toEqual({
            inputText: originalText,
            config: { ...config(), title: '用户改标题' },
        });
        expect(calls.every((call) => !call.path.includes('/runs'))).toBe(true);
    });
    it('保留周期建议或明确改manual，其他配置不变', async () => {
        const { task, natural } = setup(async () => Response.json(response()));
        await natural.parse();
        natural.apply();
        expect(taskInput(task.draft, task.parsedConfig.value).config).toEqual(config());
        task.keepSuggestedSchedule.value = false;
        expect(
            taskInput(task.draft, task.parsedConfig.value, task.keepSuggestedSchedule.value).config,
        ).toEqual({ ...config(), schedule: { frequency: 'manual' } });
    });
    it.each(['form', 'text', 'timezone'] as const)(
        '解析在途%s修改使迟到结果不可覆盖，表单和原文保留',
        async (changed) => {
            let finish!: (value: Response) => void;
            const { task, natural } = setup(
                async () =>
                    new Promise((resolve) => {
                        finish = resolve;
                    }),
            );
            const pending = natural.parse();
            await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
            if (changed === 'form') task.draft.title = '用户的新标题';
            if (changed === 'text') task.inputText.value = '用户的新原文';
            if (changed === 'timezone') natural.timezone.value = 'Asia/Tokyo';
            finish(Response.json(response()));
            await pending;
            expect(natural.result.value).toBeDefined();
            expect(natural.stale.value).toBe(true);
            expect(natural.apply()).toBe(false);
            expect(task.draft.title).toBe(changed === 'form' ? '用户的新标题' : '');
            expect(task.inputText.value).toBe(changed === 'text' ? '用户的新原文' : originalText);
        },
    );
    it('结果返回后的新编辑也禁止旧草稿覆盖；重新解析才建立新基准', async () => {
        const { task, natural } = setup(async () => Response.json(response()));
        await natural.parse();
        task.draft.goal = '用户的新目标';
        expect(natural.stale.value).toBe(true);
        expect(natural.apply()).toBe(false);
        await natural.parse();
        expect(natural.stale.value).toBe(false);
        expect(natural.apply()).toBe(true);
    });
    it('已有手工内容只在明确应用时替换，不自动提高预算或频率', async () => {
        const { task, natural } = setup(async () => Response.json(response()));
        task.draft.title = '原手工标题';
        task.draft.maxSearches = '1';
        await natural.parse();
        expect(task.draft.title).toBe('原手工标题');
        expect(task.draft.maxSearches).toBe('1');
        expect(task.parsedConfig.value).toBeUndefined();
    });
    it.each(['', '   ', 'a'.repeat(2001), '中'.repeat(2001)])(
        '输入不合法时零请求并保留原文',
        async (inputText) => {
            const fetcher = vi.fn<typeof fetch>(async () => Response.json(response()));
            const { task, natural } = setup(fetcher);
            task.inputText.value = inputText;
            await natural.parse();
            expect(fetcher).not.toHaveBeenCalled();
            expect(task.inputText.value).toBe(inputText);
            expect(natural.inputError.value).not.toBe('');
        },
    );
    it('2000字符及UTF-8字节边界通过共享schema，错误时区在前端阻止', () => {
        const text = '中'.repeat(2000);
        expect(new TextEncoder().encode(text).length).toBe(6000);
        expect(validateDraftInput({ inputText: text }).inputText).toBe(text);
        expect(() => validateDraftInput({ inputText: '𠮷'.repeat(2001) })).toThrow();
        expect(() =>
            validateDraftInput({ inputText: originalText, timezone: 'Mars/Olympus' }),
        ).toThrow();
    });
    it('非法解析时区与输入独立定位，手工表单继续可改', async () => {
        const fetcher = vi.fn<typeof fetch>(async () => Response.json(response()));
        const { task, natural } = setup(fetcher);
        natural.timezone.value = 'Mars/Olympus';
        await natural.parse();
        expect(natural.timezoneError.value).not.toBe('');
        expect(natural.inputError.value).toBe('');
        expect(task.inputText.value).toBe(originalText);
        task.draft.title = '继续手工';
        expect(task.draft.title).toBe('继续手工');
        expect(fetcher).not.toHaveBeenCalled();
    });
    it.each([429, 503])('%s保留原文与已有手工配置，不自动重试', async (status) => {
        const fetcher = vi.fn<typeof fetch>(async () => failure(status));
        const { task, natural } = setup(fetcher);
        task.draft.title = '手工标题';
        await natural.parse();
        expect(natural.result.value).toBeUndefined();
        expect(natural.message.value).toContain('手工');
        expect(task.inputText.value).toBe(originalText);
        expect(task.draft.title).toBe('手工标题');
        expect(fetcher).toHaveBeenCalledTimes(1);
    });
    it('超时中止transport，不自动重试或写Task，可手工继续', async () => {
        let signal: AbortSignal | undefined;
        const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
            signal = init?.signal ?? undefined;
            return new Promise(() => {});
        });
        const { task, natural } = setup(fetcher, 20);
        await natural.parse();
        expect(signal?.aborted).toBe(true);
        expect(natural.message.value).toContain('超时');
        expect(task.inputText.value).toBe(originalText);
        expect(natural.canApply.value).toBe(false);
        expect(fetcher).toHaveBeenCalledTimes(1);
    });
    it.each(['input', 'mode', 'schema'] as const)('返回%s不一致不能应用到表单', async (kind) => {
        const { natural, task } = setup(async () =>
            Response.json({
                ...response(),
                ...(kind === 'input' ? { inputText: '另一份描述' } : {}),
                ...(kind === 'mode' ? { manualReason: 'model_unavailable' } : {}),
                ...(kind === 'schema' ? { requiresConfirmation: false } : {}),
            }),
        );
        await natural.parse();
        expect(natural.result.value).toBeUndefined();
        expect(natural.canApply.value).toBe(false);
        expect(task.draft.title).toBe('');
        expect(natural.message.value).toContain('合法解析');
    });
    it('重复点击与键盘激活只调用一次解析，用户停止保留原文且忽略迟到响应', async () => {
        let finish!: (value: Response) => void;
        let signal: AbortSignal | undefined;
        const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
            signal = init?.signal ?? undefined;
            return new Promise((resolve) => {
                finish = resolve;
            });
        });
        const { natural, task } = setup(fetcher);
        const pending = natural.parse();
        await natural.parse();
        await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
        natural.cancel();
        finish(Response.json(response()));
        await pending;
        expect(signal?.aborted).toBe(true);
        expect(natural.result.value).toBeUndefined();
        expect(task.inputText.value).toBe(originalText);
        expect(fetcher).toHaveBeenCalledTimes(1);
    });
    it.each(['account', 'dispose'] as const)(
        '%s变化中止解析，迟到成功/401不能污染新账号',
        async (change) => {
            let finish!: (value: Response) => void;
            let signal: AbortSignal | undefined;
            const { natural, task, lifecycle, scope } = setup(async (_url, init) => {
                signal = init?.signal ?? undefined;
                return new Promise((resolve) => {
                    finish = resolve;
                });
            });
            const pending = natural.parse();
            await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
            if (change === 'account')
                lifecycle.replaceSession({ ...account, user: { ...account.user, id: id(2) } });
            else scope.stop();
            finish(change === 'account' ? failure(401) : Response.json(response()));
            await pending;
            expect(signal?.aborted).toBe(true);
            expect(natural.result.value).toBeUndefined();
            expect(natural.message.value).toBe('');
            if (change === 'account') {
                expect(lifecycle.session.user?.id).toBe(id(2));
                expect(task.inputText.value).toBe('');
            }
        },
    );
    it('未修改字段精确保真；改一个固定日期只转换该字段，保留另一微秒', () => {
        const original = config();
        const draft = taskDraftFromConfig(original);
        expect(taskInput(draft, original).config).toEqual(original);
        draft.end = '2026-11-01T10:11:12.345';
        const updated = taskInput(draft, original).config;
        expect(updated.timeRange).toEqual({
            kind: 'fixed',
            start: original.timeRange.kind === 'fixed' ? original.timeRange.start : '',
            end: new Date(draft.end).toISOString(),
        });
        expect(updated.focusPoints).toEqual(original.focusPoints);
    });
    it('编辑或删除列表中的一项，不按换行、逗号或空格拆分其他项', () => {
        const original = config();
        const draft = taskDraftFromConfig(original);
        draft.focusPoints[0] = '费用、资格\n仍是一个关注点';
        draft.exclusions.push('广告,重复转载');
        const updated = taskInput(draft, original).config;
        expect(updated.focusPoints).toEqual([
            '费用、资格\n仍是一个关注点',
            original.focusPoints[1],
        ]);
        expect(updated.exclusions).toEqual([...original.exclusions, '广告,重复转载']);
        draft.focusPoints.splice(0, 1);
        expect(taskInput(draft, original).config.focusPoints).toEqual([original.focusPoints[1]]);
        expect(taskInput(draft, original).config.sourcePreferences).toEqual(
            original.sourcePreferences,
        );
    });
    it('沿既有shared schema按UTF-16码元限制，非BMP边界不冒称8000字节合法样本', () => {
        const boundary = '𠮷'.repeat(1000);
        expect(boundary.length).toBe(2000);
        expect(new TextEncoder().encode(boundary).byteLength).toBe(4000);
        expect(validateDraftInput({ inputText: boundary }).inputText).toBe(boundary);
        expect(() => validateDraftInput({ inputText: `${boundary}𠮷` })).toThrow();
        const bytes8000 = '𠮷'.repeat(2000);
        expect(new TextEncoder().encode(bytes8000).byteLength).toBe(8000);
        expect(bytes8000.length).toBe(4000);
        expect(() => validateDraftInput({ inputText: bytes8000 })).toThrow();
    });
    it.each(['text', 'form', 'timezone'] as const)(
        '%s改动后即使改回原值，旧解析仍需重新确认而不能覆盖',
        async (kind) => {
            const { task, natural } = setup(async () => Response.json(response()));
            await natural.parse();
            if (kind === 'text') {
                task.inputText.value = '新原文';
                task.inputText.value = originalText;
            } else if (kind === 'form') {
                task.draft.title = '新标题';
                task.draft.title = '';
            } else {
                natural.timezone.value = 'Asia/Tokyo';
                natural.timezone.value = '';
            }
            expect(natural.stale.value).toBe(true);
            expect(natural.apply()).toBe(false);
            expect(task.draft.title).toBe('');
        },
    );
    it('已应用结果后继续编辑不误报过期，下一次解析失败仍保留应用配置及手工修改', async () => {
        let fail = false;
        const { task, natural } = setup(async () =>
            fail ? failure(429) : Response.json(response()),
        );
        await natural.parse();
        natural.apply();
        task.draft.title = '应用后手工修正';
        task.keepSuggestedSchedule.value = false;
        expect(natural.stale.value).toBe(false);
        expect(natural.canApply.value).toBe(false);
        fail = true;
        await natural.parse();
        expect(natural.result.value).toBeUndefined();
        expect(task.draft.title).toBe('应用后手工修正');
        expect(task.parsedConfig.value).toEqual(config());
        expect(
            taskInput(task.draft, task.parsedConfig.value, task.keepSuggestedSchedule.value).config,
        ).toEqual({
            ...config(),
            title: '应用后手工修正',
            schedule: { frequency: 'manual' },
        });
    });
    it('解析预算用尽的manual结果保留估算解析用量，不变更Task预算或创建Run', async () => {
        const value = {
            ...response('manual'),
            manualReason: 'budget_exceeded' as const,
            parsingUsage: { attempts: 2, inputTokens: 900, outputTokens: 100, estimated: true },
        };
        const fetcher = vi.fn<typeof fetch>(async () => Response.json(value));
        const { task, natural } = setup(fetcher);
        await natural.parse();
        expect(natural.result.value?.manualReason).toBe('budget_exceeded');
        expect(natural.result.value?.parsingUsage).toEqual(value.parsingUsage);
        expect(natural.apply()).toBe(true);
        expect(taskInput(task.draft, task.parsedConfig.value).config.budget).toEqual(
            config().budget,
        );
        expect(fetcher).toHaveBeenCalledTimes(1);
    });
    it('结果已返回后更换账号清除结果和原文，不能应用上一账号草稿', async () => {
        const { task, natural, lifecycle } = setup(async () => Response.json(response()));
        await natural.parse();
        expect(natural.canApply.value).toBe(true);
        lifecycle.replaceSession({ ...account, user: { ...account.user, id: id(2) } });
        expect(natural.result.value).toBeUndefined();
        expect(natural.apply()).toBe(false);
        expect(task.inputText.value).toBe('');
        expect(task.draft.title).toBe('');
    });
});
