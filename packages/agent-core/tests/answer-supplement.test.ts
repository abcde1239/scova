import { describe, expect, it } from 'vite-plus/test';
import { answerSupplementDecision } from '../src/answer-supplement.ts';
import type { AgentContext } from '../src/types.ts';
import type { ReportValue } from '@scova/models';
const now = Date.now();
function fixture() {
    const context = {
        budget: { maxSearches: 10, maxPages: 20, maxInputTokens: 10000, maxOutputTokens: 10000 },
        usage: { searches: 1, pages: 1, inputTokens: 100, outputTokens: 100 },
        deadlineAt: new Date(now + 300000),
    } as AgentContext;
    const input = {
        value: {
            version: 1,
            questions: [
                {
                    id: 'q0',
                    text: '原问题',
                    priority: 'core',
                    status: 'provisional',
                    claimIndexes: [0],
                    gap: '条件缺失',
                },
            ],
            selections: [],
        } as ReportValue,
        supplementalSearches: 0,
        queryCount: 1,
        readIndex: 1,
        synthesisAttempts: 1,
        modelBlocked: false,
        searchBlocked: false,
        finalInput: 7000,
        finalOutput: 5000,
        now,
    };
    return { context, input };
}
describe('bounded answer-gap supplementation', () => {
    it('targets an unresolved core question within the original allowances', () => {
        const { context, input } = fixture();
        expect(answerSupplementDecision(context, input).target?.id).toBe('q0');
    });
    it.each([
        'supplement_limit',
        'query_limit',
        'read_limit',
        'input_reserve',
        'output_reserve',
        'deadline',
        'repair_used',
        'blocked',
        'answered',
    ])('stops before new requests: %s', (kind) => {
        const { context, input } = fixture();
        if (kind === 'supplement_limit') input.supplementalSearches = 2;
        if (kind === 'query_limit') input.queryCount = 10;
        if (kind === 'read_limit') input.readIndex = 20;
        if (kind === 'input_reserve') context.usage.inputTokens = 9000;
        if (kind === 'output_reserve') context.usage.outputTokens = 9000;
        if (kind === 'deadline') context.deadlineAt = new Date(now + 100000);
        if (kind === 'repair_used') input.synthesisAttempts = 2;
        if (kind === 'blocked') input.searchBlocked = true;
        if (kind === 'answered') input.value.questions[0].status = 'supported';
        expect(answerSupplementDecision(context, input).target).toBeUndefined();
    });
});
