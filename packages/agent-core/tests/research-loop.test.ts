import { describe, expect, it } from 'vite-plus/test';
import { allowsKnowledge, fieldChecks, gapActions } from '../src/research/loop.ts';
import type { AgentCandidate, ComparisonExtraction } from '../src/types.ts';
import type { PlannedRequirement } from '../src/report/artifacts/index.ts';

const requirement: PlannedRequirement = {
    id: 'r0',
    format: 'brief',
    questionIds: ['q0'],
    object: 'ReAct',
    field: '机制',
    required: true,
    verification: 'stable',
};
const check = {
    requirementId: 'r0',
    status: 'evidence_missing',
    query: 'ReAct termination conditions',
    reason: '缺少终止条件原文',
};
const receipt = (checks: unknown[], ids = ['r0']): ComparisonExtraction => ({
    operationKey: 'synthesize-0',
    response: {
        mode: 'live',
        usage: { inputTokens: 1, outputTokens: 1, estimated: false },
        data: {
            artifacts: [
                {
                    format: 'brief',
                    requirements: ids.map((id) => ({ id, text: '', claimIndexes: [] })),
                },
            ],
            fieldChecks: checks,
        },
    },
});
const candidate = {
    claims: [],
    pages: [],
    coverage: {
        artifacts: [
            {
                format: 'brief',
                coverage: {
                    requirements: [{ ...requirement, status: 'unknown', claimIndexes: [] }],
                },
            },
        ],
    },
} as unknown as AgentCandidate;

describe('gap-driven decisions', () => {
    it('repairs objectively broken citations before a missing-evidence search', () => {
        const broken = receipt([check]);
        const data = broken.response.data as {
            artifacts: { requirements: { claimIndexes: number[] }[] }[];
            claims: unknown[];
        };
        data.artifacts[0]!.requirements[0]!.claimIndexes = [0];
        data.claims = [
            { kind: 'inference', citations: [{ pageId: 'missing', quote: 'invented' }] },
        ];
        expect(gapActions(candidate, [requirement], [broken])[0]!.action).toBe('repair');
    });
    it('repairs absent or malformed diagnoses before searching and accepts only explicit receipt-local targets', () => {
        for (const checks of [
            [],
            [check, check],
            [{ ...check, requirementId: 'foreign' }],
            [{ ...check, query: '' }],
            [{ ...check, extra: true }],
            [{ ...check, status: 'supported' }],
        ]) {
            expect(fieldChecks([receipt(checks)], [requirement]).size).toBe(0);
            expect(gapActions(candidate, [requirement], [receipt(checks)])[0]!.action).toBe(
                'repair',
            );
        }
        expect(fieldChecks([receipt([check], ['foreign'])], [requirement]).size).toBe(0);
    });
    it('selects search, rebind and conflict actions by the latest valid per-field diagnosis', () => {
        const missing = receipt([check]);
        expect(gapActions(candidate, [requirement], [missing])[0]).toMatchObject({
            action: 'search',
            query: check.query,
        });
        for (const status of ['supported', 'binding_missing', 'conflict']) {
            const later = receipt([{ ...check, status, query: '' }]);
            expect(gapActions(candidate, [requirement], [missing, later])[0]!.action).toBe(
                status === 'conflict' ? 'conflict' : 'rebind',
            );
        }
    });
    it.each(['current', 'exact', 'source_required', undefined] as const)(
        'closes model fallback for %s',
        (verification) => {
            expect(allowsKnowledge({ ...requirement, verification }, [])).toBe(false);
        },
    );
    it.each(['最新价格', '具体日期', '精确数值', '指定文献', 'exact sample size', 'verbatim DOI'])(
        'preserves explicit verification obligations: %s',
        (text) => {
            expect(allowsKnowledge(requirement, [{ id: 'q0', text }])).toBe(false);
        },
    );
    it('allows stable explanation without treating another question as its obligation', () => {
        expect(
            allowsKnowledge(requirement, [
                { id: 'q0', text: '一般机制' },
                { id: 'q1', text: '最新价格' },
            ]),
        ).toBe(true);
        expect(allowsKnowledge(undefined, [])).toBe(false);
    });
});
