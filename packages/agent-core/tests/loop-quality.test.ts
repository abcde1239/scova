import { describe, expect, it } from 'vite-plus/test';
import { researchCompletion } from '../src/research/completion.ts';
import { gained, validGapLoop, gapProgress } from '../src/research/gap-loop.ts';
import { observedReadTarget } from '../src/search/navigation.ts';
import type { AgentCandidate, AgentContext } from '../src/types.ts';
import type { ResearchState } from '../src/research/state.ts';

describe('loop quality boundaries', () => {
    it('separates deliverable knowledge, exhausted verification and complete external support', () => {
        const coverage = {
            delivery: { questionCount: 1, answeredQuestions: 1 },
            artifacts: [
                { coverage: { requirements: [{ required: true, status: 'model_answered' }] } },
            ],
        } as Parameters<typeof researchCompletion>[0];
        expect(researchCompletion(coverage)).toMatchObject({
            answerReady: true,
            verificationDone: false,
            externalEvidenceComplete: false,
        });
        expect(researchCompletion(coverage, 'verified').verificationDone).toBe(false);
        expect(researchCompletion(coverage, 'budget')).toMatchObject({
            verificationDone: true,
            externalEvidenceComplete: false,
            stopReason: 'budget',
        });
        coverage.artifacts![0]!.coverage!.requirements[0]!.status = 'supported';
        expect(researchCompletion(coverage)).toMatchObject({
            verificationDone: true,
            externalEvidenceComplete: true,
            stopReason: 'verified',
        });
    });
    it('does not count unrelated new bodies, associations or fields as progress for the target', () => {
        const before = { supported: [], bodies: [], linkCount: 0, targetLinks: [] };
        const after = { supported: ['other'], bodies: ['new'], linkCount: 1, targetLinks: [] };
        expect(gained(before, after)).toBe(true); // Historical checkpoints retain their rule.
        expect(gained(before, after, 'target')).toBe(false);
        expect(gained(before, { ...after, supported: ['target'] }, 'target')).toBe(true);
        expect(gained(before, { ...after, targetLinks: ['legal-target-span'] }, 'target')).toBe(
            true,
        );
        const candidate = {
            pages: [],
            coverage: {
                propositions: [
                    {
                        requirementIds: ['other'],
                        support: 'direct',
                        passages: [{ pageId: 'p0', contentHash: 'hash', start: 0, end: 10 }],
                    },
                ],
            },
        } as unknown as AgentCandidate;
        expect(gapProgress(candidate, [], 'target').targetLinks).toEqual([]);
        expect(gapProgress(candidate, [], 'other').targetLinks).toHaveLength(1);
    });
    it('requires a frozen new policy for direct reads and bounds persisted target associations', () => {
        const requirement = {
            id: 'r0',
            format: 'brief',
            questionIds: ['q0'],
            object: 'Node',
            field: '版本',
            required: true,
        } as const;
        const loop = {
            history: [
                {
                    fingerprint: 'a'.repeat(64),
                    requirementId: 'r0',
                    action: 'read',
                    before: { supported: [], bodies: [], linkCount: 0, targetLinks: [] },
                },
            ],
            cursor: 0,
            pending: 0,
            target: {
                requirementId: 'r0',
                questionIds: ['q0'],
                action: 'read',
                query: 'Node version',
                url: 'https://nodejs.org/blog/release/v24.22.3',
            },
        };
        const requirements = [{ ...requirement, questionIds: [...requirement.questionIds] }];
        expect(validGapLoop(loop, requirements, 1)).toBe(false);
        expect(validGapLoop(loop, requirements, 1, true)).toBe(true);
        loop.history[0]!.before.targetLinks = ['a'.repeat(81)] as never[];
        expect(validGapLoop(loop, requirements, 1, true)).toBe(false);
    });
    it('prioritizes the latest observed release while respecting source restrictions and discovery scope', () => {
        const context = {
            config: {
                topic: 'Node.js',
                goal: '最新版本与发布日期',
                sourcePreferences: {
                    officialOnly: true,
                    preferredUrls: ['https://nodejs.org/'],
                    excludedUrls: [],
                },
            },
        } as unknown as AgentContext;
        const state = {
            selections: [],
            readIndex: 0,
            pages: [
                {
                    questionIds: ['q0'],
                    links: [
                        {
                            url: 'https://github.com/nodejs/release',
                            text: 'Node.js release schedule',
                        },
                    ],
                },
            ],
            searches: [
                {
                    query: { questionIds: ['q0'] },
                    response: {
                        results: ['22.0.0', '24.22.3'].map((v) => ({
                            originalUrl: `https://nodejs.org/blog/release/v${v}`,
                            url: `https://nodejs.org/blog/release/v${v}`,
                            title: `Node.js v${v}`,
                            snippet: 'Node.js release date',
                        })),
                    },
                },
            ],
        } as unknown as ResearchState;
        const target = {
            requirementId: 'r0',
            questionIds: ['q0', 'q1'],
            action: 'search' as const,
            query: 'Node.js release date',
        };
        expect(observedReadTarget(context, state, target)).toEqual({
            url: 'https://nodejs.org/blog/release/v24.22.3',
            questionIds: ['q0'],
        });
        state.selections = [
            { url: 'https://nodejs.org/blog/release/v24.22.3', questionIds: ['q0'] },
            { url: 'https://nodejs.org/blog/release/v22.0.0', questionIds: ['q0'] },
        ];
        state.readIndex = 2;
        expect(observedReadTarget(context, state, target)).toBeUndefined();
    });
});
