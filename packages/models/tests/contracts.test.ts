import { describe, expect, it } from 'vite-plus/test';
import { TypeCompiler } from '@sinclair/typebox/compiler';
import { Kind } from '@sinclair/typebox';
import * as contracts from '../src/index.ts';
import { Value } from '@sinclair/typebox/value';
import {
    ApiErrorSchema,
    ClaimSchema,
    ContractValidationError,
    CreateTaskInputSchema,
    HttpUrlSchema,
    IdempotencyHeadersSchema,
    LoginInputSchema,
    ModeSchema,
    PageQuerySchema,
    RegisterInputSchema,
    ReportSchema,
    RevisionHeadersSchema,
    RunEventSchema,
    RunSchema,
    SseResetControlSchema,
    SseMessageSchema,
    TaskConfigSchema,
    TaskVersionSchema,
    TimeRangeSchema,
    TimezoneSchema,
    UpdatePreferencesInputSchema,
    UuidSchema,
    createBudgetSchema,
    parseContract,
    parseRevisionEtag,
    revisionEtag,
    type Claim,
    type Report,
    type Run,
    type TaskConfig,
    type TaskVersion,
} from '../src/index.ts';

const id = '019a0000-0000-7000-8000-000000000001';
const otherId = '019a0000-0000-7000-8000-000000000002';
const instant = '2026-10-24T12:00:00Z';
const config: TaskConfig = {
    title: '英语听力',
    topic: 'B1 英语听力',
    goal: '推荐带字幕的免费材料',
    focusPoints: ['字幕'],
    exclusions: [],
    sourcePreferences: {
        preferredUrls: ['https://example.org/listen'],
        excludedUrls: [],
        officialOnly: false,
    },
    timeRange: { kind: 'rolling', days: 7 },
    timezone: 'Asia/Shanghai',
    schedule: { frequency: 'weekly', localTime: '09:00', weekday: 1 },
    outputFormat: 'brief',
    budget: {
        maxSearches: 10,
        maxPages: 20,
        maxDurationSeconds: 300,
        maxInputTokens: 40000,
        maxOutputTokens: 8000,
    },
    notificationPreference: { mode: 'important_change', runIssues: true },
};
const run: Run = {
    id,
    taskId: id,
    taskVersionId: otherId,
    parentRunId: null,
    baselineRunId: null,
    mode: 'live',
    status: 'succeeded',
    outcome: 'baseline',
    trigger: 'manual',
    budget: config.budget,
    usage: { searches: 2, pages: 3, inputTokens: 100, outputTokens: 50, estimated: false },
    coverage: {
        completeness: 'complete',
        searchedQueries: ['B1 listening'],
        gaps: [],
        exhausted: [],
    },
    queuedAt: instant,
    startedAt: instant,
    finishedAt: instant,
    failureCode: null,
};
const claim: Claim = {
    id,
    kind: 'fact',
    text: '材料附带字幕',
    confidenceLabel: '来源原文',
    evidenceIds: [id],
};
const report: Report = {
    id,
    runId: id,
    taskId: id,
    taskVersionId: otherId,
    baselineRunId: null,
    schemaVersion: 1,
    title: '听力简报',
    summary: '本周发现',
    format: 'brief',
    mode: 'live',
    outcome: 'baseline',
    coverage: run.coverage!,
    limitations: [],
    claims: [claim],
    evidence: [
        {
            id,
            sourceId: id,
            snapshotId: otherId,
            url: 'https://example.org/listen',
            title: '听力',
            quote: 'with subtitles',
            location: 'paragraph 2',
            observedAt: instant,
        },
    ],
    changes: [],
    publishedAt: instant,
};

