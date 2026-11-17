import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
    pgTable,
    uuid,
    text,
    integer,
    char,
    timestamp,
    jsonb,
    index,
    uniqueIndex,
    foreignKey,
    check,
    type PgTableExtraConfigValue,
} from 'drizzle-orm/pg-core';
import { taskStatusEnum, type JsonValue, occurrenceStatusEnum } from './enums.ts';
import { users } from './identity.ts';
import { runs } from './runs.ts';

export const tasks = pgTable(
    'tasks',
    {
        id: uuid('id').notNull().primaryKey().$defaultFn(randomUUID),
        userId: uuid('user_id').notNull(),
        title: text('title').notNull(),
        status: taskStatusEnum('status').notNull().default('active'),
        revision: integer('revision').notNull().default(1),
        currentVersionId: uuid('current_version_id'),
        scheduleRevision: integer('schedule_revision').notNull().default(1),
        nextRunAt: timestamp('next_run_at', { withTimezone: true, precision: 6, mode: 'date' }),
        createdAt: timestamp('created_at', { withTimezone: true, precision: 6, mode: 'date' })
            .notNull()
            .defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true, precision: 6, mode: 'date' })
            .notNull()
            .$defaultFn(() => new Date())
            .$onUpdate(() => new Date()),
        archivedAt: timestamp('archived_at', { withTimezone: true, precision: 6, mode: 'date' }),
    },
    (table): PgTableExtraConfigValue[] => [
        index('tasks_user_id_status_updated_at_idx').on(
            table.userId,
            table.status,
            table.updatedAt,
        ),
        uniqueIndex('tasks_user_id_id_key').on(table.userId, table.id),
        index('tasks_due_active')
            .on(table.nextRunAt, table.id)
            .where(sql.raw('"status" = \'active\' AND "next_run_at" IS NOT NULL')),
        index('tasks_history_page').on(table.userId, table.updatedAt.desc(), table.id.desc()),
        foreignKey({
            name: 'tasks_user_id_fkey',
            columns: [table.userId],
            foreignColumns: [users.id],
        })
            .onDelete('cascade')
            .onUpdate('no action'),
        foreignKey({
            name: 'tasks_user_id_id_current_version_id_fkey',
            columns: [table.userId, table.id, table.currentVersionId],
            foreignColumns: [taskVersions.userId, taskVersions.taskId, taskVersions.id],
        })
            .onDelete('no action')
            .onUpdate('no action'),
        check('task_revision_positive', sql.raw('revision >= 1 AND schedule_revision >= 1')),
        check('task_title_nonempty', sql.raw('length(btrim(title)) > 0')),
    ],
);

export type Task = typeof tasks.$inferSelect;

export const taskVersions = pgTable(
    'task_versions',
    {
        id: uuid('id').notNull().primaryKey().$defaultFn(randomUUID),
        userId: uuid('user_id').notNull(),
        taskId: uuid('task_id').notNull(),
        version: integer('version').notNull(),
        inputText: text('input_text'),
        configSchemaVersion: integer('config_schema_version').notNull().default(1),
        configJson: jsonb('config_json').$type<JsonValue>().notNull(),
        comparisonScopeHash: char('comparison_scope_hash', { length: 64 }).notNull(),
        createdAt: timestamp('created_at', { withTimezone: true, precision: 6, mode: 'date' })
            .notNull()
            .defaultNow(),
    },
    (table): PgTableExtraConfigValue[] => [
        uniqueIndex('task_versions_user_id_id_key').on(table.userId, table.id),
        uniqueIndex('task_versions_user_id_task_id_version_key').on(
            table.userId,
            table.taskId,
            table.version,
        ),
        uniqueIndex('task_versions_user_id_task_id_id_key').on(
            table.userId,
            table.taskId,
            table.id,
        ),
        foreignKey({
            name: 'task_versions_user_id_fkey',
            columns: [table.userId],
            foreignColumns: [users.id],
        })
            .onDelete('cascade')
            .onUpdate('no action'),
        foreignKey({
            name: 'task_versions_user_id_task_id_fkey',
            columns: [table.userId, table.taskId],
            foreignColumns: [tasks.userId, tasks.id],
        })
            .onDelete('no action')
            .onUpdate('no action'),
        check(
            'task_version_valid',
            sql.raw(
                "version >= 1 AND config_schema_version = 1 AND comparison_scope_hash ~ '^[0-9a-f]{64}$' AND jsonb_typeof(config_json) = 'object'",
            ),
        ),
    ],
);

export type TaskVersion = typeof taskVersions.$inferSelect;

export const scheduleOccurrences = pgTable(
    'schedule_occurrences',
    {
        id: uuid('id').notNull().primaryKey().$defaultFn(randomUUID),
        userId: uuid('user_id').notNull(),
        taskId: uuid('task_id').notNull(),
        scheduleRevision: integer('schedule_revision').notNull(),
        scheduledAt: timestamp('scheduled_at', {
            withTimezone: true,
            precision: 6,
            mode: 'date',
        }).notNull(),
        status: occurrenceStatusEnum('status').notNull().default('created'),
        runId: uuid('run_id'),
        missedCount: integer('missed_count').notNull().default(0),
    },
    (table): PgTableExtraConfigValue[] => [
        uniqueIndex('schedule_occurrences_user_id_id_key').on(table.userId, table.id),
        uniqueIndex('schedule_occurrences_task_id_schedule_revision_scheduled_at_key').on(
            table.taskId,
            table.scheduleRevision,
            table.scheduledAt,
        ),
        uniqueIndex('schedule_occurrences_user_id_task_id_id_key').on(
            table.userId,
            table.taskId,
            table.id,
        ),
        foreignKey({
            name: 'schedule_occurrences_user_id_fkey',
            columns: [table.userId],
            foreignColumns: [users.id],
        })
            .onDelete('cascade')
            .onUpdate('no action'),
        foreignKey({
            name: 'schedule_occurrences_user_id_task_id_fkey',
            columns: [table.userId, table.taskId],
            foreignColumns: [tasks.userId, tasks.id],
        })
            .onDelete('no action')
            .onUpdate('no action'),
        foreignKey({
            name: 'schedule_occurrences_user_id_task_id_run_id_fkey',
            columns: [table.userId, table.taskId, table.runId],
            foreignColumns: [runs.userId, runs.taskId, runs.id],
        })
            .onDelete('no action')
            .onUpdate('no action'),
        check('occurrence_counters_valid', sql.raw('schedule_revision >= 1 AND missed_count >= 0')),
    ],
);

export type ScheduleOccurrence = typeof scheduleOccurrences.$inferSelect;
