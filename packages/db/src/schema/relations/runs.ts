import { relations } from 'drizzle-orm';
import { baselines, runs } from '../runs.ts';
import { users } from '../identity.ts';
import { tasks, scheduleOccurrences, taskVersions } from '../tasks.ts';
import { toolCalls, runEvents, outbox } from '../ledger.ts';
import { runSources } from '../sources.ts';
import { reports } from '../reports.ts';
import { notifications } from '../notifications.ts';
import { reportQuestions } from '../questions.ts';

export const baselinesRelations = relations(baselines, ({ one }) => ({
    owner: one(users, {
        relationName: 'User_Baseline',
        fields: [baselines.userId],
        references: [users.id],
    }),
    task: one(tasks, {
        relationName: 'Baseline_task',
        fields: [baselines.userId, baselines.taskId],
        references: [tasks.userId, tasks.id],
    }),
    completeRun: one(runs, {
        relationName: 'Baseline_completeRun',
        fields: [
            baselines.userId,
            baselines.taskId,
            baselines.comparisonScopeHash,
            baselines.completeRunId,
        ],
        references: [runs.userId, runs.taskId, runs.comparisonScopeHash, runs.id],
    }),
}));

export const runsRelations = relations(runs, ({ one, many }) => ({
    owner: one(users, { relationName: 'User_Run', fields: [runs.userId], references: [users.id] }),
    scheduleLinks: many(scheduleOccurrences, { relationName: 'ScheduleOccurrence_run' }),
    baselinePointers: many(baselines, { relationName: 'Baseline_completeRun' }),
    version: one(taskVersions, {
        relationName: 'Run_version',
        fields: [runs.userId, runs.taskId, runs.taskVersionId],
        references: [taskVersions.userId, taskVersions.taskId, taskVersions.id],
    }),
    task: one(tasks, {
        relationName: 'Run_task',
        fields: [runs.userId, runs.taskId],
        references: [tasks.userId, tasks.id],
    }),
    occurrence: one(scheduleOccurrences, {
        relationName: 'Run_occurrence',
        fields: [runs.userId, runs.taskId, runs.occurrenceId],
        references: [
            scheduleOccurrences.userId,
            scheduleOccurrences.taskId,
            scheduleOccurrences.id,
        ],
    }),
    parent: one(runs, {
        relationName: 'Run_parent',
        fields: [runs.userId, runs.taskId, runs.parentRunId],
        references: [runs.userId, runs.taskId, runs.id],
    }),
    children: many(runs, { relationName: 'Run_parent' }),
    baseline: one(runs, {
        relationName: 'Run_baseline',
        fields: [runs.userId, runs.taskId, runs.comparisonScopeHash, runs.baselineRunId],
        references: [runs.userId, runs.taskId, runs.comparisonScopeHash, runs.id],
    }),
    comparisons: many(runs, { relationName: 'Run_baseline' }),
    toolCalls: many(toolCalls, { relationName: 'ToolCall_run' }),
    events: many(runEvents, { relationName: 'RunEvent_run' }),
    sources: many(runSources, { relationName: 'RunSource_run' }),
    reports: many(reports, { relationName: 'Report_run' }),
    referencingReports: many(reports, { relationName: 'Report_baseline' }),
    notifications: many(notifications, { relationName: 'Notification_run' }),
    questions: many(reportQuestions, { relationName: 'ReportQuestion_followupRun' }),
    outbox: many(outbox, { relationName: 'Outbox_run' }),
}));
