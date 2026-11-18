import { Type, type Static } from '@sinclair/typebox';
import { UuidSchema, describeProperties } from '../common/schema.ts';

/** Server-owned, frozen context. Messages are discussion, sources alone support citations. */
export const ReportConversationContextSchema = Type.Object(
    {
        version: Type.Literal(1),
        reportId: UuidSchema,
        questionId: UuidSchema,
        operation: Type.Union([Type.Literal('research'), Type.Literal('revise')]),
        merge: Type.Optional(
            Type.Object(
                {
                    reportIds: Type.Array(UuidSchema, {
                        minItems: 1,
                        maxItems: 8,
                        uniqueItems: true,
                    }),
                },
                { additionalProperties: false },
            ),
        ),
        report: Type.Object(
            {
                title: Type.String({ maxLength: 1000 }),
                summary: Type.String({ maxLength: 16000 }),
                claims: Type.Array(Type.String({ maxLength: 4000 }), { maxItems: 30 }),
            },
            { additionalProperties: false },
        ),
        messages: Type.Array(
            Type.Object(
                {
                    role: Type.Union([Type.Literal('user'), Type.Literal('assistant')]),
                    content: Type.String({ maxLength: 16000 }),
                },
                { additionalProperties: false },
            ),
            { maxItems: 26 },
        ),
        sources: Type.Array(
            Type.Object(
                {
                    id: UuidSchema,
                    url: Type.String({ maxLength: 8000 }),
                    title: Type.String({ maxLength: 1000 }),
                    text: Type.String({ maxLength: 4000 }),
                    observedAt: Type.String(),
                },
                { additionalProperties: false },
            ),
            { maxItems: 24 },
        ),
        omittedTurns: Type.Integer({ minimum: 0 }),
        earlierTurns: Type.Optional(
            Type.Array(
                Type.Object(
                    {
                        questionId: UuidSchema,
                        question: Type.String({ maxLength: 256 }),
                        answer: Type.String({ maxLength: 512 }),
                    },
                    { additionalProperties: false },
                ),
                { maxItems: 16 },
            ),
        ),
    },
    { additionalProperties: false },
);
export type ReportConversationContext = Static<typeof ReportConversationContextSchema>;
describeProperties(ReportConversationContextSchema);
