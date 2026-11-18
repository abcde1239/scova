import { Type, type Static } from '@sinclair/typebox';
import type { ReportArtifact } from '../report/artifacts.ts';
import type { ReportValue } from '../report/value.ts';
import { classifyReportDelivery } from '../report/delivery.ts';

const count = Type.Integer({ minimum: 0, maximum: 240 });
export const ResearchMetricsSchema = Type.Object(
    {
        version: Type.Literal(1),
        questionCount: count,
        answeredQuestions: count,
        externallySupportedQuestions: count,
        unresolvedQuestionIds: Type.Array(Type.String({ minLength: 1, maxLength: 50 }), {
            maxItems: 20,
            uniqueItems: true,
        }),
        requiredFields: count,
        answeredFields: count,
        externallySupportedFields: count,
    },
    {
        additionalProperties: false,
        description:
            '回答完成、外部证据支持、未解决请求分别统计；外部支持来自模型语义评估，不是独立事实核查',
    },
);
export type ResearchMetrics = Static<typeof ResearchMetricsSchema>;

export function researchCoverageMetrics(
    value: ReportValue | undefined,
    claims: readonly { kind: string }[],
    artifacts?: readonly ReportArtifact[],
): ResearchMetrics {
    const questions = value?.questions ?? [];
    const fields =
        artifacts?.flatMap((a) => a.coverage?.requirements ?? []).filter((r) => r.required) ?? [];
    const answered = questions.filter(
        (q) =>
            classifyReportDelivery(value && { ...value, questions: [q] }, claims, artifacts)
                .answeredQuestions === 1,
    );
    const externallySupported = answered.filter((q) => {
        const required = fields.filter((r) => r.questionIds.includes(q.id));
        return required.length
            ? required.every(
                  (r) =>
                      r.status === 'supported' &&
                      r.claimIndexes.every(
                          (i) =>
                              !['model_answer', 'conflict', 'insufficient'].includes(
                                  claims[i]?.kind ?? 'insufficient',
                              ),
                      ),
              )
            : q.status === 'supported';
    });
    return {
        version: 1,
        questionCount: questions.length,
        answeredQuestions: answered.length,
        externallySupportedQuestions: externallySupported.length,
        unresolvedQuestionIds: questions.filter((q) => !answered.includes(q)).map((q) => q.id),
        requiredFields: fields.length,
        answeredFields: fields.filter((r) => ['supported', 'model_answered'].includes(r.status))
            .length,
        externallySupportedFields: fields.filter((r) => r.status === 'supported').length,
    };
}

export const PropositionEvidenceSchema = Type.Array(
    Type.Object(
        {
            claimIndex: Type.Integer({ minimum: 0, maximum: 299 }),
            requirementIds: Type.Array(Type.String({ minLength: 1, maxLength: 80 }), {
                maxItems: 240,
                uniqueItems: true,
            }),
            conditions: Type.String({ maxLength: 2000 }),
            support: Type.Union([
                Type.Literal('direct'),
                Type.Literal('partial'),
                Type.Literal('none'),
                Type.Literal('unknown'),
            ]),
            passages: Type.Array(
                Type.Object(
                    {
                        pageId: Type.String({ minLength: 1, maxLength: 80 }),
                        contentHash: Type.String({ pattern: '^[a-f0-9]{64}$' }),
                        start: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
                        end: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
                    },
                    { additionalProperties: false },
                ),
                { maxItems: 10 },
            ),
        },
        { additionalProperties: false },
    ),
    {
        maxItems: 300,
        description:
            '按结论命题保存字段绑定、必要条件、模型支持评估及原文UTF-16区间；正文hash对应不可变读取快照',
    },
);
