import { Type, type Static } from '@sinclair/typebox';
import { OutputFormatsSchema } from './output-formats.ts';
import {
    HttpUrlSchema,
    InstantSchema,
    NonEmptyTextSchema,
    NotificationPreferenceSchema,
    OutputFormatSchema,
    RevisionSchema,
    TaskStatusSchema,
    TimezoneSchema,
    UuidSchema,
    refineSchema,
    describeProperties,
} from './common.ts';

/** 新任务初始配额；保存后的任务版本和执行预算不会随默认值改变。 */
export const DEFAULT_TASK_BUDGET = {
    maxSearches: 10,
    maxPages: 20,
    maxDurationSeconds: 600,
    maxInputTokens: 1_000_000,
    maxOutputTokens: 128_000,
} as const;

/** 默认部署允许保存的预算上限；已冻结执行继续使用自身快照。 */
export const DEFAULT_TASK_BUDGET_LIMITS = {
    maxSearches: 10,
    maxPages: 20,
    maxDurationSeconds: 1800,
    maxInputTokens: 2_000_000,
    maxOutputTokens: 512_000,
} as const;

/** 默认预算与硬上限由部署策略提供，契约只约束类型和正整数。 */
export interface BudgetPolicy {
    maxSearches?: number;
    maxPages?: number;
    maxDurationSeconds?: number;
    maxInputTokens?: number;
    maxOutputTokens?: number;
}
export function createBudgetSchema(policy: BudgetPolicy = {}) {
    const positive = (description: string, maximum?: number) => {
        if (maximum !== undefined && (!Number.isSafeInteger(maximum) || maximum < 1))
            throw new Error('部署预算上限必须为正安全整数');
        return Type.Integer({
            minimum: 1,
            maximum: maximum ?? Number.MAX_SAFE_INTEGER,
            description,
        });
    };
    return Type.Object(
        {
            maxSearches: positive('最多搜索调用次数，包含重试', policy.maxSearches),
            maxPages: positive('最多网页读取次数，包含重试', policy.maxPages),
            maxDurationSeconds: positive(
                '单次执行总时间预算（秒），恢复不重置期限',
                policy.maxDurationSeconds,
            ),
            maxInputTokens: positive('累计模型输入 token 上限', policy.maxInputTokens),
            maxOutputTokens: positive('累计模型输出 token 上限', policy.maxOutputTokens),
        },
        { additionalProperties: false, description: '单次执行预算，服务端部署策略另行设置上限' },
    );
}
export const BudgetSchema = createBudgetSchema();
const FixedTimeRangeObject = Type.Object(
    {
        kind: Type.Literal('fixed'),
        start: InstantSchema,
        end: InstantSchema,
    },
    { additionalProperties: false, description: '固定查阅范围，结束时间不得早于开始时间' },
);
const FixedTimeRangeSchema = refineSchema(
    FixedTimeRangeObject,
    'ScovaFixedTimeRange',
    (value) => Date.parse(value.start) <= Date.parse(value.end),
);
export const TimeRangeSchema = Type.Union(
    [
        Type.Object(
            {
                kind: Type.Literal('rolling'),
                days: Type.Integer({
                    minimum: 1,
                    maximum: Number.MAX_SAFE_INTEGER,
                    description: '每次执行向前查阅的天数',
                }),
            },
            { additionalProperties: false, description: '滚动查阅范围' },
        ),
        FixedTimeRangeSchema,
    ],
    { description: '滚动或固定时间范围' },
);
const LocalTimeSchema = Type.String({
    pattern: '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$',
    description: '任务时区的当地时分 HH:mm',
});
export const ScheduleSchema = Type.Union(
    [
        Type.Object(
            { frequency: Type.Literal('manual') },
            { additionalProperties: false, description: '仅手动执行' },
        ),
        Type.Object(
            { frequency: Type.Literal('daily'), localTime: LocalTimeSchema },
            { additionalProperties: false, description: '每日按当地时间执行' },
        ),
        Type.Object(
            {
                frequency: Type.Literal('weekly'),
                localTime: LocalTimeSchema,
                weekday: Type.Integer({
                    minimum: 1,
                    maximum: 7,
                    description: 'ISO 星期：周一为 1，周日为 7',
                }),
            },
            { additionalProperties: false, description: '每周按当地星期和时间执行' },
        ),
    ],
    { description: '首版仅手动、每日、每周；DST 消歧由调度服务统一处理' },
);
export const SourcePreferencesSchema = Type.Object(
    {
        preferredUrls: Type.Array(HttpUrlSchema, {
            uniqueItems: true,
            description: '优先查阅的来源 URL',
        }),
        excludedUrls: Type.Array(HttpUrlSchema, {
            uniqueItems: true,
            description: '排除查阅的来源 URL',
        }),
        officialOnly: Type.Boolean({ description: '是否限定官方来源；Agent 仍需验证来源性质' }),
    },
    { additionalProperties: false, description: '来源偏好，不授予任意网络地址访问权限' },
);
export const SearchModeSchema = Type.Union(
    [Type.Literal('auto'), Type.Literal('api'), Type.Literal('searxng')],
    {
        description:
            '搜索方式：auto沿用账号独立搜索配置，api使用账号搜索API，searxng使用内置SearXNG与网页读取；省略等同auto，无服务器搜索默认',
    },
);
export type SearchMode = Static<typeof SearchModeSchema>;

