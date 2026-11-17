import { eq, runs as dbRuns } from '@scova/db';
import { expect, it } from 'vite-plus/test';
import { candidateFromCheckpoint, type ComparisonExtraction } from '@scova/agent-core';
import { createAgentRepository } from '../../src/repo/agent.ts';
import { createDefaultServices } from '../../../server/src/app/services.ts';
import { createReportService } from '../../../server/src/service/reports.ts';
import { liveResearch } from './live-research.ts';
import { fixture, saver, delivery, assertEmpty } from './fixture.ts';

export function registerReceiptAuthentication() {
    it.each([false, true])(
        'authenticates conflict review receipts while preserving unresolved evidence (tampered=%s)',
        async (tampered) => {
            const seed = await liveResearch({ claimKind: 'conflict' });
            const run = (await fixture.db.query.runs.findFirst({
                where: eq(dbRuns.id, seed.run.id),
            }))!;
            const ref = run.checkpointRef as {
                threadId: string;
                checkpointId: string;
                namespace: '';
                leaseEpoch: number;
            };
            const config = {
                configurable: {
                    thread_id: ref.threadId,
                    checkpoint_ns: '',
                    checkpoint_id: ref.checkpointId,
                },
            };
            const tuple = (await saver.getTuple(config))!;
            const checkpoint = structuredClone(tuple.checkpoint);
            const state = checkpoint.channel_values.research as {
                conflictReviewPolicy?: number;
                synthesisExtractions: ComparisonExtraction[];
            };
            expect(state.conflictReviewPolicy).toBe(1);
            const reviews = state.synthesisExtractions.filter((r) =>
                r.operationKey.startsWith('conflict-review'),
            );
            expect(reviews.length).toBeGreaterThan(0);
            expect(seed.candidate.claims.some((c) => c.kind === 'conflict')).toBe(true);
            expect(seed.candidate.coverage.metrics!.unresolvedQuestionIds.length).toBeGreaterThan(
                0,
            );
            if (!tampered) {
                await delivery.deliver(seed.claimed.token, seed.candidate);
                return;
            }
            const data = reviews[0]!.response.data as { conflictReview: { reason: string } };
            data.conflictReview.reason = '篡改复核理由';
            checkpoint.id = crypto.randomUUID();
            checkpoint.channel_versions.research = saver.getNextVersion(
                Number(checkpoint.channel_versions.research),
            );
            const saved = await saver.put(
                config,
                checkpoint,
                tuple.metadata!,
                checkpoint.channel_versions,
            );
            expect((await saver.getTuple(saved))!.checkpoint.channel_values.research).toEqual(
                state,
            );
            await createAgentRepository(fixture.db, seed.claimed.token).promoteCheckpoint({
                ...ref,
                checkpointId: saved.configurable!.checkpoint_id as string,
            });
            await expect(
                delivery.deliver(seed.claimed.token, seed.candidate),
            ).rejects.toMatchObject({ code: 'INVALID_DELIVERY_EVIDENCE' });
            await assertEmpty(seed.run.id);
        },
    );

    it.each([
        false,
        true,
        'diagnosis',
        'strip_loop',
        'strip_completion',
        'strip_gap',
        'strip_knowledge',
        'strip_gap_loop',
    ])(
        'authenticates cross-question passage links and gap policy against immutable model receipts (tampered=%s)',
        async (tampered) => {
            const seed = await liveResearch({ evidenceLinks: true });
            expect(seed.candidate.pages[0]!.questionIds).toEqual(['q0']);
            const run = (await fixture.db.query.runs.findFirst({
                where: eq(dbRuns.id, seed.run.id),
            }))!;
            const ref = run.checkpointRef as {
                threadId: string;
                checkpointId: string;
                namespace: '';
                leaseEpoch: number;
            };
            const config = {
                configurable: {
                    thread_id: ref.threadId,
                    checkpoint_ns: '',
                    checkpoint_id: ref.checkpointId,
                },
            };
            const tuple = (await saver.getTuple(config))!;
            const checkpoint = structuredClone(tuple.checkpoint);
            const state = checkpoint.channel_values.research as {
                evidencePolicy?: number;
                researchLoopPolicy?: number;
                conflictReviewPolicy?: number;
                answerCompletionPolicy?: number;
                gapKindPolicy?: number;
                knowledgeFirstPolicy?: number;
                gapLoopPolicy?: number;
                planningExtraction: {
                    response: {
                        researchPolicy?: {
                            answerCompletionPolicy?: number;
                            gapKindPolicy?: number;
                            knowledgeFirstPolicy?: number;
                            gapLoopPolicy?: number;
                        };
                    };
                };
                synthesisExtractions: {
                    response: {
                        data: {
                            evidenceLinks: { reason: string }[];
                            fieldChecks: { reason: string }[];
                        };
                    };
                }[];
            };
            const repository = createAgentRepository(fixture.db, seed.claimed.token);
            const restoredContext = {
                ...seed.context,
                ...(await repository.comparison()),
                usage: await repository.usage(),
            };
            expect(state.evidencePolicy).toBe(1);
            expect(state.researchLoopPolicy).toBe(1);
            expect(
                seed.candidate.claims.some(
                    (claim) => claim.questionIds.includes('q1') && claim.kind === 'fact',
                ),
                JSON.stringify(seed.candidate.coverage),
            ).toBe(true);
            expect(candidateFromCheckpoint(restoredContext, state)).toEqual(seed.candidate);
            if (!tampered) {
                for (const attack of ['metrics', 'passage'] as const) {
                    const forged = structuredClone(seed.candidate);
                    if (attack === 'metrics') forged.coverage.metrics!.answeredQuestions++;
                    else forged.coverage.propositions![0]!.passages[0]!.start++;
                    await expect(
                        delivery.deliver(seed.claimed.token, forged),
                    ).rejects.toMatchObject({ code: 'INVALID_DELIVERY_EVIDENCE' });
                }
                const published = await delivery.deliver(seed.claimed.token, seed.candidate);
                const dto = await createReportService(
                    createDefaultServices({ db: () => fixture.db }),
                ).get(seed.user.id, published.reportId);
                expect(dto.coverage.metrics).toEqual(seed.candidate.coverage.metrics);
                expect(dto.coverage.propositions).toEqual(seed.candidate.coverage.propositions);
                return;
            }
            // Same span and projected answer: only immutable receipt authentication catches this.
            let changed = 0;
            if (
                [
                    'strip_loop',
                    'strip_completion',
                    'strip_gap',
                    'strip_knowledge',
                    'strip_gap_loop',
                ].includes(String(tampered))
            ) {
                if (tampered === 'strip_loop' || tampered === 'strip_completion') {
                    delete state.answerCompletionPolicy;
                    delete state.planningExtraction.response.researchPolicy?.answerCompletionPolicy;
                }
                if (tampered === 'strip_loop' || tampered === 'strip_gap') {
                    delete state.gapKindPolicy;
                    delete state.planningExtraction.response.researchPolicy?.gapKindPolicy;
                }
                if (tampered === 'strip_loop' || tampered === 'strip_knowledge') {
                    delete state.knowledgeFirstPolicy;
                    delete state.planningExtraction.response.researchPolicy?.knowledgeFirstPolicy;
                    expect(() => candidateFromCheckpoint(restoredContext, state)).toThrow();
                    // Also remove the draft cursor/receipts so the core state is coherent.
                    // Delivery must still reject it against the immutable planning receipt.
                    for (const key of [
                        'modelDraftDone',
                        'modelDraftTargets',
                        'modelDraftIndex',
                        'modelDraftAttempt',
                        'modelDraftExtractions',
                    ])
                        Reflect.deleteProperty(state, key);
                }
                if (tampered === 'strip_loop') {
                    delete state.researchLoopPolicy;
                    delete state.conflictReviewPolicy;
                }
                if (tampered === 'strip_loop' || tampered === 'strip_gap_loop') {
                    delete state.gapLoopPolicy;
                    delete state.planningExtraction.response.researchPolicy?.gapLoopPolicy;
                    Reflect.deleteProperty(state, 'gapLoop');
                }
                changed++;
            } else
                for (const receipt of state.synthesisExtractions)
                    for (const entry of tampered === 'diagnosis'
                        ? receipt.response.data.fieldChecks
                        : receipt.response.data.evidenceLinks) {
                        entry.reason = '篡改支持或缺口判断';
                        changed++;
                    }
            expect(changed).toBeGreaterThan(0);
            checkpoint.id = crypto.randomUUID();
            checkpoint.channel_versions.research = saver.getNextVersion(
                Number(checkpoint.channel_versions.research),
            );
            const saved = await saver.put(
                config,
                checkpoint,
                tuple.metadata!,
                checkpoint.channel_versions,
            );
            expect((await saver.getTuple(saved))!.checkpoint.channel_values.research).toEqual(
                state,
            );
            await repository.promoteCheckpoint({
                ...ref,
                checkpointId: saved.configurable!.checkpoint_id as string,
            });
            const forged = candidateFromCheckpoint(restoredContext, state);
            if (
                ![
                    'strip_loop',
                    'strip_completion',
                    'strip_gap',
                    'strip_knowledge',
                    'strip_gap_loop',
                ].includes(String(tampered))
            )
                expect(forged).toEqual(seed.candidate);
            await expect(delivery.deliver(seed.claimed.token, forged)).rejects.toMatchObject({
                code: 'INVALID_DELIVERY_EVIDENCE',
            });
            await assertEmpty(seed.run.id);
        },
    );
}
