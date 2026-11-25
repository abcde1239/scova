import { describeProperties } from '../common/schema.ts';
import { Type, type Static } from '@sinclair/typebox';
import { ProjectThreadAttachmentRefSchema } from './thread-attachments.ts';
import { ProjectAutonomySchema } from './settings-evidence.ts';
import { InstantSchema, UuidSchema } from '../common/schema.ts';

export const PROJECT_THREAD_PAGE_SIZE = 50;
export const PROJECT_THREAD_MAX_PAGE_SIZE = 100;
export const PROJECT_THREAD_MAX_SEQ = 2_147_483_647;

const title = Type.String({
    minLength: 1,
    maxLength: 120,
    pattern: '\\S',
    description: '会话标题',
});
const seq = Type.Integer({ minimum: 0, maximum: PROJECT_THREAD_MAX_SEQ });
const attributes = { additionalProperties: false };

export const CreateProjectThreadSchema = Type.Object({ title: Type.Optional(title) }, attributes);
export type CreateProjectThread = Static<typeof CreateProjectThreadSchema>;

export const UpdateProjectThreadSchema = Type.Object(
    {
        title: Type.Optional(title),
        archived: Type.Optional(Type.Boolean({ description: '是否归档该会话' })),
    },
    { ...attributes, minProperties: 1 },
);
export type UpdateProjectThread = Static<typeof UpdateProjectThreadSchema>;

export const ProjectThreadSchema = Type.Object(
    {
        id: { ...UuidSchema, description: '会话标识' },
        projectId: { ...UuidSchema, description: '所属项目标识' },
        title,
        isDefault: Type.Boolean({ description: '是否承接旧项目对话' }),
        archivedAt: Type.Union([InstantSchema, Type.Null()], { description: '归档时间' }),
        lastActivityAt: { ...InstantSchema, description: '最后活动时间' },
        createdAt: { ...InstantSchema, description: '会话创建时间' },
    },
    attributes,
);
export type ProjectThread = Static<typeof ProjectThreadSchema>;

export const ProjectThreadListSchema = Type.Object(
    { items: Type.Array(ProjectThreadSchema, { description: '项目会话，包括已归档会话' }) },
    attributes,
);

const kinds = [
    Type.Literal('message'),
    Type.Literal('tool_step'),
    Type.Literal('plan'),
    Type.Literal('run'),
    Type.Literal('report'),
    Type.Literal('schedule'),
    Type.Literal('disambiguation'),
    Type.Literal('notice'),
] as const;

export const ProjectThreadItemSchema = Type.Object(
    {
        id: { ...UuidSchema, description: '时间线条目标识' },
        threadId: { ...UuidSchema, description: '所属会话标识' },
        turnId: Type.Union([UuidSchema, Type.Null()], { description: '产生条目的轮次' }),
        seq: { ...seq, minimum: 1, description: '会话内单调递增序号' },
        kind: Type.Union([...kinds], { description: '条目类型' }),
        payload: Type.Record(Type.String(), Type.Unknown(), { description: '条目内容' }),
        refs: Type.Array(Type.Unknown(), { description: '条目引用' }),
        status: Type.Union([Type.String({ minLength: 1, maxLength: 32 }), Type.Null()], {
            description: '动作或轮次状态',
        }),
        createdAt: { ...InstantSchema, description: '条目创建时间' },
    },
    attributes,
);
export type ProjectThreadItem = Static<typeof ProjectThreadItemSchema>;

export const ProjectThreadSnapshotSchema = Type.Object(
    {
        thread: { ...ProjectThreadSchema, description: '会话信息' },
        items: Type.Array(ProjectThreadItemSchema, { description: '按序号递增的当前页条目' }),
        lastSeq: { ...seq, description: '这一页最后条目序号，无条目时回显请求游标' },
        hasMore: Type.Boolean({ description: '是否还有快照条目' }),
    },
    attributes,
);
export type ProjectThreadSnapshot = Static<typeof ProjectThreadSnapshotSchema>;

const paragraphIndex = Type.Integer({ minimum: 0, maximum: 999 });
const projectReportAnchor = Type.Union([
    Type.Object({ kind: Type.Literal('claim'), claimId: UuidSchema, paragraphIndex }, attributes),
    Type.Object(
        { kind: Type.Union([Type.Literal('summary'), Type.Literal('limitation')]), paragraphIndex },
        attributes,
    ),
]);
export type ProjectReportParagraphAnchor = Static<typeof projectReportAnchor>;
export const ProjectThreadReportRefSchema = Type.Object(
    { kind: Type.Literal('report'), id: UuidSchema, anchor: Type.Optional(projectReportAnchor) },
    attributes,
);
export const ProjectThreadSourceRefSchema = Type.Object(
    { kind: Type.Literal('source'), reportId: UuidSchema, snapshotId: UuidSchema },
    attributes,
);
const projectThreadTurnRef = Type.Union([
    ProjectThreadReportRefSchema,
    ProjectThreadSourceRefSchema,
    ProjectThreadAttachmentRefSchema,
    Type.Object(
        { kind: Type.Literal('task', { description: '项目任务引用' }), id: UuidSchema },
        attributes,
    ),
]);
export const SendProjectTurnSchema = Type.Object(
    {
        turnId: UuidSchema,
        autonomy: Type.Optional(ProjectAutonomySchema),
        message: Type.String({ minLength: 1, maxLength: 2000, pattern: '\\S' }),
        refs: Type.Optional(Type.Array(projectThreadTurnRef, { maxItems: 3 })),
    },
    attributes,
);
export type SendProjectTurn = Static<typeof SendProjectTurnSchema>;
export const ProjectTurnReceiptSchema = Type.Object(
    {
        turnId: UuidSchema,
        status: Type.Union([
            Type.Literal('running'),
            Type.Literal('completed'),
            Type.Literal('failed'),
            Type.Literal('canceled'),
        ]),
    },
    attributes,
);
export const ProjectActionReceiptSchema = Type.Object(
    {
        actionId: UuidSchema,
        status: Type.Union([Type.Literal('applied'), Type.Literal('rejected')]),
        taskId: Type.Union([UuidSchema, Type.Null()]),
        runId: Type.Union([UuidSchema, Type.Null()]),
    },
    attributes,
);

[
    CreateProjectThreadSchema,
    UpdateProjectThreadSchema,
    ProjectThreadSchema,
    ProjectThreadListSchema,
    ProjectThreadItemSchema,
    ProjectThreadSnapshotSchema,
    SendProjectTurnSchema,
    ProjectTurnReceiptSchema,
    ProjectActionReceiptSchema,
].forEach(describeProperties);
