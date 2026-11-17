import { relations } from 'drizzle-orm';
import { tasks, taskVersions, scheduleOccurrences } from '../tasks.ts';
import { users } from '../identity.ts';
import { baselines, runs } from '../runs.ts';
import { feedback } from '../notifications.ts';

export const tasksRelations = relations(tasks, ({ one, many }) => ({
    owner: one(users, {
        relationName: 'User_Task',
        fields: [tasks.userId],
        references: [users.id],
    }),
    versions: many(taskVersions, { relationName: 'TaskVersion_task' }),
    currentVersion: one(taskVersions, {
        relationName: 'Task_currentVersion',
        fields: [tasks.userId, tasks.id, tasks.currentVersionId],
        references: [taskVersions.userId, taskVersions.taskId, taskVersions.id],
    }),
    occurrences: many(scheduleOccurrences, { relationName: 'ScheduleOccurrence_task' }),
    baselines: many(baselines, { relationName: 'Baseline_task' }),
    runs: many(runs, { relationName: 'Run_task' }),
    feedback: many(feedback, { relationName: 'Feedback_task' }),
}));

export const taskVersionsRelations = relations(taskVersions, ({ one, many }) => ({
    owner: one(users, {
        relationName: 'User_TaskVersion',
        fields: [taskVersions.userId],
        references: [users.id],
    }),
    task: one(tasks, {
        relationName: 'TaskVersion_task',
        fields: [taskVersions.userId, taskVersions.taskId],
        references: [tasks.userId, tasks.id],
    }),
    currentForTasks: many(tasks, { relationName: 'Task_currentVersion' }),
    runs: many(runs, { relationName: 'Run_version' }),
}));

export const scheduleOccurrencesRelations = relations(scheduleOccurrences, ({ one, many }) => ({
    owner: one(users, {
        relationName: 'User_ScheduleOccurrence',
        fields: [scheduleOccurrences.userId],
        references: [users.id],
    }),
    task: one(tasks, {
        relationName: 'ScheduleOccurrence_task',
        fields: [scheduleOccurrences.userId, scheduleOccurrences.taskId],
        references: [tasks.userId, tasks.id],
    }),
    run: one(runs, {
        relationName: 'ScheduleOccurrence_run',
        fields: [scheduleOccurrences.userId, scheduleOccurrences.taskId, scheduleOccurrences.runId],
        references: [runs.userId, runs.taskId, runs.id],
    }),
    createdRuns: many(runs, { relationName: 'Run_occurrence' }),
}));
