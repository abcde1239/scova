import { relations } from 'drizzle-orm';
import { changeRecords, changeEvidence } from '../changes.ts';
import { users } from '../identity.ts';
import { reports } from '../reports.ts';
import { sources, sourceSnapshots, evidence } from '../sources.ts';

export const changeRecordsRelations = relations(changeRecords, ({ one, many }) => ({
    owner: one(users, {
        relationName: 'User_ChangeRecord',
        fields: [changeRecords.userId],
        references: [users.id],
    }),
    report: one(reports, {
        relationName: 'ChangeRecord_report',
        fields: [changeRecords.userId, changeRecords.reportId],
        references: [reports.userId, reports.id],
    }),
    source: one(sources, {
        relationName: 'ChangeRecord_source',
        fields: [changeRecords.userId, changeRecords.sourceId],
        references: [sources.userId, sources.id],
    }),
    oldSnapshot: one(sourceSnapshots, {
        relationName: 'ChangeRecord_oldSnapshot',
        fields: [changeRecords.userId, changeRecords.oldSourceId, changeRecords.oldSnapshotId],
        references: [sourceSnapshots.userId, sourceSnapshots.sourceId, sourceSnapshots.id],
    }),
    newSnapshot: one(sourceSnapshots, {
        relationName: 'ChangeRecord_newSnapshot',
        fields: [changeRecords.userId, changeRecords.sourceId, changeRecords.newSnapshotId],
        references: [sourceSnapshots.userId, sourceSnapshots.sourceId, sourceSnapshots.id],
    }),
    citations: many(changeEvidence, { relationName: 'ChangeEvidence_change' }),
}));

export const changeEvidenceRelations = relations(changeEvidence, ({ one }) => ({
    owner: one(users, {
        relationName: 'User_ChangeEvidence',
        fields: [changeEvidence.userId],
        references: [users.id],
    }),
    change: one(changeRecords, {
        relationName: 'ChangeEvidence_change',
        fields: [changeEvidence.userId, changeEvidence.changeRecordId],
        references: [changeRecords.userId, changeRecords.id],
    }),
    evidence: one(evidence, {
        relationName: 'ChangeEvidence_evidence',
        fields: [changeEvidence.userId, changeEvidence.evidenceId],
        references: [evidence.userId, evidence.id],
    }),
}));
