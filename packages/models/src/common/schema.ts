import {
    FormatRegistry,
    Kind,
    Type,
    TypeRegistry,
    type Static,
    type TSchema,
} from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

/** 注册由 Value 与 Elysia 的 TypeBox 编译器共同使用的格式校验。 */
FormatRegistry.Set('scova-timezone', (value) => {
    if (!/^[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)*$/.test(value)) return false;
    try {
        new Intl.DateTimeFormat('en', { timeZone: value }).format();
        return value.length > 0;
    } catch {
        return false;
    }
});
FormatRegistry.Set('scova-http-url', (value) => {
    if (!/^https?:\/\//i.test(value)) return false;
    try {
        const url = new URL(value);
        return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
    } catch {
        return false;
    }
});
FormatRegistry.Set('scova-instant', (value) => {
    const match =
        /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.exec(
            value,
        );
    if (!match || !Number.isFinite(Date.parse(value))) return false;
    const [, year, month, day] = match;
    const date = new Date(0);
    date.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
    return (
        date.getUTCFullYear() === Number(year) &&
        date.getUTCMonth() + 1 === Number(month) &&
        date.getUTCDate() === Number(day)
    );
});
FormatRegistry.Set(
    'scova-revision',
    (value) => /^"[1-9][0-9]*"$/.test(value) && Number.isSafeInteger(Number(value.slice(1, -1))),
);

/** 补全组合 schema 属性上的中文说明，保持 OpenAPI 与运行时源一致。 */
export function describeProperties<S extends TSchema>(schema: S): S {
    const labels: Record<string, string> = {
        kind: '范围或记录分类',
        start: '范围开始时间',
        end: '范围结束时间',
        frequency: '执行频率',
        localTime: '当地执行时分',
        weekday: '当地执行星期',
        title: '任务或资料标题',
        topic: '查阅主题',
        goal: '查阅目标',
        status: '当前控制状态',
        outcome: '执行业务结论',
        id: '资源标识',
        taskId: '所属任务标识',
        taskVersionId: '固定使用的配置版本标识',
        currentVersionId: '当前配置版本标识',
        parentRunId: '重试或关联研究的父执行，可为空',
        baselineRunId: '本次比较所用基线执行，可为空',
        config: '完整查阅任务配置',
        revision: '资源修订版本',
        inputText: '用户原始需求描述',
        version: '不可变配置版本号',
        configSchemaVersion: '配置结构版本',
        comparisonScopeHash: '语义比较范围指纹',
        mode: '真实或演示服务模式',
        trigger: '执行触发来源',
        budget: '本次预算快照',
        usage: '累计预算用量',
        coverage: '系统判定的查阅覆盖范围，可为空',
        completeness: '本次查阅完整性',
        queuedAt: '入队时间',
        startedAt: '开始时间，可为空',
        finishedAt: '结束时间，可为空',
        createdAt: '创建时间',
        updatedAt: '最后修改时间',
        publishedAt: '成果交付时间',
        failureCode: '失败原因编码，可为空',
        searches: '累计搜索次数',
        pages: '累计网页读取次数',
        inputTokens: '累计模型输入用量',
        outputTokens: '累计模型输出用量',
        estimated: '是否为保守估算用量',
        summary: '脱敏概述',
        message: '面向用户的中文说明',
        code: '稳定错误编码',
        requestId: '请求追踪标识',
        fieldErrors: '字段校验错误',
        path: 'JSON Pointer 字段路径',
        items: '本页资源列表',
        nextCursor: '下一页不透明游标，末页为空',
        cursor: '请求分页游标',
        limit: '请求分页条数',
        oldValue: '旧事实值，可为空',
        newValue: '新事实值，可为空',
        oldEvidenceIds: '旧值的原文证据',
        newEvidenceIds: '新值的原文证据',
        factKey: '被比较的事实键',
        important: '是否已确认重要变化',
        reason: '分类或控制原因',
        claims: '结构化结论列表',
        evidence: '可定位原文证据列表',
        changes: '重复、新增与变化列表',
        schemaVersion: '公共结构版本',
        evidenceIds: '引用的证据标识',
        confidenceLabel: '证据可信度说明',
        text: '结论正文',
        format: '报告展示形式',
        limitations: '查阅限制与证据缺口',
        url: '原文链接',
        sourceId: '来源标识',
        snapshotId: '原文快照标识',
        quote: '原文引用片段',
        location: '原文位置',
        observedAt: '本次观测时间',
        type: '事件或控制帧类型',
        payload: '由类型决定的结构化数据',
        eventId: '稳定持久化事件标识',
        runId: '所属执行标识',
        seq: '执行内递增事件序号',
        occurredAt: '事件发生时间',
        reportId: '已交付报告标识',
        recoveryCount: '恢复接管次数',
        step: '编排步骤名称',
        durationMs: '耗时毫秒数',
        toolCallId: '工具调用记录标识',
        tool: '工具类别',
        retryable: '是否允许按策略重试',
        snapshot: '用于重置客户端的执行快照',
        resumeAfter: '快照对应的最新持久化序号',
        'if-match': '乐观锁修订请求头',
        'idempotency-key': '稳定幂等请求键',
        'last-event-id': '已处理的最后事件标识',
        after: '请求更大序号的事件',
    };
    const seen = new WeakSet<object>();
    const visit = (value: unknown) => {
        if (typeof value !== 'object' || value === null || seen.has(value)) return;
        seen.add(value);
        if (Array.isArray(value)) {
            value.forEach(visit);
            return;
        }
        const current = value as Record<string, unknown>;
        const properties = current.properties as
            | Record<string, Record<string, unknown>>
            | undefined;
        if (properties)
            for (const [name, property] of Object.entries(properties)) {
                if (!property.description)
                    property.description = labels[name] ?? `接口字段 ${name} 的配置或结果`;
            }
        Object.values(current).forEach(visit);
    };
    visit(schema);
    return schema;
}

/** 保留可生成 OpenAPI 的 JSON Schema，并在同一 schema 上执行跨字段校验。 */
export const RefinementBase = Symbol.for('scova.contracts.refinementBase');
export function refineSchema<S extends TSchema>(
    schema: S,
    kind: string,
    check: (value: Static<S>) => boolean,
): S {
    TypeRegistry.Set(
        kind,
        (_schema, value) => Value.Check(schema, value) && check(value as Static<S>),
    );
    return { ...schema, [Kind]: kind, [RefinementBase]: schema } as S;
}

export const UuidSchema = Type.String({
    pattern:
        '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$',
    description: '资源 UUID，不用于指定其他用户或访问数据库内部状态',
});
export const InstantSchema = Type.String({
    format: 'scova-instant',
    description: '带 UTC 偏移的 ISO 8601 时间',
});
export const TimezoneSchema = Type.String({
    format: 'scova-timezone',
    description: '明确的 IANA 时区，例如 Asia/Shanghai',
});
export const HttpUrlSchema = Type.String({
    format: 'scova-http-url',
    maxLength: 4096,
    description: 'HTTP/HTTPS 来源原文链接，不包含用户名或密码；实际抓取另行执行网络安全校验',
});
export const NonEmptyTextSchema = Type.String({
    minLength: 1,
    pattern: '\\S',
    description: '至少包含一个非空白字符的文本',
});
export const RevisionSchema = Type.Integer({
    minimum: 1,
    maximum: Number.MAX_SAFE_INTEGER,
    description: '从 1 递增的资源修订版本',
});
export const ModeSchema = Type.Union([Type.Literal('demo'), Type.Literal('live')], {
    description: '服务模式，演示和真实资料的基线分别保存',
});
export const TaskStatusSchema = Type.Union(
    [Type.Literal('active'), Type.Literal('paused'), Type.Literal('archived')],
    { description: '任务生命周期：启用、暂停计划、归档' },
);
export const RunStatusSchema = Type.Union(
    [
        Type.Literal('queued'),
        Type.Literal('running'),
        Type.Literal('recovering'),
        Type.Literal('cancel_requested'),
        Type.Literal('canceled'),
        Type.Literal('succeeded'),
        Type.Literal('partial'),
        Type.Literal('failed'),
    ],
    { description: '执行控制状态，与业务结论分别保存' },
);
export const RunOutcomeSchema = Type.Union(
    [
        Type.Literal('baseline'),
        Type.Literal('important_change'),
        Type.Literal('new_findings'),
        Type.Literal('no_important_change'),
        Type.Literal('inconclusive'),
    ],
    { description: '执行业务结论；不完整查阅不能声明没有重要变化' },
);
export const OutputFormatSchema = Type.Union(
    [
        Type.Literal('brief'),
        Type.Literal('list'),
        Type.Literal('comparison'),
        Type.Literal('research_report'),
    ],
    { description: '同一结构化报告的展示形式：简报、主题清单、对比表、研究报告' },
);
export const NotificationPreferenceSchema = Type.Object(
    {
        mode: Type.Union(
            [Type.Literal('summary'), Type.Literal('important_change'), Type.Literal('off')],
            { description: '每次汇总、仅重要变化或关闭提醒' },
        ),
        runIssues: Type.Boolean({ description: '是否提醒失败或不完整执行等运行问题' }),
    },
    { additionalProperties: false, description: '站内提醒偏好，不包含邮件或外部推送' },
);

export const FieldErrorSchema = Type.Object(
    {
        path: Type.String({
            description: 'JSON Pointer 字段路径，例如 /config/timezone；根输入为 /',
        }),
        message: NonEmptyTextSchema,
    },
    { additionalProperties: false, description: '可定位的字段校验错误' },
);
export const ApiErrorSchema = Type.Object(
    {
        code: NonEmptyTextSchema,
        message: NonEmptyTextSchema,
        requestId: NonEmptyTextSchema,
        fieldErrors: Type.Optional(
            Type.Array(FieldErrorSchema, { description: '输入校验失败时的字段错误列表' }),
        ),
    },
    {
        additionalProperties: false,
        description: '错误体；HTTP 状态必须反映错误，不使用固定 200 的包装协议',
    },
);
export const PageQuerySchema = Type.Object(
    {
        cursor: Type.Optional(
            Type.String({ minLength: 1, maxLength: 1024, description: '上页返回的不透明游标' }),
        ),
        limit: Type.Optional(
            Type.Integer({
                minimum: 1,
                maximum: Number.MAX_SAFE_INTEGER,
                description: '请求条数；默认值和运行上限由部署策略决定',
            }),
        ),
    },
    { additionalProperties: false, description: '游标分页查询参数' },
);
export const RevisionHeadersSchema = Type.Object(
    {
        'if-match': Type.String({
            pattern: '^"[1-9][0-9]*"$',
            format: 'scova-revision',
            description:
                '编辑时提交读取到的 ETag，例如 "3"；必须在安全整数范围内，修订冲突返回 409',
        }),
    },
    { additionalProperties: true, description: '乐观锁请求头' },
);
export const IdempotencyHeadersSchema = Type.Object(
    {
        'idempotency-key': Type.String({
            minLength: 16,
            maxLength: 128,
            pattern: '^[A-Za-z0-9._-]+$',
            description: '同一用户动作重发保持不变的幂等键，不得包含会话凭据',
        }),
    },
    { additionalProperties: true, description: '写操作幂等请求头；同键不同参数返回 409' },
);

export function pageSchema<S extends TSchema>(item: S) {
    return describeProperties(
        Type.Object(
            {
                items: Type.Array(item),
                nextCursor: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
            },
            { additionalProperties: false, description: '普通 JSON 分页结果' },
        ),
    );
}

for (const schema of [
    NotificationPreferenceSchema,
    FieldErrorSchema,
    ApiErrorSchema,
    PageQuerySchema,
    RevisionHeadersSchema,
    IdempotencyHeadersSchema,
])
    describeProperties(schema);

export type Mode = Static<typeof ModeSchema>;
export type TaskStatus = Static<typeof TaskStatusSchema>;
export type RunStatus = Static<typeof RunStatusSchema>;
export type RunOutcome = Static<typeof RunOutcomeSchema>;
export type FieldError = Static<typeof FieldErrorSchema>;
export type ApiError = Static<typeof ApiErrorSchema>;
export type PageQuery = Static<typeof PageQuerySchema>;
export type NotificationPreference = Static<typeof NotificationPreferenceSchema>;
