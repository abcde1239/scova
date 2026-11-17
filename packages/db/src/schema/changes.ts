import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
    pgTable,
    uuid,
    text,
    uniqueIndex,
    foreignKey,
    check,
    type PgTableExtraConfigValue,
} from 'drizzle-orm/pg-core';
import { changeKindEnum, evidenceSideEnum } from './enums.ts';
import { users } from './identity.ts';
import { reports } from './reports.ts';
import { sources, sourceSnapshots, evidence } from './sources.ts';

export const changeRecords = pgTable(
    'change_records',
    {
        id: uuid('id').notNull().primaryKey().$defaultFn(randomUUID),
        userId: uuid('user_id').notNull(),
        reportId: uuid('report_id').notNull(),
        sourceId: uuid('source_id').notNull(),
        kind: changeKindEnum('kind').notNull(),
        oldSourceId: uuid('old_source_id'),
        oldSnapshotId: uuid('old_snapshot_id'),
        newSnapshotId: uuid('new_snapshot_id'),
        factKey: text('fact_key').notNull(),
        oldValue: text('old_value'),
        newValue: text('new_value'),
        importance: text('importance').notNull(),
        reason: text('reason').notNull(),
    },
    (table): PgTableExtraConfigValue[] => [
        uniqueIndex('change_records_user_id_id_key').on(table.userId, table.id),
        foreignKey({
            name: 'change_records_user_id_fkey',
            columns: [table.userId],
            foreignColumns: [users.id],
        })
            .onDelete('cascade')
            .onUpdate('no action'),
        foreignKey({
            name: 'change_records_user_id_report_id_fkey',
            columns: [table.userId, table.reportId],
            foreignColumns: [reports.userId, reports.id],
        })
            .onDelete('no action')
            .onUpdate('no action'),
        foreignKey({
            name: 'change_records_user_id_source_id_fkey',
            columns: [table.userId, table.sourceId],
            foreignColumns: [sources.userId, sources.id],
        })
            .onDelete('no action')
            .onUpdate('no action'),
        foreignKey({
            name: 'change_records_user_id_old_source_id_old_snapshot_id_fkey',
            columns: [table.userId, table.oldSourceId, table.oldSnapshotId],
            foreignColumns: [sourceSnapshots.userId, sourceSnapshots.sourceId, sourceSnapshots.id],
        })
            .onDelete('no action')
            .onUpdate('no action'),
        foreignKey({
            name: 'change_records_user_id_source_id_new_snapshot_id_fkey',
            columns: [table.userId, table.sourceId, table.newSnapshotId],
            foreignColumns: [sourceSnapshots.userId, sourceSnapshots.sourceId, sourceSnapshots.id],
        })
            .onDelete('no action')
            .onUpdate('no action'),
        check(
            'change_old_snapshot_pair',
            sql.raw('(old_source_id IS NULL) = (old_snapshot_id IS NULL)'),
        ),
        check(
            'change_values_valid',
            sql.raw(
                "\r\n  (kind <> 'changed' OR (old_snapshot_id IS NOT NULL AND new_snapshot_id IS NOT NULL AND old_value IS NOT NULL AND new_value IS NOT NULL)) AND\r\n  (kind <> 'new' OR (old_source_id IS NULL AND old_snapshot_id IS NULL AND old_value IS NULL AND new_snapshot_id IS NOT NULL AND new_value IS NOT NULL))\r\n",
            ),
        ),
    ],
);

export type ChangeRecord = typeof changeRecords.$inferSelect;

export const changeEvidence = pgTable(
    'change_evidence',
    {
        id: uuid('id').notNull().primaryKey().$defaultFn(randomUUID),
        userId: uuid('user_id').notNull(),
        changeRecordId: uuid('change_record_id').notNull(),
        evidenceId: uuid('evidence_id').notNull(),
        side: evidenceSideEnum('side').notNull(),
    },
    (table): PgTableExtraConfigValue[] => [
        uniqueIndex('change_evidence_user_id_id_key').on(table.userId, table.id),
        uniqueIndex('change_evidence_change_record_id_evidence_id_side_key').on(
            table.changeRecordId,
            table.evidenceId,
            table.side,
        ),
        foreignKey({
            name: 'change_evidence_user_id_fkey',
            columns: [table.userId],
            foreignColumns: [users.id],
        })
            .onDelete('cascade')
            .onUpdate('no action'),
        foreignKey({
            name: 'change_evidence_user_id_change_record_id_fkey',
            columns: [table.userId, table.changeRecordId],
            foreignColumns: [changeRecords.userId, changeRecords.id],
        })
            .onDelete('no action')
            .onUpdate('no action'),
        foreignKey({
            name: 'change_evidence_user_id_evidence_id_fkey',
            columns: [table.userId, table.evidenceId],
            foreignColumns: [evidence.userId, evidence.id],
        })
            .onDelete('no action')
            .onUpdate('no action'),
    ],
);

export type ChangeEvidence = typeof changeEvidence.$inferSelect;
