import { relations } from 'drizzle-orm';
import { inboxItems, notifications, workflowNotifications, feedback } from '../notifications.ts';
import { users } from '../identity.ts';
import { reports, claims } from '../reports.ts';
import { runs } from '../runs.ts';
import { tasks } from '../tasks.ts';
import { sources } from '../sources.ts';
import { workflowRuns } from '../workflows.ts';

export const inboxItemsRelations = relations(inboxItems, ({ one }) => ({
    owner: one(users, {
        relationName: 'User_InboxItem',
        fields: [inboxItems.userId],
        references: [users.id],
    }),
    report: one(reports, {
        relationName: 'InboxItem_report',
        fields: [inboxItems.userId, inboxItems.reportId],
        references: [reports.userId, reports.id],
    }),
}));

export const notificationsRelations = relations(notifications, ({ one }) => ({
    owner: one(users, {
        relationName: 'User_Notification',
        fields: [notifications.userId],
        references: [users.id],
    }),
    run: one(runs, {
        relationName: 'Notification_run',
        fields: [notifications.userId, notifications.runId],
        references: [runs.userId, runs.id],
    }),
    report: one(reports, {
        relationName: 'Notification_report',
        fields: [notifications.userId, notifications.runId, notifications.reportId],
        references: [reports.userId, reports.runId, reports.id],
    }),
}));

export const workflowNotificationsRelations = relations(workflowNotifications, ({ one }) => ({
    run: one(workflowRuns, {
        fields: [workflowNotifications.userId, workflowNotifications.workflowRunId],
        references: [workflowRuns.userId, workflowRuns.id],
    }),
}));

export const feedbackRelations = relations(feedback, ({ one }) => ({
    owner: one(users, {
        relationName: 'User_Feedback',
        fields: [feedback.userId],
        references: [users.id],
    }),
    task: one(tasks, {
        relationName: 'Feedback_task',
        fields: [feedback.userId, feedback.taskId],
        references: [tasks.userId, tasks.id],
    }),
    source: one(sources, {
        relationName: 'Feedback_source',
        fields: [feedback.userId, feedback.sourceId],
        references: [sources.userId, sources.id],
    }),
    claim: one(claims, {
        relationName: 'Feedback_claim',
        fields: [feedback.userId, feedback.taskId, feedback.claimId],
        references: [claims.userId, claims.taskId, claims.id],
    }),
}));
