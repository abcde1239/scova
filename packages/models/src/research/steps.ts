import { Type, type Static } from '@sinclair/typebox';
import { UuidSchema } from '../common/schema.ts';

export const StepNameSchema = Type.Union(
    [
        Type.Literal('load_context'),
        Type.Literal('plan'),
        Type.Literal('search'),
        Type.Literal('select'),
        Type.Literal('read'),
        Type.Literal('verify'),
        Type.Literal('compare'),
        Type.Literal('synthesize'),
        Type.Literal('answer_supplement'),
        Type.Literal('model_answer'),
        Type.Literal('model_draft'),
        Type.Literal('gap_loop'),
        Type.Literal('conflict_review'),
        Type.Literal('validate'),
        Type.Literal('ready_for_delivery'),
    ],
    { description: '持久化 Agent 编排节点，不传输逐 token 过程或隐式思维链' },
);

export const StepExecutionSchema = Type.Object(
    {
        graphVersion: Type.Literal(1, { description: '本次执行的公开研究拓扑版本' }),
        instanceId: UuidSchema,
        attemptId: UuidSchema,
    },
    {
        additionalProperties: false,
        description: '稳定逻辑节点实例及本次尝试身份，不包含检查点或租约内部标识',
    },
);

export type StepName = Static<typeof StepNameSchema>;
export type StepExecution = Static<typeof StepExecutionSchema>;
