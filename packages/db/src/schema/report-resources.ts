import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
    check,
    customType,
    foreignKey,
    integer,
    jsonb,
    primaryKey,
    pgTable,
    text,
    timestamp,
    uniqueIndex,
    uuid,
} from 'drizzle-orm/pg-core';
import {
    REPORT_ATTACHMENT_INLINE_MAX_BYTES,
    REPORT_ATTACHMENT_MAX_BYTES,
    REPORT_CHART_MAX_BYTES,
    type ReportAttachmentParseState,
    type ReportSourceHostRow,
} from '@scova/models';
import { reports } from './reports.ts';

const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });

// Keep the reservation after an attachment is deleted until bucket cleanup succeeds.
export const reportAttachmentObjects = pgTable(
    'report_attachment_objects',
    {
        id: uuid('id').notNull(),
        // Retain the owner key for cleanup after account removal.
        userId: uuid('user_id').notNull(),
        createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
    },
    (table) => [primaryKey({ columns: [table.userId, table.id] })],
);

// The owning report is also the persistent reference. Insertion and unlink-on-delete are atomic.
export const reportResources = pgTable(
    'report_resources',
    {
        id: uuid('id').primaryKey().$defaultFn(randomUUID),
        userId: uuid('user_id').notNull(),
        reportId: uuid('report_id').notNull(),
        reportVersion: timestamp('report_version', { withTimezone: true, mode: 'date' }).notNull(),
        purpose: text('purpose', { enum: ['source-host-chart', 'reference-csv'] }).notNull(),
        version: integer('version').notNull(),
        contentKey: text('content_key').notNull(),
        content: bytea('content'),
        objectId: uuid('object_id'),
        objectSize: integer('object_size'),
        metadata: jsonb('metadata')
            .$type<
                | { rows: ReportSourceHostRow[] }
                | ({ filename: string } & ReportAttachmentParseState)
            >()
            .notNull(),
        createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
        expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
    },
    (table) => [
        foreignKey({
            name: 'report_resources_owner_report_fkey',
            columns: [table.userId, table.reportId],
            foreignColumns: [reports.userId, reports.id],
        }).onDelete('cascade'),
        uniqueIndex('report_resources_content_key').on(
            table.userId,
            table.reportId,
            table.purpose,
            table.reportVersion,
            table.version,
            table.contentKey,
        ),
        foreignKey({
            name: 'report_resources_owner_object_fkey',
            columns: [table.userId, table.objectId],
            foreignColumns: [reportAttachmentObjects.userId, reportAttachmentObjects.id],
        }),
        uniqueIndex('report_resources_owner_object_idx').on(table.userId, table.objectId),
        check(
            'report_resources_purpose_valid',
            sql`purpose IN ('source-host-chart', 'reference-csv')`,
        ),
        check(
            'report_resources_payload_valid',
            sql.raw(
                `content_key ~ '^[a-f0-9]{64}$' AND version > 0 AND (
                    (object_id IS NULL AND object_size IS NULL AND content IS NOT NULL AND octet_length(content) BETWEEN 1 AND CASE WHEN purpose = 'source-host-chart' THEN ${REPORT_CHART_MAX_BYTES} ELSE ${REPORT_ATTACHMENT_INLINE_MAX_BYTES} END)
                    OR (purpose = 'reference-csv' AND content IS NULL AND object_id IS NOT NULL AND object_size IS NOT NULL AND object_size BETWEEN ${REPORT_ATTACHMENT_INLINE_MAX_BYTES + 1} AND ${REPORT_ATTACHMENT_MAX_BYTES})
                )`,
            ),
        ),
        check(
            'report_resources_expiry_valid',
            sql`(purpose = 'source-host-chart' AND expires_at IS NOT NULL AND expires_at > created_at) OR (purpose = 'reference-csv' AND expires_at IS NULL)`,
        ),
    ],
);