describe('共享任务与输入契约', () => {
    it('保存完整手工配置、不可变版本 DTO，并保留普通 JSON', () => {
        expect(() =>
            parseContract(TaskConfigSchema, {
                ...config,
                outputFormat: 'brief',
                outputFormats: ['list'],
            }),
        ).toThrow();
        expect(parseContract(CreateTaskInputSchema, { config })).toEqual({ config });
        const version: TaskVersion = {
            id,
            taskId: id,
            version: 1,
            configSchemaVersion: 1,
            config,
            comparisonScopeHash: 'a'.repeat(64),
            createdAt: instant,
        };
        expect(parseContract(TaskVersionSchema, version).config.goal).toBe(config.goal);
        expect(parseContract(CreateTaskInputSchema, { config })).not.toHaveProperty('data');
    });

    it.each(['', ' ', '\n\t'])('拒绝空白目标 %j 并定位 goal', (goal) => {
        try {
            parseContract(TaskConfigSchema, { ...config, goal });
            throw new Error('应当拒绝');
        } catch (error) {
            expect(error).toBeInstanceOf(ContractValidationError);
            expect(
                (error as ContractValidationError).fieldErrors.some(
                    (field) => field.path === '/goal',
                ),
            ).toBe(true);
        }
    });

    it.each(['Mars/Olympus', '', '+08:00'])('拒绝非法 IANA 时区 %j', (timezone) => {
        expect(() => parseContract(TimezoneSchema, timezone)).toThrow(ContractValidationError);
        expect(TypeCompiler.Compile(TimezoneSchema).Check(timezone)).toBe(false);
    });

    it.each(['Asia/Shanghai', 'America/New_York', 'UTC'])('接受明确 IANA 时区 %j', (timezone) => {
        expect(Value.Check(TimezoneSchema, timezone)).toBe(true);
    });

    it.each([
        'not-a-url',
        'file:///etc/passwd',
        'javascript:alert(1)',
        'https://user:secret@example.org',
        'https:example.org',
    ])('拒绝非法来源 %j', (url) => {
        expect(() => parseContract(HttpUrlSchema, url)).toThrow(ContractValidationError);
    });

    it.each([
        'abc',
        '019a0000-0000-0000-8000-000000000001',
        '019a0000-0000-7000-0000-000000000001',
    ])('拒绝非法 UUID %j', (value) => {
        expect(Value.Check(UuidSchema, value)).toBe(false);
    });

    it('拒绝客户端 userId、未知状态和无时区日期', () => {
        expect(() => parseContract(CreateTaskInputSchema, { config, userId: otherId })).toThrow();
        expect(() => parseContract(RunSchema, { ...run, status: 'done' })).toThrow();
        expect(() =>
            parseContract(TaskVersionSchema, {
                id,
                taskId: id,
                version: 1,
                configSchemaVersion: 1,
                config,
                comparisonScopeHash: 'a'.repeat(64),
                createdAt: '2026-10-24T12:00:00',
            }),
        ).toThrow();
    });

    it.each([0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])('拒绝无效预算 %j', (maxSearches) => {
        expect(() =>
            parseContract(TaskConfigSchema, {
                ...config,
                budget: { ...config.budget, maxSearches },
            }),
        ).toThrow();
    });

    it('默认预算不是硬上限，显式部署策略在运行时和编译器中一致生效', () => {
        expect(
            parseContract(TaskConfigSchema, {
                ...config,
                budget: { ...config.budget, maxSearches: 11 },
            }).budget.maxSearches,
        ).toBe(11);
        const policySchema = createBudgetSchema({ maxSearches: 10 });
        expect(() => parseContract(policySchema, { ...config.budget, maxSearches: 11 })).toThrow();
        expect(
            TypeCompiler.Compile(policySchema).Check({ ...config.budget, maxSearches: 11 }),
        ).toBe(false);
        expect(() => createBudgetSchema({ maxSearches: 0 })).toThrow('部署预算上限');
    });

    it('固定范围拒绝倒置时间，解析器和 Elysia 所用编译器结果一致', () => {
        const backwards = { kind: 'fixed', start: '2026-10-25T00:00:00Z', end: instant };
        expect(Value.Check(TimeRangeSchema, backwards)).toBe(false);
        expect(TypeCompiler.Compile(TimeRangeSchema).Check(backwards)).toBe(false);
        expect(() => parseContract(TimeRangeSchema, backwards)).toThrow(ContractValidationError);
        const valid = { ...backwards, end: '2026-10-25T00:00:00Z' };
        expect(TypeCompiler.Compile(TimeRangeSchema).Check(valid)).toBe(true);
        expect(() =>
            parseContract(TimeRangeSchema, { ...valid, start: '2026-02-30T12:00:00Z' }),
        ).toThrow();
    });

    it.each([
        { frequency: 'weekly', localTime: '24:00', weekday: 1 },
        { frequency: 'weekly', localTime: '09:00', weekday: 0 },
        { frequency: 'cron', expression: '* * * * *' },
    ])('拒绝非法计划 %j', (schedule) => {
        expect(() => parseContract(TaskConfigSchema, { ...config, schedule })).toThrow();
    });
});

