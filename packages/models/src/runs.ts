import { Type, type Static } from '@sinclair/typebox';
import {
    InstantSchema,
    ModeSchema,
    NonEmptyTextSchema,
    RunOutcomeSchema,
    RunStatusSchema,
    UuidSchema,
    refineSchema,
    describeProperties,
} from './common.ts';
import { BudgetSchema } from './tasks.ts';

const CountSchema = Type.Integer({
    minimum: 0,
    maximum: Number.MAX_SAFE_INTEGER,
    description: '非负安全整数计数',
});
export const UsageSchema = Type.Object(
    {
        searches: CountSchema,
        pages: CountSchema,
        inputTokens: CountSchema,
        outputTokens: CountSchema,
        estimated: Type.Boolean({ description: '模型未返回计量时是否使用保守估算' }),
    },
    { additionalProperties: false, description: '包含重试与恢复期间累计消耗的预算用量' },
);
export const CoverageSchema = Type.Object(
    {
        completeness: Type.Union([Type.Literal('complete'), Type.Literal('partial')]),
        searchedQueries: Type.Array(NonEmptyTextSchema, {
            description: '已经执行的查询摘要，不包含完整提示词',
        }),
        gaps: Type.Array(NonEmptyTextSchema, { description: '未覆盖子问题、失败来源或未核验冲突' }),
        exhausted: Type.Array(
            Type.Union([
                Type.Literal('searches'),
                Type.Literal('pages'),
                Type.Literal('time'),
                Type.Literal('input_tokens'),
                Type.Literal('output_tokens'),
            ]),
            { uniqueItems: true, description: '已耗尽的预算维度' },
        ),
    },
    {
        additionalProperties: false,
        description: '由系统判定的查阅覆盖范围，complete 不等于互联网穷尽',
    },
);
const RunObject = Type.Object(
    {
        id: UuidSchema,
        taskId: UuidSchema,
        taskVersionId: UuidSchema,
        parentRunId: Type.Union([UuidSchema, Type.Null()]),
        baselineRunId: Type.Union([UuidSchema, Type.Null()]),
        mode: ModeSchema,
        status: RunStatusSchema,
        outcome: Type.Union([RunOutcomeSchema, Type.Null()]),
        trigger: Type.Union([
            Type.Literal('manual'),
            Type.Literal('scheduled'),
            Type.Literal('retry'),
            Type.Literal('followup'),
        ]),
        budget: BudgetSchema,
        usage: UsageSchema,
        coverage: Type.Union([CoverageSchema, Type.Null()]),
        queuedAt: InstantSchema,
        startedAt: Type.Union([InstantSchema, Type.Null()]),
        finishedAt: Type.Union([InstantSchema, Type.Null()]),
        failureCode: Type.Union([NonEmptyTextSchema, Type.Null()]),
    },
    {
        additionalProperties: false,
        description: '执行公共快照，不暴露租约、checkpoint 或数据库内部字段',
    },
);
export const RunSchema = refineSchema(RunObject, 'ScovaRun', (value) => {
    if (value.status === 'succeeded' && value.coverage?.completeness !== 'complete') return false;
    if (value.status === 'partial' && value.coverage?.completeness !== 'partial') return false;
    return (
        !['no_important_change', 'baseline'].includes(value.outcome ?? '') ||
        (value.status === 'succeeded' && value.coverage?.completeness === 'complete')
    );
});
export const RunListResponseSchema = Type.Object(
    {
        items: Type.Array(RunSchema, { description: '当前账号此任务的执行历史' }),
        nextCursor: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    },
    { additionalProperties: false, description: '按排队时间与ID倒序的执行历史，游标绑定任务' },
);
describeProperties(RunListResponseSchema);
export const RunCommandResponseSchema = Type.Object(
    { run: RunSchema, reused: Type.Boolean({ description: '是否返回已经存在的活动执行' }) },
    { additionalProperties: false, description: '执行命令的普通 JSON 响应；首次入队使用 HTTP 202' },
);
export const RunCommandInputSchema = Type.Object(
    {
        mode: Type.Optional(Type.Literal('live')),
    },
    {
        additionalProperties: false,
        description: '启动真实研究；可省略 mode，缺少必要服务配置时明确失败',
    },
);
for (const schema of [
    UsageSchema,
    CoverageSchema,
    RunSchema,
    RunCommandInputSchema,
    RunCommandResponseSchema,
])
    describeProperties(schema);
export type Usage = Static<typeof UsageSchema>;
export type Coverage = Static<typeof CoverageSchema>;
export type Run = Static<typeof RunSchema>;
export type RunCommandResponse = Static<typeof RunCommandResponseSchema>;
export type RunCommandInput = Static<typeof RunCommandInputSchema>;
