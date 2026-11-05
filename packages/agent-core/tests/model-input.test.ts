import { describe, expect, it } from 'vite-plus/test';
import { estimateModelInputTokens } from '@scova/connectors';
import { evidenceExcerpt, fitSources } from '../src/model-input.ts';
import type { AgentPage } from '../src/types.ts';

describe('model source coverage', () => {
    const input = { prompt: 'summarize', schema: {}, maxInputTokens: 3000, maxOutputTokens: 1000 };
    const pages = ['a', 'b'].map(
        (id) =>
            ({
                id,
                url: `https://example.com/${id}`,
                questionIds: ['q0'],
                text: `开头${'😀中间。'.repeat(2000)}结尾`,
            }) as AgentPage,
    );
    it('fits all sources into remaining input, preserving separate exact head/middle/tail excerpts', () => {
        const result = fitSources(input, pages);
        expect(result.clipped).toBe(true);
        expect(estimateModelInputTokens(result.input)).toBeLessThanOrEqual(input.maxInputTokens);
        const sources = result.input.untrustedSources as { pageId: string; excerpts: string[] }[];
        expect(sources).toHaveLength(2);
        for (const [index, source] of sources.entries()) {
            expect(source.excerpts[0].startsWith('开头')).toBe(true);
            expect(source.excerpts.at(-1)!.endsWith('结尾')).toBe(true);
            for (const excerpt of source.excerpts) {
                expect(pages[index].text).toContain(excerpt);
                expect(excerpt.isWellFormed()).toBe(true);
            }
        }
    });
    it('rejects input that cannot fit metadata instead of silently dropping pages', () => {
        expect(() => fitSources({ ...input, maxInputTokens: 10 }, pages)).toThrow(/预算不足/);
    });
    it('comparison includes content past 4000 characters when its larger budget fits', () => {
        const body = 'source '.repeat(1800) + 'Final important finding.';
        const result = fitSources(
            { ...input, maxInputTokens: 40000 },
            [{ ...pages[0], text: body }],
            true,
        );
        expect(result.clipped).toBe(false);
        expect(result.input.untrustedSources).toEqual([
            { pageId: 'a', url: 'https://example.com/a', questionIds: ['q0'], text: body },
        ]);
    });
    it('ends evidence at a sentence boundary and preserves Unicode when none exists', () => {
        expect(evidenceExcerpt(`完整句子。${'后续'.repeat(400)}`)).toBe('完整句子。');
        const result = evidenceExcerpt('😀'.repeat(600));
        expect(Array.from(result)).toHaveLength(500);
        expect(result.isWellFormed()).toBe(true);
    });
});
