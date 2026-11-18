import { expect, it, vi } from 'vite-plus/test';
import { gapLoopNode } from '../src/research/nodes/gap-loop.ts';
import type { AgentRuntime } from '../src/research/runtime.ts';
import type { ResearchState } from '../src/research/state.ts';

vi.mock('../src/research/candidate.ts', () => ({ candidate: () => ({ coverage: {}, pages: [] }) }));
vi.mock('../src/research/claims.ts', () => ({
    frozenRequirements: () => [],
    needsConflictReview: () => false,
}));
vi.mock('../src/research/loop.ts', () => ({
    gapActions: () => [
        { requirementId: 'missing', questionIds: ['q0'], action: 'rebind', query: '' },
    ],
}));
vi.mock('../src/research/gap-loop.ts', () => ({
    gapProgress: () => ({ supported: [], bodies: [], linkCount: 0 }),
    chooseGap: (actions: unknown[]) => ({ action: actions[0], fingerprint: 'a'.repeat(64) }),
    gained: () => false,
    MAX_GAP_ACTIONS: 20,
    GAP_LOOP_PASSES: 64,
}));

it('stops a missing frozen synthesis target without persisting a negative batch cursor', async () => {
    const state = {
        questions: [{ id: 'q0', text: 'question' }],
        notes: [],
        queries: [],
        synthesisAttempts: 2,
        claims: [],
        selections: [],
        pages: [],
    } as unknown as ResearchState;
    const rt = {
        formats: ['brief'],
        now: () => 0,
        deps: { tools: {} },
        context: {
            deadlineAt: new Date(100_000),
            config: {
                topic: 'Node',
                goal: 'version',
                focusPoints: [],
                timeRange: { kind: 'unbounded' },
            },
            budget: { maxInputTokens: 20_000, maxOutputTokens: 4000 },
            usage: { inputTokens: 0, outputTokens: 0 },
        },
    } as unknown as AgentRuntime;
    const result = await gapLoopNode(rt)(state);
    expect(result.ready).toBe(true);
    expect(result.synthesisBatchIndex).toBeUndefined();
    expect(result.gapLoop).toMatchObject({ stopped: true, history: [] });
    expect(result.gapLoop?.target).toBeUndefined();
    expect(result.notes?.join(' ')).toContain('目标字段不在冻结综合批次中');
});
