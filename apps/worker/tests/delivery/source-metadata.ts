import { requiredDatabaseValue } from '@/utils/database.ts';
import {
    reports as dbReports,
    eq,
    count as dbCount,
    runSources as dbRunSources,
    runs as dbRuns,
    inboxItems as dbInboxItems,
    baselines as dbBaselines,
    changeRecords as dbChangeRecords,
    toolCalls as dbToolCalls,
    and,
    runEvents as dbRunEvents,
    asc,
} from '@scova/db';
import { expect, it } from 'vite-plus/test';
import { type ReadPage } from '@scova/connectors';
import { liveResearch } from './live-research.ts';
import { delivery, fixture, assertEmpty } from './fixture.ts';

export function registerSourceMetadata() {
    it('未知时间和适用条件保留在notes，已回答的首次交付允许完成', async () => {
        const seed = await liveResearch({ publication: null, condition: '仅适用于本轮申请' });
        expect(seed.candidate.coverage.delivery).toMatchObject({
            status: 'answered',
            answeredCoreQuestions: 1,
        });
        expect(seed.candidate.coverage.completeness).toBe('complete');
        expect(seed.candidate.coverage.notes?.join(' ')).toContain('时间范围未核验');
        const { reportId } = await delivery.deliver(seed.claimed.token, seed.candidate);
        const saved = await fixture.db.query.runs.findFirst({ where: eq(dbRuns.id, seed.run.id) });
        expect(saved).toMatchObject({
            status: 'succeeded',
            outcome: 'baseline',
            coverageJson: { delivery: { status: 'answered' } },
        });
        expect(
            await fixture.db.query.reports.findFirst({ where: eq(dbReports.id, reportId) }),
        ).toBeDefined();
        expect(
            await fixture.db.query.baselines.findFirst({
                where: eq(dbBaselines.taskId, seed.task.id),
            }),
        ).toMatchObject({ completeRunId: seed.run.id });
        // A separate Run is needed to test validation, since replay legitimately reuses an already committed report.
        const other = await liveResearch({ publication: null });
        other.candidate.coverage.delivery!.status = 'sources_only';
        await expect(delivery.deliver(other.claimed.token, other.candidate)).rejects.toMatchObject({
            code: 'INVALID_DELIVERY_EVIDENCE',
        });
        await assertEmpty(other.run.id);
    });

    it('同一正文读取重试恢复后不因旧失败降级，来源范围匹配不强加官方认证缺口', async () => {
        const seed = await liveResearch({ retryRead: true, officialOnly: true });
        expect(seed.candidate.coverage.completeness).toBe('complete');
        await delivery.deliver(seed.claimed.token, seed.candidate);
        const saved = await fixture.db.query.runs.findFirst({ where: eq(dbRuns.id, seed.run.id) });
        expect(saved).toMatchObject({
            status: 'succeeded',
            outcome: 'baseline',
            coverageJson: { delivery: { status: 'answered' }, completeness: 'complete', gaps: [] },
        });
        const calls = await fixture.db.query.toolCalls.findMany({
            where: and(eq(dbToolCalls.runId, seed.run.id), eq(dbToolCalls.tool, 'read')),
            orderBy: [asc(dbToolCalls.attemptNo)],
        });
        // A transport failure retains its conservative unknown settlement and reserved usage.
        expect(calls.map((call) => call.status)).toEqual(['unknown', 'succeeded']);
        expect(calls[0].operationKey).toBe(calls[1].operationKey);
        expect(saved!.usageJson).toMatchObject({ pages: 2 });
        expect((saved!.coverageJson as { notes: string[] }).notes.join(' ')).toContain('重试恢复');
    });

    it('日期精度和修改时间独立保存，不将未知时区日期写成午夜UTC', async () => {
        const day = new Date(Date.now() - 3 * 86400_000).toISOString().slice(0, 10);
        const seed = await liveResearch({ publication: day, modified: new Date().toISOString() });
        await delivery.deliver(seed.claimed.token, seed.candidate);
        const observation = await fixture.db.query.runSources.findFirst({
            where: eq(dbRunSources.runId, seed.run.id),
            with: { snapshot: true },
        });
        expect(observation!.snapshot!.publishedAt).toBeNull();
        expect(observation!.metadataJson).toMatchObject({
            publication: {
                parserVersion: 'scova-publication-v2',
                status: 'known',
                instant: null,
                observations: expect.arrayContaining([
                    expect.objectContaining({ rawValue: day }),
                    expect.objectContaining({ field: 'meta:modified' }),
                ]),
            },
        });
    });

    it('HTML来源声明日期经Reader→Agent→账本验证后首次完整交付建立基线', async () => {
        const seed = await liveResearch();
        expect(seed.candidate.coverage).toMatchObject({ completeness: 'complete', gaps: [] });
        const { reportId } = await delivery.deliver(seed.claimed.token, seed.candidate);
        expect(
            await fixture.db.query.reports
                .findFirst({ where: eq(dbReports.id, reportId) })
                .then((row) => requiredDatabaseValue(row)),
        ).toMatchObject({
            completeness: 'complete',
        });
        expect(
            await fixture.db.query.runs
                .findFirst({ where: eq(dbRuns.id, seed.run.id) })
                .then((row) => requiredDatabaseValue(row)),
        ).toMatchObject({
            status: 'succeeded',
            outcome: 'baseline',
        });
        expect(
            await fixture.db.query.baselines
                .findFirst({ where: eq(dbBaselines.taskId, seed.task.id) })
                .then((row) => requiredDatabaseValue(row)),
        ).toMatchObject({ completeRunId: seed.run.id });
        const observation = await fixture.db.query.runSources
            .findFirst({ where: eq(dbRunSources.runId, seed.run.id), with: { snapshot: true } })
            .then((row) => requiredDatabaseValue(row));
        expect(observation.snapshot!.publishedAt).not.toBeNull();
        expect(observation.metadataJson).toMatchObject({
            publication: { status: 'known' },
            truncated: false,
        });
    });

    it('首次完整基线后，第二轮完成比较的重复资料可声明无重要变化并推进基线', async () => {
        const first = await liveResearch();
        expect(first.candidate.coverage.completeness).toBe('complete');
        await delivery.deliver(first.claimed.token, first.candidate);
        const second = await liveResearch({ previous: first });
        expect(second.candidate).toMatchObject({
            comparison: 'completed',
            coverage: { completeness: 'complete', gaps: [] },
        });
        const result = await delivery.deliver(second.claimed.token, second.candidate);
        const report = await fixture.db.query.reports
            .findFirst({ where: eq(dbReports.id, result.reportId) })
            .then((row) => requiredDatabaseValue(row));
        expect(report).toMatchObject({ completeness: 'complete', baselineRunId: first.run.id });
        expect(report.limitationsJson).toEqual([]);
        expect(
            await fixture.db.query.runs
                .findFirst({ where: eq(dbRuns.id, second.run.id) })
                .then((row) => requiredDatabaseValue(row)),
        ).toMatchObject({
            status: 'succeeded',
            outcome: 'no_important_change',
            coverageJson: {
                completeness: 'complete',
                gaps: [],
            },
        });
        expect(
            await fixture.db.query.baselines
                .findFirst({ where: eq(dbBaselines.taskId, first.task.id) })
                .then((row) => requiredDatabaseValue(row)),
        ).toMatchObject({ completeRunId: second.run.id });
        expect(
            await fixture.db
                .select({ count: dbCount() })
                .from(dbInboxItems)
                .where(eq(dbInboxItems.reportId, result.reportId))
                .then((rows) => rows[0]!.count),
        ).toBe(1);
        const completed = await fixture.db.query.runEvents
            .findFirst({
                where: and(
                    eq(dbRunEvents.runId, second.run.id),
                    eq(dbRunEvents.type, 'run.completed'),
                ),
            })
            .then((row) => requiredDatabaseValue(row));
        expect(completed.payload).toMatchObject({
            status: 'succeeded',
            outcome: 'no_important_change',
        });
        expect(
            await fixture.db.query.changeRecords.findMany({
                where: eq(dbChangeRecords.reportId, report.id),
            }),
        ).toMatchObject([{ kind: 'duplicate' }]);
    });

    it.each([false, true])(
        '同URL/hash复用快照仍保留两轮真实observedAt和本次truncated=%s，partial不推进完整基线',
        async (firstTruncated) => {
            const prefix = '公开公告的保存正文内容。'.repeat(10);
            const first = await liveResearch({
                body: firstTruncated ? prefix + '更多尚未保存内容' : prefix,
                maxTextChars: prefix.length,
            });
            await delivery.deliver(first.claimed.token, first.candidate);
            const before = await fixture.db.query.baselines.findFirst({
                where: eq(dbBaselines.taskId, first.task.id),
            });
            const second = await liveResearch({
                previous: first,
                body: firstTruncated ? prefix : prefix + '更多尚未保存内容',
                maxTextChars: prefix.length,
            });
            expect(first.candidate.pages[0].contentHash).toBe(
                second.candidate.pages[0].contentHash,
            );
            await delivery.deliver(second.claimed.token, second.candidate);
            const one = await fixture.db.query.runSources
                .findFirst({
                    where: eq(dbRunSources.runId, first.run.id),
                    with: { snapshot: true },
                })
                .then((row) => requiredDatabaseValue(row));
            const two = await fixture.db.query.runSources
                .findFirst({ where: eq(dbRunSources.runId, second.run.id) })
                .then((row) => requiredDatabaseValue(row));
            expect(two.snapshotId).toBe(one.snapshotId);
            expect(two.observedAt.getTime()).toBeGreaterThan(one.observedAt.getTime());
            expect(one.metadataJson).toMatchObject({ truncated: firstTruncated });
            expect(two.metadataJson).toMatchObject({ truncated: !firstTruncated });
            expect(one.snapshot!.metadataJson).toMatchObject({ truncated: firstTruncated });
            const after = await fixture.db.query.baselines.findFirst({
                where: eq(dbBaselines.taskId, first.task.id),
            });
            if (!firstTruncated) expect(after!.completeRunId).toBe(before!.completeRunId);
            else expect(after!.completeRunId).toBe(second.run.id);
            const secondRun = await fixture.db.query.runs
                .findFirst({ where: eq(dbRuns.id, second.run.id) })
                .then((row) => requiredDatabaseValue(row));
            expect(secondRun.outcome).not.toBe('no_important_change');
        },
    );

    it('资源受限但未截断的正文以partial交付并保留本次采集状态，不推进完整基线', async () => {
        const complete = await liveResearch();
        await delivery.deliver(complete.claimed.token, complete.candidate);
        const baseline = await fixture.db.query.baselines.findFirst({
            where: eq(dbBaselines.taskId, complete.task.id),
        });
        expect(baseline?.completeRunId).toBe(complete.run.id);
        const collection: ReadPage['collection'] = {
            version: 1,
            method: 'browser',
            complete: false,
            limitations: ['resource_limit'],
        };
        const limited = await liveResearch({ previous: complete, collection });
        expect(limited.candidate.pages[0].truncated).toBe(false);
        expect(limited.candidate.pages[0].contentHash).toBe(
            complete.candidate.pages[0].contentHash,
        );
        expect(limited.candidate.coverage.completeness).toBe('partial');
        expect(limited.candidate.changes?.every((change) => change.kind === 'uncertain')).toBe(
            true,
        );
        const result = await delivery.deliver(limited.claimed.token, limited.candidate);
        const report = await fixture.db.query.reports.findFirst({
            where: eq(dbReports.id, result.reportId),
        });
        expect(report?.completeness).toBe('partial');
        expect(JSON.stringify(report?.limitationsJson)).toContain('网页渲染或资源加载受限');
        const observation = await fixture.db.query.runSources.findFirst({
            where: eq(dbRunSources.runId, limited.run.id),
            with: { snapshot: true },
        });
        expect(observation?.metadataJson).toMatchObject({ truncated: false, collection });
        expect(observation?.snapshot?.textBody).toBe(limited.candidate.pages[0].text);
        expect(
            (
                await fixture.db.query.baselines.findFirst({
                    where: eq(dbBaselines.taskId, limited.task.id),
                })
            )?.completeRunId,
        ).toBe(complete.run.id);
        expect(
            await fixture.db.query.runs.findFirst({ where: eq(dbRuns.id, limited.run.id) }),
        ).toMatchObject({
            status: 'partial',
            outcome: 'inconclusive',
        });
    });
}
