import { describe, expect, it } from 'vite-plus/test';
import { collectionDateEntry } from '../src/research/collection.ts';
import { baselineEligibility } from '../src/research/baseline.ts';
import { partitionClaims } from '../src/research/claims.ts';
import { compareCollection } from '../src/report/comparison/collection.ts';
import type { AgentContext, AgentPage, ComparisonManifest } from '../src/types.ts';
import type { ResearchState } from '../src/research/state.ts';
import type { Coverage } from '@scova/models';

const context = {
    config: {
        researchMode: 'collection',
        timeRange: { kind: 'fixed', start: '2026-11-10T00:00:00Z', end: '2026-11-17T00:00:00Z' },
        timezone: 'UTC',
    },
} as AgentContext;
const page = (meta: string) =>
    ({
        id: 'read-0',
        url: 'https://example.com/a',
        title: 'Release',
        publication: {
            parserVersion: 'scova-publication-v2',
            status: 'unknown',
            instant: null,
            observations: [...meta.matchAll(/property="([^"]+)" content="([^"]+)"/g)].map((m) => ({
                field:
                    m[1] === 'article:modified_time' ? 'meta:modified' : 'article:published_time',
                rawValue: m[2],
                locator: 'head>meta',
            })),
        },
    }) as AgentPage;
const published = (date: string) => `<meta property="article:published_time" content="${date}">`;
const modified = (date: string) => `<meta property="article:modified_time" content="${date}">`;

describe('frozen collection and baseline policy', () => {
    it('uses a trusted update only when publication is unknown, without overriding outside/conflicting publication', () => {
        expect(collectionDateEntry(context, page(modified('2026-11-15T12:00:00Z')))).toMatchObject({
            status: 'accepted',
            dateKind: 'modified',
            dateSource: 'meta:modified',
        });
        expect(
            collectionDateEntry(
                context,
                page(published('2026-10-01T00:00:00Z') + modified('2026-11-15T12:00:00Z')),
            ),
        ).toMatchObject({ status: 'outside', dateKind: 'published' });
        expect(
            collectionDateEntry(
                context,
                page(
                    published('2026-11-13T00:00:00Z') +
                        published('2026-11-14T00:00:00Z') +
                        modified('2026-11-15T12:00:00Z'),
                ),
            ).status,
        ).toBe('unconfirmed');
    });
    it('retains known day precision without inventing a UTC publication timestamp', () => {
        expect(collectionDateEntry(context, page(published('2026-11-15')))).toMatchObject({
            status: 'accepted',
            publishedAt: null,
            dateValue: '2026-11-15',
            dateKind: 'published',
        });
        expect(collectionDateEntry(context, page(''))).toMatchObject({
            status: 'unconfirmed',
            publishedAt: null,
        });
    });
    it('rejects inference, partial support and paraphrased values only under the new collection policy', () => {
        const source = { ...page(''), text: 'Version 24 was released.', questionIds: ['q0'] };
        const state = {
            questions: [{ id: 'q0', text: 'version' }],
            pages: [source],
            collectionPolicy: 1,
        } as ResearchState;
        const fact = {
            kind: 'fact',
            text: 'Version 24',
            questionIds: ['q0'],
            citations: [{ pageId: 'read-0', quote: source.text }],
            assessment: {
                relevance: 'direct',
                support: 'direct',
                role: 'answer',
                sourceRelation: 'unknown',
                reason: 'exact',
                conditions: '',
                gap: '',
            },
        };
        expect(partitionClaims({ claims: [fact] }, state).accepted).toHaveLength(1);
        expect(
            partitionClaims({ claims: [{ ...fact, kind: 'inference' }] }, state).accepted,
        ).toEqual([]);
        expect(
            partitionClaims(
                { claims: [{ ...fact, assessment: { ...fact.assessment, support: 'partial' } }] },
                state,
            ).accepted,
        ).toEqual([]);
        expect(
            partitionClaims(
                { claims: [{ ...fact, text: 'The release is version twenty four' }] },
                state,
            ).accepted,
        ).toEqual([]);
        expect(
            partitionClaims(
                { claims: [{ ...fact, kind: 'inference' }] },
                { ...state, collectionPolicy: undefined },
            ).accepted,
        ).toHaveLength(1);
    });
    it('separates an answered model report from an externally complete comparison origin', () => {
        const coverage = {
            completeness: 'complete',
            gaps: [],
            artifacts: [
                { coverage: { requirements: [{ required: true, status: 'model_answered' }] } },
            ],
        } as unknown as Coverage;
        expect(baselineEligibility(coverage)).toMatchObject({
            eligible: false,
            reason: 'external_incomplete',
            modelOnlyFields: 1,
        });
        coverage.artifacts![0]!.coverage!.requirements[0]!.status = 'supported';
        expect(baselineEligibility(coverage)).toMatchObject({
            eligible: true,
            reason: 'eligible',
            modelOnlyFields: 0,
        });
        coverage.completeness = 'partial';
        expect(baselineEligibility(coverage).eligible).toBe(false);
    });
    it('compares collection entries by object/field and trusted date before their value', () => {
        const fact = {
            subject: 'Node',
            predicate: 'version',
            value: '24',
            quote: '24',
            relevance: 'relevant',
            importance: 'important',
        };
        const prior = { pageId: 'old', publicationKey: 'published:2026-11-14', facts: [fact] };
        const ctx = {
            baselineRunId: 'old-run',
            baseline: {
                manifest: { pages: [prior] },
                evidence: [{ id: 'e0', pageId: 'old', quote: '24' }],
            },
        } as AgentContext;
        const manifest = {
            pages: [
                {
                    pageId: 'new',
                    url: 'https://example.com/a',
                    publicationKey: 'published:2026-11-15',
                    facts: [fact],
                },
            ],
        } as unknown as ComparisonManifest;
        expect(compareCollection(ctx, manifest, true).changes[0]!.kind).toBe('new');
        manifest.pages[0]!.publicationKey = prior.publicationKey;
        expect(compareCollection(ctx, manifest, true).changes[0]!.kind).toBe('duplicate');
        manifest.pages[0]!.facts = [{ ...fact, id: 'f1', value: '25' } as never];
        expect(compareCollection(ctx, manifest, true).changes[0]!.kind).toBe('changed');
        for (const limitation of [
            { truncated: true },
            { collection: { complete: false } },
            { extractionVersion: 'search-api/reader/v1' },
        ]) {
            const current = {
                id: 'new',
                extractionVersion: 'reader/v1',
                ...limitation,
            } as AgentPage;
            expect(compareCollection(ctx, manifest, true, [current]).changes[0]!).toMatchObject({
                kind: 'uncertain',
                important: false,
            });
        }
    });
});
