import { Type, type Static } from '@sinclair/typebox';
import { UuidSchema, InstantSchema, describeProperties } from '../common/schema.ts';
import { RunCommandResponseSchema } from '../research/runs.ts';
import { ReportFollowupSearchSchema } from './conversation.ts';
import { OutputFormatsSchema } from '../task/output-formats.ts';
const QuestionUsageSchema = Type.Object(
    {
        attempts: Type.Integer({
            minimum: 0,
            maximum: 1,
            description: '本次预留的问答模型尝试次数',
        }),
        inputTokens: Type.Integer({
            minimum: 0,
            description: '独立问答输入用量，未知调用保留预留',
        }),
        outputTokens: Type.Integer({ minimum: 0, description: '独立问答输出用量' }),
        estimated: Type.Boolean({ description: '是否含保守估算或未知调用预留' }),
    },
    { additionalProperties: false, description: '不计入任何Run预算的本次证据问答用量' },
);
describeProperties(QuestionUsageSchema);
const QuestionText = Type.String({
    minLength: 1,
    maxLength: 2000,
    pattern: '\\S',
    description: '围绕报告的纯文本问题，最多2000字符',
});
const conversationQuestionProperties = {
    question: QuestionText,
    afterQuestionId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
};
export const ReportQuestionInputSchema = Type.Object(
    {
        ...conversationQuestionProperties,
        agentProviderId: Type.Optional({
            ...UuidSchema,
            description: '仅本轮问答使用的账号模型配置标识',
        }),
    },
    { additionalProperties: false, description: '仅查阅此报告授权引用，不启动搜索' },
);
export const QuestionCitationSchema = Type.Object(
    {
        evidenceId: UuidSchema,
        quote: Type.String({
            minLength: 1,
            maxLength: 4000,
            description: '必须逐字包含在报告引用内的原文',
        }),
    },
    { additionalProperties: false },
);
export const QuestionStatementSchema = Type.Object(
    {
        kind: Type.Optional(Type.Union([Type.Literal('fact'), Type.Literal('inference')])),
        text: Type.String({
            minLength: 1,
            maxLength: 2000,
            description: '基于报告证据的解释或归纳；引用原文须逐字匹配，不构成事实真实性认证',
        }),
        citations: Type.Array(QuestionCitationSchema, {
            minItems: 1,
            maxItems: 8,
            description: '本条回答的报告原文引用',
        }),
    },
    { additionalProperties: false },
);
export const QuestionAnswerSchema = Type.Object(
    {
        status: Type.Union([Type.Literal('answered'), Type.Literal('insufficient')]),
        statements: Type.Array(QuestionStatementSchema, { maxItems: 8 }),
        reason: Type.Union([
            Type.Literal('evidence_answer'),
            Type.Literal('insufficient_evidence'),
            Type.Literal('model_unavailable'),
            Type.Literal('model_failed'),
            Type.Literal('invalid_output'),
            Type.Literal('aborted'),
        ]),
        needsResearch: Type.Boolean({ description: '资料不足时可由用户另行明确确认后续研究' }),
        usage: QuestionUsageSchema,
    },
    {
        additionalProperties: false,
        description: '独立问答用量与经授权原文核验的回答；失败调用保留预算预留',
    },
);
export const ReportQuestionSchema = Type.Object(
    {
        id: UuidSchema,
        reportId: UuidSchema,
        question: QuestionText,
        answer: QuestionAnswerSchema,
        followupRunId: Type.Union([UuidSchema, Type.Null()]),
        revisionRunId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
        createdAt: InstantSchema,
    },
    { additionalProperties: false },
);
export const ReportRequestedQuestionSchema = describeProperties(
    Type.Object(
        {
            ...ReportQuestionSchema.properties,
            answer: Type.Null(),
            followupRunId: UuidSchema,
            searchSelection: ReportFollowupSearchSchema,
        },
        { additionalProperties: false },
    ),
);
export const ReportQuestionDetailSchema = Type.Union([
    ReportQuestionSchema,
    ReportRequestedQuestionSchema,
]);
const followupProperties = {
    ...conversationQuestionProperties,
    confirm: Type.Literal(true),
    outputFormats: Type.Optional(OutputFormatsSchema),
};
export const ReportFollowupInputSchema = Type.Union([
    describeProperties(
        Type.Object(
            {
                ...followupProperties,
                ...ReportFollowupSearchSchema.anyOf[0].properties,
            },
            { additionalProperties: false },
        ),
    ),
    describeProperties(
        Type.Object(
            {
                ...followupProperties,
                ...ReportFollowupSearchSchema.anyOf[1].properties,
            },
            { additionalProperties: false },
        ),
    ),
]);
export type ReportFollowupInput = Static<typeof ReportFollowupInputSchema>;
export const ReportFollowupResponseSchema = describeProperties(
    Type.Object(
        { question: ReportRequestedQuestionSchema, ...RunCommandResponseSchema.properties },
        { additionalProperties: false },
    ),
);
export const QuestionFollowupInputSchema = Type.Object(
    {
        confirm: Type.Literal(true, { description: '明确同意使用原报告执行预算生成新成果' }),
        operation: Type.Optional(Type.Union([Type.Literal('research'), Type.Literal('revise')])),
        outputFormats: Type.Optional(OutputFormatsSchema),
    },
    { additionalProperties: false },
);
export const ReportMergeInputSchema = describeProperties(
    Type.Object(
        {
            confirm: Type.Literal(true),
            reportIds: Type.Array(UuidSchema, {
                minItems: 1,
                maxItems: 8,
                uniqueItems: true,
                description: '同一原报告对话生成的续作，原报告自动包含',
            }),
            outputFormats: Type.Optional(OutputFormatsSchema),
        },
        { additionalProperties: false },
    ),
);
for (const schema of [
    ReportQuestionInputSchema,
    QuestionCitationSchema,
    QuestionStatementSchema,
    QuestionAnswerSchema,
    ReportQuestionSchema,
    QuestionFollowupInputSchema,
])
    describeProperties(schema);
