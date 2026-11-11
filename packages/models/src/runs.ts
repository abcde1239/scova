import { Type, type Static } from '@sinclair/typebox';
import { OutputFormatsSchema } from './output-formats.ts';
import {
    InstantSchema,
    ModeSchema,
    NonEmptyTextSchema,
    RunOutcomeSchema,
    RunStatusSchema,
    OutputFormatSchema,
    UuidSchema,
    refineSchema,
    describeProperties,
} from './common.ts';
import { BudgetSchema } from './tasks.ts';
import { ReportValueSchema } from './report-value.ts';
import { ReportDeliverySchema } from './report-delivery.ts';
import { ReportArtifactSchema } from './report-artifacts.ts';

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
        artifacts: Type.Optional(
            Type.Array(ReportArtifactSchema, {
                minItems: 1,
                maxItems: 4,
                description: '本次实际生成的独立成果与结论索引，缺失表示历史单形式报告',
            }),
        ),
        reportValue: Type.Optional(ReportValueSchema),
        delivery: Type.Optional(ReportDeliverySchema),
        notes: Type.Optional(
            Type.Array(NonEmptyTextSchema, {
                maxItems: 1200,
                description: '筛选策略与背景说明，不代表执行失败或已确认的事实',
            }),
        ),
        research: Type.Optional(
            Type.Object(
                {
                    candidates: CountSchema,
                    selected: CountSchema,
                    readAttempts: CountSchema,
                    readSuccess: CountSchema,
                    relatedPages: CountSchema,
                    supplementalSearches: CountSchema,
                    acceptedClaims: CountSchema,
                    uncertainClaims: Type.Optional(CountSchema),
                    rejectedClaims: CountSchema,
                    cacheHits: CountSchema,
                    networkAttempts: CountSchema,
                },
                {
                    additionalProperties: false,
                    description:
                        '当前运行研究统计；相关性为启发式筛选，不代表事实认证；旧记录可缺省',
                },
            ),
        ),
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
const RunCommandInputObject = Type.Object(
    {
        mode: Type.Optional(Type.Literal('live')),
        outputFormat: Type.Optional(OutputFormatSchema),
        outputFormats: Type.Optional(OutputFormatsSchema),
        agentProviderId: Type.Optional(
            Type.Union([UuidSchema, Type.Null()], {
                description: '本次执行使用的本人Agent配置；省略沿用任务配置，null使用账号默认',
            }),
        ),
    },
    {
        additionalProperties: false,
        description: '启动真实研究；可省略 mode，缺少必要服务配置时明确失败',
    },
);
export const RunCommandInputSchema = refineSchema(
    RunCommandInputObject,
    'ScovaRunCommandInput',
    (value) =>
        !value.outputFormat ||
        !value.outputFormats ||
        value.outputFormats[0] === value.outputFormat,
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
