import { requiredDatabaseValue } from '@/utils/database.ts';
import { primaryArtifactSummary } from '@/utils/report-summary.ts';
import {
    type Run,
    reports as dbReports,
    eq,
    and,
    toolCalls as dbToolCalls,
    baselines as dbBaselines,
    inArray,
    inboxItems as dbInboxItems,
    runs as dbRuns,
    type DatabaseTransaction,
} from '@scova/db';
import { type AgentCandidate, type AgentContext } from '@scova/agent-core';
import { appendEvent } from '@/repo/runs.ts';
import { createTerminalNotifications } from '@/repo/notifications.ts';
import { type PageRecords } from './sources.ts';
import { createEvidenceWriter } from '@/repo/delivery/evidence.ts';
import { saveClaims } from '@/repo/delivery/claims.ts';
import { saveChanges } from '@/repo/delivery/changes.ts';

export interface ReportWriteInput {
    candidate: AgentCandidate;
    config: AgentContext['config'];
    context: AgentContext;
    pageRecords: PageRecords;
    complete: boolean;
    outcome: NonNullable<Run['outcome']>;
    changes: NonNullable<AgentCandidate['changes']>;
}

export function findBaseline(tx: DatabaseTransaction, run: Run) {
    return tx.query.baselines.findFirst({
        where: and(
            eq(dbBaselines.userId, run.userId),
            eq(dbBaselines.taskId, run.taskId),
            eq(dbBaselines.comparisonScopeHash, run.comparisonScopeHash),
        ),
    });
}

export async function saveReport(
    tx: DatabaseTransaction,
    run: Run,
    now: Date,
    input: ReportWriteInput,
): Promise<{ reportId: string; reused: boolean }> {
    const { candidate, config, pageRecords, complete, outcome } = input;
    const report = await tx
        .insert(dbReports)
        .values({
            userId: run.userId,
            runId: run.id,
            taskId: run.taskId,
            taskVersionId: run.taskVersionId,
            baselineRunId: run.baselineRunId,
            title: candidate.title,
            summary: primaryArtifactSummary(candidate.claims, candidate.coverage),
            format: candidate.coverage.artifacts?.[0]?.format ?? config.outputFormat,
            completeness: candidate.coverage.completeness,
            limitationsJson: candidate.coverage.gaps,
            feedbackEffectsJson: candidate.feedbackEffects ?? [],
            comparisonJson: candidate.manifest
                ? JSON.parse(JSON.stringify(candidate.manifest))
                : undefined,
        })
        .returning()
        .then((rows) => requiredDatabaseValue(rows[0]));
    const { saveEvidence, hasEvidence } = createEvidenceWriter(tx, run, now, pageRecords);
    for (const page of candidate.manifest?.pages ?? [])
        for (const fact of page.facts)
            await saveEvidence({ pageId: page.pageId, quote: fact.quote });
    await saveClaims(tx, run, report.id, candidate, saveEvidence);
    await saveChanges(tx, run, report.id, input, saveEvidence);
    // An uncertain model conclusion need not have a direct citation. Keep a real
    // source excerpt in the appendix without falsely linking it as claim support.
    if (!hasEvidence() && candidate.pages.length)
        await saveEvidence({
            pageId: candidate.pages[0]!.id,
            quote: Array.from(candidate.pages[0]!.text).slice(0, 300).join(''),
        });
    await tx
        .insert(dbInboxItems)
        .values({ userId: run.userId, reportId: report.id })
        .returning()
        .then((rows) => requiredDatabaseValue(rows[0]));
    await createTerminalNotifications(tx, run, {
        status: complete ? 'succeeded' : 'partial',
        outcome,
        reportId: report.id,
    });
    await tx
        .update(dbToolCalls)
        .set({ status: 'unknown', finishedAt: now })
        .where(
            and(
                eq(dbToolCalls.userId, run.userId),
                eq(dbToolCalls.runId, run.id),
                inArray(dbToolCalls.status, ['reserved', 'running']),
            ),
        )
        .returning({ id: dbToolCalls.id })
        .then((rows) => ({ count: rows.length }));
    await tx
        .update(dbRuns)
        .set({
            status: complete ? 'succeeded' : 'partial',
            outcome: outcome,
            coverageJson: candidate.coverage,
            finishedAt: now,
            failureCode: null,
            leaseOwner: null,
            leaseExpiresAt: null,
        })
        .where(eq(dbRuns.id, run.id))
        .returning()
        .then((rows) => requiredDatabaseValue(rows[0]));
    if (complete && candidate.coverage.baseline?.eligible !== false)
        await tx
            .insert(dbBaselines)
            .values({
                userId: run.userId,
                taskId: run.taskId,
                comparisonScopeHash: run.comparisonScopeHash,
                completeRunId: run.id,
            })
            .onConflictDoUpdate({
                target: [dbBaselines.userId, dbBaselines.taskId, dbBaselines.comparisonScopeHash],
                set: { completeRunId: run.id },
            })
            .returning()
            .then((rows) => requiredDatabaseValue(rows[0]));
    await appendEvent(tx, run, now, {
        type: 'coverage.updated',
        payload: candidate.coverage,
    });
    await appendEvent(tx, run, now, {
        type: 'report.published',
        payload: {
            reportId: report.id,
            completeness: candidate.coverage.completeness,
        },
    });
    await appendEvent(tx, run, now, {
        type: 'run.completed',
        payload: complete
            ? { status: 'succeeded', outcome, reportId: report.id }
            : {
                  status: 'partial',
                  outcome: 'inconclusive',
                  reportId: report.id,
              },
    });
    return { reportId: report.id, reused: false };
}
