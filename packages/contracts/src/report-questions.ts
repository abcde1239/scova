import { Type, type Static } from '@sinclair/typebox';
import { UuidSchema, InstantSchema, describeProperties } from './common.ts';
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
export const ReportQuestionInputSchema = Type.Object(
    { question: QuestionText },
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
        text: Type.String({
            minLength: 1,
            maxLength: 2000,
            description: '来自所列引用的逐字原文摘录，不构成事实真实性认证',
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
        createdAt: InstantSchema,
    },
    { additionalProperties: false },
);
export const QuestionFollowupInputSchema = Type.Object(
    { confirm: Type.Literal(true, { description: '明确同意使用原报告执行预算进行新搜索' }) },
    { additionalProperties: false },
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
