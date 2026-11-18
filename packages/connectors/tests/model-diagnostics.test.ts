import { Ajv } from 'ajv';
import { describe, expect, it } from 'vite-plus/test';
import { modelSchemaHash, modelSchemaIssues } from '../src/model/diagnostics.ts';

describe('trusted model contract diagnostics', () => {
    it('groups literal unions and preserves independent required and array limits', () => {
        const schema = {
            type: 'object',
            additionalProperties: false,
            properties: {
                relevance: {
                    anyOf: ['direct', 'background', 'unrelated', 'unknown'].map((value) => ({
                        const: value,
                        type: 'string',
                    })),
                },
                claims: { type: 'array', maxItems: 2, items: { type: 'string' } },
                assessment: { type: 'string' },
                outputFormat: { type: 'string' },
            },
            required: ['relevance', 'claims', 'assessment', 'outputFormat'],
        };
        const validate = new Ajv({ allErrors: true }).compile(schema);
        expect(
            validate({
                relevance: 'DO_NOT_RENDER sk-secret',
                claims: ['one', 'two', 'three'],
                DO_NOT_RENDER: 'sk-secret',
            }),
        ).toBe(false);
        const issues = modelSchemaIssues(schema, validate.errors!);
        expect(issues).toContainEqual({
            schemaPath: '#/properties/relevance/anyOf',
            keyword: 'enum',
            allowedValues: ['direct', 'background', 'unrelated', 'unknown'],
        });
        expect(issues.filter((i) => i.schemaPath === '#/properties/relevance/anyOf')).toHaveLength(
            1,
        );
        expect(issues).toContainEqual({
            schemaPath: '#/properties/claims/maxItems',
            keyword: 'maxItems',
            limit: 2,
        });
        expect(issues).toContainEqual({
            schemaPath: '#/additionalProperties',
            keyword: 'additionalProperties',
            allowedProperties: ['relevance', 'claims', 'assessment', 'outputFormat'],
        });
        expect(
            issues.filter((i) => i.keyword === 'required').map((i) => i.requiredProperty),
        ).toEqual(['assessment', 'outputFormat']);
        expect(JSON.stringify(issues)).not.toMatch(/DO_NOT_RENDER|sk-secret/);
        expect(modelSchemaHash(schema)).toMatch(/^[a-f0-9]{64}$/);
        expect(modelSchemaHash(structuredClone(schema))).toBe(modelSchemaHash(schema));
        expect(modelSchemaHash({ ...schema, required: ['claims'] })).not.toBe(
            modelSchemaHash(schema),
        );
    });
});
