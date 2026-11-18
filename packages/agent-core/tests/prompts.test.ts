import { describe, expect, it } from 'vite-plus/test';
import { researchPrompt } from '../src/model/prompts.ts';

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
    });
});
