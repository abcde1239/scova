import { Type, type Static } from '@sinclair/typebox';
import { HttpUrlSchema, InstantSchema, UuidSchema } from '../common/schema.ts';

export const PROJECT_SETTINGS_GOAL_LIMIT = 600;
export const PROJECT_SETTINGS_REQUIREMENTS_LIMIT = 1_200;
export const PROJECT_SETTINGS_SOURCE_LIMIT = 8;
export const PROJECT_SETTINGS_SOURCE_URL_LIMIT = 512;
export const PROJECT_REPORT_SEARCH_QUERY_LIMIT = 160;
export const PROJECT_EVIDENCE_SEARCH_LIMIT = 10;

const closed = { additionalProperties: false };
const goal = Type.String({ maxLength: PROJECT_SETTINGS_GOAL_LIMIT, description: '项目目标' });
const requirements = Type.String({
    maxLength: PROJECT_SETTINGS_REQUIREMENTS_LIMIT,
    description: '适用于项目的长期要求',
});
const preferredSources = Type.Array(
    { ...HttpUrlSchema, maxLength: PROJECT_SETTINGS_SOURCE_URL_LIMIT },
    {
        maxItems: PROJECT_SETTINGS_SOURCE_LIMIT,
        uniqueItems: true,
        description: '用户保存的常用来源链接',
    },
);
export const ProjectAutonomySchema = Type.Union(
    [Type.Literal('ask'), Type.Literal('budgeted'), Type.Literal('autonomous')],
    { description: '询问、预算内自动或自主的默认档位' },
);
export type ProjectAutonomy = Static<typeof ProjectAutonomySchema>;

export const ProjectSettingsSchema = Type.Object(
    {
        projectId: { ...UuidSchema, description: '项目标识' },
        goal,
        requirements,
        preferredSources,
        defaultAutonomy: ProjectAutonomySchema,
        updatedAt: Type.Union([InstantSchema, Type.Null()], {
            description: '保存时间，未保存时为空',
        }),
    },
    closed,
);
export type ProjectSettings = Static<typeof ProjectSettingsSchema>;

export const PatchProjectSettingsSchema = Type.Object(
    {
        goal: Type.Optional(goal),
        requirements: Type.Optional(requirements),
        preferredSources: Type.Optional(preferredSources),
        defaultAutonomy: Type.Optional(ProjectAutonomySchema),
    },
    { ...closed, minProperties: 1 },
);
export type PatchProjectSettings = Static<typeof PatchProjectSettingsSchema>;

export const ProjectReportSearchQuerySchema = Type.Object(
    {
        q: Type.String({
            minLength: 1,
            maxLength: PROJECT_REPORT_SEARCH_QUERY_LIMIT,
            pattern: '\\S',
            description: '报告或来源检索文字',
        }),
        limit: Type.Optional(
            Type.String({ pattern: '^(?:[1-9]|10)$', description: '返回条数，默认 5，范围 1–10' }),
        ),
    },
    closed,
);
export type ProjectReportSearchQuery = Static<typeof ProjectReportSearchQuerySchema>;

const reportFields = {
    id: { ...UuidSchema, description: '报告标识' },
    taskId: { ...UuidSchema, description: '报告所属任务标识' },
    title: Type.String({ description: '报告标题' }),
    summary: Type.String({ description: '有界的报告摘要' }),
    publishedAt: { ...InstantSchema, description: '报告发布时间' },
};

const sourceFields = {
    sourceId: { ...UuidSchema, description: '来源标识' },
    snapshotId: { ...UuidSchema, description: '报告运行中的来源快照标识' },
    title: Type.String({ description: '来源快照标题' }),
    canonicalUrl: HttpUrlSchema,
};
const sourceRef = Type.Object(sourceFields, { ...closed, description: '匹配的报告来源' });

export const ProjectReportEvidenceSearchSchema = Type.Object(
    {
        items: Type.Array(
            Type.Object(
                {
                    ...reportFields,
                    matchingClaim: Type.Union([Type.String(), Type.Null()], {
                        description: '首条匹配结论',
                    }),
                    matchingSource: Type.Union([sourceRef, Type.Null()], {
                        description: '首个匹配来源',
                    }),
                },
                closed,
            ),
            { description: '当前项目中匹配的报告，按发布时间倒序' },
        ),
    },
    closed,
);
export type ProjectReportEvidenceSearch = Static<typeof ProjectReportEvidenceSearchSchema>;

export const ProjectReportEvidenceSchema = Type.Object(
    {
        ...reportFields,
        sources: Type.Array(sourceRef, { description: '报告运行中的成功来源快照，最多 12 条' }),
    },
    closed,
);
export type ProjectReportEvidence = Static<typeof ProjectReportEvidenceSchema>;

export const ProjectSourceEvidenceSchema = Type.Object(
    {
        ...sourceFields,
        reportId: { ...UuidSchema, description: '用于校验当前项目权限的报告标识' },
        publishedAt: Type.Union([InstantSchema, Type.Null()], { description: '来源发布时间' }),
        excerpt: Type.Union([Type.String(), Type.Null()], {
            description: '未过期的快照正文节选，缺失时为空',
        }),
    },
    closed,
);
export type ProjectSourceEvidence = Static<typeof ProjectSourceEvidenceSchema>;
