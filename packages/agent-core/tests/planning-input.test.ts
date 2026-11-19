import { describe, expect, it } from 'vite-plus/test';
import { estimateModelInputTokens, type StructuredInput } from '@scova/connectors';
import { fitPlanningInput } from '../src/model/planning-input.ts';
import { requirementPlanSchema } from '../src/report/artifacts/index.ts';

describe('planning input preflight', () => {
    const frozen = {
        questions: [
            { id: 'q0', text: '核对官方信息，不要求最近变化；必须完整保留用户对象与字段。' },
        ],
        topic: '标准规范',
        excluded: ['广告'],
    };
    const input: StructuredInput = {
        prompt: 'Repeated instructions '.repeat(400),
        schema: {
            type: 'object',
            properties: { requirements: requirementPlanSchema(['brief'], ['q0']) },
        },
        maxInputTokens: 4000,
        maxOutputTokens: 1000,
    };
    it('fits the original 4000 stage limit without changing schema, user scope or output budget', () => {
        const prepared = fitPlanningInput(input, frozen, ['brief']);
        expect(estimateModelInputTokens(prepared)).toBeLessThanOrEqual(4000);
        expect(prepared.maxInputTokens).toBe(4000);
        expect(prepared.maxOutputTokens).toBe(1000);
        expect(prepared.schema).toBe(input.schema);
        expect(prepared.prompt).toContain(JSON.stringify(frozen));
    });
    it('keeps geographic-neutral instructions when fitting v2, without upgrading older inputs', () => {
        const scoped = { ...frozen, topic: 'Compare consumer protection in Japan and France' };
        expect(fitPlanningInput(input, scoped, ['brief'], 1).prompt).not.toContain(
            'Geographic scope:',
        );
        const { prompt } = fitPlanningInput(input, scoped, ['brief'], 2);
        expect(prompt).toContain('Do not infer the user’s location');
        expect(prompt).toContain('Preserve any geographic scope explicitly requested');
        expect(prompt).toContain(JSON.stringify(scoped));
    });
    it('returns already bounded input unchanged', () => {
        const compact = { ...input, prompt: 'Use frozen requirements.' };
        expect(fitPlanningInput(compact, frozen, ['brief'])).toBe(compact);
    });
    it('fails locally before a paid call when a full task cannot fit, without truncation', () => {
        expect(() =>
            fitPlanningInput({ ...input, maxInputTokens: 100 }, frozen, ['brief']),
        ).toThrow();
    });
});
