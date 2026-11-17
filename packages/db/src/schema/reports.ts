import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
    pgTable,
    uuid,
    text,
    integer,
    timestamp,
    jsonb,
    index,
    uniqueIndex,
    foreignKey,
    check,
    type PgTableExtraConfigValue,
} from 'drizzle-orm/pg-core';
import {
    outputFormatEnum,
    completenessEnum,
    type JsonValue,
    claimKindEnum,
    evidenceRelationEnum,
} from './enums.ts';
import { users } from './identity.ts';
import { runs } from './runs.ts';
import { evidence } from './sources.ts';

export const reports = pgTable(
    'reports',
    {
        id: uuid('id').notNull().primaryKey().$defaultFn(randomUUID),
        userId: uuid('user_id').notNull(),
        runId: uuid('run_id').notNull(),
        taskId: uuid('task_id').notNull(),
        taskVersionId: uuid('task_version_id').notNull(),
        baselineRunId: uuid('baseline_run_id'),
        schemaVersion: integer('schema_version').notNull().default(1),
        title: text('title').notNull(),
        summary: text('summary').notNull(),
        format: outputFormatEnum('format').notNull(),
        completeness: completenessEnum('completeness').notNull(),
        limitationsJson: jsonb('limitations_json').$type<JsonValue>().notNull().default([]),
        comparisonJson: jsonb('comparison_json').$type<JsonValue>(),
        feedbackEffectsJson: jsonb('feedback_effects_json')
            .$type<JsonValue>()
            .notNull()
            .default([]),
        publishedAt: timestamp('published_at', { withTimezone: true, precision: 6, mode: 'date' })
            .notNull()
            .defaultNow(),
    },
    (table): PgTableExtraConfigValue[] => [
        index('reports_user_id_published_at_idx').on(table.userId, table.publishedAt.desc()),
        uniqueIndex('reports_user_id_id_key').on(table.userId, table.id),
        uniqueIndex('reports_user_id_run_id_key').on(table.userId, table.runId),
        uniqueIndex('reports_user_id_task_id_id_key').on(table.userId, table.taskId, table.id),
        uniqueIndex('reports_user_id_run_id_id_key').on(table.userId, table.runId, table.id),
        index('reports_history_page').on(table.userId, table.publishedAt.desc(), table.id.desc()),
        index('reports_task_history_page').on(
            table.userId,
            table.taskId,
            table.publishedAt.desc(),
            table.id.desc(),
        ),
        foreignKey({
            name: 'reports_user_id_fkey',
            columns: [table.userId],
            foreignColumns: [users.id],
        })
            .onDelete('cascade')
            .onUpdate('no action'),
        foreignKey({
            name: 'reports_user_id_run_id_task_id_task_version_id_fkey',
            columns: [table.userId, table.runId, table.taskId, table.taskVersionId],
            foreignColumns: [runs.userId, runs.id, runs.taskId, runs.taskVersionId],
        })
            .onDelete('no action')
            .onUpdate('no action'),
        foreignKey({
            name: 'reports_user_id_task_id_baseline_run_id_fkey',
            columns: [table.userId, table.taskId, table.baselineRunId],
            foreignColumns: [runs.userId, runs.taskId, runs.id],
        })
            .onDelete('no action')
            .onUpdate('no action'),
        check(
            'report_schema_valid',
            sql.raw("schema_version = 1 AND jsonb_typeof(limitations_json) = 'array'"),
        ),
        check(
            'report_feedback_effects_valid',
            sql.raw("jsonb_typeof(feedback_effects_json) = 'array'"),
        ),
    ],
);

export type Report = typeof reports.$inferSelect;

export const claims = pgTable(
    'claims',
    {
        id: uuid('id').notNull().primaryKey().$defaultFn(randomUUID),
        userId: uuid('user_id').notNull(),
        taskId: uuid('task_id').notNull(),
        reportId: uuid('report_id').notNull(),
        kind: claimKindEnum('kind').notNull(),
        text: text('text').notNull(),
        confidenceLabel: text('confidence_label').notNull(),
        order: integer('order').notNull(),
    },
    (table): PgTableExtraConfigValue[] => [
        uniqueIndex('claims_user_id_id_key').on(table.userId, table.id),
        uniqueIndex('claims_user_id_task_id_id_key').on(table.userId, table.taskId, table.id),
        uniqueIndex('claims_report_id_order_key').on(table.reportId, table.order),
        foreignKey({
            name: 'claims_user_id_fkey',
            columns: [table.userId],
            foreignColumns: [users.id],
        })
            .onDelete('cascade')
            .onUpdate('no action'),
        foreignKey({
            name: 'claims_user_id_task_id_report_id_fkey',
            columns: [table.userId, table.taskId, table.reportId],
            foreignColumns: [reports.userId, reports.taskId, reports.id],
        })
            .onDelete('no action')
            .onUpdate('no action'),
        check('claim_order_valid', sql.raw('"order" >= 0 AND length(btrim(text)) > 0')),
    ],
);

export type Claim = typeof claims.$inferSelect;

export const claimEvidence = pgTable(
    'claim_evidence',
    {
        id: uuid('id').notNull().primaryKey().$defaultFn(randomUUID),
        userId: uuid('user_id').notNull(),
        claimId: uuid('claim_id').notNull(),
        evidenceId: uuid('evidence_id').notNull(),
        relation: evidenceRelationEnum('relation').notNull(),
    },
    (table): PgTableExtraConfigValue[] => [
        uniqueIndex('claim_evidence_user_id_id_key').on(table.userId, table.id),
        uniqueIndex('claim_evidence_claim_id_evidence_id_key').on(table.claimId, table.evidenceId),
        foreignKey({
            name: 'claim_evidence_user_id_fkey',
            columns: [table.userId],
            foreignColumns: [users.id],
        })
            .onDelete('cascade')
            .onUpdate('no action'),
        foreignKey({
            name: 'claim_evidence_user_id_claim_id_fkey',
            columns: [table.userId, table.claimId],
            foreignColumns: [claims.userId, claims.id],
        })
            .onDelete('no action')
            .onUpdate('no action'),
        foreignKey({
            name: 'claim_evidence_user_id_evidence_id_fkey',
            columns: [table.userId, table.evidenceId],
            foreignColumns: [evidence.userId, evidence.id],
        })
            .onDelete('no action')
            .onUpdate('no action'),
    ],
);

export type ClaimEvidence = typeof claimEvidence.$inferSelect;
