import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
    pgTable,
    uuid,
    boolean,
    timestamp,
    index,
    uniqueIndex,
    foreignKey,
    check,
    type PgTableExtraConfigValue,
} from 'drizzle-orm/pg-core';
import { users } from './identity.ts';
import { reports, claims } from './reports.ts';
import { notificationKindEnum, feedbackKindEnum } from './enums.ts';
import { runs } from './runs.ts';
import { tasks } from './tasks.ts';
import { sources } from './sources.ts';

export const inboxItems = pgTable(
    'inbox_items',
    {
        id: uuid('id').notNull().primaryKey().$defaultFn(randomUUID),
        userId: uuid('user_id').notNull(),
        reportId: uuid('report_id').notNull(),
        readAt: timestamp('read_at', { withTimezone: true, precision: 6, mode: 'date' }),
        createdAt: timestamp('created_at', { withTimezone: true, precision: 6, mode: 'date' })
            .notNull()
            .defaultNow(),
    },
    (table): PgTableExtraConfigValue[] => [
        index('inbox_items_user_id_read_at_created_at_idx').on(
            table.userId,
            table.readAt,
            table.createdAt,
        ),
        uniqueIndex('inbox_items_user_id_id_key').on(table.userId, table.id),
        uniqueIndex('inbox_items_user_id_report_id_key').on(table.userId, table.reportId),
        index('inbox_history_page').on(table.userId, table.createdAt.desc(), table.id.desc()),
        foreignKey({
            name: 'inbox_items_user_id_fkey',
            columns: [table.userId],
            foreignColumns: [users.id],
        })
            .onDelete('cascade')
            .onUpdate('no action'),
        foreignKey({
            name: 'inbox_items_user_id_report_id_fkey',
            columns: [table.userId, table.reportId],
            foreignColumns: [reports.userId, reports.id],
        })
            .onDelete('no action')
            .onUpdate('no action'),
    ],
);

export type InboxItem = typeof inboxItems.$inferSelect;

export const notifications = pgTable(
    'notifications',
    {
        id: uuid('id').notNull().primaryKey().$defaultFn(randomUUID),
        userId: uuid('user_id').notNull(),
        runId: uuid('run_id').notNull(),
        reportId: uuid('report_id'),
        kind: notificationKindEnum('kind').notNull(),
        readAt: timestamp('read_at', { withTimezone: true, precision: 6, mode: 'date' }),
        createdAt: timestamp('created_at', { withTimezone: true, precision: 6, mode: 'date' })
            .notNull()
            .defaultNow(),
    },
    (table): PgTableExtraConfigValue[] => [
        uniqueIndex('notifications_user_id_id_key').on(table.userId, table.id),
        uniqueIndex('notifications_user_id_run_id_kind_key').on(
            table.userId,
            table.runId,
            table.kind,
        ),
        foreignKey({
            name: 'notifications_user_id_fkey',
            columns: [table.userId],
            foreignColumns: [users.id],
        })
            .onDelete('cascade')
            .onUpdate('no action'),
        foreignKey({
            name: 'notifications_user_id_run_id_fkey',
            columns: [table.userId, table.runId],
            foreignColumns: [runs.userId, runs.id],
        })
            .onDelete('no action')
            .onUpdate('no action'),
        foreignKey({
            name: 'notifications_user_id_run_id_report_id_fkey',
            columns: [table.userId, table.runId, table.reportId],
            foreignColumns: [reports.userId, reports.runId, reports.id],
        })
            .onDelete('no action')
            .onUpdate('no action'),
        check(
            'notification_report_required',
            sql.raw("kind = 'run_issue' OR report_id IS NOT NULL"),
        ),
    ],
);

export type Notification = typeof notifications.$inferSelect;

export const feedback = pgTable(
    'feedback',
    {
        id: uuid('id').notNull().primaryKey().$defaultFn(randomUUID),
        userId: uuid('user_id').notNull(),
        taskId: uuid('task_id').notNull(),
        sourceId: uuid('source_id'),
        claimId: uuid('claim_id'),
        kind: feedbackKindEnum('kind').notNull(),
        active: boolean('active').notNull().default(true),
        updatedAt: timestamp('updated_at', { withTimezone: true, precision: 6, mode: 'date' })
            .notNull()
            .$defaultFn(() => new Date())
            .$onUpdate(() => new Date()),
    },
    (table): PgTableExtraConfigValue[] => [
        uniqueIndex('feedback_user_id_id_key').on(table.userId, table.id),
        uniqueIndex('feedback_source_once')
            .on(table.userId, table.taskId, table.sourceId)
            .where(sql.raw('source_id IS NOT NULL')),
        uniqueIndex('feedback_claim_once')
            .on(table.userId, table.taskId, table.claimId)
            .where(sql.raw('claim_id IS NOT NULL')),
        foreignKey({
            name: 'feedback_user_id_fkey',
            columns: [table.userId],
            foreignColumns: [users.id],
        })
            .onDelete('cascade')
            .onUpdate('no action'),
        foreignKey({
            name: 'feedback_user_id_task_id_fkey',
            columns: [table.userId, table.taskId],
            foreignColumns: [tasks.userId, tasks.id],
        })
            .onDelete('no action')
            .onUpdate('no action'),
        foreignKey({
            name: 'feedback_user_id_source_id_fkey',
            columns: [table.userId, table.sourceId],
            foreignColumns: [sources.userId, sources.id],
        })
            .onDelete('no action')
            .onUpdate('no action'),
        foreignKey({
            name: 'feedback_user_id_task_id_claim_id_fkey',
            columns: [table.userId, table.taskId, table.claimId],
            foreignColumns: [claims.userId, claims.taskId, claims.id],
        })
            .onDelete('no action')
            .onUpdate('no action'),
        check('feedback_exactly_one_target', sql.raw('num_nonnulls(source_id, claim_id) = 1')),
    ],
);

export type Feedback = typeof feedback.$inferSelect;
