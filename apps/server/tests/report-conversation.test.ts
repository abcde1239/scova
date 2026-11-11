import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vite-plus/test';
import { estimateModelInputTokens } from '@scova/connectors';
import type { Report, ReportQuestion } from '@scova/models';
import { conversationContext, questionContextInput } from '../src/utils/report-conversation.ts';
import {
    questionModelSchema,
    questionPrompt,
    validateQuestionAnswer,
} from '../src/utils/report-questions.ts';

const evidenceId = randomUUID();
const report = {
    id: randomUUID(),
    title: '报告',
    summary: '报告摘要',
    claims: [{ text: '第一点' }, { text: '第二点' }],
    evidence: [
        {
            id: evidenceId,
            url: 'https://example.com/notice',
            title: '公告',
            quote: '申请时间尚未确认。',
            observedAt: '2026-11-10T00:00:00Z',
        },
    ],
} as Report;
const turn = (question: string): ReportQuestion => ({
    id: randomUUID(),
    reportId: report.id,
    question,
    answer: {
        status: 'answered',
        statements: [
            {
                text: '申请时间尚未确认。',
                citations: [{ evidenceId, quote: '申请时间尚未确认。' }],
            },
        ],
        reason: 'evidence_answer',
        needsResearch: false,
        usage: { attempts: 1, inputTokens: 100, outputTokens: 20, estimated: false },
    },
    followupRunId: null,
    createdAt: '2026-11-10T00:00:00Z',
});

describe('report conversation input and provenance', () => {
    it('keeps recent ordered roles and traceable older excerpts without inventing evidence', () => {
        const history = Array.from({ length: 40 }, (_, i) => turn(`第${i}轮`));
        const context = conversationContext(report, randomUUID(), '解释第二点', history);
        expect(context.messages).toHaveLength(25);
        expect(context.messages[0]).toEqual({ role: 'user', content: '第28轮' });
        expect(context.earlierTurns?.[0]?.questionId).toBe(history[12]!.id);
        expect(context.earlierTurns).toHaveLength(16);
        expect(context.omittedTurns).toBe(28);
        expect(context.sources).toHaveLength(1);
        const input = questionContextInput(
            context,
            questionPrompt,
            questionModelSchema,
            40000,
            2000,
        );
        expect(input.messages?.at(-1)?.role).toBe('assistant');
        expect(JSON.stringify(input.untrustedSources)).toContain('第二点');
    });
    it('bounds the full payload and retains the current question while leaving stored turns unchanged', () => {
        const history = Array.from({ length: 20 }, () => turn('长问题'.repeat(600)));
        const before = structuredClone(history);
        const context = conversationContext(report, randomUUID(), '继续说明', history);
        const input = questionContextInput(
            context,
            questionPrompt,
            questionModelSchema,
            7000,
            1000,
        );
        expect(estimateModelInputTokens(input)).toBeLessThanOrEqual(7000);
        expect(context.messages.at(-1)?.content).toBe('继续说明');
        expect(context.omittedTurns).toBeGreaterThan(8);
        expect(history).toEqual(before);
    });
    it('allows cited inference but rejects fabricated quotes and unmarked paraphrases', () => {
        const usage = { attempts: 1, inputTokens: 100, outputTokens: 20, estimated: false };
        const value = {
            statements: [
                {
                    kind: 'inference',
                    text: '目前无法据此确定申请日期。',
                    citations: [{ evidenceId, quote: '时间尚未确认' }],
                },
            ],
            needsResearch: false,
        };
        expect(
            validateQuestionAnswer(value, [{ id: evidenceId, quote: '申请时间尚未确认。' }], usage)
                .status,
        ).toBe('answered');
        expect(() =>
            validateQuestionAnswer(
                { ...value, statements: [{ ...value.statements[0], kind: 'fact' }] },
                [{ id: evidenceId, quote: '申请时间尚未确认。' }],
                usage,
            ),
        ).toThrow();
        expect(() =>
            validateQuestionAnswer(value, [{ id: evidenceId, quote: '完全不同的原文' }], usage),
        ).toThrow();
    });
});
