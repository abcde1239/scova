import { Type, type Static } from '@sinclair/typebox';
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
