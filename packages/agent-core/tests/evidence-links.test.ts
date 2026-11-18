import { describe, expect, it } from 'vite-plus/test';
import { citationSupportsQuestions, evidenceLinks } from '../src/evidence/links.ts';
import type { AgentPage } from '../src/types.ts';

const page = {
    id: 'p0',
    text: 'Only offline: persistent memory is disabled. Price: $20.',
    questionIds: ['q0'],
} as AgentPage;
const link = {
    pageId: 'p0',
    questionId: 'q1',
    quote: 'Only offline: persistent memory is disabled.',
    reason: 'Explains the memory condition.',
};
const receipt = (links: unknown[]) => ({
    response: { data: { evidenceLinks: links } },
});

describe('passage-scoped evidence associations', () => {
    it('keeps the original discovery relation and limits the new relation to the exact passage', () => {
        const before = structuredClone(page);
        const links = evidenceLinks([receipt([link])], [page], ['q0', 'q1']);
        expect(citationSupportsQuestions(page, link.quote, ['q0', 'q1'], links)).toBe(true);
        expect(citationSupportsQuestions(page, 'Price: $20.', ['q1'], links)).toBe(false);
        expect(citationSupportsQuestions(page, link.quote, ['q2'], links)).toBe(false);
        expect(page).toEqual(before);
    });

    it.each([
        { ...link, pageId: 'foreign' },
        { ...link, questionId: 'foreign' },
        { ...link, quote: 'persistent memory is enabled' },
        { ...link, quote: 'Only offline … disabled.' },
        { ...link, reason: '' },
        { ...link, authority: true },
    ])('rejects malformed, fabricated, stitched or foreign associations (%j)', (invalid) => {
        expect(evidenceLinks([receipt([invalid])], [page], ['q0', 'q1'])).toEqual([]);
    });
});