describe('账号与 HTTP 协议', () => {
    it('注册接受8位纯数字及纯字母密码，拒绝7位和超过128位', () => {
        const register = { email: 'a@example.org', defaultTimezone: 'UTC' };
        for (const password of ['12345678', 'abcdefgh', 'a'.repeat(128)])
            expect(parseContract(RegisterInputSchema, { ...register, password }).password).toBe(
                password,
            );
        for (const password of ['1234567', 'a'.repeat(129)])
            expect(() => parseContract(RegisterInputSchema, { ...register, password })).toThrow();
    });
    it('注册拒绝弱密码和 owner 注入，登录不重复应用注册强度策略', () => {
        expect(() =>
            parseContract(RegisterInputSchema, {
                email: 'a@example.org',
                password: 'short',
                defaultTimezone: 'UTC',
            }),
        ).toThrow();
        expect(() =>
            parseContract(RegisterInputSchema, {
                email: 'a@example.org',
                password: 'long-password-123',
                defaultTimezone: 'UTC',
                userId: otherId,
            }),
        ).toThrow();
        expect(
            parseContract(LoginInputSchema, { email: 'a@example.org', password: 'x' }).password,
        ).toBe('x');
        expect(() => parseContract(UpdatePreferencesInputSchema, {})).toThrow();
    });

    it('错误包含 requestId 与可定位字段，未包装为成功响应', () => {
        try {
            parseContract(TaskConfigSchema, { ...config, timezone: 'bad' });
        } catch (error) {
            const response = (error as ContractValidationError).toResponse('request-1');
            expect(parseContract(ApiErrorSchema, response).fieldErrors).toContainEqual(
                expect.objectContaining({ path: '/timezone' }),
            );
            expect(response.code).toBe('VALIDATION_ERROR');
        }
    });

    it('修订请求头和响应 ETag 往返且拒绝弱标签、溢出与裸数', () => {
        expect(parseRevisionEtag(revisionEtag(3))).toBe(3);
        expect(parseContract(RevisionHeadersSchema, { 'if-match': '"3"' })['if-match']).toBe('"3"');
        for (const invalid of ['3', 'W/"3"', '"0"', '"9007199254740992"'])
            expect(() => parseRevisionEtag(invalid)).toThrow();
        expect(() =>
            parseContract(RevisionHeadersSchema, { 'if-match': '"9007199254740992"' }),
        ).toThrow();
        expect(
            TypeCompiler.Compile(RevisionHeadersSchema).Check({ 'if-match': '"9007199254740992"' }),
        ).toBe(false);
        expect(() =>
            parseContract(IdempotencyHeadersSchema, { 'idempotency-key': 'short' }),
        ).toThrow();
        expect(() => parseContract(PageQuerySchema, { limit: 0 })).toThrow();
        expect(() => parseContract(PageQuerySchema, { cursor: '' })).toThrow();
    });
});

