import { Type, type Static } from '@sinclair/typebox';
import {
    CreateTaskInputSchema,
    TaskDetailResponseSchema,
    TaskConfigSchema,
} from './task/schema.ts';
import {
    InstantSchema,
    RunStatusSchema,
    TaskStatusSchema,
    UuidSchema,
    describeProperties,
    pageSchema,
} from './common/schema.ts';

const ProjectNameSchema = Type.String({
    minLength: 1,
    maxLength: 120,
    pattern: String.raw`^(?=[\s\S]*\S)[^\x00]+$`,
    description: '项目名称，保存时去除首尾空白',
});
export const CreateProjectInputSchema = describeProperties(
    Type.Object({ name: ProjectNameSchema }, { additionalProperties: false }),
);
export const ProjectSchema = describeProperties(
    Type.Object(
        { id: UuidSchema, name: ProjectNameSchema, createdAt: InstantSchema },
        { additionalProperties: false, description: '当前账号拥有的项目' },
    ),
);
export const ProjectListResponseSchema = pageSchema(ProjectSchema);
export const TaskProjectResponseSchema = Type.Object(
    {
        project: Type.Union([ProjectSchema, Type.Null()], {
            description: '任务当前所属项目，未归类时为空',
        }),
    },
    { additionalProperties: false, description: '当前账号的任务归属' },
);
export type TaskProjectResponse = Static<typeof TaskProjectResponseSchema>;
export const CreateProjectTaskInputSchema = Type.Object(
    {
        ...CreateTaskInputSchema.properties,
        start: Type.Boolean({ description: '保存后立即启动一次真实研究' }),
    },
    { additionalProperties: false },
);
export const CreateProjectTaskResponseSchema = Type.Object(
    {
        detail: TaskDetailResponseSchema,
        runId: Type.Union([UuidSchema, Type.Null()], { description: '立即启动的执行标识，可为空' }),
    },
    { additionalProperties: false },
);
export type CreateProjectTaskInput = Static<typeof CreateProjectTaskInputSchema>;
export type CreateProjectTaskResponse = Static<typeof CreateProjectTaskResponseSchema>;

export const ProjectTaskSummarySchema = describeProperties(
    Type.Object(
        {
            id: UuidSchema,
            title: Type.String({ minLength: 1 }),
            status: TaskStatusSchema,
            nextRunAt: Type.Union([InstantSchema, Type.Null()]),
        },
        { additionalProperties: false },
    ),
);
export const ProjectTaskListResponseSchema = pageSchema(ProjectTaskSummarySchema);

export const ProjectRunSummarySchema = describeProperties(
    Type.Object(
        {
            id: UuidSchema,
            title: Type.String({ minLength: 1, description: '所属任务的当前标题' }),
            taskId: UuidSchema,
            status: RunStatusSchema,
            queuedAt: InstantSchema,
        },
        { additionalProperties: false },
    ),
);
export const ProjectReportSummarySchema = describeProperties(
    Type.Object(
        {
            id: UuidSchema,
            title: Type.String({ minLength: 1 }),
            taskId: UuidSchema,
            runId: UuidSchema,
            publishedAt: InstantSchema,
        },
        { additionalProperties: false },
    ),
);
export const ProjectDetailResponseSchema = describeProperties(
    Type.Object(
        {
            project: ProjectSchema,
            tasks: ProjectTaskListResponseSchema,
            nextRun: Type.Optional(
                Type.Union(
                    [
                        Type.Object(
                            {
                                taskId: UuidSchema,
                                title: Type.String({ description: '计划任务标题' }),
                                at: InstantSchema,
                            },
                            { additionalProperties: false },
                        ),
                        Type.Null(),
                    ],
                    { description: '整个项目最早的计划任务，可为空' },
                ),
            ),
            recentRuns: Type.Array(ProjectRunSummarySchema, {
                maxItems: 5,
                description: '最近执行',
            }),
            recentReports: Type.Array(ProjectReportSummarySchema, {
                maxItems: 5,
                description: '最近发布的报告',
            }),
        },
        { additionalProperties: false },
    ),
);

export type CreateProjectInput = Static<typeof CreateProjectInputSchema>;
export type Project = Static<typeof ProjectSchema>;
export type ProjectListResponse = Static<typeof ProjectListResponseSchema>;
export type ProjectDetailResponse = Static<typeof ProjectDetailResponseSchema>;

const DraftIdentitySchema = Type.Object(
    { id: UuidSchema, revision: Type.Integer({ minimum: 1, description: '预期草案修订号' }) },
    { additionalProperties: false },
);
export const ProjectConversationInputSchema = Type.Object(
    {
        turnId: UuidSchema,
        message: Type.String({
            minLength: 1,
            maxLength: 2000,
            description: '用户本轮输入的消息',
            pattern: '\\S',
        }),
        kind: Type.Union([Type.Literal('ask'), Type.Literal('draft')], {
            description: '报告提问或研究起草',
        }),
        reportId: Type.Optional(UuidSchema),
        target: Type.Optional({ ...DraftIdentitySchema, description: '本轮明确修订的草案' }),
    },
    { additionalProperties: false },
);
export const ProjectResearchDraftSchema = Type.Object(
    {
        ...DraftIdentitySchema.properties,
        config: TaskConfigSchema,
        taskId: Type.Union([UuidSchema, Type.Null()], {
            description: '已确认创建的任务标识，可为空',
        }),
        runId: Type.Union([UuidSchema, Type.Null()], { description: '立即启动的执行标识，可为空' }),
    },
    { additionalProperties: false },
);
const ProjectConversationTurnSchema = Type.Object(
    {
        id: UuidSchema,
        message: Type.String({ description: '用户本轮输入的消息' }),
        kind: ProjectConversationInputSchema.properties.kind,
        target: ProjectConversationInputSchema.properties.target,
        status: Type.Union(
            [
                Type.Literal('running'),
                Type.Literal('completed'),
                Type.Literal('failed'),
                Type.Literal('canceled'),
            ],
            { description: '当前会话轮次状态' },
        ),
        answer: Type.Union([Type.String(), Type.Null()], {
            description: '本轮回答或终止说明，可为空',
        }),
        reportId: Type.Union([UuidSchema, Type.Null()], {
            description: '当前仍可读取的引用报告标识，可为空',
        }),
        draftId: Type.Union([UuidSchema, Type.Null()], {
            description: '本轮输出的研究草案标识，可为空',
        }),
    },
    { additionalProperties: false },
);
export const ProjectConversationSchema = Type.Object(
    {
        turns: Type.Array(ProjectConversationTurnSchema, {
            description: '按时间递增的最近会话轮次',
        }),
        drafts: Type.Array(ProjectResearchDraftSchema, {
            description: '可继续编辑的草案或近期确认结果',
        }),
    },
    { additionalProperties: false },
);
export const ProjectDraftEditSchema = Type.Object(
    {
        revision: DraftIdentitySchema.properties.revision,
        config: TaskConfigSchema,
    },
    { additionalProperties: false },
);
export const ProjectDraftConfirmSchema = Type.Object(
    {
        revision: DraftIdentitySchema.properties.revision,
        start: CreateProjectTaskInputSchema.properties.start,
    },
    { additionalProperties: false },
);
export type ProjectConversationInput = Static<typeof ProjectConversationInputSchema>;
export type ProjectConversation = Static<typeof ProjectConversationSchema>;
export type ProjectResearchDraft = Static<typeof ProjectResearchDraftSchema>;
export type ProjectDraftEdit = Static<typeof ProjectDraftEditSchema>;
export type ProjectDraftConfirm = Static<typeof ProjectDraftConfirmSchema>;
