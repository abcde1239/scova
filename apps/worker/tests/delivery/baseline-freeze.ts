import { requiredDatabaseValue } from '../../../server/src/utils/execution/database.ts';
import {
    reports as dbReports,
    eq,
    count as dbCount,
    runs as dbRuns,
    notifications as dbNotifications,
    sql,
    baselines as dbBaselines,
    changeRecords as dbChangeRecords,
} from '@scova/db';
import { expect, it } from 'vite-plus/test';
import { createAgentRepository } from '../../../server/src/repo/execution/agent.ts';
import { liveResearch } from './live-research.ts';
import { fixture, delivery, assertEmpty, runs } from './fixture.ts';

export function registerBaselineFreeze() {
    it('通知SQL失败使报告/Inbox/基线/终态一起回滚，修复后可重试', async () => {
        const researched = await liveResearch();
        await fixture.db.execute(
            sql.raw(
                `CREATE FUNCTION notification_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected notification failure'; END $$`,
            ),
        );
        await fixture.db.execute(
            sql.raw(
                'CREATE TRIGGER notification_fail BEFORE INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION notification_fail()',
            ),
        );
        try {
            await expect(
                delivery.deliver(researched.claimed.token, researched.candidate),
            ).rejects.toThrow();
            await assertEmpty(researched.run.id);
            expect(
                await fixture.db
                    .select({ count: dbCount() })
                    .from(dbNotifications)
                    .where(eq(dbNotifications.runId, researched.run.id))
                    .then((rows) => rows[0]!.count),
            ).toBe(0);
            expect(
                await fixture.db
                    .select({ count: dbCount() })
                    .from(dbBaselines)
                    .where(eq(dbBaselines.taskId, researched.task.id))
                    .then((rows) => rows[0]!.count),
            ).toBe(0);
            expect(
                (
                    await fixture.db.query.runs
                        .findFirst({ where: eq(dbRuns.id, researched.run.id) })
                        .then((row) => requiredDatabaseValue(row))
                ).status,
            ).toBe('running');
        } finally {
            await fixture.db.execute(sql.raw('DROP TRIGGER notification_fail ON notifications'));
            await fixture.db.execute(sql.raw('DROP FUNCTION notification_fail()'));
        }
        await delivery.deliver(researched.claimed.token, researched.candidate);
        expect(
            await fixture.db
                .select({ count: dbCount() })
                .from(dbNotifications)
                .where(eq(dbNotifications.runId, researched.run.id))
                .then((rows) => rows[0]!.count),
        ).toBe(1);
    });

    it.each(['new', 'repost'] as const)('新增URL按%s分类，不把转载当独立新增', async (kind) => {
        const first = await liveResearch();
        await delivery.deliver(first.claimed.token, first.candidate);
        const addedUrl = 'https://example.com/new-material?programme=ai';
        const second = await liveResearch({
            previous: first,
            pageUrl: addedUrl,
            bodyByUrl:
                kind === 'new'
                    ? { [addedUrl]: '新增公开课程，报名截止日期为十二月一日。' }
                    : undefined,
        });
        const result = await delivery.deliver(second.claimed.token, second.candidate);
        const changes = await fixture.db.query.changeRecords.findMany({
            where: eq(dbChangeRecords.reportId, result.reportId),
            with: { source: true },
        });
        expect(changes.find((change) => change.source.canonicalUrl === addedUrl)).toMatchObject({
            kind: kind === 'new' ? 'new' : 'duplicate_candidate',
            importance: 'normal',
        });
        expect(
            await fixture.db.query.runs
                .findFirst({ where: eq(dbRuns.id, second.run.id) })
                .then((row) => requiredDatabaseValue(row)),
        ).toMatchObject({
            status: 'succeeded',
            outcome: kind === 'new' ? 'new_findings' : 'no_important_change',
        });
    });

    it('提取版本变化保守partial而非完整重复，旧完整基线不变', async () => {
        const first = await liveResearch();
        await delivery.deliver(first.claimed.token, first.candidate);
        const second = await liveResearch({
            previous: first,
            extractionVersion: 'readability/future-v2',
        });
        const result = await delivery.deliver(second.claimed.token, second.candidate);
        expect(
            await fixture.db.query.reports
                .findFirst({ where: eq(dbReports.id, result.reportId) })
                .then((row) => requiredDatabaseValue(row)),
        ).toMatchObject({ completeness: 'partial' });
        expect(
            await fixture.db.query.runs
                .findFirst({ where: eq(dbRuns.id, second.run.id) })
                .then((row) => requiredDatabaseValue(row)),
        ).toMatchObject({
            outcome: 'inconclusive',
        });
        expect(
            await fixture.db.query.baselines
                .findFirst({ where: eq(dbBaselines.taskId, first.task.id) })
                .then((row) => requiredDatabaseValue(row)),
        ).toMatchObject({ completeRunId: first.run.id });
    });

    it.each(['foreign-page', 'missing-quote'] as const)(
        '基线manifest %s损坏不借用别人的snapshot或无引用事实',
        async (kind) => {
            const first = await liveResearch();
            await delivery.deliver(first.claimed.token, first.candidate);
            const manifest = structuredClone(first.candidate.manifest!);
            if (kind === 'foreign-page') manifest.pages[0].url = 'https://foreign.example/source';
            else {
                manifest.pages[0].facts[0].quote = '没有保留引用的旧事实';
                manifest.pages[0].facts[0].value = '旧事实';
            }
            await fixture.db
                .update(dbReports)
                .set({ comparisonJson: JSON.parse(JSON.stringify(manifest)) })
                .where(eq(dbReports.runId, first.run.id))
                .returning({ id: dbReports.id })
                .then((rows) => ({ count: rows.length }));
            const second = await liveResearch({ previous: first });
            expect(
                await createAgentRepository(fixture.db, second.claimed.token).comparison(),
            ).toMatchObject({ baselineRunId: first.run.id, baseline: { status: 'unavailable' } });
            await delivery.deliver(second.claimed.token, second.candidate);
            expect(
                await fixture.db.query.runs
                    .findFirst({ where: eq(dbRuns.id, second.run.id) })
                    .then((row) => requiredDatabaseValue(row)),
            ).toMatchObject({ status: 'partial', outcome: 'inconclusive' });
            expect(
                await fixture.db.query.baselines
                    .findFirst({ where: eq(dbBaselines.taskId, first.task.id) })
                    .then((row) => requiredDatabaseValue(row)),
            ).toMatchObject({ completeRunId: first.run.id });
        },
    );

    it('首次冻结null后即使出现新指针，恢复仍保持null；模式不匹配的基线不采用', async () => {
        const initial = await liveResearch({ skipExecute: true });
        expect(initial.claimed.run.baselineRunId).toBeNull();
        const history = await fixture.db
            .insert(dbRuns)
            .values({
                userId: initial.user.id,
                taskId: initial.task.id,
                taskVersionId: initial.version.id,
                comparisonScopeHash: initial.run.comparisonScopeHash,
                mode: 'live',
                trigger: 'manual',
                status: 'succeeded',
                outcome: 'baseline',
                budgetJson: initial.config.budget,
                coverageJson: {
                    completeness: 'complete',
                    gaps: [],
                    searchedQueries: [],
                    exhausted: [],
                },
            })
            .returning()
            .then((rows) => requiredDatabaseValue(rows[0]));
        await fixture.db
            .insert(dbReports)
            .values({
                userId: initial.user.id,
                taskId: initial.task.id,
                taskVersionId: initial.version.id,
                runId: history.id,
                title: '历史报告',
                summary: '历史完整来源',
                format: 'brief',
                completeness: 'complete',
            })
            .returning()
            .then((rows) => requiredDatabaseValue(rows[0]));
        await fixture.db
            .insert(dbBaselines)
            .values({
                userId: initial.user.id,
                taskId: initial.task.id,
                comparisonScopeHash: initial.run.comparisonScopeHash,
                completeRunId: history.id,
            })
            .returning()
            .then((rows) => requiredDatabaseValue(rows[0]));
        await fixture.db
            .update(dbRuns)
            .set({ leaseExpiresAt: new Date(0) })
            .where(eq(dbRuns.id, initial.run.id))
            .returning()
            .then((rows) => requiredDatabaseValue(rows[0]));
        const recovered = await runs.claim(initial.run.id, 'null-recovery', 60_000);
        if (recovered.kind !== 'claimed') throw new Error('Expected recovery');
        expect(recovered.run.baselineRunId).toBeNull();
        expect(await createAgentRepository(fixture.db, recovered.token).comparison()).toMatchObject(
            {
                baselineRunId: null,
                baseline: null,
            },
        );
        await runs.finish(recovered.token, { code: 'EXECUTOR_FAILED' });
        const demo = await fixture.db
            .insert(dbRuns)
            .values({
                userId: initial.user.id,
                taskId: initial.task.id,
                taskVersionId: initial.version.id,
                comparisonScopeHash: initial.run.comparisonScopeHash,
                mode: 'demo',
                trigger: 'manual',
                budgetJson: initial.config.budget,
                usageJson: {
                    searches: 0,
                    pages: 0,
                    inputTokens: 0,
                    outputTokens: 0,
                    estimated: false,
                },
            })
            .returning()
            .then((rows) => requiredDatabaseValue(rows[0]));
        const demoClaim = await runs.claim(demo.id, 'demo-isolation');
        if (demoClaim.kind !== 'claimed') throw new Error('Expected demo claim');
        expect(demoClaim.run.baselineRunId).toBeNull();
    });
}
