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
import { toolCallStatusEnum, type JsonValue, idempotencyStatusEnum } from './enums.ts';
import { users } from './identity.ts';
import { runs } from './runs.ts';

export const toolCalls = pgTable(
    'tool_calls',
    {
        id: uuid('id').notNull().primaryKey().$defaultFn(randomUUID),
        userId: uuid('user_id').notNull(),
        runId: uuid('run_id').notNull(),
        operationKey: text('operation_key').notNull(),
        tool: text('tool').notNull(),
        attemptNo: integer('attempt_no').notNull(),
        status: toolCallStatusEnum('status').notNull().default('reserved'),
        inputSummary: text('input_summary').notNull(),
        reservedBudget: jsonb('reserved_budget').$type<JsonValue>().notNull(),
        usage: jsonb('usage').$type<JsonValue>(),
        outputRef: jsonb('output_ref').$type<JsonValue>(),
        startedAt: timestamp('started_at', { withTimezone: true, precision: 6, mode: 'date' }),
        finishedAt: timestamp('finished_at', { withTimezone: true, precision: 6, mode: 'date' }),
    },
    (table): PgTableExtraConfigValue[] => [
        uniqueIndex('tool_calls_user_id_id_key').on(table.userId, table.id),
        uniqueIndex('tool_calls_run_id_operation_key_attempt_no_key').on(
            table.runId,
            table.operationKey,
            table.attemptNo,
        ),
        foreignKey({
            name: 'tool_calls_user_id_fkey',
            columns: [table.userId],
            foreignColumns: [users.id],
        })
            .onDelete('cascade')
            .onUpdate('no action'),
        foreignKey({
            name: 'tool_calls_user_id_run_id_fkey',
            columns: [table.userId, table.runId],
            foreignColumns: [runs.userId, runs.id],
        })
            .onDelete('no action')
            .onUpdate('no action'),
        check('tool_attempt_valid', sql.raw('attempt_no >= 1')),
    ],
);

export type ToolCall = typeof toolCalls.$inferSelect;

export const runEvents = pgTable(
    'run_events',
    {
        id: uuid('id').notNull().primaryKey().$defaultFn(randomUUID),
        userId: uuid('user_id').notNull(),
        runId: uuid('run_id').notNull(),
        seq: integer('seq').notNull(),
        schemaVersion: integer('schema_version').notNull().default(1),
        type: text('type').notNull(),
        payload: jsonb('payload').$type<JsonValue>().notNull(),
        occurredAt: timestamp('occurred_at', { withTimezone: true, precision: 6, mode: 'date' })
            .notNull()
            .defaultNow(),
    },
    (table): PgTableExtraConfigValue[] => [
        uniqueIndex('run_events_user_id_id_key').on(table.userId, table.id),
        uniqueIndex('run_events_run_id_seq_key').on(table.runId, table.seq),
        foreignKey({
            name: 'run_events_user_id_fkey',
            columns: [table.userId],
            foreignColumns: [users.id],
        })
            .onDelete('cascade')
            .onUpdate('no action'),
        foreignKey({
            name: 'run_events_user_id_run_id_fkey',
            columns: [table.userId, table.runId],
            foreignColumns: [runs.userId, runs.id],
        })
            .onDelete('no action')
            .onUpdate('no action'),
        check('event_sequence_and_version_valid', sql.raw('seq >= 1 AND schema_version = 1')),
        check(
            'event_type_valid',
            sql.raw(
                "type IN (\r\n  'run.queued', 'run.started', 'run.recovering', 'step.started', 'step.completed',\r\n  'tool.started', 'tool.completed', 'tool.failed', 'budget.updated', 'coverage.updated', 'research.updated',\r\n  'report.published', 'run.completed', 'run.failed', 'run.canceled'\r\n)",
            ),
        ),
    ],
);

export type RunEvent = typeof runEvents.$inferSelect;

export const outbox = pgTable(
    'outbox',
    {
        id: uuid('id').notNull().primaryKey().$defaultFn(randomUUID),
        userId: uuid('user_id').notNull(),
        aggregateType: text('aggregate_type').notNull().default('run'),
        aggregateId: uuid('aggregate_id').notNull(),
        eventType: text('event_type').notNull(),
        dedupeKey: text('dedupe_key').notNull(),
        payload: jsonb('payload').$type<JsonValue>().notNull(),
        availableAt: timestamp('available_at', { withTimezone: true, precision: 6, mode: 'date' })
            .notNull()
            .defaultNow(),
        leaseExpiresAt: timestamp('lease_expires_at', {
            withTimezone: true,
            precision: 6,
            mode: 'date',
        }),
        attempts: integer('attempts').notNull().default(0),
        sentAt: timestamp('sent_at', { withTimezone: true, precision: 6, mode: 'date' }),
    },
    (table): PgTableExtraConfigValue[] => [
        uniqueIndex('outbox_dedupe_key_key').on(table.dedupeKey),
        index('outbox_sent_at_available_at_idx').on(table.sentAt, table.availableAt),
        uniqueIndex('outbox_user_id_id_key').on(table.userId, table.id),
        foreignKey({
            name: 'outbox_user_id_fkey',
            columns: [table.userId],
            foreignColumns: [users.id],
        })
            .onDelete('cascade')
            .onUpdate('no action'),
        foreignKey({
            name: 'outbox_user_id_aggregate_id_fkey',
            columns: [table.userId, table.aggregateId],
            foreignColumns: [runs.userId, runs.id],
        })
            .onDelete('no action')
            .onUpdate('no action'),
        check('outbox_run_aggregate', sql.raw("aggregate_type = 'run' AND attempts >= 0")),
    ],
);

export type Outbox = typeof outbox.$inferSelect;

export const idempotencyRecords = pgTable(
    'idempotency_records',
    {
        id: uuid('id').notNull().primaryKey().$defaultFn(randomUUID),
        userId: uuid('user_id').notNull(),
        scope: text('scope').notNull(),
        keyHash: text('key_hash').notNull(),
        payloadHash: text('payload_hash').notNull(),
        status: idempotencyStatusEnum('status').notNull().default('pending'),
        responseCode: integer('response_code'),
        resourceId: uuid('resource_id'),
        expiresAt: timestamp('expires_at', {
            withTimezone: true,
            precision: 6,
            mode: 'date',
        }).notNull(),
    },
    (table): PgTableExtraConfigValue[] => [
        index('idempotency_records_expires_at_idx').on(table.expiresAt),
        uniqueIndex('idempotency_records_user_id_id_key').on(table.userId, table.id),
        uniqueIndex('idempotency_records_user_id_scope_key_hash_key').on(
            table.userId,
            table.scope,
            table.keyHash,
        ),
        foreignKey({
            name: 'idempotency_records_user_id_fkey',
            columns: [table.userId],
            foreignColumns: [users.id],
        })
            .onDelete('cascade')
            .onUpdate('no action'),
        check(
            'idempotency_response_valid',
            sql.raw('response_code IS NULL OR response_code BETWEEN 100 AND 599'),
        ),
    ],
);

export type IdempotencyRecord = typeof idempotencyRecords.$inferSelect;
