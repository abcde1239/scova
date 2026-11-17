import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
    pgTable,
    uuid,
    text,
    integer,
    char,
    timestamp,
    jsonb,
    index,
    uniqueIndex,
    foreignKey,
    check,
    type PgTableExtraConfigValue,
} from 'drizzle-orm/pg-core';
import { users } from './identity.ts';
import { tasks, taskVersions, scheduleOccurrences } from './tasks.ts';
import {
    serviceModeEnum,
    runTriggerEnum,
    runStatusEnum,
    type JsonValue,
    runOutcomeEnum,
} from './enums.ts';

export const baselines = pgTable(
    'baselines',
    {
        id: uuid('id').notNull().primaryKey().$defaultFn(randomUUID),
        userId: uuid('user_id').notNull(),
        taskId: uuid('task_id').notNull(),
        comparisonScopeHash: char('comparison_scope_hash', { length: 64 }).notNull(),
        completeRunId: uuid('complete_run_id').notNull(),
        updatedAt: timestamp('updated_at', { withTimezone: true, precision: 6, mode: 'date' })
            .notNull()
            .$defaultFn(() => new Date())
            .$onUpdate(() => new Date()),
    },
    (table): PgTableExtraConfigValue[] => [
        uniqueIndex('baselines_user_id_id_key').on(table.userId, table.id),
        uniqueIndex('baselines_user_id_task_id_comparison_scope_hash_key').on(
            table.userId,
            table.taskId,
            table.comparisonScopeHash,
        ),
        foreignKey({
            name: 'baselines_user_id_fkey',
            columns: [table.userId],
            foreignColumns: [users.id],
        })
            .onDelete('cascade')
            .onUpdate('no action'),
        foreignKey({
            name: 'baselines_user_id_task_id_fkey',
            columns: [table.userId, table.taskId],
            foreignColumns: [tasks.userId, tasks.id],
        })
            .onDelete('no action')
            .onUpdate('no action'),
        foreignKey({
            name: 'baselines_user_id_task_id_comparison_scope_hash_complete_r_fkey',
            columns: [table.userId, table.taskId, table.comparisonScopeHash, table.completeRunId],
            foreignColumns: [runs.userId, runs.taskId, runs.comparisonScopeHash, runs.id],
        })
            .onDelete('no action')
            .onUpdate('no action'),
    ],
);

export type Baseline = typeof baselines.$inferSelect;

