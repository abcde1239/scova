import { randomUUID } from 'node:crypto';
import { REPORT_EXPORT_MAX_BYTES } from '@scova/models';
import { sql } from 'drizzle-orm';
import {
    check,
    foreignKey,
    index,
    integer,
    pgTable,
    text,
    timestamp,
    uniqueIndex,
    uuid,
} from 'drizzle-orm/pg-core';
import { reports } from './reports.ts';

// Small, private text assets only, never an object bucket or a client-supplied locator.
export const reportExports = pgTable(
    'report_exports',
    {
        id: uuid('id').primaryKey().$defaultFn(randomUUID),
        userId: uuid('user_id').notNull(),
        reportId: uuid('report_id').notNull(),
        rendererVersion: integer('renderer_version').notNull(),
        format: text('format', { enum: ['markdown', 'json'] })
            .notNull()
            .default('markdown'),
        // Keep the original payload column so stored Markdown survives the format migration.
        content: text('markdown').notNull(),
        byteLength: integer('byte_length').notNull(),
        sha256: text('sha256').notNull(),
        createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
        expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    },
    (table) => [
        uniqueIndex('report_exports_owner_report_format_version').on(
            table.userId,
            table.reportId,
            table.format,
            table.rendererVersion,
        ),
        check('report_exports_format_valid', sql.raw("format IN ('markdown', 'json')")),
        index('report_exports_expires_at_id_idx').on(table.expiresAt, table.id),
        foreignKey({
            name: 'report_exports_owner_report_fkey',
            columns: [table.userId, table.reportId],
            foreignColumns: [reports.userId, reports.id],
        }).onDelete('cascade'),
        check(
            'report_exports_payload_valid',
            sql.raw(
                `byte_length BETWEEN 1 AND ${REPORT_EXPORT_MAX_BYTES} AND byte_length = octet_length(markdown) AND sha256 ~ '^[a-f0-9]{64}$'`,
            ),
        ),
        check(
            'report_exports_lifetime_valid',
            sql.raw('renderer_version > 0 AND expires_at > created_at'),
        ),
    ],
);
