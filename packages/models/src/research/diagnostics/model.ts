import { Type, type Static } from '@sinclair/typebox';

export const ModelDiagnosticSchema = Type.Object(
    {
        stage: Type.Union(
            ['planning', 'comparison', 'synthesis', 'other'].map((value) => Type.Literal(value)),
        ),
        schemaHash: Type.String({ pattern: '^[a-f0-9]{64}$' }),
        failure: Type.Union(
            ['json', 'schema', 'envelope', 'refusal'].map((value) => Type.Literal(value)),
        ),
        issues: Type.Array(
            Type.Object(
                {
                    schemaPath: Type.String({ maxLength: 240 }),
                    keyword: Type.String({ maxLength: 80 }),
                    allowedValues: Type.Optional(
                        Type.Array(Type.String({ maxLength: 80 }), { maxItems: 30 }),
                    ),
                    limit: Type.Optional(Type.Number()),
                    requiredProperty: Type.Optional(Type.String({ maxLength: 80 })),
                    allowedProperties: Type.Optional(
                        Type.Array(Type.String({ maxLength: 80 }), { maxItems: 30 }),
                    ),
                },
                { additionalProperties: false },
            ),
            { maxItems: 6 },
        ),
    },
    {
        additionalProperties: false,
        description: '模型输出的脱敏契约诊断，仅含阶段、schema指纹与预期约束，不含响应值',
    },
);
export type ModelDiagnostic = Static<typeof ModelDiagnosticSchema>;
