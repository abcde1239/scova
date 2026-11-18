import { describe, expect, it } from 'vite-plus/test';
import { classifyReportDelivery, validReportArtifacts, type ReportValue } from '@scova/models';
import { buildReportArtifacts } from '../src/report/artifacts/index.ts';
import type { AgentClaim, AgentContext, ComparisonExtraction } from '../src/types.ts';

const questions = [
    { id: 'q0', text: '比较隔离级别与并发更新' },
    { id: 'q2', text: '并发更新的影响与重试条件' },
];
const context = { config: { outputFormat: 'research_report' } } as AgentContext;
const requirement = {
    id: 'concurrent-update',
    format: 'research_report',
    object: '隔离级别',
    field: '并发等待、提交回滚、应用限制和重试',
    questionIds: ['q0', 'q2'],
    required: true,
};
const direct = {
    relevance: 'direct',
    support: 'direct',
    role: 'answer',
    sourceRelation: 'original',
    reason: '官方说明',
    conditions: '仅针对该并发更新路径',
    gap: '',
} as const;
const claims: AgentClaim[] = [
    { text: '更新遇到被锁定的行时，后手先等待先手结束。', questionIds: ['q0', 'q2'] },
    { text: '若先手提交实际更新，后手以并发更新错误回滚。', questionIds: ['q2'] },
    { text: '收到上述并发更新错误后，应重试整个事务。', questionIds: ['q2'] },
    { text: '只读事务不发生该级别的更新序列化冲突。', questionIds: ['q2'] },
].map((c) => ({
    ...c,
    kind: 'inference',
    citations: [{ pageId: 'p0', quote: c.text }],
    assessment: direct,
}));
const value: ReportValue = {
    version: 1,
    timeless: true,
    questions: questions.map((q, i) => ({
        ...q,
        priority: i ? 'supporting' : 'core',
        status: 'supported',
        claimIndexes: claims.flatMap((c, index) => (c.questionIds.includes(q.id) ? [index] : [])),
        gap: '',
    })),
    selections: claims.map((c, claimIndex) => ({
        claimIndex,
        questionIds: c.questionIds,
        placement: 'main',
        reason: '回应问题',
        basis: 'model_assessment',
        timeScope: 'unknown',
        assessment: direct,
    })),
};
const receipt = (operationKey: string, data: unknown): ComparisonExtraction => ({
    operationKey,
    response: { mode: 'live', data, usage: { inputTokens: 1, outputTokens: 1, estimated: false } },
});
const build = (source = claims, assessed = value, indexes = [0, 1, 2, 3]) =>
    buildReportArtifacts(
        context,
        questions,
        source,
        assessed,
        receipt('plan-0', { requirements: [requirement] }),
        [
            receipt('synthesize-0', {
                claims: source,
                artifacts: [
                    {
                        format: 'research_report',
                        requirements: [
                            { id: requirement.id, text: source[1]!.text, claimIndexes: indexes },
                        ],
                    },
                ],
            }),
        ],
        (raw) => raw as AgentClaim,
    )[0]!;

describe('compound artifact fields keep their explicit supporting claim group', () => {
    it('uses question coverage across the linked group rather than requiring every claim to repeat the broad goal', () => {
        const artifact = build();
        expect(artifact.coverage?.requirements[0]).toMatchObject({
            status: 'supported',
            claimIndexes: [0, 1, 2, 3],
        });
        expect(validReportArtifacts([artifact], claims, value)).toBe(true);
        expect(classifyReportDelivery(value, claims, [artifact]).status).toBe('answered');
    });
    it('retains a supported subset as partial when the group does not cover every required question', () => {
        const artifact = build(claims, value, [1, 2, 3]);
        expect(artifact.coverage?.requirements[0]).toMatchObject({
            status: 'partial',
            claimIndexes: [1, 2, 3],
        });
    });
    it('keeps a genuinely partial linked statement partial while preserving the remaining direct evidence', () => {
        const source = claims.map((c, index) =>
            index === 2 ? { ...c, assessment: { ...direct, support: 'partial' as const } } : c,
        );
        const assessed = {
            ...value,
            selections: value.selections.map((s, index) =>
                index === 2 ? { ...s, assessment: { ...direct, support: 'partial' as const } } : s,
            ),
        };
        expect(build(source, assessed).coverage?.requirements[0]).toMatchObject({
            status: 'partial',
            claimIndexes: [0, 1, 2, 3],
        });
    });
    it('does not promote an insufficient member merely because another claim covers the broad goal', () => {
        const source = claims.map((c, index) =>
            index === 2 ? { ...c, kind: 'insufficient' as const } : c,
        );
        const artifact = build(source);
        expect(artifact.coverage?.requirements[0]?.claimIndexes).toEqual([0, 1, 3]);
    });
    it('excludes a member whose question tags do not overlap this field at all', () => {
        const source = claims.map((c, index) =>
            index === 3 ? { ...c, questionIds: ['q-unrelated'] } : c,
        );
        const assessed = {
            ...value,
            selections: value.selections.map((s, index) =>
                index === 3 ? { ...s, questionIds: ['q-unrelated'] } : s,
            ),
        };
        expect(build(source, assessed).coverage?.requirements[0]?.claimIndexes).toEqual([0, 1, 2]);
    });
});
