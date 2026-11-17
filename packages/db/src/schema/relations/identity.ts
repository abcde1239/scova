import { relations } from 'drizzle-orm';
import { users, sessions } from '../identity.ts';
import { tasks, taskVersions, scheduleOccurrences } from '../tasks.ts';
import { baselines, runs } from '../runs.ts';
import { toolCalls, runEvents, outbox, idempotencyRecords } from '../ledger.ts';
import { sources, sourceSnapshots, runSources, evidence } from '../sources.ts';
import { reports, claims, claimEvidence } from '../reports.ts';
import { changeRecords, changeEvidence } from '../changes.ts';
import { inboxItems, notifications, feedback } from '../notifications.ts';
import { bookmarks, notes } from '../library.ts';
import { reportQuestions, questionEvidence } from '../questions.ts';

export const usersRelations = relations(users, ({ many }) => ({
    sessionRows: many(sessions, { relationName: 'User_Session' }),
    taskRows: many(tasks, { relationName: 'User_Task' }),
    taskVersionRows: many(taskVersions, { relationName: 'User_TaskVersion' }),
    scheduleOccurrenceRows: many(scheduleOccurrences, { relationName: 'User_ScheduleOccurrence' }),
    baselineRows: many(baselines, { relationName: 'User_Baseline' }),
    runRows: many(runs, { relationName: 'User_Run' }),
    toolCallRows: many(toolCalls, { relationName: 'User_ToolCall' }),
    runEventRows: many(runEvents, { relationName: 'User_RunEvent' }),
    outboxRows: many(outbox, { relationName: 'User_Outbox' }),
    idempotencyRecordRows: many(idempotencyRecords, { relationName: 'User_IdempotencyRecord' }),
    sourceRows: many(sources, { relationName: 'User_Source' }),
    sourceSnapshotRows: many(sourceSnapshots, { relationName: 'User_SourceSnapshot' }),
    runSourceRows: many(runSources, { relationName: 'User_RunSource' }),
    evidenceRows: many(evidence, { relationName: 'User_Evidence' }),
    reportRows: many(reports, { relationName: 'User_Report' }),
    claimRows: many(claims, { relationName: 'User_Claim' }),
    claimEvidenceRows: many(claimEvidence, { relationName: 'User_ClaimEvidence' }),
    changeRecordRows: many(changeRecords, { relationName: 'User_ChangeRecord' }),
    changeEvidenceRows: many(changeEvidence, { relationName: 'User_ChangeEvidence' }),
    inboxItemRows: many(inboxItems, { relationName: 'User_InboxItem' }),
    notificationRows: many(notifications, { relationName: 'User_Notification' }),
    feedbackRows: many(feedback, { relationName: 'User_Feedback' }),
    bookmarkRows: many(bookmarks, { relationName: 'User_Bookmark' }),
    noteRows: many(notes, { relationName: 'User_Note' }),
    reportQuestionRows: many(reportQuestions, { relationName: 'User_ReportQuestion' }),
    questionEvidenceRows: many(questionEvidence, { relationName: 'User_QuestionEvidence' }),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
    owner: one(users, {
        relationName: 'User_Session',
        fields: [sessions.userId],
        references: [users.id],
    }),
}));
