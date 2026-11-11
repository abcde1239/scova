import { describe, expect, it } from 'vite-plus/test';
import { researchPrompt, assessmentPrompt } from '../src/prompts.ts';

describe('research prompt contracts', () => {
    it('preserves frozen context and treats task template syntax literally', () => {
        const input = {
            window: { start: '2026-11-01', end: '2026-11-10' },
            task: { goal: '价格 {{input}} $&' },
        };
        const prompt = researchPrompt('synthesis', input);
        expect(prompt).toContain(JSON.stringify(input));
        expect(prompt.match(/价格/g)).toHaveLength(1);
        expect(() => researchPrompt('planning', undefined)).toThrow('requires serializable input');
        expect(prompt).toContain('Simplified Chinese');
        expect(prompt).toContain('Never translate, stitch across excerpts');
        expect(prompt).toContain('billed annually');
        expect(prompt).toContain('Acquisition time is not publication time');
    });
    it('plans complementary sources within frozen questions and separates semantic support from quote matching', () => {
        expect(researchPrompt('planning', { questions: ['q0'] })).toContain(
            'Every questionId must come from the input',
        );
        expect(researchPrompt('planning', {})).toContain('local language');
        expect(assessmentPrompt).toContain('Chinese');
        expect(assessmentPrompt).toContain('support');
    });
});
