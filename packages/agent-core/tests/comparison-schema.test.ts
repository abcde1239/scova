import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vite-plus/test';
import { comparisonSchema, manifestFromModel } from '../src/comparison.ts';
import type { AgentContext, AgentPage } from '../src/types.ts';

function fixture() {
    const quote = 'The revision links https://example.org/original with 40 participants.';
    const page: AgentPage = {
        id: 'read-0',
        kind: 'read_page',
        mode: 'live',
        originalUrl: 'https://example.org/revision',
        url: 'https://example.org/revision',
        fetchedUrl: 'https://example.org/revision',
        title: 'Study revision',
        text: quote,
        contentHash: createHash('sha256').update(quote).digest('hex'),
        extractionVersion: 'test-v1',
        collectedAt: '2026-11-03T00:00:00Z',
        truncated: false,
        untrusted: true,
        questionIds: ['q0'],
    };
    // Decoding only reads these identity fields; execution context is outside this boundary.
    const context = {
        runId: 'run-live',
        userId: 'owner',
        comparisonScopeHash: 'scope',
        mode: 'live',
    } as AgentContext;
    const fact = {
        subject: 'Study',
        predicate: 'sample count',
        value: '40 participants',
        quote,
        relevance: 'relevant',
        importance: 'important',
    };
    const response = (relation: unknown) => ({
        pages: [{ pageId: page.id, facts: [{ ...fact, relation }] }],
    });
    return { context, page, response, quote };
}

describe('comparison model strict schema contract', () => {
    it('requires every declared object property and allows a null relation on the wire', () => {
        function check(schema: Record<string, unknown>, path: string) {
            const types = Array.isArray(schema.type) ? schema.type : [schema.type];
            if (types.includes('object')) {
                const properties = schema.properties as Record<string, Record<string, unknown>>;
                expect(schema.additionalProperties, path).toBe(false);
                expect([...(schema.required as string[])].sort(), path).toEqual(
                    Object.keys(properties).sort(),
                );
                for (const [name, child] of Object.entries(properties)) {
                    if (name === 'relation') expect(child.type).toContain('null');
                    check(child, `${path}.${name}`);
                }
            }
            if (schema.items) check(schema.items as Record<string, unknown>, `${path}[]`);
        }
        check(comparisonSchema, '$');
    });

    it('normalizes a nullable wire relation to absent without changing the response', () => {
        const { context, page, response } = fixture();
        const input = response(null);
        const manifest = manifestFromModel(input, context, [page]);
        expect(manifest).not.toBeNull();
        expect(manifest!.pages[0]!.facts[0]).not.toHaveProperty('relation');
        expect(input.pages[0]!.facts[0]!.relation).toBeNull();
    });

    it('preserves a supported relation and still rejects fabricated or malformed relations', () => {
        const { context, page, response, quote } = fixture();
        const relation = { kind: 'revision', url: 'https://example.org/original', quote };
        expect(
            manifestFromModel(response(relation), context, [page])!.pages[0]!.facts[0]!.relation,
        ).toEqual(relation);
        for (const invalid of [
            false,
            {},
            { ...relation, kind: 'unsupported' },
            { ...relation, quote: 'Invented quotation https://example.org/original' },
            { ...relation, url: 'https://example.org/invented' },
        ]) {
            expect(manifestFromModel(response(invalid), context, [page])).toBeNull();
        }
    });
});
