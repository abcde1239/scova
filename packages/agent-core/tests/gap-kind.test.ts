import { describe, expect, it } from 'vite-plus/test';
import { structuredSupport } from '../src/gap-kind.ts';
import { buildReportValue } from '../src/report-value.ts';
import type { AgentClaim, AgentContext, AgentPage } from '../src/types.ts';

const pages = [0, 1].map((i) => ({
    id: `p${i}`,
    url: `https://example.com/${i}`,
    contentHash: `${i}`,
    text: `原文${i}`,
})) as AgentPage[];
function entry(
    i: number,
    support: 'direct' | 'partial' = 'direct',
    gapKind: 'none' | 'missing_core' | 'missing_detail' | 'condition' = 'none',
) {
    const claim: AgentClaim = {
        kind: 'inference',
        text: `说明${i}`,
        questionIds: ['q0'],
        citations: [{ pageId: `p${i}`, quote: `原文${i}` }],
        assessment: {
            relevance: 'direct',
            support,
            role: 'answer',
            sourceRelation: 'original',
            reason: '原文支持',
            conditions: '在条件甲下',
            gap: gapKind === 'none' ? '' : '具体说明',
            gapKind,
        },
    };
    return { claim, assessment: claim.assessment };
}
const options = { gapKinds: true, pages };
describe('frozen structured gap support', () => {
    it('does not activate structured support for a legacy checkpoint carrying a gap kind', () => {
        expect(structuredSupport([entry(0)], ['q0'], {})).toBeUndefined();
        const context = {
            config: {
                topic: '稳定机制',
                goal: '解释机制',
                focusPoints: [],
                researchMode: 'collection',
                timeRange: { kind: 'rolling', days: 30 },
            },
        } as unknown as AgentContext;
        const claim = entry(0, 'direct', 'missing_detail').claim;
        expect(
            buildReportValue(context, [{ id: 'q0', text: '机制' }], [claim], pages).questions[0]!
                .status,
        ).toBe('provisional');
        expect(
            buildReportValue(
                context,
                [{ id: 'q0', text: '机制' }],
                [claim],
                pages,
                undefined,
                options,
            ).questions[0]!.status,
        ).toBe('supported');
    });
    it('allows detail and qualified conditions but keeps missing core and conflict unresolved', () => {
        expect(structuredSupport([entry(0, 'direct', 'missing_detail')], ['q0'], options)).toBe(
            true,
        );
        expect(structuredSupport([entry(0, 'direct', 'condition')], ['q0'], options)).toBe(true);
        expect(structuredSupport([entry(0, 'direct', 'missing_core')], ['q0'], options)).toBe(
            false,
        );
        const conflict = entry(0);
        conflict.claim.kind = 'conflict';
        expect(structuredSupport([conflict], ['q0'], options)).toBe(false);
        const unqualified = entry(0, 'direct', 'condition');
        unqualified.assessment!.conditions = '';
        expect(structuredSupport([unqualified], ['q0'], options)).toBe(false);
    });
    it('requires independent validated bodies and full question coverage for partial composition', () => {
        const entries = [entry(0, 'partial'), entry(1, 'partial')];
        expect(structuredSupport(entries, ['q0'], options)).toBe(true);
        expect(structuredSupport(entries.slice(0, 1), ['q0'], options)).toBe(false);
        expect(
            structuredSupport(entries, ['q0'], {
                ...options,
                pages: [pages[0]!, { ...pages[1]!, contentHash: pages[0]!.contentHash }],
            }),
        ).toBe(false);
        expect(
            structuredSupport(entries, ['q0'], {
                ...options,
                pages: [pages[0]!, { ...pages[1]!, url: pages[0]!.url }],
            }),
        ).toBe(false);
        entries[1]!.claim.questionIds = ['q1'];
        expect(structuredSupport(entries, ['q0', 'q1'], options)).toBe(false);
    });
});
