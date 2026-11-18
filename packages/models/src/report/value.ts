import { Type, type Static } from '@sinclair/typebox';
import { refineSchema } from '../common/schema.ts';

const text = (maxLength: number, minLength = 0) => Type.String({ minLength, maxLength });
const ids = Type.Array(text(50, 1), { maxItems: 20, uniqueItems: true });
const indexes = Type.Array(Type.Integer({ minimum: 0, maximum: 299 }), {
    maxItems: 300,
    uniqueItems: true,
});

const assessmentProperties = {
    relevance: Type.Union([
        Type.Literal('direct'),
        Type.Literal('background'),
        Type.Literal('unrelated'),
        Type.Literal('unknown'),
    ]),
    support: Type.Union([
        Type.Literal('direct'),
        Type.Literal('partial'),
        Type.Literal('none'),
        Type.Literal('unknown'),
    ]),
    role: Type.Union([
        Type.Literal('answer'),
        Type.Literal('comparison'),
        Type.Literal('condition'),
        Type.Literal('risk'),
        Type.Literal('lead'),
    ]),
    sourceRelation: Type.Union([
        Type.Literal('original'),
        Type.Literal('secondary'),
        Type.Literal('unknown'),
    ]),
    reason: text(500, 1),
    conditions: text(500),
    gap: text(500),
};
const assessmentOptions = {
    additionalProperties: false,
    description: '模型对问题关联和支持关系的自评，不是事实认证',
};
/** Legacy synthesis wire schema; kept byte-identical for existing receipts and providers. */
export const ClaimAssessmentWireSchema = Type.Object(assessmentProperties, assessmentOptions);
/** Only missing_core blocks support; detail and condition gaps stay visible without vetoing the answer. */
export const GapKindSchema = Type.Union(
    [
        Type.Literal('none'),
        Type.Literal('missing_core'),
        Type.Literal('missing_detail'),
        Type.Literal('condition'),
    ],
    {
        description:
            '缺口类别：none 无缺口，missing_core 缺主命题，missing_detail 缺次要细节，condition 需保留适用条件',
    },
);
/** A model's assessment of its own answer, never an independent verification. */
export const ClaimAssessmentSchema = Type.Object(
    { ...assessmentProperties, gapKind: Type.Optional(GapKindSchema) },
    assessmentOptions,
);
export type ClaimAssessment = Static<typeof ClaimAssessmentSchema>;

const ReportValueObject = Type.Object(
    {
        timeless: Type.Optional(
            Type.Literal(true, {
                description: '该任务未要求来源在时间窗口内新发布；时间元数据仍保留真实未知',
            }),
        ),
        researchMode: Type.Optional(
            Type.Literal('collection', {
                description: '以读取到的来源信息回答，不认证发布时间；timeScope保留真实判定',
            }),
        ),
        version: Type.Literal(1),
        questions: Type.Array(
            Type.Object(
                {
                    id: text(50, 1),
                    text: Type.String({ minLength: 1 }),
                    priority: Type.Union([Type.Literal('core'), Type.Literal('supporting')]),
                    status: Type.Union([
                        Type.Literal('supported'),
                        Type.Literal('provisional'),
                        Type.Literal('disputed'),
                        Type.Literal('unresolved'),
                    ]),
                    claimIndexes: indexes,
                    gap: text(1000),
                },
                { additionalProperties: false },
            ),
            { minItems: 1, maxItems: 20 },
        ),
        selections: Type.Array(
            Type.Object(
                {
                    claimIndex: Type.Integer({ minimum: 0, maximum: 299 }),
                    questionIds: ids,
                    placement: Type.Union([
                        Type.Literal('main'),
                        Type.Literal('reference'),
                        Type.Literal('omitted'),
                    ]),
                    reason: text(500, 1),
                    basis: Type.Union([
                        Type.Literal('model_assessment'),
                        Type.Literal('model_knowledge'),
                        Type.Literal('unassessed'),
                    ]),
                    timeScope: Type.Union([
                        Type.Literal('within'),
                        Type.Literal('background'),
                        Type.Literal('unknown'),
                    ]),
                    assessment: Type.Optional(ClaimAssessmentSchema),
                },
                { additionalProperties: false },
            ),
            { minItems: 1, maxItems: 300 },
        ),
    },
    {
        additionalProperties: false,
        description: '固定问题、答案状态及正文选择，索引绑定报告结论顺序',
    },
);
export const ReportValueSchema = refineSchema(ReportValueObject, 'ScovaReportValue', (value) => {
    const questionIds = new Set(value.questions.map((q) => q.id));
    const selections = new Map(value.selections.map((s) => [s.claimIndex, s]));
    return (
        questionIds.size === value.questions.length &&
        selections.size === value.selections.length &&
        value.questions.some((q) => q.priority === 'core') &&
        value.selections.every(
            (s) =>
                s.questionIds.every((id) => questionIds.has(id)) &&
                (s.basis !== 'unassessed') === !!s.assessment &&
                (s.basis !== 'model_knowledge' ||
                    (s.assessment?.support === 'none' && !s.assessment.gap)) &&
                (s.placement !== 'main' ||
                    (s.assessment?.relevance === 'direct' &&
                        (s.basis === 'model_knowledge' ||
                            ['direct', 'partial'].includes(s.assessment.support)) &&
                        s.assessment.role !== 'lead' &&
                        s.questionIds.length > 0)),
        ) &&
        value.questions.every(
            (q) =>
                (q.status === 'unresolved') === (q.claimIndexes.length === 0) &&
                (q.status !== 'supported' ||
                    (!q.gap &&
                        q.claimIndexes.every((index) => {
                            const selection = selections.get(index);
                            return (
                                !!selection &&
                                (selection.timeScope === 'within' ||
                                    value.timeless === true ||
                                    value.researchMode === 'collection') &&
                                selection.assessment?.support === 'direct' &&
                                !selection.assessment.gap
                            );
                        }))) &&
                q.claimIndexes.every((index) => {
                    const selection = selections.get(index);
                    return selection?.placement === 'main' && selection.questionIds.includes(q.id);
                }),
        )
    );
});
export type ReportValue = Static<typeof ReportValueSchema>;

/** Detail responses additionally bind every selection to the immutable claim order. */
export function validReportValueClaims(value: ReportValue, claimCount: number): boolean {
    return (
        value.selections.length === claimCount &&
        value.selections.every((s) => s.claimIndex < claimCount) &&
        value.selections.every(
            (s) =>
                s.placement !== 'main' ||
                s.questionIds.every((id) =>
                    value.questions.find((q) => q.id === id)?.claimIndexes.includes(s.claimIndex),
                ),
        )
    );
}
