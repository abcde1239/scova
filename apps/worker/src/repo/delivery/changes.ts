import { requiredDatabaseValue } from '@/utils/database.ts';
import {
    type Run,
    eq,
    and,
    evidence as dbEvidence,
    inArray,
    changeRecords as dbChangeRecords,
    changeEvidence as dbChangeEvidence,
    type DatabaseTransaction,
} from '@scova/db';
import { invalid } from '@/utils/delivery.ts';
import type { ReportWriteInput } from '@/repo/delivery/reports.ts';
import type { SaveEvidence } from '@/repo/delivery/evidence.ts';

export async function saveChanges(
    tx: DatabaseTransaction,
    run: Run,
    reportId: string,
    input: Pick<ReportWriteInput, 'changes' | 'candidate' | 'context' | 'pageRecords'>,
    saveEvidence: SaveEvidence,
) {
    const { changes, candidate, context, pageRecords } = input;
    for (const item of changes) {
        const page = pageRecords.get(item.pageId);
        if (!page) return invalid();
        if (candidate.comparison !== 'completed') invalid();
        const oldIds = [...new Set(item.oldEvidenceIds)];
        const allowedOld = new Set(context.baseline?.evidence.map((entry) => entry.id) ?? []);
        if (oldIds.some((id) => !allowedOld.has(id))) invalid();
        const oldEvidence = oldIds.length
            ? await tx.query.evidence.findMany({
                  where: and(
                      inArray(dbEvidence.id, oldIds),
                      eq(dbEvidence.userId, run.userId),
                      eq(dbEvidence.runId, run.baselineRunId!),
                  ),
                  with: {
                      observation: { with: { source: true, snapshot: true } },
                  },
              })
            : [];
        if (
            oldEvidence.length !== oldIds.length ||
            oldEvidence.some(
                (entry) =>
                    entry.observation.snapshotId !== entry.snapshotId ||
                    entry.observation.fetchStatus !== 'succeeded',
            )
        )
            invalid();
        const oldSnapshotIds = new Set(oldEvidence.map((entry) => entry.snapshotId));
        if (oldSnapshotIds.size > 1) invalid();
        if (
            item.kind === 'changed' &&
            (!oldEvidence.length ||
                !item.newCitations.length ||
                item.oldValue === null ||
                item.newValue === null)
        )
            invalid();
        if (
            item.kind === 'new' &&
            (oldEvidence.length || item.oldValue !== null || !item.newCitations.length)
        )
            invalid();
        if (item.important && item.kind !== 'changed') invalid();
        const change = await tx
            .insert(dbChangeRecords)
            .values({
                userId: run.userId,
                reportId: reportId,
                sourceId: page.sourceId,
                kind: item.kind,
                factKey: item.factKey,
                oldValue: item.oldValue,
                newValue: item.newValue,
                oldSourceId: oldEvidence[0]?.observation.sourceId ?? null,
                oldSnapshotId: oldEvidence[0]?.snapshotId ?? null,
                newSnapshotId: page.snapshotId,
                importance: item.important ? 'important' : 'normal',
                reason: item.reason,
            })
            .returning()
            .then((rows) => requiredDatabaseValue(rows[0]));
        for (const old of oldEvidence)
            await tx
                .insert(dbChangeEvidence)
                .values({
                    userId: run.userId,
                    changeRecordId: change.id,
                    evidenceId: old.id,
                    side: 'old',
                })
                .returning()
                .then((rows) => requiredDatabaseValue(rows[0]));
        const newIds = new Set<string>();
        for (const citation of item.newCitations) {
            if (citation.pageId !== item.pageId) invalid();
            newIds.add(await saveEvidence(citation));
        }
        for (const evidenceId of newIds)
            await tx
                .insert(dbChangeEvidence)
                .values({
                    userId: run.userId,
                    changeRecordId: change.id,
                    evidenceId: evidenceId,
                    side: 'new',
                })
                .returning()
                .then((rows) => requiredDatabaseValue(rows[0]));
    }
}
