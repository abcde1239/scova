import { Type, type Static } from '@sinclair/typebox';
import { describeProperties, FieldErrorSchema, TimezoneSchema } from './common.ts';
import { TaskConfigSchema, type TaskConfig } from './tasks.ts';

const InputTextSchema = Type.String({
    minLength: 1,
    maxLength: 2000,
    pattern: '\\S',
    description: '原始需求描述，最多2000个字符且不超过8000 UTF-8字节；服务端原样返回',
});
export const TaskDraftScopeSchema = Type.Object(
    {
        goal: Type.String({
            minLength: 1,
            maxLength: 2000,
            pattern: '\\S',
            description: '问答确认的查阅目标',
        }),
        focusPoints: Type.Array(Type.String({ minLength: 1, maxLength: 1000, pattern: '\\S' }), {
            maxItems: 10,
        }),
        exclusions: Type.Array(Type.String({ minLength: 1, maxLength: 1000, pattern: '\\S' }), {
            maxItems: 10,
        }),
        sourcePreferences: Type.Object(
            {
                ...TaskConfigSchema.properties.sourcePreferences.properties,
                preferredUrls: Type.Array(
                    TaskConfigSchema.properties.sourcePreferences.properties.preferredUrls.items,
                    { maxItems: 10, uniqueItems: true },
                ),
                excludedUrls: Type.Array(
                    TaskConfigSchema.properties.sourcePreferences.properties.excludedUrls.items,
                    { maxItems: 10, uniqueItems: true },
                ),
            },
            { additionalProperties: false },
        ),
        timeRange: TaskConfigSchema.properties.timeRange,
        outputFormat: TaskConfigSchema.properties.outputFormat,
        researchMode: Type.Union([Type.Literal('collection'), Type.Literal('analysis')]),
    },
    {
        additionalProperties: false,
        description: '生成草稿前经用户确认的搜索范围，模型不得扩大；不创建或执行任务',
    },
);
export type TaskDraftScope = Static<typeof TaskDraftScopeSchema>;
/** Compare confirmed user choices independently of JSON property order. */
export function taskDraftScopeMatches(scope: TaskDraftScope, config: TaskConfig): boolean {
    const sameItems = (a: string[], b: string[]) =>
        a.length === b.length && a.every((item, index) => item === b[index]);
    return (
        scope.goal === config.goal &&
        sameItems(scope.focusPoints, config.focusPoints) &&
        sameItems(scope.exclusions, config.exclusions) &&
        sameItems(scope.sourcePreferences.preferredUrls, config.sourcePreferences.preferredUrls) &&
        sameItems(scope.sourcePreferences.excludedUrls, config.sourcePreferences.excludedUrls) &&
        scope.sourcePreferences.officialOnly === config.sourcePreferences.officialOnly &&
        (scope.timeRange.kind === 'rolling'
            ? config.timeRange.kind === 'rolling' && scope.timeRange.days === config.timeRange.days
            : config.timeRange.kind === 'fixed' &&
              scope.timeRange.start === config.timeRange.start &&
              scope.timeRange.end === config.timeRange.end) &&
        scope.outputFormat === config.outputFormat &&
        scope.researchMode === config.researchMode
    );
}
export const TaskDraftInputSchema = Type.Object(
    {
        inputText: InputTextSchema,
        timezone: Type.Optional(TimezoneSchema),
        searchScope: Type.Optional(TaskDraftScopeSchema),
    },
    {
        additionalProperties: false,
        description: '只解析未保存草稿；依次采用显式时区、原文明确时区、用户默认时区',
    },
);
export const TaskDraftUsageSchema = Type.Object(
    {
        attempts: Type.Integer({
            minimum: 0,
            maximum: 2,
            description: '已预留的模型调用次数，含修复',
        }),
        inputTokens: Type.Integer({
            minimum: 0,
            description: '独立解析输入用量；未知调用保留预留',
        }),
        outputTokens: Type.Integer({
            minimum: 0,
            description: '独立解析输出用量；未知调用保留预留',
        }),
        estimated: Type.Boolean({ description: '是否含保守预留或估算用量' }),
    },
    { additionalProperties: false, description: '不计入任何Run预算的本次草稿解析用量' },
);
export const TaskDraftResponseSchema = Type.Object(
    {
        inputText: InputTextSchema,
        config: TaskConfigSchema,
        mode: Type.Union([Type.Literal('model'), Type.Literal('manual')], {
            description: '模型解析成功或需手工编辑；不使用固定演示资料冒充解析',
        }),
        requiresConfirmation: Type.Literal(true, {
            description: '所有草稿必须经用户确认后另行保存',
        }),
        manualReason: Type.Union(
            [
                Type.Literal('model_unavailable'),
                Type.Literal('ambiguous_timezone'),
                Type.Literal('invalid_output'),
                Type.Literal('timeout'),
                Type.Literal('aborted'),
                Type.Literal('budget_exceeded'),
                Type.Literal('model_failed'),
                Type.Null(),
            ],
            { description: '手工回退的脱敏原因；模型解析成功时为空' },
        ),
        warnings: Type.Array(FieldErrorSchema, {
            description: '安全默认、待确认计划及手工编辑提示',
        }),
        parsingUsage: TaskDraftUsageSchema,
    },
    { additionalProperties: false, description: '未持久化的完整可编辑草稿，不创建任务或执行' },
);
for (const schema of [
    TaskDraftScopeSchema,
    TaskDraftInputSchema,
    TaskDraftUsageSchema,
    TaskDraftResponseSchema,
])
    describeProperties(schema);
export type TaskDraftInput = Static<typeof TaskDraftInputSchema>;
export type TaskDraftResponse = Static<typeof TaskDraftResponseSchema>;
export type TaskDraftUsage = Static<typeof TaskDraftUsageSchema>;
