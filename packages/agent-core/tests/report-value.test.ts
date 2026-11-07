import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vite-plus/test';
import { ReportValueSchema, parseContract, type ClaimAssessment } from '@scova/models';
import { buildReportValue, readAssessment, taskQuestions } from '../src/report-value.ts';
import type { AgentClaim, AgentContext, AgentPage } from '../src/types.ts';

const assessment: ClaimAssessment = {
    relevance: 'direct',
    support: 'direct',
    role: 'answer',
    sourceRelation: 'unknown',
    reason: '原文直接记载截止日期',
    conditions: '',
    gap: '',
};
const context = {
    config: {
        topic: '申请',
        goal: '何时截止？',
        focusPoints: ['必须回答：费用', '申请流程'],
        timeRange: { kind: 'fixed', start: '2026-11-01T00:00:00Z', end: '2026-11-06T00:00:00Z' },
    },
} as AgentContext;
const page = {
    id: 'read-0',
    url: 'https://example.test/application',
    text: '11月5日截止。',
    contentHash: createHash('sha256').update('11月5日截止。').digest('hex'),
    publication: {
        parserVersion: 'scova-publication-v1',
        status: 'known',
        instant: '2026-11-03T00:00:00Z',
        observations: [
            { field: 'datePublished', rawValue: '2026-11-03T00:00:00Z', locator: 'meta' },
        ],
    },
} as AgentPage;
function claim(values: Partial<AgentClaim> = {}): AgentClaim {
    return {
        kind: 'fact',
        text: page.text,
        questionIds: ['q0'],
        citations: [{ pageId: page.id, quote: page.text }],
        assessment,
        ...values,
    };
}
const build = (claims: AgentClaim[], pages = [page]) =>
    parseContract(
        ReportValueSchema,
        buildReportValue(context, taskQuestions(context), claims, pages),
    );

describe('question-first report selection', () => {
    it('freezes original questions and explicit must-answer priorities', () => {
        const value = build([claim()]);
        expect(value.questions.map((q) => [q.id, q.priority, q.status])).toEqual([
            ['q0', 'core', 'supported'],
            ['q1', 'core', 'unresolved'],
            ['q2', 'supporting', 'unresolved'],
        ]);
    });
    it('does not treat an exact quote as semantic support when it only supplies background', () => {
        const value = build([claim({ assessment: { ...assessment, relevance: 'background' } })]);
        expect(value.questions[0].status).toBe('unresolved');
        expect(value.selections[0].placement).toBe('reference');
    });
    it.each(['none', 'unknown'] as const)('does not promote %s support', (support) => {
        expect(
            build([claim({ assessment: { ...assessment, support } })]).selections[0].placement,
        ).toBe('reference');
    });
    it('retains useful conditional content next to its gap without claiming completion', () => {
        const value = build([
            claim({
                kind: 'inference',
                assessment: {
                    ...assessment,
                    support: 'partial',
                    conditions: '仅限境内申请',
                    gap: '境外时间未说明',
                },
            }),
        ]);
        expect(value.questions[0].status).toBe('provisional');
        expect(value.questions[0].gap).toContain('境外');
        expect(value.selections[0].placement).toBe('main');
    });
    it('keeps missing assessments unknown instead of fabricating verified answers', () => {
        const value = build([claim({ assessment: undefined })]);
        expect(value.selections[0].basis).toBe('unassessed');
        expect(value.questions[0].status).toBe('unresolved');
        expect(readAssessment({ ...assessment, support: 99 })).toBeUndefined();
    });
    it('does not let a self-assessment promote a claim without citations', () => {
        const value = build([claim({ kind: 'insufficient', citations: [] })]);
        expect(value.questions[0].status).toBe('unresolved');
        expect(value.selections[0].placement).toBe('reference');
    });
    it('keeps conflicts and conditions distinct while omitting exact repetitions', () => {
        const value = build([
            claim(),
            claim(),
            claim({ kind: 'conflict', text: '两来源日期不同。' }),
            claim({ assessment: { ...assessment, conditions: '仅境内' } }),
        ]);
        expect(value.selections.map((s) => s.placement)).toEqual([
            'main',
            'omitted',
            'main',
            'main',
        ]);
        expect(value.questions[0].status).toBe('disputed');
    });
    it('excludes unrelated text without discarding the stored claim', () => {
        const claims = [claim({ assessment: { ...assessment, relevance: 'unrelated' } })];
        const snapshot = structuredClone(claims);
        expect(build(claims).selections[0].placement).toBe('omitted');
        expect(claims).toEqual(snapshot);
    });
    it('unknown dates and older background cannot be certified as current answers', () => {
        expect(build([claim()], [{ ...page, publication: undefined }]).questions[0].status).toBe(
            'provisional',
        );
        const old: AgentPage = {
            ...page,
            publication: {
                ...page.publication!,
                instant: '2025-01-01T00:00:00Z',
                observations: [
                    { field: 'datePublished', rawValue: '2025-01-01T00:00:00Z', locator: 'meta' },
                ],
            },
        };
        expect(build([claim()], [old]).selections[0].timeScope).toBe('background');
    });
    it('does not let one supported detail erase another important condition', () => {
        const value = build([
            claim(),
            claim({ text: '还需要核实资格。', assessment: { ...assessment, gap: '资格未说明' } }),
        ]);
        expect(value.questions[0].status).toBe('provisional');
    });
});
