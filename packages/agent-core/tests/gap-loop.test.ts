import { describe, expect, it } from 'vite-plus/test';
import {
    chooseGap,
    gapFingerprint,
    gained,
    initialReadLimit,
    initialSearchLimit,
    type GapLoop,
    type GapTarget,
} from '../src/research/gap-loop.ts';
import { isSynthesisOperation } from '../src/research/synthesis-batches.ts';
import { needsConflictReview } from '../src/research/claims.ts';
import {
    isConflictReviewOperation,
    conflictReviewOperation,
} from '../src/research/conflict-review.ts';
import type { ResearchState } from '../src/research/state.ts';
import type { AgentCandidate } from '../src/types.ts';

const candidate = {
    pages: [{ url: 'https://example.com/a', contentHash: 'hash' }],
    coverage: {
        reportValue: {
            questions: [
                { id: 'q0', priority: 'core' },
                { id: 'q1', priority: 'core' },
                { id: 'q2', priority: 'secondary' },
            ],
        },
    },
} as unknown as AgentCandidate;
const target = (id: string, question: string): GapTarget => ({
    requirementId: id,
    questionIds: [question],
    action: 'repair',
    query: '',
});
const empty = { supported: [], bodies: [], linkCount: 0 };

describe('gap loop scheduling and termination', () => {
    it('reviews a scheduled conflict at an extended pass while legacy checkpoints keep their original turns', () => {
        const state = {
            conflictReviewPolicy: 1,
            gapLoopPolicy: 1,
            synthesisAttempts: 5,
            conflictReviewPass: 5,
            conflictReviewIndex: 0,
            conflictReviewTargets: ['r'],
            gapLoop: {
                history: [],
                cursor: 0,
                target: { ...target('r', 'q0'), action: 'conflict' },
            },
        } as unknown as ResearchState;
        expect(needsConflictReview(state)).toBe(true);
        expect(isConflictReviewOperation(conflictReviewOperation(5, 'r', 0))).toBe(true);
        expect(
            needsConflictReview({ ...state, gapLoopPolicy: undefined, gapLoop: undefined }),
        ).toBe(false);
        expect(needsConflictReview({ ...state, conflictReviewIndex: 1 })).toBe(false);
    });
    it('reserves discovery capacity without starving a single-call budget', () => {
        expect(initialReadLimit(20)).toBe(12);
        expect(initialReadLimit(10)).toBe(6);
        expect(initialReadLimit(1)).toBe(1);
        expect(initialReadLimit(0)).toBe(0);
        expect(initialReadLimit(100)).toBe(12);
        expect(initialSearchLimit(10)).toBe(8);
        expect(initialSearchLimit(3)).toBe(1);
        expect(initialSearchLimit(2)).toBe(1);
        expect(initialSearchLimit(1)).toBe(1);
        expect(initialSearchLimit(0)).toBe(0);
    });
    it('rotates among core questions and prioritizes them over supplementary questions', () => {
        const memory: GapLoop = { history: [], cursor: 1 };
        expect(
            chooseGap(
                [target('a', 'q0'), target('b', 'q1'), target('c', 'q2')],
                memory,
                candidate,
                [],
            )?.action.requirementId,
        ).toBe('b');
        expect(
            chooseGap(
                [target('a', 'q0'), target('c', 'q2')],
                { ...memory, cursor: 2 },
                candidate,
                [],
            )?.action.requirementId,
        ).toBe('a');
    });
    it('never repeats an identical action and stops a field after two no-gain attempts', () => {
        const action = target('a', 'q0');
        const fingerprint = gapFingerprint(action, candidate, []);
        const memory: GapLoop = {
            history: [
                { fingerprint, requirementId: 'a', action: 'repair', before: empty, gain: false },
            ],
            cursor: 0,
        };
        expect(chooseGap([action], memory, candidate, [])).toBeUndefined();
        expect(chooseGap([action], memory, candidate, ['new_error'])).toBeDefined();
        memory.history.push({ ...memory.history[0]!, fingerprint: 'different' });
        expect(
            chooseGap([action, target('b', 'q1')], memory, candidate, ['another_error'])?.action
                .requirementId,
        ).toBe('b');
    });
    it('counts only new body hashes, valid associations or newly supported fields as gain', () => {
        expect(gained(empty, empty)).toBe(false);
        for (const key of ['supported', 'bodies'] as const)
            expect(gained(empty, { ...empty, [key]: ['new'] })).toBe(true);
        expect(gained(empty, { ...empty, linkCount: 1 })).toBe(true);
        expect(
            gained(
                { supported: ['r'], bodies: ['h'], linkCount: 1 },
                { supported: [], bodies: ['h'], linkCount: 1 },
            ),
        ).toBe(false);
    });
    it('accepts extended operation identities only when the frozen policy supplies its larger bounds', () => {
        expect(isSynthesisOperation('synthesize-batch-2-12', 64, 60)).toBe(true);
        expect(isSynthesisOperation('synthesize-batch-2-12', 4, 60)).toBe(false);
        expect(isSynthesisOperation('synthesize-64', 64, 60)).toBe(false);
        expect(isSynthesisOperation('synthesize-01', 64, 60)).toBe(false);
    });
});
