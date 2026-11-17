import { Type, type Static } from '@sinclair/typebox';
import { OutputFormatSchema } from './common.ts';

const id = Type.String({ minLength: 1, maxLength: 80 });
const label = Type.String({ minLength: 1, maxLength: 1000 });
const indexes = Type.Array(Type.Integer({ minimum: 0, maximum: 299 }), {
    maxItems: 300,
    uniqueItems: true,
});
const status = Type.Union([
    Type.Literal('supported'),
    Type.Literal('partial'),
    Type.Literal('unknown'),
    Type.Literal('model_answered'),
]);
const group = Type.Optional(Type.String({ minLength: 1, maxLength: 40, pattern: '\\S' }));
const supportedValue = {
    text: Type.String({ maxLength: 2000 }),
    claimIndexes: indexes,
    status,
    gap: Type.String({ maxLength: 1000 }),
};
export const ArtifactDocumentSectionSchema = Type.Object(
    {
        id: Type.String({ minLength: 1, maxLength: 80, pattern: '^[a-zA-Z0-9_-]+$' }),
        title: Type.String({ minLength: 1, maxLength: 160, pattern: '\\S' }),
        role: Type.Union([
            Type.Literal('overview'),
            Type.Literal('key_findings'),
            Type.Literal('context'),
            Type.Literal('analysis'),
            Type.Literal('conclusion'),
            Type.Literal('limitations'),
        ]),
        claimIndexes: Type.Array(Type.Integer({ minimum: 0, maximum: 299 }), {
            minItems: 1,
            maxItems: 300,
            uniqueItems: true,
        }),
    },
    { additionalProperties: false },
);
export const ArtifactDocumentSchema = Type.Object(
    {
        version: Type.Literal(1),
        sections: Type.Array(ArtifactDocumentSectionSchema, { minItems: 1, maxItems: 12 }),
    },
    {
        additionalProperties: false,
        description:
            '成果的保存正文大纲；简报与研究报告覆盖全部正文结论，清单与对比表只组织未绑定到字段或单元格的综述结论；标题仅组织内容，不另存无依据的自由文本',
    },
);
export type ArtifactDocument = Static<typeof ArtifactDocumentSchema>;
export const ArtifactRequirementSchema = Type.Object(
    {
        id,
        questionIds: Type.Array(Type.String({ minLength: 1, maxLength: 50 }), {
            minItems: 1,
            maxItems: 20,
            uniqueItems: true,
        }),
        object: Type.String({ maxLength: 200 }),
        field: label,
        required: Type.Boolean(),
        status,
        claimIndexes: indexes,
        gap: Type.String({ maxLength: 1000 }),
    },
    { additionalProperties: false },
);
export const ReportArtifactSchema = Type.Object(
    {
        format: OutputFormatSchema,
        claimIndexes: Type.Array(Type.Integer({ minimum: 0, maximum: 299 }), {
            minItems: 1,
            maxItems: 300,
            uniqueItems: true,
        }),
        summary: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
        coverage: Type.Optional(
            Type.Object(
                {
                    version: Type.Literal(1),
                    requirements: Type.Array(ArtifactRequirementSchema, {
                        minItems: 1,
                        maxItems: 60,
                    }),
                },
                { additionalProperties: false },
            ),
        ),
        content: Type.Optional(
            Type.Object(
                {
                    version: Type.Literal(1),
                    document: Type.Optional(ArtifactDocumentSchema),
                    list: Type.Optional(
                        Type.Object(
                            {
                                entries: Type.Array(
                                    Type.Object(
                                        {
                                            id,
                                            name: label,
                                            group,
                                            fields: Type.Array(
                                                Type.Object(
                                                    { id, label, ...supportedValue },
                                                    { additionalProperties: false },
                                                ),
                                                { minItems: 1, maxItems: 60 },
                                            ),
                                        },
                                        { additionalProperties: false },
                                    ),
                                    { minItems: 1, maxItems: 20 },
                                ),
                            },
                            { additionalProperties: false },
                        ),
                    ),
                    comparison: Type.Optional(
                        Type.Object(
                            {
                                objects: Type.Array(
                                    Type.Object(
                                        { id, name: label },
                                        { additionalProperties: false },
                                    ),
                                    { minItems: 1, maxItems: 20 },
                                ),
                                dimensions: Type.Array(
                                    Type.Object(
                                        { id, label, group },
                                        { additionalProperties: false },
                                    ),
                                    { minItems: 1, maxItems: 20 },
                                ),
                                cells: Type.Array(
                                    Type.Object(
                                        { objectId: id, dimensionId: id, ...supportedValue },
                                        { additionalProperties: false },
                                    ),
                                    { minItems: 1, maxItems: 60 },
                                ),
                            },
                            { additionalProperties: false },
                        ),
                    ),
                },
                { additionalProperties: false },
            ),
        ),
    },
    { additionalProperties: false },
);
export type ReportArtifact = Static<typeof ReportArtifactSchema>;
export type ArtifactRequirement = Static<typeof ArtifactRequirementSchema>;
