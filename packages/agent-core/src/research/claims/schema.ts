import { evidenceLinks } from '../../evidence/links.ts';
import { ClaimAssessmentWireSchema } from '@scova/models';
import { type ResearchState, MAX_QUESTIONS, MAX_QUERIES } from '../state.ts';

export function planSchema(questionIds: string[]): Record<string, unknown> {
    return {
        type: 'object',
        additionalProperties: false,
        required: ['queries'],
        properties: {
            queries: {
                type: 'array',
                minItems: 1,
                maxItems: MAX_QUERIES,
                items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['query', 'questionIds'],
                    properties: {
                        query: { type: 'string', minLength: 1, maxLength: 2000 },
                        questionIds: {
                            type: 'array',
                            minItems: 1,
                            maxItems: MAX_QUESTIONS,
                            items: { type: 'string', enum: questionIds },
                        },
                    },
                },
            },
        },
    };
}

export function linkedEvidence(state: ResearchState) {
    return state.evidencePolicy
        ? evidenceLinks(
              state.synthesisExtractions ?? [],
              state.pages,
              state.questions.map((q) => q.id),
          )
        : [];
}

export const claimSchema: Record<string, unknown> = {
    type: 'object',
    additionalProperties: false,
    required: ['claims'],
    properties: {
        claims: {
            type: 'array',
            minItems: 1,
            maxItems: 30,
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['kind', 'text', 'citations', 'questionIds'],
                properties: {
                    assessment: ClaimAssessmentWireSchema,
                    kind: {
                        type: 'string',
                        enum: ['fact', 'inference', 'conflict', 'insufficient'],
                    },
                    text: { type: 'string', minLength: 1, maxLength: 2000 },
                    questionIds: {
                        type: 'array',
                        maxItems: MAX_QUESTIONS,
                        items: { type: 'string' },
                    },
                    citations: {
                        type: 'array',
                        maxItems: 10,
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            required: ['pageId', 'quote'],
                            properties: {
                                pageId: { type: 'string' },
                                quote: { type: 'string', minLength: 1, maxLength: 2000 },
                            },
                        },
                    },
                },
            },
        },
    },
};
