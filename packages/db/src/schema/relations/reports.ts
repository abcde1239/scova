import { relations } from 'drizzle-orm';
import { reports, claims, claimEvidence } from '../reports.ts';
import { users } from '../identity.ts';
import { runs } from '../runs.ts';
import { changeRecords } from '../changes.ts';
import { inboxItems, notifications, feedback } from '../notifications.ts';
import { notes } from '../library.ts';
import { reportQuestions } from '../questions.ts';
import { evidence } from '../sources.ts';

export const reportsRelations = relations(reports, ({ one, many }) => ({
    owner: one(users, {
        relationName: 'User_Report',
        fields: [reports.userId],
        references: [users.id],
    }),
    run: one(runs, {
        relationName: 'Report_run',
        fields: [reports.userId, reports.runId, reports.taskId, reports.taskVersionId],
        references: [runs.userId, runs.id, runs.taskId, runs.taskVersionId],
    }),
    baseline: one(runs, {
        relationName: 'Report_baseline',
        fields: [reports.userId, reports.taskId, reports.baselineRunId],
        references: [runs.userId, runs.taskId, runs.id],
    }),
    claims: many(claims, { relationName: 'Claim_report' }),
    changes: many(changeRecords, { relationName: 'ChangeRecord_report' }),
    inboxItems: many(inboxItems, { relationName: 'InboxItem_report' }),
    notifications: many(notifications, { relationName: 'Notification_report' }),
    notes: many(notes, { relationName: 'Note_report' }),
    questions: many(reportQuestions, { relationName: 'ReportQuestion_report' }),
}));

export const claimsRelations = relations(claims, ({ one, many }) => ({
    owner: one(users, {
        relationName: 'User_Claim',
        fields: [claims.userId],
        references: [users.id],
    }),
    report: one(reports, {
        relationName: 'Claim_report',
        fields: [claims.userId, claims.taskId, claims.reportId],
        references: [reports.userId, reports.taskId, reports.id],
    }),
    citations: many(claimEvidence, { relationName: 'ClaimEvidence_claim' }),
    feedback: many(feedback, { relationName: 'Feedback_claim' }),
}));

export const claimEvidenceRelations = relations(claimEvidence, ({ one }) => ({
    owner: one(users, {
        relationName: 'User_ClaimEvidence',
        fields: [claimEvidence.userId],
        references: [users.id],
    }),
    claim: one(claims, {
        relationName: 'ClaimEvidence_claim',
        fields: [claimEvidence.userId, claimEvidence.claimId],
        references: [claims.userId, claims.id],
    }),
    evidence: one(evidence, {
        relationName: 'ClaimEvidence_evidence',
        fields: [claimEvidence.userId, claimEvidence.evidenceId],
        references: [evidence.userId, evidence.id],
    }),
}));