export type QuestionAnswer = Static<typeof QuestionAnswerSchema>;
export type ReportQuestion = Static<typeof ReportQuestionSchema>;
export const ReportConversationSchema = Type.Object(
    {
        reportId: UuidSchema,
        turns: Type.Array(
            Type.Object(
                {
                    ...ReportQuestionSchema.properties,
                    round: Type.Optional(Type.Integer({ minimum: 1 })),
                    searchSelection: Type.Optional(ReportFollowupSearchSchema),
                    answer: Type.Union([QuestionAnswerSchema, Type.Null()]),
                },
                { additionalProperties: false },
            ),
            { maxItems: 100 },
        ),
        hasEarlier: Type.Boolean(),
        artifacts: Type.Optional(
            Type.Array(
                Type.Object(
                    {
                        reportId: UuidSchema,
                        questionId: UuidSchema,
                        runId: UuidSchema,
                        operation: Type.Union([
                            Type.Literal('research'),
                            Type.Literal('revise'),
                            Type.Literal('merge'),
                        ]),
                        title: Type.String(),
                        round: Type.Optional(Type.Integer({ minimum: 1 })),
                    },
                    { additionalProperties: false },
                ),
                { maxItems: 200 },
            ),
        ),
        activeRun: Type.Optional(Type.Boolean()),
        continuations: Type.Optional(
            Type.Array(
                Type.Object(
                    {
                        runId: UuidSchema,
                        rootRunId: UuidSchema,
                        questionId: UuidSchema,
                        operation: Type.Union([Type.Literal('research'), Type.Literal('revise')]),
                    },
                    { additionalProperties: false },
                ),
                { maxItems: 200 },
            ),
        ),
        mergeRuns: Type.Optional(
            Type.Array(
                Type.Object(
                    {
                        runId: UuidSchema,
                        rootRunId: Type.Optional(UuidSchema),
                        questionId: UuidSchema,
                        round: Type.Optional(Type.Integer({ minimum: 1 })),
                    },
                    { additionalProperties: false },
                ),
                { maxItems: 100 },
            ),
        ),
    },
    { additionalProperties: false },
);
export type ReportConversation = Static<typeof ReportConversationSchema>;
describeProperties(ReportConversationSchema);
export const ReportConversationQuerySchema = describeProperties(
    Type.Object(
        { beforeQuestionId: Type.Optional(UuidSchema) },
        { additionalProperties: false, description: '读取指定轮次之前的会话历史，每页最多100轮' },
    ),
);
