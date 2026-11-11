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
]);
const supportedValue = {
    text: Type.String({ maxLength: 2000 }),
    claimIndexes: indexes,
    status,
    gap: Type.String({ maxLength: 1000 }),
};
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
                    list: Type.Optional(
                        Type.Object(
                            {
                                entries: Type.Array(
                                    Type.Object(
                                        {
                                            id,
                                            name: label,
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
                                    Type.Object({ id, label }, { additionalProperties: false }),
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
