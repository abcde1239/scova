import { Type, type Static } from '@sinclair/typebox';
import {
    describeProperties,
    InstantSchema,
    ModeSchema,
    PageQuerySchema,
    pageSchema,
    RunStatusSchema,
    UuidSchema,
} from './common/schema.ts';

const researchKinds = [
    Type.Literal('summary'),
    Type.Literal('important_change'),
    Type.Literal('run_issue'),
] as const;
const workflowKind = Type.Literal('workflow');
export const NotificationKindSchema = Type.Union([...researchKinds, workflowKind], {
    description: '完整汇总、重要变化、运行问题或工作流通知',
});
const common = {
    id: UuidSchema,
    readAt: Type.Union([InstantSchema, Type.Null()], { description: '首次已读时间；未读为空' }),
    createdAt: InstantSchema,
};
const ResearchNotificationSchema = Type.Object(
    {
        ...common,
        runId: UuidSchema,
        taskId: UuidSchema,
        reportId: Type.Union([UuidSchema, Type.Null()], { description: '关联报告；失败时可为空' }),
        kind: Type.Union([...researchKinds], {
            description: '完整汇总、已确认重要变化或不完整/失败的运行问题',
        }),
        runStatus: RunStatusSchema,
        mode: ModeSchema,
        failureCode: Type.Union([Type.String({ minLength: 1 }), Type.Null()], {
            description: '执行的脱敏失败分类；无失败为空',
        }),
    },
    { additionalProperties: false, description: '当前账号的研究通知' },
);
const nodeIdOptions = { pattern: '^[A-Za-z0-9_-]{1,64}$' };
const WorkflowNotificationSchema = Type.Object(
    {
        ...common,
        kind: workflowKind,
        workflowRunId: UuidSchema,
        nodeId: Type.String({ ...nodeIdOptions, description: '发送通知的节点标识' }),
        artifactNodeId: Type.Optional(
            Type.String({ ...nodeIdOptions, description: '关联的成果节点标识' }),
        ),
        title: Type.String({ description: '执行时渲染的通知标题' }),
        body: Type.String({ description: '执行时渲染的通知正文' }),
    },
    { additionalProperties: false, description: '当前账号的工作流站内通知' },
);
export const NotificationSchema = Type.Union(
    [ResearchNotificationSchema, WorkflowNotificationSchema],
    {
        description: '当前账号的站内通知，独立于报告收件箱',
    },
);
export const NotificationListQuerySchema = Type.Object(
    {
        ...PageQuerySchema.properties,
        kind: Type.Optional(NotificationKindSchema),
        unread: Type.Optional(Type.Boolean({ description: '只看未读或已读；省略返回全部' })),
    },
    { additionalProperties: false, description: '通知分页与种类/已读筛选' },
);
export const NotificationListResponseSchema = pageSchema(NotificationSchema);
export const NotificationPatchInputSchema = Type.Object(
    { read: Type.Boolean({ description: '标为已读或恢复未读，不改变收件箱状态' }) },
    { additionalProperties: false, description: '修改通知已读状态' },
);
for (const schema of [
    ResearchNotificationSchema,
    WorkflowNotificationSchema,
    NotificationListQuerySchema,
    NotificationPatchInputSchema,
])
    describeProperties(schema);
export type ResearchNotification = Static<typeof ResearchNotificationSchema>;
export type Notification = Static<typeof NotificationSchema>;
export type NotificationListQuery = Static<typeof NotificationListQuerySchema>;
export type NotificationPatchInput = Static<typeof NotificationPatchInputSchema>;
