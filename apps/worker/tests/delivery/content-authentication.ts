import { requiredDatabaseValue } from '../../../server/src/utils/execution/database.ts';
import {
    reports as dbReports,
    eq,
    count as dbCount,
    evidence as dbEvidence,
    runs as dbRuns,
    notifications as dbNotifications,
    inboxItems as dbInboxItems,
    sql,
    baselines as dbBaselines,
    toolCalls as dbToolCalls,
    claims as dbClaims,
    and,
} from '@scova/db';
import type { Report } from '@scova/models';
import { expect, it } from 'vite-plus/test';
import { candidateFromCheckpoint } from '@scova/agent-core';
import { createAgentRepository } from '../../../server/src/repo/execution/agent.ts';
import { liveResearch } from './live-research.ts';
import { fixture, saver, delivery, assertEmpty } from './fixture.ts';
import { checkpointWithBodies } from './checkpoint.ts';

export function registerContentAuthentication() {
    it.each(['valid', 'candidate', 'receipt'] as const)(
        'authenticates and persists editorial document organization (%s)',
        async (attack) => {
            const seed = await liveResearch({
                outputFormats: ['research_report', 'brief'],
                editorialDocument: true,
            });
            expect(
                seed.candidate.coverage.artifacts?.map((artifact) => artifact.content?.document),
            ).toEqual(
                [0, 1].map((index) => ({
                    version: 1,
                    sections: [
                        {
                            id: 'findings',
                            title: '关键发现',
                            role: 'key_findings',
                            claimIndexes: [index],
                        },
                    ],
                })),
            );
            let candidate = structuredClone(seed.candidate);
            if (attack === 'candidate') {
                candidate.coverage.artifacts![0]!.content!.document!.sections[0]!.title =
                    '伪造标题';
            } else if (attack === 'receipt') {
                const run = (await fixture.db.query.runs.findFirst({
                    where: eq(dbRuns.id, seed.run.id),
                }))!;
                const ref = run.checkpointRef as {
                    threadId: string;
                    namespace: '';
                    checkpointId: string;
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
                    synthesisExtractions: {
                        response: {
                            data: { artifacts: { document: { sections: { title: string }[] } }[] };
                        };
                    }[];
                };
                const repository = createAgentRepository(fixture.db, seed.claimed.token);
                const context = {
                    ...seed.context,
                    ...(await repository.comparison()),
                    usage: await repository.usage(),
                };
                expect(
                    candidateFromCheckpoint(
                        context,
                        checkpointWithBodies(state, seed.candidate.pages),
                    ),
                ).toEqual(seed.candidate);
                state.synthesisExtractions[0]!.response.data.artifacts[0]!.document.sections[0]!.title =
                    '伪造标题';
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
                candidate = candidateFromCheckpoint(
                    context,
                    checkpointWithBodies(state, seed.candidate.pages),
                );
            }
            if (attack !== 'valid') {
                await expect(delivery.deliver(seed.claimed.token, candidate)).rejects.toMatchObject(
                    { code: 'INVALID_DELIVERY_EVIDENCE' },
                );
                await assertEmpty(seed.run.id);
                return;
            }
            await delivery.deliver(seed.claimed.token, candidate);
            const saved = (await fixture.db.query.runs.findFirst({
                where: eq(dbRuns.id, seed.run.id),
            }))!;
            expect((saved.coverageJson as Report['coverage']).artifacts).toEqual(
                candidate.coverage.artifacts,
            );
        },
    );

    it('delivers uncertain claims and comparison values without promoting fabricated quotes or baselines', async () => {
        const seed = await liveResearch({ badComparisonQuote: true, badClaimQuote: true });
        expect(seed.candidate.claims[0]).toMatchObject({
            kind: 'insufficient',
            citations: [],
            uncertainty: expect.arrayContaining(['quote_unmatched']),
        });
        expect(seed.candidate.changes).toContainEqual(
            expect.objectContaining({ kind: 'uncertain', newCitations: [], important: false }),
        );
        const result = await delivery.deliver(seed.claimed.token, seed.candidate);
        const report = await fixture.db.query.reports.findFirst({
            where: eq(dbReports.id, result.reportId),
        });
        const claims = await fixture.db.query.claims.findMany({
            where: eq(dbClaims.reportId, result.reportId),
        });
        const evidence = await fixture.db.query.evidence.findMany({
            where: eq(dbEvidence.runId, seed.run.id),
        });
        const baseline = await fixture.db.query.baselines.findFirst({
            where: eq(dbBaselines.taskId, seed.task.id),
        });
        expect(report?.completeness).toBe('partial');
        expect(report?.summary).toContain('暂无直接回答');
        expect(claims[0]?.confidenceLabel).toContain('引用未能定位');
        expect(evidence).toHaveLength(1);
        expect(evidence[0]!.quote).not.toContain('UNLOCATABLE');
        expect(baseline).toBeUndefined();
    });

    it.each([false, true])(
        'rebuilds every comparison batch from its successful ledger (tampered=%s)',
        async (tampered) => {
            const seed = await liveResearch({ pageCount: 4 });
            expect(seed.candidate.manifest!.pages).toHaveLength(4);
            const batch = await fixture.db.query.toolCalls.findFirst({
                where: and(
                    eq(dbToolCalls.runId, seed.run.id),
                    sql`${dbToolCalls.operationKey} LIKE 'compare-facts-batch-1-v2:%'`,
                ),
            });
            expect(batch?.status).toBe('succeeded');
            if (tampered) {
                await fixture.db
                    .update(dbToolCalls)
                    .set({ status: 'unknown' })
                    .where(eq(dbToolCalls.id, batch!.id));
                await expect(
                    delivery.deliver(seed.claimed.token, seed.candidate),
                ).rejects.toMatchObject({ code: 'INVALID_DELIVERY_EVIDENCE' });
                await assertEmpty(seed.run.id);
            } else {
                const result = await delivery.deliver(seed.claimed.token, seed.candidate);
                const report = await fixture.db.query.reports.findFirst({
                    where: eq(dbReports.id, result.reportId),
                });
                expect(report?.comparisonJson).toEqual(seed.candidate.manifest);
            }
        },
    );

    it.each([false, true])(
        'comparison repair delivery requires its own successful ledger (tampered=%s)',
        async (tampered) => {
            const seed = await liveResearch({ truncatedComparison: true });
            expect(seed.candidate.comparison).toBe('completed');
            const repair = await fixture.db.query.toolCalls.findFirst({
                where: and(
                    eq(dbToolCalls.runId, seed.run.id),
                    sql`${dbToolCalls.operationKey} LIKE 'compare-facts-repair-v1:%'`,
                ),
            });
            expect(repair?.status).toBe('succeeded');
            if (tampered) {
                await fixture.db
                    .update(dbToolCalls)
                    .set({ status: 'unknown' })
                    .where(eq(dbToolCalls.id, repair!.id));
                await expect(
                    delivery.deliver(seed.claimed.token, seed.candidate),
                ).rejects.toMatchObject({ code: 'INVALID_DELIVERY_EVIDENCE' });
                await assertEmpty(seed.run.id);
            } else {
                const result = await delivery.deliver(seed.claimed.token, seed.candidate);
                const report = await fixture.db.query.reports.findFirst({
                    where: eq(dbReports.id, result.reportId),
                });
                expect(report?.comparisonJson).toEqual(seed.candidate.manifest);
                expect(report?.completeness).toBe('partial');
                expect(await delivery.deliver(seed.claimed.token, seed.candidate)).toEqual({
                    reportId: result.reportId,
                    reused: true,
                });
            }
        },
    );

    for (const mode of ['summary', 'important_change', 'off'] as const)
        for (const runIssues of [true, false])
            it(`通知${mode}/${runIssues}经真实完整/重要变化/partial交付，重放保留已读`, async () => {
                const first = await liveResearch({
                    notificationPreference: { mode, runIssues },
                    body: '申请截止日期为十一月十五日。',
                });
                const firstDelivery = await delivery.deliver(first.claimed.token, first.candidate);
                const firstRows = await fixture.db.query.notifications.findMany({
                    where: eq(dbNotifications.runId, first.run.id),
                });
                expect(firstRows.map((row) => row.kind)).toEqual(
                    mode === 'summary' ? ['summary'] : [],
                );
                expect(
                    await fixture.db
                        .select({ count: dbCount() })
                        .from(dbInboxItems)
                        .where(eq(dbInboxItems.reportId, firstDelivery.reportId))
                        .then((rows) => rows[0]!.count),
                ).toBe(1);
                const second = await liveResearch({
                    previous: first,
                    body: '申请截止日期为十一月二十日。',
                });
                const delivered = await delivery.deliver(second.claimed.token, second.candidate);
                expect(
                    (
                        await fixture.db.query.runs
                            .findFirst({ where: eq(dbRuns.id, second.run.id) })
                            .then((row) => requiredDatabaseValue(row))
                    ).outcome,
                ).toBe('important_change');
                const rows = await fixture.db.query.notifications.findMany({
                    where: eq(dbNotifications.runId, second.run.id),
                });
                expect(rows.map((row) => row.kind)).toEqual(mode === 'off' ? [] : [mode]);
                const readAt = new Date('2026-01-01T00:00:00Z');
                if (rows[0])
                    await fixture.db
                        .update(dbNotifications)
                        .set({ readAt: readAt })
                        .where(eq(dbNotifications.id, rows[0].id))
                        .returning()
                        .then((rows) => requiredDatabaseValue(rows[0]));
                expect(
                    await delivery.deliver(second.claimed.token, second.candidate),
                ).toMatchObject({
                    reportId: delivered.reportId,
                    reused: true,
                });
                if (rows[0])
                    expect(
                        (
                            await fixture.db.query.notifications
                                .findFirst({ where: eq(dbNotifications.id, rows[0].id) })
                                .then((row) => requiredDatabaseValue(row))
                        ).readAt,
                    ).toEqual(readAt);
                const third = await liveResearch({
                    previous: first,
                    importance: 'unknown',
                    body: '申请截止日期尚未确定。',
                });
                const partial = await delivery.deliver(third.claimed.token, third.candidate);
                expect(
                    (
                        await fixture.db.query.runs
                            .findFirst({ where: eq(dbRuns.id, third.run.id) })
                            .then((row) => requiredDatabaseValue(row))
                    ).status,
                ).toBe('partial');
                expect(
                    (
                        await fixture.db.query.notifications.findMany({
                            where: eq(dbNotifications.runId, third.run.id),
                        })
                    ).map((row) => row.kind),
                ).toEqual(runIssues ? ['run_issue'] : []);
                expect(
                    await fixture.db
                        .select({ count: dbCount() })
                        .from(dbInboxItems)
                        .where(eq(dbInboxItems.reportId, partial.reportId))
                        .then((rows) => rows[0]!.count),
                ).toBe(1);
            });
}
