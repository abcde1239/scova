import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
    pgTable,
    uuid,
    text,
    integer,
    timestamp,
    index,
    uniqueIndex,
    foreignKey,
    check,
    type PgTableExtraConfigValue,
} from 'drizzle-orm/pg-core';
import { users } from './identity.ts';
import { sources } from './sources.ts';
import { reports } from './reports.ts';

export const bookmarks = pgTable(
    'bookmarks',
    {
        id: uuid('id').notNull().primaryKey().$defaultFn(randomUUID),
        userId: uuid('user_id').notNull(),
        sourceId: uuid('source_id').notNull(),
        createdAt: timestamp('created_at', { withTimezone: true, precision: 6, mode: 'date' })
            .notNull()
            .defaultNow(),
    },
    (table): PgTableExtraConfigValue[] => [
        uniqueIndex('bookmarks_user_id_id_key').on(table.userId, table.id),
        uniqueIndex('bookmarks_user_id_source_id_key').on(table.userId, table.sourceId),
        index('bookmarks_library_page').on(table.userId, table.createdAt.desc(), table.id.desc()),
        foreignKey({
            name: 'bookmarks_user_id_fkey',
            columns: [table.userId],
            foreignColumns: [users.id],
        })
            .onDelete('cascade')
            .onUpdate('no action'),
        foreignKey({
            name: 'bookmarks_user_id_source_id_fkey',
            columns: [table.userId, table.sourceId],
            foreignColumns: [sources.userId, sources.id],
        })
            .onDelete('no action')
            .onUpdate('no action'),
    ],
);

export type Bookmark = typeof bookmarks.$inferSelect;

export const notes = pgTable(
    'notes',
    {
        id: uuid('id').notNull().primaryKey().$defaultFn(randomUUID),
        userId: uuid('user_id').notNull(),
        sourceId: uuid('source_id'),
        reportId: uuid('report_id'),
        body: text('body').notNull(),
        revision: integer('revision').notNull().default(1),
        createdAt: timestamp('created_at', { withTimezone: true, precision: 6, mode: 'date' })
            .notNull()
            .defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true, precision: 6, mode: 'date' })
            .notNull()
            .$defaultFn(() => new Date())
            .$onUpdate(() => new Date()),
    },
    (table): PgTableExtraConfigValue[] => [
        uniqueIndex('notes_user_id_id_key').on(table.userId, table.id),
        index('notes_library_page').on(table.userId, table.updatedAt.desc(), table.id.desc()),
        index('notes_library_fts').using('GIN', sql.raw("to_tsvector('simple'::regconfig, body)")),
        foreignKey({
            name: 'notes_user_id_fkey',
            columns: [table.userId],
            foreignColumns: [users.id],
        })
            .onDelete('cascade')
            .onUpdate('no action'),
        foreignKey({
            name: 'notes_user_id_source_id_fkey',
            columns: [table.userId, table.sourceId],
            foreignColumns: [sources.userId, sources.id],
        })
            .onDelete('no action')
            .onUpdate('no action'),
        foreignKey({
            name: 'notes_user_id_report_id_fkey',
            columns: [table.userId, table.reportId],
            foreignColumns: [reports.userId, reports.id],
        })
            .onDelete('no action')
            .onUpdate('no action'),
        check('note_exactly_one_target', sql.raw('num_nonnulls(source_id, report_id) = 1')),
        check('note_revision_positive', sql.raw('revision >= 1')),
    ],
);

export type Note = typeof notes.$inferSelect;
