import { Type, type Static } from '@sinclair/typebox';
import {
    InstantSchema,
    ModeSchema,
    RevisionSchema,
    RunStatusSchema,
    UuidSchema,
    describeProperties,
} from '../common/schema.ts';

export { concurrentStudyConflicts, readWorkflowStages } from './graph.ts';

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

const LegacyWorkflowGraphSchema = Type.Object(
    {
        nodes: Type.Array(workflowNodeSchema, { maxItems: workflowNodeLimit }),
        // Adjacent groups of seven studies yield the largest graph at the node limit.
        edges: Type.Array(workflowEdgeSchema, { maxItems: 63 }),
    },
    { ...strict, description: '工作流画布，发布时验证串行阶段与并行组的连线' },
);
const canvasText = Type.String({ maxLength: 8000 });
const sourceIds = Type.Array(nodeId, { maxItems: workflowNodeLimit, uniqueItems: true });
const canvasBase = { id: nodeId, label: Type.Optional(title) };
export const WorkflowCanvasNodeSchema = Type.Union([
    Type.Object({ ...canvasBase, type: Type.Literal('start') }, strict),
    Type.Object({ ...canvasBase, type: Type.Literal('end') }, strict),
    Type.Object({ ...canvasBase, type: Type.Literal('merge') }, strict),
    Type.Object(
        {
            ...canvasBase,
            type: Type.Literal('study'),
            taskId: Type.Union([UuidSchema, Type.Literal('')]),
        },
        strict,
    ),
    Type.Object(
        {
            ...canvasBase,
            type: Type.Literal('csv'),
            config: Type.Object(
                {
                    source: Type.Optional(nodeId),
                    filters: Type.Array(
                        Type.Object(
                            {
                                column: Type.String({ maxLength: 256 }),
                                operator: Type.Union([
                                    Type.Literal('equals'),
                                    Type.Literal('notEquals'),
                                    Type.Literal('lessThan'),
                                    Type.Literal('greaterThan'),
                                ]),
                                value: canvasText,
                            },
                            strict,
                        ),
                        { maxItems: 32 },
                    ),
                    columns: Type.Optional(
                        Type.Array(Type.String({ maxLength: 256 }), { maxItems: 128 }),
                    ),
                },
                strict,
            ),
        },
        strict,
    ),
    Type.Object(
        {
            ...canvasBase,
            type: Type.Literal('generate'),
            config: Type.Object({ sources: sourceIds, instructions: canvasText }, strict),
        },
        strict,
    ),
    Type.Object(
        {
            ...canvasBase,
            type: Type.Literal('deliver'),
            config: Type.Object(
                {
                    source: Type.Union([nodeId, Type.Literal('')]),
                    format: Type.Union([Type.Literal('csv'), Type.Literal('markdown')]),
                    filename: Type.String({ maxLength: 180 }),
                },
                strict,
            ),
        },
        strict,
    ),
    Type.Object(
        {
            ...canvasBase,
            type: Type.Literal('notify'),
            config: Type.Object(
                { source: Type.Optional(nodeId), title: canvasText, body: canvasText },
                strict,
            ),
        },
        strict,
    ),
]);
export const WorkflowCanvasGraphSchema = Type.Object(
    {
        version: Type.Literal(2),
        nodes: Type.Array(WorkflowCanvasNodeSchema, { maxItems: workflowNodeLimit }),
        edges: Type.Array(workflowEdgeSchema, { maxItems: 120 }),
        layout: Type.Object(
            {
                positions: Type.Record(
                    nodeId,
                    Type.Object(
                        {
                            x: Type.Number({ minimum: -100000, maximum: 100000 }),
                            y: Type.Number({ minimum: -100000, maximum: 100000 }),
                        },
                        strict,
                    ),
                    { maxProperties: workflowNodeLimit },
                ),
                groups: Type.Array(Type.Object({ id: nodeId, title, nodeIds: sourceIds }, strict), {
                    maxItems: workflowNodeLimit,
                }),
            },
            strict,
        ),
    },
    strict,
);
export const WorkflowGraphSchema = Type.Union([
    LegacyWorkflowGraphSchema,
    WorkflowCanvasGraphSchema,
]);
export const WorkflowCanvasInputSchema = Type.Object(
    {
        csv: Type.Optional(Type.String({ maxLength: 262144 })),
        text: Type.Optional(Type.String({ maxLength: 64000 })),
        threshold: Type.Optional(Type.Number()),
        inventoryColumn: Type.Optional(Type.String({ maxLength: 256 })),
        notify: Type.Optional(Type.Boolean()),
        period: Type.Optional(Type.String({ maxLength: 128 })),
        providerId: Type.Optional(UuidSchema),
    },
    strict,
);
export const WorkflowCanvasOutputSchema = Type.Object(
    {
        text: Type.Optional(Type.String()),
        table: Type.Optional(
            Type.Object(
                { columns: Type.Array(Type.String()), rows: Type.Array(Type.Array(Type.String())) },
                strict,
            ),
        ),
        reportId: Type.Optional(UuidSchema),
        artifact: Type.Optional(
            Type.Object(
                {
                    filename: Type.String(),
                    format: Type.Union([Type.Literal('csv'), Type.Literal('markdown')]),
                    content: Type.String(),
                },
                strict,
            ),
        ),
        notification: Type.Optional(
            Type.Object(
                {
                    title: Type.String(),
                    body: Type.String(),
                    artifactNodeId: Type.Optional(nodeId),
                },
                strict,
            ),
        ),
        count: Type.Optional(Type.Integer({ minimum: 0 })),
    },
    strict,
);
export type WorkflowCanvasNode = Static<typeof WorkflowCanvasNodeSchema>;
export type WorkflowCanvasGraph = Static<typeof WorkflowCanvasGraphSchema>;
export type WorkflowCanvasInput = Static<typeof WorkflowCanvasInputSchema>;
export type WorkflowCanvasOutput = Static<typeof WorkflowCanvasOutputSchema>;
export type LegacyWorkflowGraph = Static<typeof LegacyWorkflowGraphSchema>;
export const isWorkflowCanvasGraph = (graph: WorkflowGraph): graph is WorkflowCanvasGraph =>
    'version' in graph;
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
        versionId: Type.Optional(UuidSchema),
        draftRevision: Type.Optional(RevisionSchema),
        mode: Type.Optional(Type.Literal('live', { description: '按真实研究执行策略启动' })),
        input: Type.Optional(WorkflowCanvasInputSchema),
        preview: Type.Optional(Type.Boolean()),
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
        type: Type.Union([
            Type.Literal('start'),
            Type.Literal('study'),
            Type.Literal('end'),
            Type.Literal('merge'),
            Type.Literal('csv'),
            Type.Literal('generate'),
            Type.Literal('deliver'),
            Type.Literal('notify'),
        ]),
        output: Type.Optional(WorkflowCanvasOutputSchema),
        status: workflowNodeStatusSchema,
        parallelGroup: Type.Optional(nodeId),
        attempt: Type.Integer({ minimum: 0, maximum: 3 }),
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
        versionId: Type.Union([UuidSchema, Type.Null()]),
        mode: ModeSchema,
        status: WorkflowRunStatusSchema,
        nodes: Type.Array(WorkflowRunNodeSchema, { maxItems: workflowNodeLimit }),
        preview: Type.Optional(Type.Boolean()),
        draftSnapshot: Type.Optional(WorkflowCanvasGraphSchema),
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
