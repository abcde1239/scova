import { Type, type Static } from '@sinclair/typebox';
import { parseContract } from '../common/validation.ts';
import {
    HttpUrlSchema,
    InstantSchema,
    UuidSchema,
    refineSchema,
    describeProperties,
} from '../common/schema.ts';

export const FeedbackKindSchema = Type.Union(
    [Type.Literal('irrelevant'), Type.Literal('known'), Type.Literal('deeper')],
    { description: '不相关、已了解或希望深入；切换与撤销只影响后续新执行' },
);
const target = {
    sourceId: Type.Union([UuidSchema, Type.Null()]),
    claimId: Type.Union([UuidSchema, Type.Null()]),
};
export const FeedbackInputSchema = refineSchema(
    Type.Object(
        {
            taskId: UuidSchema,
            sourceId: Type.Optional(UuidSchema),
            claimId: Type.Optional(UuidSchema),
            kind: FeedbackKindSchema,
        },
        { additionalProperties: false, description: '对当前任务的一份资料或一条结论设置反馈' },
    ),
    'ScovaFeedbackInput',
    (value) => Number(!!value.sourceId) + Number(!!value.claimId) === 1,
);
export const FeedbackSchema = refineSchema(
    Type.Object(
        {
            id: UuidSchema,
            taskId: UuidSchema,
            ...target,
            kind: FeedbackKindSchema,
            active: Type.Boolean({ description: '当前反馈是否生效，撤销不会删除历史Run快照' }),
            updatedAt: InstantSchema,
        },
        { additionalProperties: false, description: '目标唯一的可撤销反馈；相同设置保持幂等' },
    ),
    'ScovaFeedback',
    (value) => Number(!!value.sourceId) + Number(!!value.claimId) === 1,
);
export const FeedbackListSchema = Type.Object(
    {
        items: Type.Array(FeedbackSchema, { maxItems: 200 }),
    },
    { additionalProperties: false, description: '任务当前生效的反馈；最多同时生效200条' },
);

export const FeedbackSnapshotItemSchema = Type.Object(
    {
        id: UuidSchema,
        ...target,
        kind: FeedbackKindSchema,
        updatedAt: InstantSchema,
        text: Type.Union([Type.String({ maxLength: 4096 }), Type.Null()]),
        sources: Type.Array(
            Type.Object(
                {
                    url: HttpUrlSchema,
                    contentHash: Type.Union([
                        Type.String({ pattern: '^[a-f0-9]{64}$' }),
                        Type.Null(),
                    ]),
                    quote: Type.Union([Type.String({ maxLength: 2000 }), Type.Null()]),
                },
                { additionalProperties: false },
            ),
            { maxItems: 10 },
        ),
    },
    { additionalProperties: false, description: 'Run创建时复制的反馈目标，不再查询可变反馈行' },
);
export const FeedbackSnapshotSchema = Type.Object(
    {
        schemaVersion: Type.Literal(1),
        userId: UuidSchema,
        taskId: UuidSchema,
        items: Type.Array(FeedbackSnapshotItemSchema, { maxItems: 200 }),
    },
    {
        additionalProperties: false,
        description: '服务端内部的不可变反馈快照；不包含凭据或网页全文',
    },
);
export const FeedbackEffectSchema = Type.Object(
    {
        feedbackId: UuidSchema,
        kind: FeedbackKindSchema,
        targetType: Type.Union([Type.Literal('source'), Type.Literal('claim')]),
        targetId: UuidSchema,
        effect: Type.Union([
            Type.Literal('expanded_query'),
            Type.Literal('promoted'),
            Type.Literal('excluded'),
            Type.Literal('deprioritized'),
            Type.Literal('baseline_protected'),
            Type.Literal('monitoring'),
            Type.Literal('not_applied_budget'),
            Type.Literal('not_applied_unmatched'),
            Type.Literal('not_applied_policy'),
        ]),
        reason: Type.String({ minLength: 1, maxLength: 1000 }),
        url: Type.Optional(HttpUrlSchema),
        query: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
    },
    {
        additionalProperties: false,
        description: '已对照本次计划、实际搜索与正文解释的反馈作用；未执行不会记作已生效',
    },
);
export const FeedbackEffectsSchema = Type.Array(FeedbackEffectSchema, {
    maxItems: 600,
    description: '本次执行实际反馈作用及未执行原因',
});
for (const schema of [
    FeedbackInputSchema,
    FeedbackSchema,
    FeedbackListSchema,
    FeedbackSnapshotItemSchema,
    FeedbackSnapshotSchema,
    FeedbackEffectSchema,
    FeedbackEffectsSchema,
])
    describeProperties(schema);
export type FeedbackInput = Static<typeof FeedbackInputSchema>;
export type Feedback = Static<typeof FeedbackSchema>;
export type FeedbackSnapshot = Static<typeof FeedbackSnapshotSchema>;
export type FeedbackSnapshotItem = Static<typeof FeedbackSnapshotItemSchema>;
export type FeedbackEffect = Static<typeof FeedbackEffectSchema>;

/** 旧Run的[]表示未设置反馈；新Run必须由同一Task锁内的投影器创建。 */
export function readFeedbackSnapshot(
    value: unknown,
    userId: string,
    taskId: string,
): FeedbackSnapshot {
    if (Array.isArray(value) && value.length === 0)
        return { schemaVersion: 1, userId, taskId, items: [] };
    const snapshot = parseContract(FeedbackSnapshotSchema, value);
    if (
        snapshot.userId !== userId ||
        snapshot.taskId !== taskId ||
        new Set(snapshot.items.map((item) => item.id)).size !== snapshot.items.length ||
        snapshot.items.some((item) => Number(!!item.sourceId) + Number(!!item.claimId) !== 1)
    )
        throw new Error('反馈快照归属或目标无效');
    return snapshot;
}
