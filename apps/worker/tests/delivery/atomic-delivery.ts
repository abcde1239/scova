import { requiredDatabaseValue } from '@/utils/database.ts';
import {
    reports as dbReports,
    eq,
    count as dbCount,
    runSources as dbRunSources,
    runs as dbRuns,
    inboxItems as dbInboxItems,
    baselines as dbBaselines,
    sources as dbSources,
    and,
    runEvents as dbRunEvents,
    asc,
} from '@scova/db';
import { expect, it } from 'vite-plus/test';
import { seedRun } from '../support/run-database.ts';
import { research, delivery, fixture, sha, runs, assertEmpty } from './fixture.ts';

export function registerAtomicDelivery() {
    it('保留正文与精确quote定位，partial原子交付1报告/Inbox/终态且不建基线', async () => {
        const seed = await research();
        const result = await delivery.deliver(seed.claimed.token, seed.candidate);
        const report = await fixture.db.query.reports
            .findFirst({
                where: eq(dbReports.id, result.reportId),
                with: {
                    claims: { with: { citations: { with: { evidence: true } } } },
                    inboxItems: true,
                },
            })
            .then((row) => requiredDatabaseValue(row));
        expect(report).toMatchObject({
            userId: seed.user.id,
            runId: seed.run.id,
            taskVersionId: seed.version.id,
            completeness: 'partial',
            format: 'brief',
        });
        expect(report.inboxItems).toHaveLength(1);
        expect(report.limitationsJson).toContain(seed.candidate.demoReason);
        const observations = await fixture.db.query.runSources.findMany({
            where: eq(dbRunSources.runId, seed.run.id),
            with: { snapshot: true, source: true },
        });
        expect(observations).toHaveLength(1);
        expect(observations[0]).toMatchObject({
            requestedUrl: seed.candidate.pages[0].originalUrl,
            fetchedUrl: seed.candidate.pages[0].fetchedUrl,
            fetchStatus: 'succeeded',
        });
        expect(observations[0].source.canonicalUrl).toBe(seed.candidate.pages[0].url);
        const snapshot = observations[0].snapshot!;
        expect(snapshot).toMatchObject({
            textBody: seed.candidate.pages[0].text,
            contentHash: sha(seed.candidate.pages[0].text),
            extractorVersion: seed.candidate.pages[0].extractionVersion,
        });
        expect(snapshot.textExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 29 * 86400_000);
        for (const claim of report.claims) {
            expect(claim.kind).toBe('fact');
            expect(claim.citations.length).toBeGreaterThan(0);
            for (const citation of claim.citations) {
                const evidence = citation.evidence;
                const selector = evidence.selectorJson as {
                    type: string;
                    start: number;
                    end: number;
                    extractorVersion: string;
                };
                expect(selector.type).toBe('text_offset');
                expect(snapshot.textBody!.slice(selector.start, selector.end)).toBe(evidence.quote);
                expect(sha(evidence.quote)).toBe(evidence.quoteHash);
                expect(evidence).toMatchObject({
                    runId: seed.run.id,
                    userId: seed.user.id,
                    snapshotId: snapshot.id,
                });
            }
        }
        expect(
            await fixture.db.query.runs
                .findFirst({ where: eq(dbRuns.id, seed.run.id) })
                .then((row) => requiredDatabaseValue(row)),
        ).toMatchObject({
            status: 'partial',
            outcome: 'inconclusive',
            failureCode: null,
            leaseOwner: null,
            coverageJson: { completeness: 'partial' },
        });
        expect(
            await fixture.db
                .select({ count: dbCount() })
                .from(dbBaselines)
                .where(eq(dbBaselines.taskId, seed.task.id))
                .then((rows) => rows[0]!.count),
        ).toBe(0);
        const events = await fixture.db.query.runEvents.findMany({
            where: eq(dbRunEvents.runId, seed.run.id),
            orderBy: [asc(dbRunEvents.seq)],
        });
        expect(events.slice(-3).map((event) => event.type)).toEqual([
            'coverage.updated',
            'report.published',
            'run.completed',
        ]);
        expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1));
        expect(await runs.finish(seed.claimed.token, { code: 'EXECUTOR_FAILED' })).toBe(false);
    });

    it('提交后未ACK重投和并发deliver都复用同1份报告/Inbox/终态事件', async () => {
        const seed = await research();
        const results = await Promise.all([
            delivery.deliver(seed.claimed.token, seed.candidate),
            delivery.deliver(seed.claimed.token, seed.candidate),
        ]);
        expect(results[0].reportId).toBe(results[1].reportId);
        expect(results.filter((item) => !item.reused)).toHaveLength(1);
        expect(await delivery.deliver(seed.claimed.token, seed.candidate)).toMatchObject({
            reportId: results[0].reportId,
            reused: true,
        });
        expect(await runs.claim(seed.run.id, 'redelivery')).toEqual({ kind: 'ignored' });
        expect(
            await fixture.db
                .select({ count: dbCount() })
                .from(dbReports)
                .where(eq(dbReports.runId, seed.run.id))
                .then((rows) => rows[0]!.count),
        ).toBe(1);
        expect(
            await fixture.db
                .select({ count: dbCount() })
                .from(dbInboxItems)
                .where(eq(dbInboxItems.reportId, results[0].reportId))
                .then((rows) => rows[0]!.count),
        ).toBe(1);
        expect(
            await fixture.db
                .select({ count: dbCount() })
                .from(dbRunEvents)
                .where(
                    and(
                        eq(dbRunEvents.runId, seed.run.id),
                        eq(dbRunEvents.type, 'report.published'),
                    ),
                )
                .then((rows) => rows[0]!.count),
        ).toBe(1);
        expect(
            await fixture.db
                .select({ count: dbCount() })
                .from(dbRunEvents)
                .where(
                    and(eq(dbRunEvents.runId, seed.run.id), eq(dbRunEvents.type, 'run.completed')),
                )
                .then((rows) => rows[0]!.count),
        ).toBe(1);
    });

    it.each(['owner', 'run', 'version', 'mode', 'quote', 'page', 'coverage', 'url'] as const)(
        '拒绝候选伪造：%s',
        async (kind) => {
            const seed = await research();
            const other = await seedRun(fixture.db);
            const candidate = structuredClone(seed.candidate);
            if (kind === 'owner') candidate.userId = other.user.id;
            if (kind === 'run') candidate.runId = other.run.id;
            if (kind === 'version') candidate.taskVersionId = other.version.id;
            if (kind === 'mode') candidate.mode = 'live';
            if (kind === 'quote') candidate.claims[0].citations[0].quote = '从未采集的虚构文本';
            if (kind === 'page') candidate.claims[0].citations[0].pageId = 'other-owner-page';
            if (kind === 'coverage')
                candidate.coverage = {
                    completeness: 'complete',
                    searchedQueries: [],
                    exhausted: [],
                    gaps: [],
                };
            if (kind === 'url') candidate.pages[0].fetchedUrl = 'https://evil.example/forged';
            await expect(delivery.deliver(seed.claimed.token, candidate)).rejects.toMatchObject({
                code: 'INVALID_DELIVERY_EVIDENCE',
            });
            await assertEmpty(seed.run.id);
            expect(
                await fixture.db
                    .select({ count: dbCount() })
                    .from(dbSources)
                    .where(eq(dbSources.userId, seed.user.id))
                    .then((rows) => rows[0]!.count),
            ).toBe(0);
        },
    );
}
