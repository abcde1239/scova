import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
    check,
    customType,
    foreignKey,
    integer,
    jsonb,
    pgTable,
    text,
    timestamp,
    uniqueIndex,
    uuid,
} from 'drizzle-orm/pg-core';
import {
    REPORT_ATTACHMENT_MAX_BYTES,
    REPORT_CHART_MAX_BYTES,
    type ReportAttachmentParseState,
    type ReportSourceHostRow,
} from '@scova/models';
import { reports } from './reports.ts';

const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });

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
        content: bytea('content').notNull(),
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
        check(
            'report_resources_purpose_valid',
            sql`purpose IN ('source-host-chart', 'reference-csv')`,
        ),
        check(
            'report_resources_payload_valid',
            sql.raw(
                `octet_length(content) BETWEEN 1 AND CASE WHEN purpose = 'source-host-chart' THEN ${REPORT_CHART_MAX_BYTES} ELSE ${REPORT_ATTACHMENT_MAX_BYTES} END AND content_key ~ '^[a-f0-9]{64}$' AND version > 0`,
            ),
        ),
        check(
            'report_resources_expiry_valid',
            sql`(purpose = 'source-host-chart' AND expires_at IS NOT NULL AND expires_at > created_at) OR (purpose = 'reference-csv' AND expires_at IS NULL)`,
        ),
    ],
);
