import { ArtifactDocumentSchema } from '@scova/models';
import { type Format } from './requirements.ts';

export function artifactSynthesisSchema(formats: Format[]) {
    return {
        type: 'array',
        minItems: 1,
        maxItems: 4,
        items: {
            type: 'object',
            additionalProperties: false,
            required: ['format', 'requirements', 'document'],
            properties: {
                format: { type: 'string', enum: formats },
                document: {
                    anyOf: [JSON.parse(JSON.stringify(ArtifactDocumentSchema)), { type: 'null' }],
                },
                requirements: {
                    type: 'array',
                    maxItems: 60,
                    items: {
                        type: 'object',
                        additionalProperties: false,
                        required: ['id', 'text', 'claimIndexes'],
                        properties: {
                            id: { type: 'string', minLength: 1, maxLength: 80 },
                            text: { type: 'string', maxLength: 2000 },
                            claimIndexes: {
                                type: 'array',
                                maxItems: 30,
                                uniqueItems: true,
                                items: { type: 'integer', minimum: 0, maximum: 29 },
                            },
                        },
                    },
                },
            },
        },
    };
}
