import { describeProperties } from '../common/schema.ts';
import { Type, type Static } from '@sinclair/typebox';
import { InstantSchema, UuidSchema } from '../common/schema.ts';
import { CreateProjectInputSchema, ProjectSchema } from '../projects.ts';
import { SendProjectTurnSchema } from './threads.ts';

const closed = { additionalProperties: false };
export const WorkspaceIntakeInputSchema = Type.Object(
    {
        message: SendProjectTurnSchema.properties.message,
        destination: Type.Union([
            Type.Object({ kind: Type.Literal('auto') }, closed),
            Type.Object({ kind: Type.Literal('project'), projectId: UuidSchema }, closed),
            Type.Object(
                {
                    kind: Type.Literal('new-project'),
                    name: CreateProjectInputSchema.properties.name,
                },
                closed,
            ),
        ]),
    },
    closed,
);
export type WorkspaceIntakeInput = Static<typeof WorkspaceIntakeInputSchema>;

export const WorkspaceIntakeResultSchema = Type.Union([
    Type.Object(
        {
            kind: Type.Literal('ready'),
            projectId: UuidSchema,
            threadId: UuidSchema,
            turnId: UuidSchema,
        },
        closed,
    ),
    Type.Object(
        {
            kind: Type.Literal('choose-project'),
            candidates: Type.Array(Type.Pick(ProjectSchema, ['id', 'name'], closed), {
                maxItems: 5,
            }),
        },
        closed,
    ),
]);
export type WorkspaceIntakeResult = Static<typeof WorkspaceIntakeResultSchema>;

export const WorkspaceHomeSchema = Type.Object(
    {
        recentProjects: Type.Array(
            Type.Object(
                {
                    ...ProjectSchema.properties,
                    lastActivityAt: InstantSchema,
                },
                closed,
            ),
            { maxItems: 6 },
        ),
        pending: Type.Array(
            Type.Object(
                {
                    id: UuidSchema,
                    projectId: UuidSchema,
                    projectName: ProjectSchema.properties.name,
                    threadId: UuidSchema,
                    threadTitle: Type.String(),
                },
                closed,
            ),
            { maxItems: 8 },
        ),
    },
    closed,
);
export type WorkspaceHome = Static<typeof WorkspaceHomeSchema>;

[WorkspaceIntakeInputSchema, WorkspaceIntakeResultSchema, WorkspaceHomeSchema].forEach(
    describeProperties,
);
