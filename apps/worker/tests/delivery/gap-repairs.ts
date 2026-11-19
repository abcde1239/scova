import {
    reports as dbReports,
    eq,
    evidence as dbEvidence,
    runs as dbRuns,
    sql,
    baselines as dbBaselines,
    toolCalls as dbToolCalls,
    claims as dbClaims,
    and,
    runEvents as dbRunEvents,
} from '@scova/db';
import { expect, it } from 'vite-plus/test';
import { candidateFromCheckpoint } from '@scova/agent-core';
import { type SearchResponse } from '@scova/connectors';
import { createAgentRepository } from '../../src/repo/agent.ts';
import { seedRun } from '../support/run-database.ts';
import { createDefaultServices } from '../../../server/src/app/services.ts';
import { createReportService } from '../../../server/src/service/reports.ts';
import { liveResearch } from './live-research.ts';
import { fixture, delivery, assertEmpty, saver, runs } from './fixture.ts';
import { checkpointWithBodies } from './checkpoint.ts';

export function registerGapRepairs() {
    it('authenticates extended local synthesis receipts and persists completed gap repairs', async () => {
        const seed = await liveResearch({ delayedBindings: true });
        const calls = await fixture.db.query.toolCalls.findMany({
            where: eq(dbToolCalls.runId, seed.run.id),
        });
        expect(
            calls.some(
                (c) =>
                    c.status === 'succeeded' &&
                    /^synthesize-(?:4|batch-\d+-4):/.test(c.operationKey),
            ),
        ).toBe(true);
        const { reportId } = await delivery.deliver(seed.claimed.token, seed.candidate);
        const dto = await createReportService(createDefaultServices({ db: () => fixture.db })).get(
            seed.user.id,
            reportId,
        );
        expect(dto.coverage.metrics?.unresolvedQuestionIds).toEqual([]);
    });

    it.each([false, true, 'draft'])(
        'authenticates and persists model knowledge answers without external citations (tampered=%s)',
        async (tampered) => {
            const seed = await liveResearch({
                claimKind: 'insufficient',
                modelAnswers: true,
                draftAnswers: tampered === 'draft' || tampered === false,
                outputFormats: ['research_report', 'comparison'],
            });
            expect(seed.candidate.claims.some((c) => c.kind === 'model_answer')).toBe(true);
            expect(seed.candidate.coverage.delivery?.answeredQuestions).toBe(2);
            if (tampered) {
                const invalidated = await fixture.db
                    .update(dbToolCalls)
                    .set({ status: 'unknown' })
                    .where(
                        and(
                            eq(dbToolCalls.runId, seed.run.id),
                            tampered === 'draft'
                                ? sql`${dbToolCalls.operationKey} LIKE 'model-draft-%'`
                                : sql`${dbToolCalls.operationKey} LIKE 'model-answer-%'`,
                        ),
                    )
                    .returning({ id: dbToolCalls.id });
                expect(invalidated.length).toBeGreaterThan(0);
                await expect(
                    delivery.deliver(seed.claimed.token, seed.candidate),
                ).rejects.toMatchObject({ code: 'INVALID_DELIVERY_EVIDENCE' });
                await assertEmpty(seed.run.id);
                return;
            }
            const { reportId } = await delivery.deliver(seed.claimed.token, seed.candidate);
            const dto = await createReportService(
                createDefaultServices({ db: () => fixture.db }),
            ).get(seed.user.id, reportId);
            expect(dto.coverage.metrics).toMatchObject({
                answeredQuestions: 2,
                externallySupportedQuestions: 0,
                unresolvedQuestionIds: [],
            });
            const stored = await fixture.db.query.claims.findMany({
                where: eq(dbClaims.reportId, reportId),
                with: { citations: true },
            });
            const model = stored.filter((c) => c.kind === 'model_answer');
            expect(model.length).toBeGreaterThan(0);
            expect(
                model.every((c) => c.confidenceLabel === '模型自回答' && c.citations.length === 0),
            ).toBe(true);
            const report = await fixture.db.query.reports.findFirst({
                where: eq(dbReports.id, reportId),
            });
            expect(report?.completeness).toBe('complete');
            expect(
                await fixture.db.query.runs.findFirst({ where: eq(dbRuns.id, seed.run.id) }),
            ).toMatchObject({ status: 'succeeded' });
            expect(
                await fixture.db.query.baselines.findFirst({
                    where: eq(dbBaselines.taskId, seed.task.id),
                }),
            ).toBeUndefined();
            expect(dto.coverage.baseline).toMatchObject({
                eligible: false,
                reason: 'external_incomplete',
                modelOnlyFields: 4,
            });
        },
    );

    it('delivers source-only evidence for all selected formats when both model generations fail', async () => {
        const seed = await liveResearch({
            outputFormats: ['research_report', 'comparison', 'list', 'brief'],
            failSynthesis: true,
        });
        expect(seed.claimed.budget).toMatchObject({
            maxInputTokens: 40_000,
            maxOutputTokens: 8_000,
        });
        expect(seed.candidate.coverage).toMatchObject({
            completeness: 'partial',
            delivery: { status: 'sources_only' },
        });
        expect(seed.candidate.claims.every((claim) => claim.kind === 'insufficient')).toBe(true);
        const usage = await createAgentRepository(fixture.db, seed.claimed.token).usage();
        expect(usage.inputTokens).toBeLessThanOrEqual(seed.claimed.budget.maxInputTokens);
        expect(usage.outputTokens).toBeLessThanOrEqual(seed.claimed.budget.maxOutputTokens);
        const { reportId } = await delivery.deliver(seed.claimed.token, seed.candidate);
        expect(
            await fixture.db.query.reports.findFirst({ where: eq(dbReports.id, reportId) }),
        ).toBeDefined();
        expect(
            await fixture.db.query.runs.findFirst({ where: eq(dbRuns.id, seed.run.id) }),
        ).toMatchObject({
            status: 'partial',
            coverageJson: { delivery: { status: 'sources_only' } },
        });
        expect(
            await fixture.db.query.baselines.findFirst({
                where: eq(dbBaselines.taskId, seed.task.id),
            }),
        ).toBeUndefined();
        const evidence = await fixture.db.query.evidence.findMany({
            where: eq(dbEvidence.runId, seed.run.id),
        });
        expect(evidence.length).toBeGreaterThan(0);
    });

    it.each(['valid', 'query', 'url', 'snippet', 'coverage', 'page'] as const)(
        'authenticates page-backed search receipts after checkpoint projection (%s)',
        async (attack) => {
            const seed = await liveResearch({ providerPage: true });
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
                searches: { query: { query: string }; response: SearchResponse }[];
            };
            const repository = createAgentRepository(fixture.db, seed.claimed.token);
            const restoredContext = {
                ...seed.context,
                ...(await repository.comparison()),
                usage: await repository.usage(),
            };
            expect(
                candidateFromCheckpoint(
                    restoredContext,
                    checkpointWithBodies(state, seed.candidate.pages),
                ),
            ).toEqual(seed.candidate);
            const search = state.searches[0]!;
            expect(search.response.results[0]).not.toHaveProperty('page');
            const calls = await fixture.db.query.toolCalls.findMany({
                where: and(eq(dbToolCalls.runId, seed.run.id), eq(dbToolCalls.tool, 'search')),
            });
            const full = (calls[0]!.outputRef as unknown as { result: SearchResponse }).result;
            expect(full.results[0]!.page?.text).toBeTruthy();
            if (attack === 'valid') {
                const result = await delivery.deliver(seed.claimed.token, seed.candidate);
                expect(result.reportId).toBeTruthy();
                expect(
                    await fixture.db.query.evidence.findFirst({
                        where: eq(dbEvidence.runId, seed.run.id),
                    }),
                ).toBeDefined();
                return;
            }
            if (attack === 'query') {
                search.response.query = '伪造查询';
                search.query.query = search.response.query;
            }
            if (attack === 'url') search.response.results[0]!.url = 'https://evil.example/notice';
            if (attack === 'snippet') search.response.results[0]!.snippet = '伪造摘要';
            if (attack === 'coverage')
                search.response.coverage.complete = !search.response.coverage.complete;
            if (attack === 'page')
                search.response.results[0]!.page = { ...full.results[0]!.page!, text: '伪造正文' };
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
            const persisted = (await saver.getTuple(saved))!;
            expect(persisted.checkpoint.channel_values.research).toEqual(state);
            await createAgentRepository(fixture.db, seed.claimed.token).promoteCheckpoint({
                ...ref,
                checkpointId: saved.configurable!.checkpoint_id as string,
            });
            const forged = candidateFromCheckpoint(
                restoredContext,
                checkpointWithBodies(state, seed.candidate.pages),
            );
            await expect(delivery.deliver(seed.claimed.token, forged)).rejects.toMatchObject({
                code: 'INVALID_DELIVERY_EVIDENCE',
            });
            await assertEmpty(seed.run.id);
        },
    );

    it('搜索事件保存实际服务类型，模型事件不附搜索标签', async () => {
        const seed = await seedRun(fixture.db);
        const claimed = await runs.claim(seed.run.id, 'search-provider-event');
        if (claimed.kind !== 'claimed') throw new Error('run was not claimed');
        const repo = createAgentRepository(fixture.db, claimed.token);
        await repo.reserve({
            operationKey: 'search-provider',
            tool: 'search',
            searchProvider: 'searxng',
            reserved: { searches: 1, pages: 0, inputTokens: 0, outputTokens: 0, estimated: false },
        });
        await repo.reserve({
            operationKey: 'model-event',
            tool: 'model',
            searchProvider: 'searxng',
            reserved: { searches: 0, pages: 0, inputTokens: 1, outputTokens: 1, estimated: false },
        });
        const events = await fixture.db
            .select()
            .from(dbRunEvents)
            .where(eq(dbRunEvents.runId, seed.run.id));
        expect(events.find((event) => event.type === 'tool.started')?.payload).toMatchObject({
            searchProvider: 'searxng',
            tool: 'search',
        });
        expect(
            events.filter((event) => event.type === 'tool.started')[1]?.payload,
        ).not.toHaveProperty('searchProvider');
    });
}