const TaskConfigObject = Type.Object(
    {
        title: Type.String({
            minLength: 1,
            maxLength: 200,
            pattern: '\\S',
            description: '便于识别的任务标题',
        }),
        topic: NonEmptyTextSchema,
        goal: NonEmptyTextSchema,
        focusPoints: Type.Array(NonEmptyTextSchema, { description: '重点关注事项' }),
        exclusions: Type.Array(NonEmptyTextSchema, { description: '需要排除的主题或条件' }),
        sourcePreferences: SourcePreferencesSchema,
        timeRange: TimeRangeSchema,
        timezone: TimezoneSchema,
        schedule: ScheduleSchema,
        outputFormat: OutputFormatSchema,
        outputFormats: Type.Optional(OutputFormatsSchema),
        searchMode: Type.Optional(SearchModeSchema),
        researchMode: Type.Optional(
            Type.Union([Type.Literal('collection'), Type.Literal('analysis')], {
                description:
                    '资料收集汇集当前来源内容；分析研究核对时间、支持关系与条件。省略沿用分析研究',
            }),
        ),
        agentProviderId: Type.Optional(
            Type.String({
                ...UuidSchema,
                description: '指定本账号执行Agent配置；省略时使用账号默认',
            }),
        ),
        budget: BudgetSchema,
        notificationPreference: NotificationPreferenceSchema,
    },
    { additionalProperties: false, description: '可编辑查阅任务配置；持久化后以不可变版本保存' },
);
export const TaskConfigSchema = refineSchema(
    TaskConfigObject,
    'ScovaTaskConfig',
    (value) => !value.outputFormats || value.outputFormats[0] === value.outputFormat,
);
export const CreateTaskInputSchema = Type.Object(
    {
        inputText: Type.Optional(NonEmptyTextSchema),
        config: TaskConfigSchema,
    },
    {
        additionalProperties: false,
        description: '保存手工配置或已确认的自然语言草稿，不接受 owner/userId',
    },
);
export const UpdateTaskInputSchema = CreateTaskInputSchema;
export const TaskVersionSchema = Type.Object(
    {
        id: UuidSchema,
        taskId: UuidSchema,
        version: RevisionSchema,
        configSchemaVersion: Type.Literal(1, { description: '配置结构版本' }),
        config: TaskConfigSchema,
        comparisonScopeHash: Type.String({
            pattern: '^[0-9a-f]{64}$',
            description: '服务端计算的语义比较范围 SHA-256，不由客户端指定',
        }),
        createdAt: InstantSchema,
    },
    { additionalProperties: false, description: '不可变任务配置版本' },
);
export const TaskSchema = Type.Object(
    {
        id: UuidSchema,
        title: Type.String({
            minLength: 1,
            maxLength: 200,
            pattern: '\\S',
            description: '当前任务标题',
        }),
        status: TaskStatusSchema,
        revision: RevisionSchema,
        currentVersionId: UuidSchema,
        nextRunAt: Type.Union([InstantSchema, Type.Null()], {
            description: '下次 UTC 执行时刻；手动、暂停或归档时可为空',
        }),
        createdAt: InstantSchema,
        updatedAt: InstantSchema,
    },
    { additionalProperties: false, description: '长期任务摘要，不等同于配置版本或单次执行' },
);
export const TaskDetailResponseSchema = Type.Object(
    {
        task: TaskSchema,
        version: TaskVersionSchema,
        baselineResetRequired: Type.Boolean({
            description: '语义查阅范围是否变化，下一次完整执行需要建立新基线',
        }),
    },
    { additionalProperties: false, description: '任务摘要与当前不可变配置版本' },
);
export const TaskListResponseSchema = Type.Object(
    {
        items: Type.Array(TaskSchema, { description: '当前账号可见的任务摘要' }),
        nextCursor: Type.Union([
            Type.String({ minLength: 1, description: '下一页游标' }),
            Type.Null({ description: '没有下一页' }),
        ]),
    },
    { additionalProperties: false, description: '按更新时间倒序的任务列表' },
);
for (const schema of [
    TimeRangeSchema,
    ScheduleSchema,
    TaskConfigSchema,
    CreateTaskInputSchema,
    UpdateTaskInputSchema,
    TaskVersionSchema,
    TaskSchema,
    TaskDetailResponseSchema,
    TaskListResponseSchema,
])
    describeProperties(schema);
export type Budget = Static<typeof BudgetSchema>;
export type TimeRange = Static<typeof TimeRangeSchema>;
export type Schedule = Static<typeof ScheduleSchema>;
export type TaskConfig = Static<typeof TaskConfigSchema>;
export type CreateTaskInput = Static<typeof CreateTaskInputSchema>;
export type UpdateTaskInput = Static<typeof UpdateTaskInputSchema>;
export type Task = Static<typeof TaskSchema>;
export type TaskVersion = Static<typeof TaskVersionSchema>;
export type TaskDetailResponse = Static<typeof TaskDetailResponseSchema>;
export type TaskListResponse = Static<typeof TaskListResponseSchema>;
