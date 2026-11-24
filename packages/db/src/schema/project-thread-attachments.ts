import { sql } from 'drizzle-orm';
import {
    check,
    index,
    integer,
    pgTable,
    text,
    timestamp,
    uniqueIndex,
    uuid,
} from 'drizzle-orm/pg-core';
import type { ReportAttachmentFormat } from '@scova/models';
import { projectThreads } from './project-conversations.ts';

export const projectThreadAttachments = pgTable(
    'project_thread_attachments',
    {
        id: uuid('id').primaryKey(),
        // Preserve the object locator after project removal so cleanup can retry independently.
        threadId: uuid('thread_id').references(() => projectThreads.id, { onDelete: 'set null' }),
        filename: text('filename').notNull(),
        format: text('format').$type<ReportAttachmentFormat>().notNull(),
        byteLength: integer('byte_length').notNull(),
        digest: text('digest').notNull(),
        storageKey: text('storage_key').notNull(),
        excerpt: text('excerpt'),
        readyAt: timestamp('ready_at', { withTimezone: true, mode: 'date' }),
        updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
    },
    (table) => [
        uniqueIndex('project_thread_attachments_content_key').on(table.threadId, table.digest),
        index('project_thread_attachments_cleanup_idx')
            .on(table.updatedAt)
            .where(sql`${table.threadId} is null or ${table.readyAt} is null`),
        check(
            'project_thread_attachments_size_check',
            sql`${table.byteLength} between 1 and 262144`,
        ),
        check(
            'project_thread_attachments_format_check',
            sql`${table.format} in ('csv', 'txt', 'pdf')`,
        ),
        check(
            'project_thread_attachments_excerpt_check',
            sql`char_length(${table.excerpt}) <= 1200`,
        ),
    ],
);

export type ProjectThreadAttachmentRow = typeof projectThreadAttachments.$inferSelect;
