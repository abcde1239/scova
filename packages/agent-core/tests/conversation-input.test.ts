import { describe, expect, it } from 'vite-plus/test';
import { estimateModelInputTokens, type StructuredInput } from '@scova/connectors';
import type { ReportConversationContext } from '@scova/models';
import { withReportConversation } from '../src/model/conversation-input.ts';

function input(): StructuredInput {
    const value = {
        prompt: 'Frozen research instructions. '.repeat(400),
        schema: { type: 'object', properties: { answer: { type: 'string' } } },
        maxInputTokens: 1,
        maxOutputTokens: 1000,
    };
    value.maxInputTokens = estimateModelInputTokens(value) + 4000;
    return value;
}
function snapshot(): ReportConversationContext {
    return {
        version: 1,
        reportId: crypto.randomUUID(),
        questionId: crypto.randomUUID(),
        operation: 'revise',
        report: { title: '报告', summary: '已保存的发现', claims: ['第一点', '第二点'] },
        messages: [
            { role: 'user', content: '解释第二点' },
            { role: 'assistant', content: '第二点适用于指定条件' },
            { role: 'user', content: '保留条件整理成新版' },
        ],
        sources: [],
        omittedTurns: 0,
    };
}

describe('report discussion input allowance', () => {
    it('keeps a short report and its references when fixed instructions exceed the old discussion target', () => {
        const request = input();
        const context = snapshot();
        const original = structuredClone(context);
        expect(estimateModelInputTokens(request)).toBeGreaterThan(request.maxInputTokens * 0.6);
        const fitted = withReportConversation(request, context);
        expect(fitted.prompt).toContain('第二点');
        expect(fitted.messages).toEqual(context.messages);
        expect(estimateModelInputTokens(fitted)).toBeLessThanOrEqual(request.maxInputTokens);
        expect(context).toEqual(original);
    });

    it('still trims oversized discussion while reserving remaining input for source evidence', () => {
        const request = input();
        const context = snapshot();
        context.earlierTurns = [
            {
                questionId: crypto.randomUUID(),
                question: '旧问题'.repeat(80),
                answer: '旧回答'.repeat(160),
            },
        ];
        context.messages.unshift(
            { role: 'user', content: '较早问题'.repeat(500) },
            { role: 'assistant', content: '较早说明'.repeat(500) },
        );
        context.report.claims = Array.from(
            { length: 30 },
            (_, i) => `${i}：${'已保存的详细内容。'.repeat(30)}`,
        );
        const original = structuredClone(context);
        const fixedTokens = estimateModelInputTokens(request);
        const fitted = withReportConversation(request, context);
        expect(fitted.messages).toEqual(original.messages.slice(-3));
        expect(fitted.prompt).not.toContain('旧回答');
        expect(fitted.prompt).toContain('"omittedTurns":1');
        expect(estimateModelInputTokens(fitted) - fixedTokens).toBeLessThanOrEqual(
            Math.floor((request.maxInputTokens - fixedTokens) * 0.6),
        );
        expect(context).toEqual(original);
    });
});