export const runs = pgTable(
    'runs',
    {
        id: uuid('id').notNull().primaryKey().$defaultFn(randomUUID),
        userId: uuid('user_id').notNull(),
        taskId: uuid('task_id').notNull(),
        taskVersionId: uuid('task_version_id').notNull(),
        comparisonScopeHash: char('comparison_scope_hash', { length: 64 }).notNull(),
        mode: serviceModeEnum('mode').notNull(),
        trigger: runTriggerEnum('trigger').notNull(),
        occurrenceId: uuid('occurrence_id'),
        parentRunId: uuid('parent_run_id'),
        status: runStatusEnum('status').notNull().default('queued'),
        queuedAt: timestamp('queued_at', { withTimezone: true, precision: 6, mode: 'date' })
            .notNull()
            .defaultNow(),
        startedAt: timestamp('started_at', { withTimezone: true, precision: 6, mode: 'date' }),
        deadlineAt: timestamp('deadline_at', { withTimezone: true, precision: 6, mode: 'date' }),
        finishedAt: timestamp('finished_at', { withTimezone: true, precision: 6, mode: 'date' }),
        leaseOwner: text('lease_owner'),
        leaseEpoch: integer('lease_epoch').notNull().default(0),
        leaseExpiresAt: timestamp('lease_expires_at', {
            withTimezone: true,
            precision: 6,
            mode: 'date',
        }),
        recoveryCount: integer('recovery_count').notNull().default(0),
        cancelRequestedAt: timestamp('cancel_requested_at', {
            withTimezone: true,
            precision: 6,
            mode: 'date',
        }),
        baselineRunId: uuid('baseline_run_id'),
        followupConfigJson: jsonb('followup_config_json').$type<JsonValue>(),
        conversationContextJson: jsonb('conversation_context_json').$type<JsonValue>(),
        feedbackSnapshotJson: jsonb('feedback_snapshot_json')
            .$type<JsonValue>()
            .notNull()
            .default([]),
        budgetJson: jsonb('budget_json').$type<JsonValue>().notNull(),
        usageJson: jsonb('usage_json').$type<JsonValue>().notNull().default({}),
        coverageJson: jsonb('coverage_json').$type<JsonValue>(),
        outcome: runOutcomeEnum('outcome'),
        failureCode: text('failure_code'),
        checkpointRef: jsonb('checkpoint_ref').$type<JsonValue>(),
    },
    (table): PgTableExtraConfigValue[] => [
        index('runs_user_id_task_id_queued_at_idx').on(
            table.userId,
            table.taskId,
            table.queuedAt.desc(),
        ),
        index('runs_status_lease_expires_at_idx').on(table.status, table.leaseExpiresAt),
        uniqueIndex('runs_user_id_id_key').on(table.userId, table.id),
        uniqueIndex('runs_user_id_task_id_id_key').on(table.userId, table.taskId, table.id),
        uniqueIndex('runs_user_id_task_id_comparison_scope_hash_id_key').on(
            table.userId,
            table.taskId,
            table.comparisonScopeHash,
            table.id,
        ),
        uniqueIndex('runs_user_id_id_task_id_task_version_id_key').on(
            table.userId,
            table.id,
            table.taskId,
            table.taskVersionId,
        ),
        uniqueIndex('run_one_active_per_task')
            .on(table.taskId)
            .where(sql.raw("status IN ('queued', 'running', 'recovering', 'cancel_requested')")),
        index('runs_history_page').on(
            table.userId,
            table.taskId,
            table.queuedAt.desc(),
            table.id.desc(),
        ),
        foreignKey({
            name: 'runs_user_id_fkey',
            columns: [table.userId],
            foreignColumns: [users.id],
        })
            .onDelete('cascade')
            .onUpdate('no action'),
        foreignKey({
            name: 'runs_user_id_task_id_task_version_id_fkey',
            columns: [table.userId, table.taskId, table.taskVersionId],
            foreignColumns: [taskVersions.userId, taskVersions.taskId, taskVersions.id],
        })
            .onDelete('no action')
            .onUpdate('no action'),
        foreignKey({
            name: 'runs_user_id_task_id_fkey',
            columns: [table.userId, table.taskId],
            foreignColumns: [tasks.userId, tasks.id],
        })
            .onDelete('no action')
            .onUpdate('no action'),
        foreignKey({
            name: 'runs_user_id_task_id_occurrence_id_fkey',
            columns: [table.userId, table.taskId, table.occurrenceId],
            foreignColumns: [
                scheduleOccurrences.userId,
                scheduleOccurrences.taskId,
                scheduleOccurrences.id,
            ],
        })
            .onDelete('no action')
            .onUpdate('no action'),
        foreignKey({
            name: 'runs_user_id_task_id_parent_run_id_fkey',
            columns: [table.userId, table.taskId, table.parentRunId],
            foreignColumns: [runs.userId, runs.taskId, runs.id],
        })
            .onDelete('no action')
            .onUpdate('no action'),
        foreignKey({
            name: 'runs_user_id_task_id_comparison_scope_hash_baseline_run_id_fkey',
            columns: [table.userId, table.taskId, table.comparisonScopeHash, table.baselineRunId],
            foreignColumns: [runs.userId, runs.taskId, runs.comparisonScopeHash, runs.id],
        })
            .onDelete('no action')
            .onUpdate('no action'),
        check('run_counters_valid', sql.raw('lease_epoch >= 0 AND recovery_count >= 0')),
        check('run_scope_hash_valid', sql.raw("comparison_scope_hash ~ '^[0-9a-f]{64}$'")),
        check(
            'run_complete_status_valid',
            sql.raw(
                "\r\n  (status <> 'succeeded' OR COALESCE(coverage_json->>'completeness' = 'complete', false)) AND\r\n  (status <> 'partial' OR COALESCE(coverage_json->>'completeness' = 'partial', false)) AND\r\n  (outcome IS NULL OR outcome NOT IN ('baseline', 'no_important_change') OR (status = 'succeeded' AND COALESCE(coverage_json->>'completeness' = 'complete', false)))\r\n",
            ),
        ),
        check(
            'run_json_shapes_valid',
            sql.raw(
                "\r\n  jsonb_typeof(budget_json) = 'object'\r\n  AND jsonb_typeof(usage_json) = 'object'\r\n  AND (\r\n    feedback_snapshot_json = '[]'::jsonb\r\n    OR (\r\n      jsonb_typeof(feedback_snapshot_json) = 'object'\r\n      AND feedback_snapshot_json->'schemaVersion' = '1'::jsonb\r\n      AND feedback_snapshot_json->>'userId' = user_id::text\r\n      AND feedback_snapshot_json->>'taskId' = task_id::text\r\n      AND jsonb_typeof(feedback_snapshot_json->'items') = 'array'\r\n    )\r\n  ) IS TRUE\r\n",
            ),
        ),
    ],
);

export type Run = typeof runs.$inferSelect;
