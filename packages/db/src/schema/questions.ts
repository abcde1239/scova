import { randomUUID } from 'node:crypto';
import {
    pgTable,
    uuid,
    text,
    timestamp,
    jsonb,
    index,
    uniqueIndex,
    foreignKey,
    type PgTableExtraConfigValue,
} from 'drizzle-orm/pg-core';
import { type JsonValue } from './enums.ts';
import { users } from './identity.ts';
import { reports } from './reports.ts';
import { runs } from './runs.ts';
import { evidence } from './sources.ts';

export const reportQuestions = pgTable(
    'report_questions',
    {
        id: uuid('id').notNull().primaryKey().$defaultFn(randomUUID),
        userId: uuid('user_id').notNull(),
        reportId: uuid('report_id').notNull(),
        question: text('question').notNull(),
        answerJson: jsonb('answer_json').$type<JsonValue>(),
        followupRunId: uuid('followup_run_id'),
        revisionRunId: uuid('revision_run_id'),
        contextJson: jsonb('context_json').$type<JsonValue>(),
        createdAt: timestamp('created_at', { withTimezone: true, precision: 6, mode: 'date' })
            .notNull()
            .defaultNow(),
    },
    (table): PgTableExtraConfigValue[] => [
        uniqueIndex('report_questions_user_id_id_key').on(table.userId, table.id),
        index('report_questions_conversation_idx').on(
            table.userId,
            table.reportId,
            table.createdAt,
            table.id,
        ),
        foreignKey({
            name: 'report_questions_user_id_fkey',
            columns: [table.userId],
            foreignColumns: [users.id],
        })
            .onDelete('cascade')
            .onUpdate('no action'),
        foreignKey({
            name: 'report_questions_user_id_report_id_fkey',
            columns: [table.userId, table.reportId],
            foreignColumns: [reports.userId, reports.id],
        })
            .onDelete('no action')
            .onUpdate('no action'),
        foreignKey({
            name: 'report_questions_user_id_followup_run_id_fkey',
            columns: [table.userId, table.followupRunId],
            foreignColumns: [runs.userId, runs.id],
        })
            .onDelete('no action')
            .onUpdate('no action'),
        foreignKey({
            name: 'report_questions_user_id_revision_run_id_fkey',
            columns: [table.userId, table.revisionRunId],
            foreignColumns: [runs.userId, runs.id],
        })
            .onDelete('no action')
            .onUpdate('no action'),
    ],
);

export type ReportQuestion = typeof reportQuestions.$inferSelect;

export const questionEvidence = pgTable(
    'question_evidence',
    {
        id: uuid('id').notNull().primaryKey().$defaultFn(randomUUID),
        userId: uuid('user_id').notNull(),
        questionId: uuid('question_id').notNull(),
        evidenceId: uuid('evidence_id').notNull(),
    },
    (table): PgTableExtraConfigValue[] => [
        uniqueIndex('question_evidence_user_id_id_key').on(table.userId, table.id),
        uniqueIndex('question_evidence_question_id_evidence_id_key').on(
            table.questionId,
            table.evidenceId,
        ),
        foreignKey({
            name: 'question_evidence_user_id_fkey',
            columns: [table.userId],
            foreignColumns: [users.id],
        })
            .onDelete('cascade')
            .onUpdate('no action'),
        foreignKey({
            name: 'question_evidence_user_id_question_id_fkey',
            columns: [table.userId, table.questionId],
            foreignColumns: [reportQuestions.userId, reportQuestions.id],
        })
            .onDelete('no action')
            .onUpdate('no action'),
        foreignKey({
            name: 'question_evidence_user_id_evidence_id_fkey',
            columns: [table.userId, table.evidenceId],
            foreignColumns: [evidence.userId, evidence.id],
        })
            .onDelete('no action')
            .onUpdate('no action'),
    ],
);

export type QuestionEvidence = typeof questionEvidence.$inferSelect;
