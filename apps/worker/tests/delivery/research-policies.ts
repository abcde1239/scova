import { randomUUID } from 'node:crypto';
import { expect, it } from 'vite-plus/test';
import { eq, runs as dbRuns, baselines as dbBaselines, toolCalls as dbToolCalls } from '@scova/db';
import { candidateFromCheckpoint } from '@scova/agent-core';
import { createAgentRepository } from '../../../server/src/repo/execution/agent.ts';
import { createDefaultServices } from '../../../server/src/app/services.ts';
import { createReportService } from '../../../server/src/service/reports.ts';
import { liveResearch } from './live-research.ts';
import { fixture, delivery, saver, assertEmpty } from './fixture.ts';

export function registerResearchPolicies() {
    it('delivers a promoted model-only deadline report without inventing an evidence source or baseline', async () => {
        const seed = await liveResearch({
            modelAnswers: true,
            draftAnswers: true,
            failUrls: ['https://example.com/publication'],
            researchMode: 'analysis',
        });
        expect(seed.candidate.pages).toEqual([]);
        expect(seed.candidate.claims.some((c) => c.kind === 'model_answer')).toBe(true);
        await fixture.db
            .update(dbRuns)
            .set({ deadlineAt: new Date(Date.now() - 1) })
            .where(eq(dbRuns.id, seed.run.id));
        const partial = (await seed.session.partial())!;
        expect(partial.claims).toEqual(seed.candidate.claims);
        const { reportId } = await delivery.deliver(seed.claimed.token, partial, true);
        const dto = await createReportService(createDefaultServices({ db: () => fixture.db })).get(
            seed.user.id,
            reportId,
        );
        expect(dto.coverage.completeness).toBe('partial');
        expect(dto.claims.some((c) => c.kind === 'model_answer')).toBe(true);
        expect(dto.evidence).toEqual([]);
        expect(
            await fixture.db.query.baselines.findFirst({
                where: eq(dbBaselines.taskId, seed.task.id),
            }),
        ).toBeUndefined();
    });

    it('keeps unknown-date collection metadata in the API while delivering no collected values or baseline', async () => {
        const seed = await liveResearch({ researchMode: 'collection', publication: null });
        expect(seed.candidate.pages).toEqual([]);
        expect(seed.candidate.coverage.dateScreening).toMatchObject({
            accepted: 0,
            unconfirmed: 1,
            outside: 0,
        });
        const { reportId } = await delivery.deliver(seed.claimed.token, seed.candidate);
        const dto = await createReportService(createDefaultServices({ db: () => fixture.db })).get(
            seed.user.id,
            reportId,
        );
        expect(dto.coverage.dateScreening).toMatchObject({ accepted: 0, unconfirmed: 1 });
        expect(dto.evidence).toEqual([]);
        expect(
            await fixture.db.query.baselines.findFirst({
                where: eq(dbBaselines.taskId, seed.task.id),
            }),
        ).toBeUndefined();
    });

    it('rejects deletion of a promoted unknown-date screening entry even when the caller rebuilds its candidate', async () => {
        const seed = await liveResearch({ researchMode: 'collection', publication: null });
        const repository = createAgentRepository(fixture.db, seed.claimed.token);
        const ref = await repository.readAuthorizedCheckpoint();
        const context = {
            ...seed.context,
            ...(await repository.comparison()),
            usage: await repository.usage(),
        };
        const config = {
            configurable: {
                thread_id: ref!.threadId,
                checkpoint_ns: '',
                checkpoint_id: ref!.checkpointId,
            },
        };
        const tuple = (await saver.getTuple(config))!;
        const checkpoint = structuredClone(tuple.checkpoint);
        const state = checkpoint.channel_values.research as { dateScreening: unknown[] };
        state.dateScreening = [];
        checkpoint.id = randomUUID();
        checkpoint.channel_versions.research = saver.getNextVersion(
            Number(checkpoint.channel_versions.research),
        );
        const saved = await saver.put(
            config,
            checkpoint,
            tuple.metadata!,
            checkpoint.channel_versions,
        );
        await repository.promoteCheckpoint({
            ...ref!,
            checkpointId: saved.configurable!.checkpoint_id as string,
        });
        const forged = candidateFromCheckpoint(context, state);
        const calls = await fixture.db.query.toolCalls.findMany({
            where: eq(dbToolCalls.runId, seed.run.id),
        });
        expect(calls.some((c) => c.tool === 'read' && c.status === 'succeeded')).toBe(true);
        await expect(delivery.deliver(seed.claimed.token, forged)).rejects.toMatchObject({
            code: 'INVALID_DELIVERY_EVIDENCE',
        });
        await assertEmpty(seed.run.id);
    });
}