describe('执行、报告与 SSE 语义', () => {
    it('零收录采集可交付诚实的部分说明，但不能伪装无证据事实或完成', () => {
        const empty = {
            ...report,
            outcome: 'inconclusive',
            limitations: ['尚无满足日期和直接出处要求的采集条目'],
            claims: [{ ...claim, kind: 'insufficient', evidenceIds: [] }],
            evidence: [],
            changes: [],
            coverage: {
                ...report.coverage,
                completeness: 'partial',
                dateScreening: {
                    window: { start: instant, end: instant },
                    accepted: 0,
                    unconfirmed: 0,
                    outside: 0,
                    entries: [],
                },
            },
        };
        expect(parseContract(ReportSchema, empty)).toEqual(empty);
        for (const invalid of [
            { ...empty, coverage: { ...empty.coverage, completeness: 'complete' } },
            { ...empty, claims: [{ ...claim, kind: 'inference', evidenceIds: [] }] },
            { ...empty, coverage: { ...empty.coverage, dateScreening: undefined } },
            {
                ...empty,
                coverage: {
                    ...empty.coverage,
                    dateScreening: { ...empty.coverage.dateScreening, accepted: 1 },
                },
            },
        ])
            expect(() => parseContract(ReportSchema, invalid)).toThrow();
    });
    it('上次报告入口必须与比较执行一致，旧报告可以不含入口', () => {
        expect(parseContract(ReportSchema, report)).toEqual(report);
        const baseline = { runId: otherId, reportId: otherId, publishedAt: instant };
        expect(() => parseContract(ReportSchema, { ...report, baseline })).toThrow();
        expect(
            parseContract(ReportSchema, { ...report, baselineRunId: otherId, baseline }).baseline,
        ).toEqual(baseline);
    });
    it('真实与演示模式显式存在且拒绝其他模式', () => {
        expect(parseContract(RunSchema, run).mode).toBe('live');
        expect(parseContract(RunSchema, { ...run, mode: 'demo' }).mode).toBe('demo');
        expect(() => parseContract(ModeSchema, 'auto')).toThrow();
    });

    it('事实必须有引用，推断、冲突和不足保持独立分类', () => {
        expect(() => parseContract(ClaimSchema, { ...claim, evidenceIds: [] })).toThrow();
        for (const kind of ['inference', 'conflict', 'insufficient'] as const)
            expect(parseContract(ClaimSchema, { ...claim, kind, evidenceIds: [] }).kind).toBe(kind);
        expect(TypeCompiler.Compile(ClaimSchema).Check({ ...claim, evidenceIds: [] })).toBe(false);
    });

    it('报告拒绝悬空引用和缺失双方证据的变化', () => {
        expect(parseContract(ReportSchema, report).claims[0]?.text).toBe(claim.text);
        expect(() =>
            parseContract(ReportSchema, {
                ...report,
                claims: [{ ...claim, evidenceIds: [otherId] }],
            }),
        ).toThrow();
        expect(() =>
            parseContract(ReportSchema, {
                ...report,
                evidence: [],
                claims: [{ ...claim, kind: 'insufficient', evidenceIds: [] }],
            }),
        ).toThrow();
        const change = {
            id,
            sourceId: id,
            kind: 'changed',
            factKey: 'deadline',
            oldValue: '10-24',
            newValue: '10-25',
            oldEvidenceIds: [],
            newEvidenceIds: [id],
            important: true,
            reason: '报名截止延期',
        };
        expect(() => parseContract(ReportSchema, { ...report, changes: [change] })).toThrow();
        expect(TypeCompiler.Compile(ReportSchema).Check({ ...report, changes: [change] })).toBe(
            false,
        );
        expect(
            parseContract(ReportSchema, {
                ...report,
                changes: [{ ...change, oldEvidenceIds: [id] }],
            }).changes,
        ).toHaveLength(1);
    });

    it('不完整执行和报告不能伪装成没有重要变化，也不建立基线', () => {
        expect(() =>
            parseContract(RunSchema, { ...run, status: 'partial', outcome: 'no_important_change' }),
        ).toThrow();
        expect(() =>
            parseContract(RunSchema, { ...run, status: 'partial', outcome: 'baseline' }),
        ).toThrow();
        expect(() =>
            parseContract(RunSchema, {
                ...run,
                status: 'succeeded',
                outcome: 'important_change',
                coverage: { ...run.coverage, completeness: 'partial' },
            }),
        ).toThrow();
        expect(() =>
            parseContract(RunSchema, {
                ...run,
                status: 'partial',
                outcome: 'important_change',
                coverage: { ...run.coverage, completeness: 'complete' },
            }),
        ).toThrow();
        const partialReport = {
            ...report,
            coverage: { ...report.coverage, completeness: 'partial' },
            outcome: 'no_important_change',
        };
        expect(() => parseContract(ReportSchema, partialReport)).toThrow();
        expect(TypeCompiler.Compile(ReportSchema).Check(partialReport)).toBe(false);
        expect(() =>
            parseContract(ReportSchema, { ...partialReport, outcome: 'inconclusive' }),
        ).toThrow();
        expect(
            parseContract(ReportSchema, {
                ...partialReport,
                outcome: 'inconclusive',
                limitations: ['部分来源无法读取'],
            }).outcome,
        ).toBe('inconclusive');
    });

    it('事件版本、eventId、序号与类型 payload 绑定', () => {
        const event = {
            schemaVersion: 1,
            eventId: otherId,
            runId: id,
            seq: 1,
            occurredAt: instant,
            type: 'run.started',
            payload: { status: 'running', startedAt: instant },
        };
        expect(parseContract(RunEventSchema, event).seq).toBe(1);
        for (const invalid of [
            { ...event, schemaVersion: 2 },
            { ...event, eventId: 'bad' },
            { ...event, eventId: undefined },
            { ...event, seq: 0 },
            { ...event, type: 'unknown' },
            { ...event, payload: { reportId: id } },
        ])
            expect(() => parseContract(RunEventSchema, invalid)).toThrow();
    });

    it('架构要求的各类持久化事件均有独立 payload 契约', () => {
        const common = {
            schemaVersion: 1,
            eventId: otherId,
            runId: id,
            seq: 1,
            occurredAt: instant,
        };
        const tool = { toolCallId: otherId, tool: 'search' };
        const cases = [
            ['run.queued', { status: 'queued', taskVersionId: id }],
            ['run.started', { status: 'running', startedAt: instant }],
            ['run.recovering', { status: 'recovering', recoveryCount: 1 }],
            ['step.started', { step: 'search' }],
            ['step.completed', { step: 'search', durationMs: 5 }],
            ['tool.started', { ...tool, summary: '查找免费材料' }],
            ['tool.completed', { ...tool, durationMs: 10, usage: run.usage }],
            [
                'tool.failed',
                { ...tool, code: 'PROVIDER_UNAVAILABLE', message: '暂时无法访问', retryable: true },
            ],
            ['budget.updated', { budget: config.budget, usage: run.usage }],
            ['coverage.updated', run.coverage],
            ['report.published', { reportId: id, completeness: 'complete' }],
            ['run.completed', { status: 'succeeded', outcome: 'baseline', reportId: id }],
            ['run.failed', { status: 'failed', code: 'NO_EVIDENCE', message: '没有可用证据' }],
            ['run.canceled', { status: 'canceled', message: '用户取消' }],
        ];
        for (const [type, payload] of cases) {
            expect(parseContract(RunEventSchema, { ...common, type, payload }).type).toBe(type);
            expect(() => parseContract(RunEventSchema, { ...common, type, payload: {} })).toThrow();
        }
        expect(() =>
            parseContract(RunEventSchema, {
                ...common,
                type: 'run.completed',
                payload: { status: 'partial', outcome: 'no_important_change', reportId: id },
            }),
        ).toThrow();
    });

    it('reset 是无 eventId/seq 的控制帧，不可冒充持久化事件或推进游标', () => {
        const reset = {
            schemaVersion: 1,
            runId: id,
            type: 'stream.reset',
            payload: { reason: 'cursor_expired', snapshot: run, resumeAfter: 5 },
        };
        expect(parseContract(SseResetControlSchema, reset).payload.resumeAfter).toBe(5);
        expect(parseContract(SseMessageSchema, reset).type).toBe('stream.reset');
        expect(() => parseContract(RunEventSchema, reset)).toThrow();
        expect(() =>
            parseContract(SseResetControlSchema, { ...reset, seq: 5, eventId: otherId }),
        ).toThrow();
        expect(() =>
            parseContract(SseResetControlSchema, { ...reset, schemaVersion: 2 }),
        ).toThrow();
        expect(() =>
            parseContract(SseResetControlSchema, {
                ...reset,
                payload: { ...reset.payload, resumeAfter: -1 },
            }),
        ).toThrow();
    });

    it('JSON Schema 保留中文描述及属性供 OpenAPI 生成，隐藏内部 refinement 元数据', () => {
        const json = JSON.stringify(ReportSchema);
        expect(json).toContain('不可变报告');
        expect(json).toContain('"properties"');
        expect(json).not.toContain('refinementBase');
        const visited = new WeakSet<object>();
        const check = (value: unknown) => {
            if (!value || typeof value !== 'object' || visited.has(value)) return;
            visited.add(value);
            if (Array.isArray(value)) {
                value.forEach(check);
                return;
            }
            const object = value as Record<string, unknown>;
            if (object.properties)
                for (const property of Object.values(
                    object.properties as Record<string, Record<string, unknown>>,
                ))
                    expect(property.description).toMatch(/[\u4e00-\u9fff]/);
            Object.values(object).forEach(check);
        };
        for (const value of Object.values(contracts))
            if (value && typeof value === 'object' && Kind in value) check(value);
    });
});

it('执行命令只接受真实研究，历史 Run 仍保留原模式契约', () => {
    expect(parseContract(contracts.RunCommandInputSchema, {})).toEqual({});
    expect(parseContract(contracts.RunCommandInputSchema, { mode: 'live' })).toEqual({
        mode: 'live',
    });
    expect(() => parseContract(contracts.RunCommandInputSchema, { mode: 'demo' })).toThrow();
});
