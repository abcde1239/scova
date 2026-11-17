import { requiredDatabaseValue } from '@/utils/database.ts';
import {
    reports as dbReports,
    eq,
    count as dbCount,
    runs as dbRuns,
    inboxItems as dbInboxItems,
    sql,
    baselines as dbBaselines,
    changeRecords as dbChangeRecords,
    toolCalls as dbToolCalls,
    and,
} from '@scova/db';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { nodeScriptCommand } from '../../../../scripts/process-runtime.mjs';
import type { Report } from '@scova/models';
import { expect, it } from 'vite-plus/test';
import { createAgentRepository } from '../../src/repo/agent.ts';
import { createAgentSession } from '../../src/service/agent.ts';
import { liveResearch } from './live-research.ts';
import { delivery, fixture, runs, saver } from './fixture.ts';

export function registerComparison() {
    it('同URL关键事实变化保存双方真实证据，完整重要变化推进基线；第三次不完整不推进', async () => {
        const first = await liveResearch({ body: '申请截止日期为十一月十五日。' });
        const firstDelivery = await delivery.deliver(first.claimed.token, first.candidate);
        const second = await liveResearch({
            previous: first,
            body: '申请截止日期为十一月二十日。',
        });
        expect(second.claimed.run.baselineRunId).toBe(first.run.id);
        const result = await delivery.deliver(second.claimed.token, second.candidate);
        const report = await fixture.db.query.reports
            .findFirst({
                where: eq(dbReports.id, result.reportId),
                with: { changes: { with: { citations: { with: { evidence: true } } } } },
            })
            .then((row) => requiredDatabaseValue(row));
        expect(report).toMatchObject({ baselineRunId: first.run.id, completeness: 'complete' });
        expect(
            await fixture.db.query.runs
                .findFirst({ where: eq(dbRuns.id, second.run.id) })
                .then((row) => requiredDatabaseValue(row)),
        ).toMatchObject({
            status: 'succeeded',
            outcome: 'important_change',
        });
        const change = report.changes.find((entry) => entry.kind === 'changed')!;
        expect(change).toMatchObject({
            oldValue: '申请截止日期为十一月十五日。',
            newValue: '申请截止日期为十一月二十日。',
            importance: 'important',
        });
        const old = change.citations.find((entry) => entry.side === 'old')!.evidence;
        const current = change.citations.find((entry) => entry.side === 'new')!.evidence;
        expect(old).toMatchObject({
            runId: first.run.id,
            quote: change.oldValue,
            snapshotId: change.oldSnapshotId,
        });
        expect(current).toMatchObject({
            runId: second.run.id,
            quote: change.newValue,
            snapshotId: change.newSnapshotId,
        });
        expect(change.oldSourceId).toBe(change.sourceId);
        const probe = nodeScriptCommand('tests/support/read-delivered-report.ts');
        const readReport = JSON.parse(
            execFileSync(probe.executable, probe.args, {
                cwd: fileURLToPath(new URL('../../../server/', import.meta.url)),
                env: {
                    ...process.env,
                    SCOVA_REPORT_PROBE_DATABASE_URL: fixture.databaseUrl,
                    SCOVA_REPORT_PROBE_USER_ID: first.user.id,
                    SCOVA_REPORT_PROBE_REPORT_ID: result.reportId,
                    SCOVA_REPORT_PROBE_NOTIFICATION_KIND: 'summary',
                },
                encoding: 'utf8',
                windowsHide: true,
                timeout: 20_000,
            }),
        ) as Report;
        expect(readReport).toMatchObject({
            baselineRunId: first.run.id,
            outcome: 'important_change',
            coverage: { completeness: 'complete' },
        });
        const readChange = readReport.changes.find((entry) => entry.kind === 'changed')!;
        expect(readChange.oldEvidenceIds).toContain(old.id);
        expect(readChange.newEvidenceIds).toContain(current.id);
        expect(readReport.evidence.find((entry) => entry.id === old.id)?.quote).toBe(old.quote);
        expect(readReport.evidence.find((entry) => entry.id === current.id)?.quote).toBe(
            current.quote,
        );
        const third = await liveResearch({
            previous: second,
            body: '申请截止日期为十一月二十一日。额外未采集内容',
            maxTextChars: 14,
        });
        await delivery.deliver(third.claimed.token, third.candidate);
        expect(
            await fixture.db.query.runs
                .findFirst({ where: eq(dbRuns.id, third.run.id) })
                .then((row) => requiredDatabaseValue(row)),
        ).toMatchObject({
            status: 'partial',
            outcome: 'inconclusive',
        });
        expect(
            await fixture.db.query.baselines
                .findFirst({ where: eq(dbBaselines.taskId, first.task.id) })
                .then((row) => requiredDatabaseValue(row)),
        ).toMatchObject({ completeRunId: second.run.id });
        expect(await delivery.deliver(second.claimed.token, second.candidate)).toMatchObject({
            reportId: result.reportId,
            reused: true,
        });
        expect(
            await fixture.db
                .select({ count: dbCount() })
                .from(dbReports)
                .where(eq(dbReports.runId, first.run.id))
                .then((rows) => rows[0]!.count),
        ).toBe(1);
        const immutableFirst = await fixture.db.query.reports
            .findFirst({ where: eq(dbReports.id, firstDelivery.reportId) })
            .then((row) => requiredDatabaseValue(row));
        expect(immutableFirst.comparisonJson).toEqual(first.candidate.manifest);
        expect(JSON.stringify(immutableFirst.comparisonJson)).not.toContain('"text":');
    });

    it('strict模型的null关系经账本校验后交付且保留原始输出，重放不重复报告', async () => {
        const seed = await liveResearch({ nullableRelation: true });
        const extraction = await fixture.db.query.toolCalls.findFirst({
            where: and(
                eq(dbToolCalls.runId, seed.run.id),
                sql`${dbToolCalls.operationKey} LIKE 'compare-facts-v1:%'`,
            ),
        });
        expect(extraction?.outputRef).toMatchObject({
            result: { data: { pages: [{ facts: [{ relation: null }] }] } },
        });
        expect(seed.candidate.manifest!.pages[0]!.facts[0]).not.toHaveProperty('relation');
        const result = await delivery.deliver(seed.claimed.token, seed.candidate);
        const report = await fixture.db.query.reports.findFirst({
            where: eq(dbReports.id, result.reportId),
        });
        expect(report?.comparisonJson).toEqual(seed.candidate.manifest);
        expect(await delivery.deliver(seed.claimed.token, seed.candidate)).toEqual({
            reportId: result.reportId,
            reused: true,
        });
        expect(
            await fixture.db.query.reports.findMany({ where: eq(dbReports.runId, seed.run.id) }),
        ).toHaveLength(1);
        expect(
            await fixture.db.query.inboxItems.findMany({
                where: eq(dbInboxItems.reportId, result.reportId),
            }),
        ).toHaveLength(1);
        expect(
            await fixture.db.query.toolCalls.findFirst({
                where: eq(dbToolCalls.id, extraction!.id),
            }),
        ).toEqual(extraction);
    });

    it('正文噪声变化但稳定事实未变为non_material，完整无重要变化', async () => {
        const first = await liveResearch({
            body: 'Deadline: 15 November. Navigation: v1.',
            factValue: '15 November',
        });
        await delivery.deliver(first.claimed.token, first.candidate);
        const second = await liveResearch({
            previous: first,
            body: 'Deadline: 15 November. Navigation: v2.',
            factValue: '15 November',
        });
        const result = await delivery.deliver(second.claimed.token, second.candidate);
        expect(
            await fixture.db.query.changeRecords.findMany({
                where: eq(dbChangeRecords.reportId, result.reportId),
            }),
        ).toMatchObject([{ kind: 'non_material', importance: 'normal' }]);
        expect(
            await fixture.db.query.runs
                .findFirst({ where: eq(dbRuns.id, second.run.id) })
                .then((row) => requiredDatabaseValue(row)),
        ).toMatchObject({
            outcome: 'no_important_change',
            status: 'succeeded',
        });
    });

    it('缺旧来源或未知重要性均partial，不推断撤回/无变化或覆盖既有基线', async () => {
        const first = await liveResearch();
        await delivery.deliver(first.claimed.token, first.candidate);
        const second = await liveResearch({
            previous: first,
            pageUrl: 'https://example.com/new',
            failUrls: ['https://example.com/publication'],
            importance: 'unknown',
        });
        const result = await delivery.deliver(second.claimed.token, second.candidate);
        const report = await fixture.db.query.reports
            .findFirst({ where: eq(dbReports.id, result.reportId), with: { changes: true } })
            .then((row) => requiredDatabaseValue(row));
        expect(report).toMatchObject({ completeness: 'partial', baselineRunId: first.run.id });
        expect(report.changes.every((entry) => entry.importance !== 'important')).toBe(true);
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

    it('冻结基线在恢复时不追随当前指针；promoted比较状态恢复复用账本结果', async () => {
        const first = await liveResearch();
        await delivery.deliver(first.claimed.token, first.candidate);
        const prior = await liveResearch({ previous: first });
        await delivery.deliver(prior.claimed.token, prior.candidate);
        const current = await liveResearch({ previous: prior });
        expect(current.claimed.run.baselineRunId).toBe(prior.run.id);
        await fixture.db
            .update(dbBaselines)
            .set({ completeRunId: first.run.id })
            .where(eq(dbBaselines.taskId, first.task.id))
            .returning({ id: dbBaselines.id })
            .then((rows) => ({ count: rows.length }));
        const count = await fixture.db
            .select({ count: dbCount() })
            .from(dbToolCalls)
            .where(eq(dbToolCalls.runId, current.run.id))
            .then((rows) => rows[0]!.count);
        await fixture.db
            .update(dbRuns)
            .set({ leaseExpiresAt: new Date(0) })
            .where(eq(dbRuns.id, current.run.id))
            .returning()
            .then((rows) => requiredDatabaseValue(rows[0]));
        const next = await runs.claim(current.run.id, 'comparison-recovery', 60_000);
        if (next.kind !== 'claimed') throw new Error('Expected recovered claim');
        expect(next.run.baselineRunId).toBe(prior.run.id);
        const repo = createAgentRepository(fixture.db, next.token);
        expect(await repo.comparison()).toMatchObject({
            baselineRunId: prior.run.id,
            baseline: { status: 'ready', runId: prior.run.id },
        });
        const session = createAgentSession({
            repository: repo,
            saver,
            token: next.token,
            bundle: current.bundle,
            context: {
                ...current.context,
                usage: next.usage,
                assertActive: () => runs.assertActive(next.token),
                emit: (event) => runs.emit(next.token, event),
            },
        });
        const candidate = await session.execute();
        expect(
            await fixture.db
                .select({ count: dbCount() })
                .from(dbToolCalls)
                .where(eq(dbToolCalls.runId, current.run.id))
                .then((rows) => rows[0]!.count),
        ).toBe(count);
        expect(candidate).toEqual(current.candidate);
        await expect(
            delivery.deliver(current.claimed.token, current.candidate),
        ).rejects.toMatchObject({
            code: 'INVALID_DELIVERY_EVIDENCE',
        });
        await delivery.deliver(next.token, candidate);
    });

    it('历史无manifest的合法基线保留冻结指针但比较保守partial，不当首次建基线', async () => {
        const first = await liveResearch();
        await delivery.deliver(first.claimed.token, first.candidate);
        await fixture.db.execute(
            sql`UPDATE reports SET comparison_json=NULL WHERE run_id=${first.run.id}::uuid`,
        );
        const second = await liveResearch({ previous: first });
        expect(second.claimed.run.baselineRunId).toBe(first.run.id);
        expect(
            await createAgentRepository(fixture.db, second.claimed.token).comparison(),
        ).toMatchObject({ baseline: { status: 'unavailable' } });
        await delivery.deliver(second.claimed.token, second.candidate);
        expect(
            await fixture.db.query.runs
                .findFirst({ where: eq(dbRuns.id, second.run.id) })
                .then((row) => requiredDatabaseValue(row)),
        ).toMatchObject({
            status: 'partial',
            outcome: 'inconclusive',
        });
        expect(
            await fixture.db.query.baselines
                .findFirst({ where: eq(dbBaselines.taskId, first.task.id) })
                .then((row) => requiredDatabaseValue(row)),
        ).toMatchObject({ completeRunId: first.run.id });
    });
}
