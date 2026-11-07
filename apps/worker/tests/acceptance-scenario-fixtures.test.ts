import { describe, expect, it } from 'vite-plus/test';
import type { AgentClaim } from '@scova/agent-core';
import { ClaimAssessmentSchema, parseContract } from '@scova/models';
import { scenarioConnectors, scenarioNames } from './support/acceptance-scenario-fixtures.ts';

describe('controlled acceptance suppliers', () => {
    for (const name of scenarioNames) {
        for (const phase of ['A', 'B'] as const) {
            it(`${name}/${phase} supplies assessed target facts with real reader quotes`, async () => {
                const bundle = scenarioConnectors(name, phase, { browserScenarios: true });
                const results = await bundle.search.search('fixture target');
                const pages = await Promise.all(
                    results.results.map(async (result, index) => {
                        const page = await bundle.reader.read(result.url);
                        expect(page.publication?.status).toBe('known');
                        return { pageId: `page-${index}`, url: page.url, text: page.text };
                    }),
                );
                const response = await bundle.model.generateStructured<{ claims: AgentClaim[] }>({
                    prompt: 'Controlled target facts, not remote research.',
                    schema: { properties: { claims: {} } },
                    maxInputTokens: 40000,
                    maxOutputTokens: 8000,
                    untrustedSources: pages,
                });
                const facts = response.data.claims.filter((claim) => claim.kind === 'fact');
                expect(facts.length).toBeGreaterThan(0);
                for (const claim of facts) {
                    expect(parseContract(ClaimAssessmentSchema, claim.assessment)).toMatchObject({
                        relevance: 'direct',
                        support: 'direct',
                        role: 'answer',
                        conditions: '',
                        gap: '',
                    });
                    expect(claim.questionIds).toEqual(['q0']);
                    for (const citation of claim.citations) {
                        expect(
                            pages.find((page) => page.pageId === citation.pageId)?.text,
                        ).toContain(citation.quote);
                    }
                }
                if (name === 'english' && phase === 'B') {
                    expect(
                        facts.some((claim) => /paid subscription|C1 audio/.test(claim.text)),
                    ).toBe(false);
                }
                if (name === 'research' && phase === 'B') {
                    expect(
                        facts.some((claim) => claim.assessment?.sourceRelation === 'secondary'),
                    ).toBe(true);
                    expect(
                        response.data.claims.some(
                            (claim) => claim.kind === 'conflict' && claim.citations.length === 2,
                        ),
                    ).toBe(true);
                    expect(
                        response.data.claims.some(
                            (claim) => claim.kind === 'insufficient' && !claim.citations.length,
                        ),
                    ).toBe(true);
                }
            });
        }
    }
});
