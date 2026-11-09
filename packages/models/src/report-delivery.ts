import { Type, type Static } from '@sinclair/typebox';
import { refineSchema } from './common.ts';
import type { ReportValue } from './report-value.ts';

const count = (description: string) => Type.Integer({ minimum: 0, maximum: 20, description });
export const ReportDeliverySchema = refineSchema(
    Type.Object(
        {
            status: Type.Union([
                Type.Literal('answered'),
                Type.Literal('partial'),
                Type.Literal('sources_only'),
            ]),
            answeredQuestions: count('已有引用支撑回答的问题数，允许条件与分歧'),
            questionCount: count('本次请求的问题总数'),
            answeredCoreQuestions: count('已有引用支撑回答的核心问题数'),
            coreQuestionCount: count('原始目标及明确必答问题总数'),
        },
        {
            additionalProperties: false,
            description: '内容交付情况，独立于严格查阅覆盖和连续比较基线',
        },
    ),
    'ScovaReportDelivery',
    (v) =>
        v.answeredQuestions <= v.questionCount &&
        v.answeredCoreQuestions <= v.coreQuestionCount &&
        v.answeredCoreQuestions <= v.answeredQuestions &&
        v.coreQuestionCount <= v.questionCount &&
        (v.status === 'answered'
            ? v.coreQuestionCount > 0 && v.answeredCoreQuestions === v.coreQuestionCount
            : v.status === 'partial'
              ? v.answeredQuestions > 0 && v.answeredCoreQuestions < v.coreQuestionCount
              : v.answeredQuestions === 0),
);
export type ReportDelivery = Static<typeof ReportDeliverySchema>;

/** Conditions, disputed views and unknown publication dates do not erase a cited answer.
 * This classification never certifies truth, complete coverage or a comparison baseline. */
export function classifyReportDelivery(
    value: ReportValue | undefined,
    claims: readonly { kind: string }[],
): ReportDelivery {
    const questions = value?.questions ?? [];
    const answered = questions.filter((q) =>
        q.claimIndexes.some((index) => {
            const selection = value?.selections.find((s) => s.claimIndex === index);
            return (
                claims[index] &&
                claims[index].kind !== 'insufficient' &&
                selection?.placement === 'main' &&
                selection.questionIds.includes(q.id) &&
                selection.assessment?.relevance === 'direct' &&
                ['direct', 'partial'].includes(selection.assessment.support) &&
                selection.assessment.role !== 'lead'
            );
        }),
    );
    const coreQuestionCount = questions.filter((q) => q.priority === 'core').length;
    const answeredCoreQuestions = answered.filter((q) => q.priority === 'core').length;
    return {
        status:
            coreQuestionCount > 0 && answeredCoreQuestions === coreQuestionCount
                ? 'answered'
                : answered.length
                  ? 'partial'
                  : 'sources_only',
        answeredQuestions: answered.length,
        questionCount: questions.length,
        answeredCoreQuestions,
        coreQuestionCount,
    };
}

export const reportDeliveryLabels: Record<ReportDelivery['status'], string> = {
    answered: '核心问题已回答',
    partial: '已生成部分答案',
    sources_only: '已保存来源资料',
};
