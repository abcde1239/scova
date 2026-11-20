import { Type, type Static } from '@sinclair/typebox';
import {
    InstantSchema,
    ModeSchema,
    RevisionSchema,
    RunStatusSchema,
    UuidSchema,
    describeProperties,
} from '../common/schema.ts';

const strict = { additionalProperties: false };
const nodeId = Type.String({ pattern: '^[A-Za-z0-9_-]{1,64}$', description: '图内唯一节点标识' });
const title = Type.String({
    minLength: 1,
    maxLength: 160,
    pattern: String.raw`\S`,
    description: '工作流名称',
});
export const workflowNodeLimit = 16;

const workflowNodeSchema = Type.Union([
    Type.Object({ id: nodeId, type: Type.Literal('start') }, strict),
    Type.Object({ id: nodeId, type: Type.Literal('study'), taskId: UuidSchema }, strict),
    Type.Object({ id: nodeId, type: Type.Literal('end') }, strict),
]);
const workflowEdgeSchema = Type.Object(
    {
        from: Type.Object({ nodeId, port: Type.Literal('out') }, strict),
        to: Type.Object({ nodeId, port: Type.Literal('in') }, strict),
    },
    strict,
);

export const WorkflowGraphSchema = Type.Object(
    {
        nodes: Type.Array(workflowNodeSchema, { maxItems: workflowNodeLimit }),
        edges: Type.Array(workflowEdgeSchema, { maxItems: workflowNodeLimit - 1 }),
    },
    { ...strict, description: '串行工作流画布，发布时验证节点与连线' },
);
export const WorkflowDraftInputSchema = Type.Object({ title, graph: WorkflowGraphSchema }, strict);
export const WorkflowSchema = Type.Object(
    {
        id: UuidSchema,
        title,
        revision: RevisionSchema,
        createdAt: InstantSchema,
        updatedAt: InstantSchema,
    },
    strict,
);
const workflowBindingSchema = Type.Object(
    { nodeId, taskId: UuidSchema, taskVersionId: UuidSchema },
    strict,
);
export const WorkflowVersionSchema = Type.Object(
    {
        id: UuidSchema,
        workflowId: UuidSchema,
        version: RevisionSchema,
        draftRevision: RevisionSchema,
        title,
        graph: WorkflowGraphSchema,
        bindings: Type.Array(workflowBindingSchema),
        publishedAt: InstantSchema,
    },
    strict,
);
export const WorkflowVersionListSchema = Type.Object(
    { items: Type.Array(WorkflowVersionSchema), nextCursor: Type.Union([UuidSchema, Type.Null()]) },
    strict,
);
export const WorkflowDetailSchema = Type.Object(
    {
        workflow: WorkflowSchema,
        draft: WorkflowGraphSchema,
        publishedVersion: Type.Union([WorkflowVersionSchema, Type.Null()]),
    },
    strict,
);
export const WorkflowListSchema = Type.Object(
    {
        items: Type.Array(WorkflowSchema),
        nextCursor: Type.Union([UuidSchema, Type.Null()]),
    },
    strict,
);

export const WorkflowStartInputSchema = Type.Object(
    {
        versionId: UuidSchema,
        mode: Type.Optional(Type.Literal('live', { description: '按真实研究执行策略启动' })),
    },
    strict,
);
export const WorkflowRunStatusSchema = Type.Union([
    Type.Literal('queued'),
    Type.Literal('running'),
    Type.Literal('cancel_requested'),
    Type.Literal('succeeded'),
    Type.Literal('canceled'),
    Type.Literal('failed'),
]);
const workflowNodeStatusSchema = Type.Union([
    Type.Literal('pending'),
    Type.Literal('running'),
    Type.Literal('succeeded'),
    Type.Literal('failed'),
    Type.Literal('canceled'),
    Type.Literal('skipped'),
]);
const nullableInstant = Type.Union([InstantSchema, Type.Null()]);
const failureCode = Type.Union([Type.String({ minLength: 1 }), Type.Null()]);
export const WorkflowRunNodeSchema = Type.Object(
    {
        id: nodeId,
        type: Type.Union([Type.Literal('start'), Type.Literal('study'), Type.Literal('end')]),
        status: workflowNodeStatusSchema,
        attempt: Type.Integer({ minimum: 0, maximum: 1 }),
        startedAt: nullableInstant,
        finishedAt: nullableInstant,
        taskId: Type.Union([UuidSchema, Type.Null()]),
        taskVersionId: Type.Union([UuidSchema, Type.Null()]),
        childRunId: Type.Union([UuidSchema, Type.Null()]),
        childStatus: Type.Union([RunStatusSchema, Type.Null()]),
        failureCode,
    },
    strict,
);
export const WorkflowRunSchema = Type.Object(
    {
        id: UuidSchema,
        workflowId: UuidSchema,
        versionId: UuidSchema,
        mode: ModeSchema,
        status: WorkflowRunStatusSchema,
        nodes: Type.Array(WorkflowRunNodeSchema, { maxItems: workflowNodeLimit }),
        createdAt: InstantSchema,
        startedAt: nullableInstant,
        finishedAt: nullableInstant,
        failureCode,
    },
    strict,
);
export const WorkflowRunListSchema = Type.Object(
    {
        items: Type.Array(WorkflowRunSchema),
        nextCursor: Type.Union([UuidSchema, Type.Null()]),
    },
    strict,
);
export const WorkflowStartResponseSchema = Type.Object(
    { run: WorkflowRunSchema, reused: Type.Boolean() },
    strict,
);

export type WorkflowGraph = Static<typeof WorkflowGraphSchema>;
export type WorkflowNode = Static<typeof workflowNodeSchema>;
export type WorkflowBinding = Static<typeof workflowBindingSchema>;
export type WorkflowRunNode = Static<typeof WorkflowRunNodeSchema>;
export type WorkflowRun = Static<typeof WorkflowRunSchema>;

for (const schema of [
    WorkflowGraphSchema,
    WorkflowDraftInputSchema,
    WorkflowSchema,
    WorkflowVersionSchema,
    WorkflowVersionListSchema,
    WorkflowDetailSchema,
    WorkflowListSchema,
    WorkflowStartInputSchema,
    WorkflowRunNodeSchema,
    WorkflowRunSchema,
    WorkflowRunListSchema,
    WorkflowStartResponseSchema,
])
    describeProperties(schema);
