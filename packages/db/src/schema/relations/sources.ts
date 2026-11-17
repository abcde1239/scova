import { relations } from 'drizzle-orm';
import { sources, sourceSnapshots, runSources, evidence } from '../sources.ts';
import { users } from '../identity.ts';
import { changeRecords, changeEvidence } from '../changes.ts';
import { feedback } from '../notifications.ts';
import { bookmarks, notes } from '../library.ts';
import { runs } from '../runs.ts';
import { claimEvidence } from '../reports.ts';
import { questionEvidence } from '../questions.ts';

export const sourcesRelations = relations(sources, ({ one, many }) => ({
    owner: one(users, {
        relationName: 'User_Source',
        fields: [sources.userId],
        references: [users.id],
    }),
    snapshots: many(sourceSnapshots, { relationName: 'SourceSnapshot_source' }),
    observations: many(runSources, { relationName: 'RunSource_source' }),
    changes: many(changeRecords, { relationName: 'ChangeRecord_source' }),
    feedback: many(feedback, { relationName: 'Feedback_source' }),
    bookmarks: many(bookmarks, { relationName: 'Bookmark_source' }),
    notes: many(notes, { relationName: 'Note_source' }),
}));

export const sourceSnapshotsRelations = relations(sourceSnapshots, ({ one, many }) => ({
    owner: one(users, {
        relationName: 'User_SourceSnapshot',
        fields: [sourceSnapshots.userId],
        references: [users.id],
    }),
    source: one(sources, {
        relationName: 'SourceSnapshot_source',
        fields: [sourceSnapshots.userId, sourceSnapshots.sourceId],
        references: [sources.userId, sources.id],
    }),
    observations: many(runSources, { relationName: 'RunSource_snapshot' }),
    oldChanges: many(changeRecords, { relationName: 'ChangeRecord_oldSnapshot' }),
    newChanges: many(changeRecords, { relationName: 'ChangeRecord_newSnapshot' }),
}));

export const runSourcesRelations = relations(runSources, ({ one, many }) => ({
    owner: one(users, {
        relationName: 'User_RunSource',
        fields: [runSources.userId],
        references: [users.id],
    }),
    run: one(runs, {
        relationName: 'RunSource_run',
        fields: [runSources.userId, runSources.runId],
        references: [runs.userId, runs.id],
    }),
    source: one(sources, {
        relationName: 'RunSource_source',
        fields: [runSources.userId, runSources.sourceId],
        references: [sources.userId, sources.id],
    }),
    snapshot: one(sourceSnapshots, {
        relationName: 'RunSource_snapshot',
        fields: [runSources.userId, runSources.sourceId, runSources.snapshotId],
        references: [sourceSnapshots.userId, sourceSnapshots.sourceId, sourceSnapshots.id],
    }),
    evidence: many(evidence, { relationName: 'Evidence_observation' }),
}));

export const evidenceRelations = relations(evidence, ({ one, many }) => ({
    owner: one(users, {
        relationName: 'User_Evidence',
        fields: [evidence.userId],
        references: [users.id],
    }),
    observation: one(runSources, {
        relationName: 'Evidence_observation',
        fields: [evidence.userId, evidence.runId, evidence.snapshotId],
        references: [runSources.userId, runSources.runId, runSources.snapshotId],
    }),
    claims: many(claimEvidence, { relationName: 'ClaimEvidence_evidence' }),
    changes: many(changeEvidence, { relationName: 'ChangeEvidence_evidence' }),
    questions: many(questionEvidence, { relationName: 'QuestionEvidence_evidence' }),
}));
