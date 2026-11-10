// PostgreSQL schema. Historical SQL remains immutable; migrations preserve existing constraints.
import { randomUUID } from 'node:crypto';
import { relations, sql } from 'drizzle-orm';
import {
    pgTable,
    pgEnum,
    uuid,
    text,
    integer,
    boolean,
    doublePrecision,
    char,
    timestamp,
    jsonb,
    index,
    uniqueIndex,
    foreignKey,
    check,
    type PgTableExtraConfigValue,
} from 'drizzle-orm/pg-core';

export type JsonValue =
    | string
    | number
    | boolean
    | null
    | { [key: string]: JsonValue }
    | JsonValue[];

export const taskStatusEnum = pgEnum('TaskStatus', ['active', 'paused', 'archived']);
export type TaskStatus = (typeof taskStatusEnum.enumValues)[number];
export const occurrenceStatusEnum = pgEnum('OccurrenceStatus', [
    'created',
    'skipped_overlap',
    'missed',
    'paused',
]);
export type OccurrenceStatus = (typeof occurrenceStatusEnum.enumValues)[number];
export const serviceModeEnum = pgEnum('ServiceMode', ['demo', 'live']);
export type ServiceMode = (typeof serviceModeEnum.enumValues)[number];
export const runTriggerEnum = pgEnum('RunTrigger', ['manual', 'scheduled', 'retry', 'followup']);
export type RunTrigger = (typeof runTriggerEnum.enumValues)[number];
export const runStatusEnum = pgEnum('RunStatus', [
    'queued',
    'running',
    'recovering',
    'cancel_requested',
    'canceled',
    'succeeded',
    'partial',
    'failed',
]);
export type RunStatus = (typeof runStatusEnum.enumValues)[number];
export const runOutcomeEnum = pgEnum('RunOutcome', [
    'baseline',
    'important_change',
    'new_findings',
    'no_important_change',
    'inconclusive',
]);
export type RunOutcome = (typeof runOutcomeEnum.enumValues)[number];
export const toolCallStatusEnum = pgEnum('ToolCallStatus', [
    'reserved',
    'running',
    'succeeded',
    'failed',
    'unknown',
]);
export type ToolCallStatus = (typeof toolCallStatusEnum.enumValues)[number];
export const idempotencyStatusEnum = pgEnum('IdempotencyStatus', ['pending', 'completed']);
export type IdempotencyStatus = (typeof idempotencyStatusEnum.enumValues)[number];
export const fetchStatusEnum = pgEnum('FetchStatus', ['succeeded', 'failed']);
export type FetchStatus = (typeof fetchStatusEnum.enumValues)[number];
export const outputFormatEnum = pgEnum('OutputFormat', [
    'brief',
    'list',
    'comparison',
    'research_report',
]);
export type OutputFormat = (typeof outputFormatEnum.enumValues)[number];
export const completenessEnum = pgEnum('Completeness', ['complete', 'partial']);
export type Completeness = (typeof completenessEnum.enumValues)[number];
export const claimKindEnum = pgEnum('ClaimKind', ['fact', 'inference', 'conflict', 'insufficient']);
export type ClaimKind = (typeof claimKindEnum.enumValues)[number];
export const evidenceRelationEnum = pgEnum('EvidenceRelation', ['supports', 'contradicts']);
export type EvidenceRelation = (typeof evidenceRelationEnum.enumValues)[number];
export const changeKindEnum = pgEnum('ChangeKind', [
    'baseline',
    'new',
    'duplicate',
    'duplicate_candidate',
    'changed',
    'non_material',
    'uncertain',
]);
export type ChangeKind = (typeof changeKindEnum.enumValues)[number];
export const evidenceSideEnum = pgEnum('EvidenceSide', ['old', 'new']);
export type EvidenceSide = (typeof evidenceSideEnum.enumValues)[number];
export const notificationKindEnum = pgEnum('NotificationKind', [
    'summary',
    'important_change',
    'run_issue',
]);
export type NotificationKind = (typeof notificationKindEnum.enumValues)[number];
export const feedbackKindEnum = pgEnum('FeedbackKind', ['irrelevant', 'known', 'deeper']);
export type FeedbackKind = (typeof feedbackKindEnum.enumValues)[number];

export const users = pgTable(
    'users',
    {
        id: uuid('id').notNull().primaryKey().$defaultFn(randomUUID),
        email: text('email').notNull(),
        normalizedEmail: text('normalized_email').notNull(),
        passwordHash: text('password_hash').notNull(),
        avatarVersion: uuid('avatar_version'),
        defaultTimezone: text('default_timezone').notNull().default('UTC'),
        notificationPreference: jsonb('notification_preference')
            .$type<JsonValue>()
            .notNull()
            .default({ mode: 'summary', runIssues: true }),
        createdAt: timestamp('created_at', { withTimezone: true, precision: 6, mode: 'date' })
            .notNull()
            .defaultNow(),
    },
    (table): PgTableExtraConfigValue[] => [
        uniqueIndex('users_normalized_email_key').on(table.normalizedEmail),
        check('user_email_nonempty', sql.raw('length(btrim(normalized_email)) > 0')),
    ],
);
export type User = typeof users.$inferSelect;

export const agentProviders = pgTable(
    'agent_providers',
    {
        id: uuid('id').notNull().primaryKey().$defaultFn(randomUUID),
        userId: uuid('user_id')
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        name: text('name').notNull(),
        baseUrl: text('base_url').notNull(),
        model: text('model').notNull(),
        protocol: text('protocol')
            .$type<'openai_chat_completions' | 'openai_json' | 'anthropic_messages' | 'gemini'>()
            .notNull()
            .default('openai_chat_completions'),
        encryptedApiKey: text('encrypted_api_key').notNull(),
        webSearch: text('web_search')
            .$type<'disabled' | 'openai_responses' | 'anthropic_web_search'>()
            .notNull()
            .default('disabled'),
        active: boolean('active').notNull().default(false),
        draftActive: boolean('draft_active').notNull().default(false),
        revision: integer('revision').notNull().default(1),
        updatedAt: timestamp('updated_at', { withTimezone: true, precision: 6, mode: 'date' })
            .notNull()
            .defaultNow(),
    },
    (table) => [
        index('agent_providers_user_id_idx').on(table.userId),
        uniqueIndex('agent_providers_one_active_per_user')
            .on(table.userId)
            .where(sql`${table.active} = true`),
        uniqueIndex('agent_providers_one_draft_active_per_user')
            .on(table.userId)
            .where(sql`${table.draftActive} = true`),
        check('agent_provider_revision_positive', sql`${table.revision} > 0`),
        check(
            'agent_provider_web_search_valid',
            sql`${table.webSearch} = 'disabled' OR (${table.webSearch} = 'openai_responses' AND ${table.protocol} IN ('openai_chat_completions', 'openai_json')) OR (${table.webSearch} = 'anthropic_web_search' AND ${table.protocol} = 'anthropic_messages')`,
        ),
    ],
);

export const sessions = pgTable(
    'sessions',
    {
        id: uuid('id').notNull().primaryKey().$defaultFn(randomUUID),
        userId: uuid('user_id').notNull(),
        tokenHash: text('token_hash').notNull(),
        csrfTokenHash: text('csrf_token_hash').notNull(),
        expiresAt: timestamp('expires_at', {
            withTimezone: true,
            precision: 6,
            mode: 'date',
        }).notNull(),
        revokedAt: timestamp('revoked_at', { withTimezone: true, precision: 6, mode: 'date' }),
        createdAt: timestamp('created_at', { withTimezone: true, precision: 6, mode: 'date' })
            .notNull()
            .defaultNow(),
    },
    (table): PgTableExtraConfigValue[] => [
        uniqueIndex('sessions_token_hash_key').on(table.tokenHash),
        index('sessions_user_id_expires_at_idx').on(table.userId, table.expiresAt),
        uniqueIndex('sessions_user_id_id_key').on(table.userId, table.id),
        foreignKey({
            name: 'sessions_user_id_fkey',
            columns: [table.userId],
            foreignColumns: [users.id],
        })
            .onDelete('cascade')
            .onUpdate('no action'),
        check(
            'session_hashes_only',
            sql.raw("token_hash ~ '^[0-9a-f]{64}$' AND csrf_token_hash ~ '^[0-9a-f]{64}$'"),
        ),
    ],
);
export type Session = typeof sessions.$inferSelect;

export const tasks = pgTable(
    'tasks',
    {
        id: uuid('id').notNull().primaryKey().$defaultFn(randomUUID),
        userId: uuid('user_id').notNull(),
        title: text('title').notNull(),
        status: taskStatusEnum('status').notNull().default('active'),
        revision: integer('revision').notNull().default(1),
        currentVersionId: uuid('current_version_id'),
        scheduleRevision: integer('schedule_revision').notNull().default(1),
        nextRunAt: timestamp('next_run_at', { withTimezone: true, precision: 6, mode: 'date' }),
        createdAt: timestamp('created_at', { withTimezone: true, precision: 6, mode: 'date' })
            .notNull()
            .defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true, precision: 6, mode: 'date' })
            .notNull()
            .$defaultFn(() => new Date())
            .$onUpdate(() => new Date()),
        archivedAt: timestamp('archived_at', { withTimezone: true, precision: 6, mode: 'date' }),
    },
    (table): PgTableExtraConfigValue[] => [
        index('tasks_user_id_status_updated_at_idx').on(
            table.userId,
            table.status,
            table.updatedAt,
        ),
        uniqueIndex('tasks_user_id_id_key').on(table.userId, table.id),
        index('tasks_due_active')
            .on(table.nextRunAt, table.id)
            .where(sql.raw('"status" = \'active\' AND "next_run_at" IS NOT NULL')),
        index('tasks_history_page').on(table.userId, table.updatedAt.desc(), table.id.desc()),
        foreignKey({
            name: 'tasks_user_id_fkey',
            columns: [table.userId],
            foreignColumns: [users.id],
        })
            .onDelete('cascade')
            .onUpdate('no action'),
        foreignKey({
            name: 'tasks_user_id_id_current_version_id_fkey',
            columns: [table.userId, table.id, table.currentVersionId],
            foreignColumns: [taskVersions.userId, taskVersions.taskId, taskVersions.id],
        })
            .onDelete('no action')
            .onUpdate('no action'),
        check('task_revision_positive', sql.raw('revision >= 1 AND schedule_revision >= 1')),
        check('task_title_nonempty', sql.raw('length(btrim(title)) > 0')),
    ],
);
export type Task = typeof tasks.$inferSelect;

export const taskVersions = pgTable(
    'task_versions',
    {
        id: uuid('id').notNull().primaryKey().$defaultFn(randomUUID),
        userId: uuid('user_id').notNull(),
        taskId: uuid('task_id').notNull(),
        version: integer('version').notNull(),
        inputText: text('input_text'),
        configSchemaVersion: integer('config_schema_version').notNull().default(1),
        configJson: jsonb('config_json').$type<JsonValue>().notNull(),
        comparisonScopeHash: char('comparison_scope_hash', { length: 64 }).notNull(),
        createdAt: timestamp('created_at', { withTimezone: true, precision: 6, mode: 'date' })
            .notNull()
            .defaultNow(),
    },
    (table): PgTableExtraConfigValue[] => [
        uniqueIndex('task_versions_user_id_id_key').on(table.userId, table.id),
        uniqueIndex('task_versions_user_id_task_id_version_key').on(
            table.userId,
            table.taskId,
            table.version,
        ),
        uniqueIndex('task_versions_user_id_task_id_id_key').on(
            table.userId,
            table.taskId,
            table.id,
        ),
        foreignKey({
            name: 'task_versions_user_id_fkey',
            columns: [table.userId],
            foreignColumns: [users.id],
        })
            .onDelete('cascade')
            .onUpdate('no action'),
        foreignKey({
            name: 'task_versions_user_id_task_id_fkey',
            columns: [table.userId, table.taskId],
            foreignColumns: [tasks.userId, tasks.id],
        })
            .onDelete('no action')
            .onUpdate('no action'),
        check(
            'task_version_valid',
            sql.raw(
                "version >= 1 AND config_schema_version = 1 AND comparison_scope_hash ~ '^[0-9a-f]{64}$' AND jsonb_typeof(config_json) = 'object'",
            ),
        ),
    ],
);
export type TaskVersion = typeof taskVersions.$inferSelect;

export const scheduleOccurrences = pgTable(
    'schedule_occurrences',
    {
        id: uuid('id').notNull().primaryKey().$defaultFn(randomUUID),
        userId: uuid('user_id').notNull(),
        taskId: uuid('task_id').notNull(),
        scheduleRevision: integer('schedule_revision').notNull(),
        scheduledAt: timestamp('scheduled_at', {
            withTimezone: true,
            precision: 6,
            mode: 'date',
        }).notNull(),
        status: occurrenceStatusEnum('status').notNull().default('created'),
        runId: uuid('run_id'),
        missedCount: integer('missed_count').notNull().default(0),
    },
    (table): PgTableExtraConfigValue[] => [
        uniqueIndex('schedule_occurrences_user_id_id_key').on(table.userId, table.id),
        uniqueIndex('schedule_occurrences_task_id_schedule_revision_scheduled_at_key').on(
            table.taskId,
            table.scheduleRevision,
            table.scheduledAt,
        ),
        uniqueIndex('schedule_occurrences_user_id_task_id_id_key').on(
            table.userId,
            table.taskId,
            table.id,
        ),
        foreignKey({
            name: 'schedule_occurrences_user_id_fkey',
            columns: [table.userId],
            foreignColumns: [users.id],
        })
            .onDelete('cascade')
            .onUpdate('no action'),
        foreignKey({
            name: 'schedule_occurrences_user_id_task_id_fkey',
            columns: [table.userId, table.taskId],
            foreignColumns: [tasks.userId, tasks.id],
        })
            .onDelete('no action')
            .onUpdate('no action'),
        foreignKey({
            name: 'schedule_occurrences_user_id_task_id_run_id_fkey',
            columns: [table.userId, table.taskId, table.runId],
            foreignColumns: [runs.userId, runs.taskId, runs.id],
        })
            .onDelete('no action')
            .onUpdate('no action'),
        check('occurrence_counters_valid', sql.raw('schedule_revision >= 1 AND missed_count >= 0')),
    ],
);
export type ScheduleOccurrence = typeof scheduleOccurrences.$inferSelect;

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

export const sources = pgTable(
    'sources',
    {
        id: uuid('id').notNull().primaryKey().$defaultFn(randomUUID),
        userId: uuid('user_id').notNull(),
        canonicalUrl: text('canonical_url').notNull(),
        canonicalUrlHash: char('canonical_url_hash', { length: 64 }).notNull(),
        firstSeenAt: timestamp('first_seen_at', { withTimezone: true, precision: 6, mode: 'date' })
            .notNull()
            .defaultNow(),
    },
    (table): PgTableExtraConfigValue[] => [
        uniqueIndex('sources_user_id_id_key').on(table.userId, table.id),
        uniqueIndex('sources_user_id_canonical_url_hash_key').on(
            table.userId,
            table.canonicalUrlHash,
        ),
        foreignKey({
            name: 'sources_user_id_fkey',
            columns: [table.userId],
            foreignColumns: [users.id],
        })
            .onDelete('cascade')
            .onUpdate('no action'),
        check('source_url_hash_valid', sql.raw("canonical_url_hash ~ '^[0-9a-f]{64}$'")),
    ],
);
export type Source = typeof sources.$inferSelect;

export const sourceSnapshots = pgTable(
    'source_snapshots',
    {
        id: uuid('id').notNull().primaryKey().$defaultFn(randomUUID),
        userId: uuid('user_id').notNull(),
        sourceId: uuid('source_id').notNull(),
        contentHash: char('content_hash', { length: 64 }).notNull(),
        extractorVersion: text('extractor_version').notNull(),
        title: text('title').notNull(),
        publishedAt: timestamp('published_at', { withTimezone: true, precision: 6, mode: 'date' }),
        textBody: text('text_body'),
        textExpiresAt: timestamp('text_expires_at', {
            withTimezone: true,
            precision: 6,
            mode: 'date',
        }),
        metadataJson: jsonb('metadata_json').$type<JsonValue>().notNull().default({}),
    },
    (table): PgTableExtraConfigValue[] => [
        uniqueIndex('source_snapshots_user_id_id_key').on(table.userId, table.id),
        uniqueIndex('source_snapshots_user_id_source_id_extractor_version_conten_key').on(
            table.userId,
            table.sourceId,
            table.extractorVersion,
            table.contentHash,
        ),
        uniqueIndex('source_snapshots_user_id_source_id_id_key').on(
            table.userId,
            table.sourceId,
            table.id,
        ),
        index('source_snapshots_library_fts').using(
            'GIN',
            sql.raw(
                "to_tsvector('simple'::regconfig, coalesce(title, '') || ' ' || coalesce(text_body, ''))",
            ),
        ),
        index('source_snapshots_expired_body')
            .on(table.textExpiresAt, table.id)
            .where(sql.raw('text_body IS NOT NULL AND text_expires_at IS NOT NULL')),
        foreignKey({
            name: 'source_snapshots_user_id_fkey',
            columns: [table.userId],
            foreignColumns: [users.id],
        })
            .onDelete('cascade')
            .onUpdate('no action'),
        foreignKey({
            name: 'source_snapshots_user_id_source_id_fkey',
            columns: [table.userId, table.sourceId],
            foreignColumns: [sources.userId, sources.id],
        })
            .onDelete('no action')
            .onUpdate('no action'),
        check('snapshot_hash_valid', sql.raw("content_hash ~ '^[0-9a-f]{64}$'")),
    ],
);
export type SourceSnapshot = typeof sourceSnapshots.$inferSelect;

export const runSources = pgTable(
    'run_sources',
    {
        id: uuid('id').notNull().primaryKey().$defaultFn(randomUUID),
        userId: uuid('user_id').notNull(),
        runId: uuid('run_id').notNull(),
        sourceId: uuid('source_id').notNull(),
        snapshotId: uuid('snapshot_id'),
        requestedUrl: text('requested_url').notNull(),
        fetchedUrl: text('fetched_url'),
        observedAt: timestamp('observed_at', { withTimezone: true, precision: 6, mode: 'date' })
            .notNull()
            .defaultNow(),
        fetchStatus: fetchStatusEnum('fetch_status').notNull(),
        errorCode: text('error_code'),
        relevance: doublePrecision('relevance'),
        metadataJson: jsonb('metadata_json').$type<JsonValue>().notNull().default({}),
    },
    (table): PgTableExtraConfigValue[] => [
        uniqueIndex('run_sources_user_id_id_key').on(table.userId, table.id),
        uniqueIndex('run_sources_run_id_source_id_key').on(table.runId, table.sourceId),
        uniqueIndex('run_sources_user_id_run_id_snapshot_id_key').on(
            table.userId,
            table.runId,
            table.snapshotId,
        ),
        index('run_sources_library_history')
            .on(
                table.userId,
                table.sourceId,
                table.snapshotId,
                table.observedAt.desc(),
                table.id.desc(),
            )
            .where(sql.raw("fetch_status = 'succeeded' AND snapshot_id IS NOT NULL")),
        index('run_sources_library_latest')
            .on(table.userId, table.sourceId, table.observedAt.desc(), table.id.desc())
            .where(sql.raw("fetch_status = 'succeeded' AND snapshot_id IS NOT NULL")),
        foreignKey({
            name: 'run_sources_user_id_fkey',
            columns: [table.userId],
            foreignColumns: [users.id],
        })
            .onDelete('cascade')
            .onUpdate('no action'),
        foreignKey({
            name: 'run_sources_user_id_run_id_fkey',
            columns: [table.userId, table.runId],
            foreignColumns: [runs.userId, runs.id],
        })
            .onDelete('no action')
            .onUpdate('no action'),
        foreignKey({
            name: 'run_sources_user_id_source_id_fkey',
            columns: [table.userId, table.sourceId],
            foreignColumns: [sources.userId, sources.id],
        })
            .onDelete('no action')
            .onUpdate('no action'),
        foreignKey({
            name: 'run_sources_user_id_source_id_snapshot_id_fkey',
            columns: [table.userId, table.sourceId, table.snapshotId],
            foreignColumns: [sourceSnapshots.userId, sourceSnapshots.sourceId, sourceSnapshots.id],
        })
            .onDelete('no action')
            .onUpdate('no action'),
        check(
            'observation_result_valid',
            sql.raw("fetch_status <> 'succeeded' OR snapshot_id IS NOT NULL"),
        ),
    ],
);
export type RunSource = typeof runSources.$inferSelect;

export const evidence = pgTable(
    'evidence',
    {
        id: uuid('id').notNull().primaryKey().$defaultFn(randomUUID),
        userId: uuid('user_id').notNull(),
        runId: uuid('run_id').notNull(),
        snapshotId: uuid('snapshot_id').notNull(),
        quote: text('quote').notNull(),
        selectorJson: jsonb('selector_json').$type<JsonValue>().notNull(),
        quoteHash: char('quote_hash', { length: 64 }).notNull(),
        capturedAt: timestamp('captured_at', { withTimezone: true, precision: 6, mode: 'date' })
            .notNull()
            .defaultNow(),
    },
    (table): PgTableExtraConfigValue[] => [
        uniqueIndex('evidence_user_id_id_key').on(table.userId, table.id),
        foreignKey({
            name: 'evidence_user_id_fkey',
            columns: [table.userId],
            foreignColumns: [users.id],
        })
            .onDelete('cascade')
            .onUpdate('no action'),
        foreignKey({
            name: 'evidence_user_id_run_id_snapshot_id_fkey',
            columns: [table.userId, table.runId, table.snapshotId],
            foreignColumns: [runSources.userId, runSources.runId, runSources.snapshotId],
        })
            .onDelete('no action')
            .onUpdate('no action'),
        check(
            'evidence_quote_valid',
            sql.raw("length(btrim(quote)) > 0 AND quote_hash ~ '^[0-9a-f]{64}$'"),
        ),
    ],
);
export type Evidence = typeof evidence.$inferSelect;

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

export const inboxItems = pgTable(
    'inbox_items',
    {
        id: uuid('id').notNull().primaryKey().$defaultFn(randomUUID),
        userId: uuid('user_id').notNull(),
        reportId: uuid('report_id').notNull(),
        readAt: timestamp('read_at', { withTimezone: true, precision: 6, mode: 'date' }),
        createdAt: timestamp('created_at', { withTimezone: true, precision: 6, mode: 'date' })
            .notNull()
            .defaultNow(),
    },
    (table): PgTableExtraConfigValue[] => [
        index('inbox_items_user_id_read_at_created_at_idx').on(
            table.userId,
            table.readAt,
            table.createdAt,
        ),
        uniqueIndex('inbox_items_user_id_id_key').on(table.userId, table.id),
        uniqueIndex('inbox_items_user_id_report_id_key').on(table.userId, table.reportId),
        index('inbox_history_page').on(table.userId, table.createdAt.desc(), table.id.desc()),
        foreignKey({
            name: 'inbox_items_user_id_fkey',
            columns: [table.userId],
            foreignColumns: [users.id],
        })
            .onDelete('cascade')
            .onUpdate('no action'),
        foreignKey({
            name: 'inbox_items_user_id_report_id_fkey',
            columns: [table.userId, table.reportId],
            foreignColumns: [reports.userId, reports.id],
        })
            .onDelete('no action')
            .onUpdate('no action'),
    ],
);
export type InboxItem = typeof inboxItems.$inferSelect;

export const notifications = pgTable(
    'notifications',
    {
        id: uuid('id').notNull().primaryKey().$defaultFn(randomUUID),
        userId: uuid('user_id').notNull(),
        runId: uuid('run_id').notNull(),
        reportId: uuid('report_id'),
        kind: notificationKindEnum('kind').notNull(),
        readAt: timestamp('read_at', { withTimezone: true, precision: 6, mode: 'date' }),
        createdAt: timestamp('created_at', { withTimezone: true, precision: 6, mode: 'date' })
            .notNull()
            .defaultNow(),
    },
    (table): PgTableExtraConfigValue[] => [
        uniqueIndex('notifications_user_id_id_key').on(table.userId, table.id),
        uniqueIndex('notifications_user_id_run_id_kind_key').on(
            table.userId,
            table.runId,
            table.kind,
        ),
        foreignKey({
            name: 'notifications_user_id_fkey',
            columns: [table.userId],
            foreignColumns: [users.id],
        })
            .onDelete('cascade')
            .onUpdate('no action'),
        foreignKey({
            name: 'notifications_user_id_run_id_fkey',
            columns: [table.userId, table.runId],
            foreignColumns: [runs.userId, runs.id],
        })
            .onDelete('no action')
            .onUpdate('no action'),
        foreignKey({
            name: 'notifications_user_id_run_id_report_id_fkey',
            columns: [table.userId, table.runId, table.reportId],
            foreignColumns: [reports.userId, reports.runId, reports.id],
        })
            .onDelete('no action')
            .onUpdate('no action'),
        check(
            'notification_report_required',
            sql.raw("kind = 'run_issue' OR report_id IS NOT NULL"),
        ),
    ],
);
export type Notification = typeof notifications.$inferSelect;

export const feedback = pgTable(
    'feedback',
    {
        id: uuid('id').notNull().primaryKey().$defaultFn(randomUUID),
        userId: uuid('user_id').notNull(),
        taskId: uuid('task_id').notNull(),
        sourceId: uuid('source_id'),
        claimId: uuid('claim_id'),
        kind: feedbackKindEnum('kind').notNull(),
        active: boolean('active').notNull().default(true),
        updatedAt: timestamp('updated_at', { withTimezone: true, precision: 6, mode: 'date' })
            .notNull()
            .$defaultFn(() => new Date())
            .$onUpdate(() => new Date()),
    },
    (table): PgTableExtraConfigValue[] => [
        uniqueIndex('feedback_user_id_id_key').on(table.userId, table.id),
        uniqueIndex('feedback_source_once')
            .on(table.userId, table.taskId, table.sourceId)
            .where(sql.raw('source_id IS NOT NULL')),
        uniqueIndex('feedback_claim_once')
            .on(table.userId, table.taskId, table.claimId)
            .where(sql.raw('claim_id IS NOT NULL')),
        foreignKey({
            name: 'feedback_user_id_fkey',
            columns: [table.userId],
            foreignColumns: [users.id],
        })
            .onDelete('cascade')
            .onUpdate('no action'),
        foreignKey({
            name: 'feedback_user_id_task_id_fkey',
            columns: [table.userId, table.taskId],
            foreignColumns: [tasks.userId, tasks.id],
        })
            .onDelete('no action')
            .onUpdate('no action'),
        foreignKey({
            name: 'feedback_user_id_source_id_fkey',
            columns: [table.userId, table.sourceId],
            foreignColumns: [sources.userId, sources.id],
        })
            .onDelete('no action')
            .onUpdate('no action'),
        foreignKey({
            name: 'feedback_user_id_task_id_claim_id_fkey',
            columns: [table.userId, table.taskId, table.claimId],
            foreignColumns: [claims.userId, claims.taskId, claims.id],
        })
            .onDelete('no action')
            .onUpdate('no action'),
        check('feedback_exactly_one_target', sql.raw('num_nonnulls(source_id, claim_id) = 1')),
    ],
);
export type Feedback = typeof feedback.$inferSelect;

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

export const reportQuestions = pgTable(
    'report_questions',
    {
        id: uuid('id').notNull().primaryKey().$defaultFn(randomUUID),
        userId: uuid('user_id').notNull(),
        reportId: uuid('report_id').notNull(),
        question: text('question').notNull(),
        answerJson: jsonb('answer_json').$type<JsonValue>(),
        followupRunId: uuid('followup_run_id'),
        createdAt: timestamp('created_at', { withTimezone: true, precision: 6, mode: 'date' })
            .notNull()
            .defaultNow(),
    },
    (table): PgTableExtraConfigValue[] => [
        uniqueIndex('report_questions_user_id_id_key').on(table.userId, table.id),
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

export const usersRelations = relations(users, ({ many }) => ({
    sessionRows: many(sessions, { relationName: 'User_Session' }),
    taskRows: many(tasks, { relationName: 'User_Task' }),
    taskVersionRows: many(taskVersions, { relationName: 'User_TaskVersion' }),
    scheduleOccurrenceRows: many(scheduleOccurrences, { relationName: 'User_ScheduleOccurrence' }),
    baselineRows: many(baselines, { relationName: 'User_Baseline' }),
    runRows: many(runs, { relationName: 'User_Run' }),
    toolCallRows: many(toolCalls, { relationName: 'User_ToolCall' }),
    runEventRows: many(runEvents, { relationName: 'User_RunEvent' }),
    outboxRows: many(outbox, { relationName: 'User_Outbox' }),
    idempotencyRecordRows: many(idempotencyRecords, { relationName: 'User_IdempotencyRecord' }),
    sourceRows: many(sources, { relationName: 'User_Source' }),
    sourceSnapshotRows: many(sourceSnapshots, { relationName: 'User_SourceSnapshot' }),
    runSourceRows: many(runSources, { relationName: 'User_RunSource' }),
    evidenceRows: many(evidence, { relationName: 'User_Evidence' }),
    reportRows: many(reports, { relationName: 'User_Report' }),
    claimRows: many(claims, { relationName: 'User_Claim' }),
    claimEvidenceRows: many(claimEvidence, { relationName: 'User_ClaimEvidence' }),
    changeRecordRows: many(changeRecords, { relationName: 'User_ChangeRecord' }),
    changeEvidenceRows: many(changeEvidence, { relationName: 'User_ChangeEvidence' }),
    inboxItemRows: many(inboxItems, { relationName: 'User_InboxItem' }),
    notificationRows: many(notifications, { relationName: 'User_Notification' }),
    feedbackRows: many(feedback, { relationName: 'User_Feedback' }),
    bookmarkRows: many(bookmarks, { relationName: 'User_Bookmark' }),
    noteRows: many(notes, { relationName: 'User_Note' }),
    reportQuestionRows: many(reportQuestions, { relationName: 'User_ReportQuestion' }),
    questionEvidenceRows: many(questionEvidence, { relationName: 'User_QuestionEvidence' }),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
    owner: one(users, {
        relationName: 'User_Session',
        fields: [sessions.userId],
        references: [users.id],
    }),
}));

export const tasksRelations = relations(tasks, ({ one, many }) => ({
    owner: one(users, {
        relationName: 'User_Task',
        fields: [tasks.userId],
        references: [users.id],
    }),
    versions: many(taskVersions, { relationName: 'TaskVersion_task' }),
    currentVersion: one(taskVersions, {
        relationName: 'Task_currentVersion',
        fields: [tasks.userId, tasks.id, tasks.currentVersionId],
        references: [taskVersions.userId, taskVersions.taskId, taskVersions.id],
    }),
    occurrences: many(scheduleOccurrences, { relationName: 'ScheduleOccurrence_task' }),
    baselines: many(baselines, { relationName: 'Baseline_task' }),
    runs: many(runs, { relationName: 'Run_task' }),
    feedback: many(feedback, { relationName: 'Feedback_task' }),
}));

export const taskVersionsRelations = relations(taskVersions, ({ one, many }) => ({
    owner: one(users, {
        relationName: 'User_TaskVersion',
        fields: [taskVersions.userId],
        references: [users.id],
    }),
    task: one(tasks, {
        relationName: 'TaskVersion_task',
        fields: [taskVersions.userId, taskVersions.taskId],
        references: [tasks.userId, tasks.id],
    }),
    currentForTasks: many(tasks, { relationName: 'Task_currentVersion' }),
    runs: many(runs, { relationName: 'Run_version' }),
}));

export const scheduleOccurrencesRelations = relations(scheduleOccurrences, ({ one, many }) => ({
    owner: one(users, {
        relationName: 'User_ScheduleOccurrence',
        fields: [scheduleOccurrences.userId],
        references: [users.id],
    }),
    task: one(tasks, {
        relationName: 'ScheduleOccurrence_task',
        fields: [scheduleOccurrences.userId, scheduleOccurrences.taskId],
        references: [tasks.userId, tasks.id],
    }),
    run: one(runs, {
        relationName: 'ScheduleOccurrence_run',
        fields: [scheduleOccurrences.userId, scheduleOccurrences.taskId, scheduleOccurrences.runId],
        references: [runs.userId, runs.taskId, runs.id],
    }),
    createdRuns: many(runs, { relationName: 'Run_occurrence' }),
}));

export const baselinesRelations = relations(baselines, ({ one }) => ({
    owner: one(users, {
        relationName: 'User_Baseline',
        fields: [baselines.userId],
        references: [users.id],
    }),
    task: one(tasks, {
        relationName: 'Baseline_task',
        fields: [baselines.userId, baselines.taskId],
        references: [tasks.userId, tasks.id],
    }),
    completeRun: one(runs, {
        relationName: 'Baseline_completeRun',
        fields: [
            baselines.userId,
            baselines.taskId,
            baselines.comparisonScopeHash,
            baselines.completeRunId,
        ],
        references: [runs.userId, runs.taskId, runs.comparisonScopeHash, runs.id],
    }),
}));

export const runsRelations = relations(runs, ({ one, many }) => ({
    owner: one(users, { relationName: 'User_Run', fields: [runs.userId], references: [users.id] }),
    scheduleLinks: many(scheduleOccurrences, { relationName: 'ScheduleOccurrence_run' }),
    baselinePointers: many(baselines, { relationName: 'Baseline_completeRun' }),
    version: one(taskVersions, {
        relationName: 'Run_version',
        fields: [runs.userId, runs.taskId, runs.taskVersionId],
        references: [taskVersions.userId, taskVersions.taskId, taskVersions.id],
    }),
    task: one(tasks, {
        relationName: 'Run_task',
        fields: [runs.userId, runs.taskId],
        references: [tasks.userId, tasks.id],
    }),
    occurrence: one(scheduleOccurrences, {
        relationName: 'Run_occurrence',
        fields: [runs.userId, runs.taskId, runs.occurrenceId],
        references: [
            scheduleOccurrences.userId,
            scheduleOccurrences.taskId,
            scheduleOccurrences.id,
        ],
    }),
    parent: one(runs, {
        relationName: 'Run_parent',
        fields: [runs.userId, runs.taskId, runs.parentRunId],
        references: [runs.userId, runs.taskId, runs.id],
    }),
    children: many(runs, { relationName: 'Run_parent' }),
    baseline: one(runs, {
        relationName: 'Run_baseline',
        fields: [runs.userId, runs.taskId, runs.comparisonScopeHash, runs.baselineRunId],
        references: [runs.userId, runs.taskId, runs.comparisonScopeHash, runs.id],
    }),
    comparisons: many(runs, { relationName: 'Run_baseline' }),
    toolCalls: many(toolCalls, { relationName: 'ToolCall_run' }),
    events: many(runEvents, { relationName: 'RunEvent_run' }),
    sources: many(runSources, { relationName: 'RunSource_run' }),
    reports: many(reports, { relationName: 'Report_run' }),
    referencingReports: many(reports, { relationName: 'Report_baseline' }),
    notifications: many(notifications, { relationName: 'Notification_run' }),
    questions: many(reportQuestions, { relationName: 'ReportQuestion_followupRun' }),
    outbox: many(outbox, { relationName: 'Outbox_run' }),
}));

export const toolCallsRelations = relations(toolCalls, ({ one }) => ({
    owner: one(users, {
        relationName: 'User_ToolCall',
        fields: [toolCalls.userId],
        references: [users.id],
    }),
    run: one(runs, {
        relationName: 'ToolCall_run',
        fields: [toolCalls.userId, toolCalls.runId],
        references: [runs.userId, runs.id],
    }),
}));

export const runEventsRelations = relations(runEvents, ({ one }) => ({
    owner: one(users, {
        relationName: 'User_RunEvent',
        fields: [runEvents.userId],
        references: [users.id],
    }),
    run: one(runs, {
        relationName: 'RunEvent_run',
        fields: [runEvents.userId, runEvents.runId],
        references: [runs.userId, runs.id],
    }),
}));

export const outboxRelations = relations(outbox, ({ one }) => ({
    owner: one(users, {
        relationName: 'User_Outbox',
        fields: [outbox.userId],
        references: [users.id],
    }),
    run: one(runs, {
        relationName: 'Outbox_run',
        fields: [outbox.userId, outbox.aggregateId],
        references: [runs.userId, runs.id],
    }),
}));

export const idempotencyRecordsRelations = relations(idempotencyRecords, ({ one }) => ({
    owner: one(users, {
        relationName: 'User_IdempotencyRecord',
        fields: [idempotencyRecords.userId],
        references: [users.id],
    }),
}));

export const sourcesRelations = relations(sources, ({ one, many }) => ({
    owner: one(users, {
        relationName: 'User_Source',
        fields: [sources.userId],
        references: [users.id],
    }),
    snapshots: many(sourceSnapshots, { relationName: 'SourceSnapshot_source' }),
    observations: many(runSources, { relationName: 'RunSource_source' }),
    changes: many(changeRecords, { relationName: 'ChangeRecord_source' }),
    feedback: many(feedback, { relationName: 'Feedback_source' }),
    bookmarks: many(bookmarks, { relationName: 'Bookmark_source' }),
    notes: many(notes, { relationName: 'Note_source' }),
}));

export const sourceSnapshotsRelations = relations(sourceSnapshots, ({ one, many }) => ({
    owner: one(users, {
        relationName: 'User_SourceSnapshot',
        fields: [sourceSnapshots.userId],
        references: [users.id],
    }),
    source: one(sources, {
        relationName: 'SourceSnapshot_source',
        fields: [sourceSnapshots.userId, sourceSnapshots.sourceId],
        references: [sources.userId, sources.id],
    }),
    observations: many(runSources, { relationName: 'RunSource_snapshot' }),
    oldChanges: many(changeRecords, { relationName: 'ChangeRecord_oldSnapshot' }),
    newChanges: many(changeRecords, { relationName: 'ChangeRecord_newSnapshot' }),
}));

export const runSourcesRelations = relations(runSources, ({ one, many }) => ({
    owner: one(users, {
        relationName: 'User_RunSource',
        fields: [runSources.userId],
        references: [users.id],
    }),
    run: one(runs, {
        relationName: 'RunSource_run',
        fields: [runSources.userId, runSources.runId],
        references: [runs.userId, runs.id],
    }),
    source: one(sources, {
        relationName: 'RunSource_source',
        fields: [runSources.userId, runSources.sourceId],
        references: [sources.userId, sources.id],
    }),
    snapshot: one(sourceSnapshots, {
        relationName: 'RunSource_snapshot',
        fields: [runSources.userId, runSources.sourceId, runSources.snapshotId],
        references: [sourceSnapshots.userId, sourceSnapshots.sourceId, sourceSnapshots.id],
    }),
    evidence: many(evidence, { relationName: 'Evidence_observation' }),
}));

export const evidenceRelations = relations(evidence, ({ one, many }) => ({
    owner: one(users, {
        relationName: 'User_Evidence',
        fields: [evidence.userId],
        references: [users.id],
    }),
    observation: one(runSources, {
        relationName: 'Evidence_observation',
        fields: [evidence.userId, evidence.runId, evidence.snapshotId],
        references: [runSources.userId, runSources.runId, runSources.snapshotId],
    }),
    claims: many(claimEvidence, { relationName: 'ClaimEvidence_evidence' }),
    changes: many(changeEvidence, { relationName: 'ChangeEvidence_evidence' }),
    questions: many(questionEvidence, { relationName: 'QuestionEvidence_evidence' }),
}));

export const reportsRelations = relations(reports, ({ one, many }) => ({
    owner: one(users, {
        relationName: 'User_Report',
        fields: [reports.userId],
        references: [users.id],
    }),
    run: one(runs, {
        relationName: 'Report_run',
        fields: [reports.userId, reports.runId, reports.taskId, reports.taskVersionId],
        references: [runs.userId, runs.id, runs.taskId, runs.taskVersionId],
    }),
    baseline: one(runs, {
        relationName: 'Report_baseline',
        fields: [reports.userId, reports.taskId, reports.baselineRunId],
        references: [runs.userId, runs.taskId, runs.id],
    }),
    claims: many(claims, { relationName: 'Claim_report' }),
    changes: many(changeRecords, { relationName: 'ChangeRecord_report' }),
    inboxItems: many(inboxItems, { relationName: 'InboxItem_report' }),
    notifications: many(notifications, { relationName: 'Notification_report' }),
    notes: many(notes, { relationName: 'Note_report' }),
    questions: many(reportQuestions, { relationName: 'ReportQuestion_report' }),
}));

export const claimsRelations = relations(claims, ({ one, many }) => ({
    owner: one(users, {
        relationName: 'User_Claim',
        fields: [claims.userId],
        references: [users.id],
    }),
    report: one(reports, {
        relationName: 'Claim_report',
        fields: [claims.userId, claims.taskId, claims.reportId],
        references: [reports.userId, reports.taskId, reports.id],
    }),
    citations: many(claimEvidence, { relationName: 'ClaimEvidence_claim' }),
    feedback: many(feedback, { relationName: 'Feedback_claim' }),
}));

export const claimEvidenceRelations = relations(claimEvidence, ({ one }) => ({
    owner: one(users, {
        relationName: 'User_ClaimEvidence',
        fields: [claimEvidence.userId],
        references: [users.id],
    }),
    claim: one(claims, {
        relationName: 'ClaimEvidence_claim',
        fields: [claimEvidence.userId, claimEvidence.claimId],
        references: [claims.userId, claims.id],
    }),
    evidence: one(evidence, {
        relationName: 'ClaimEvidence_evidence',
        fields: [claimEvidence.userId, claimEvidence.evidenceId],
        references: [evidence.userId, evidence.id],
    }),
}));

export const changeRecordsRelations = relations(changeRecords, ({ one, many }) => ({
    owner: one(users, {
        relationName: 'User_ChangeRecord',
        fields: [changeRecords.userId],
        references: [users.id],
    }),
    report: one(reports, {
        relationName: 'ChangeRecord_report',
        fields: [changeRecords.userId, changeRecords.reportId],
        references: [reports.userId, reports.id],
    }),
    source: one(sources, {
        relationName: 'ChangeRecord_source',
        fields: [changeRecords.userId, changeRecords.sourceId],
        references: [sources.userId, sources.id],
    }),
    oldSnapshot: one(sourceSnapshots, {
        relationName: 'ChangeRecord_oldSnapshot',
        fields: [changeRecords.userId, changeRecords.oldSourceId, changeRecords.oldSnapshotId],
        references: [sourceSnapshots.userId, sourceSnapshots.sourceId, sourceSnapshots.id],
    }),
    newSnapshot: one(sourceSnapshots, {
        relationName: 'ChangeRecord_newSnapshot',
        fields: [changeRecords.userId, changeRecords.sourceId, changeRecords.newSnapshotId],
        references: [sourceSnapshots.userId, sourceSnapshots.sourceId, sourceSnapshots.id],
    }),
    citations: many(changeEvidence, { relationName: 'ChangeEvidence_change' }),
}));

export const changeEvidenceRelations = relations(changeEvidence, ({ one }) => ({
    owner: one(users, {
        relationName: 'User_ChangeEvidence',
        fields: [changeEvidence.userId],
        references: [users.id],
    }),
    change: one(changeRecords, {
        relationName: 'ChangeEvidence_change',
        fields: [changeEvidence.userId, changeEvidence.changeRecordId],
        references: [changeRecords.userId, changeRecords.id],
    }),
    evidence: one(evidence, {
        relationName: 'ChangeEvidence_evidence',
        fields: [changeEvidence.userId, changeEvidence.evidenceId],
        references: [evidence.userId, evidence.id],
    }),
}));

export const inboxItemsRelations = relations(inboxItems, ({ one }) => ({
    owner: one(users, {
        relationName: 'User_InboxItem',
        fields: [inboxItems.userId],
        references: [users.id],
    }),
    report: one(reports, {
        relationName: 'InboxItem_report',
        fields: [inboxItems.userId, inboxItems.reportId],
        references: [reports.userId, reports.id],
    }),
}));

export const notificationsRelations = relations(notifications, ({ one }) => ({
    owner: one(users, {
        relationName: 'User_Notification',
        fields: [notifications.userId],
        references: [users.id],
    }),
    run: one(runs, {
        relationName: 'Notification_run',
        fields: [notifications.userId, notifications.runId],
        references: [runs.userId, runs.id],
    }),
    report: one(reports, {
        relationName: 'Notification_report',
        fields: [notifications.userId, notifications.runId, notifications.reportId],
        references: [reports.userId, reports.runId, reports.id],
    }),
}));

export const feedbackRelations = relations(feedback, ({ one }) => ({
    owner: one(users, {
        relationName: 'User_Feedback',
        fields: [feedback.userId],
        references: [users.id],
    }),
    task: one(tasks, {
        relationName: 'Feedback_task',
        fields: [feedback.userId, feedback.taskId],
        references: [tasks.userId, tasks.id],
    }),
    source: one(sources, {
        relationName: 'Feedback_source',
        fields: [feedback.userId, feedback.sourceId],
        references: [sources.userId, sources.id],
    }),
    claim: one(claims, {
        relationName: 'Feedback_claim',
        fields: [feedback.userId, feedback.taskId, feedback.claimId],
        references: [claims.userId, claims.taskId, claims.id],
    }),
}));

export const bookmarksRelations = relations(bookmarks, ({ one }) => ({
    owner: one(users, {
        relationName: 'User_Bookmark',
        fields: [bookmarks.userId],
        references: [users.id],
    }),
    source: one(sources, {
        relationName: 'Bookmark_source',
        fields: [bookmarks.userId, bookmarks.sourceId],
        references: [sources.userId, sources.id],
    }),
}));

export const notesRelations = relations(notes, ({ one }) => ({
    owner: one(users, {
        relationName: 'User_Note',
        fields: [notes.userId],
        references: [users.id],
    }),
    source: one(sources, {
        relationName: 'Note_source',
        fields: [notes.userId, notes.sourceId],
        references: [sources.userId, sources.id],
    }),
    report: one(reports, {
        relationName: 'Note_report',
        fields: [notes.userId, notes.reportId],
        references: [reports.userId, reports.id],
    }),
}));

export const reportQuestionsRelations = relations(reportQuestions, ({ one, many }) => ({
    owner: one(users, {
        relationName: 'User_ReportQuestion',
        fields: [reportQuestions.userId],
        references: [users.id],
    }),
    report: one(reports, {
        relationName: 'ReportQuestion_report',
        fields: [reportQuestions.userId, reportQuestions.reportId],
        references: [reports.userId, reports.id],
    }),
    followupRun: one(runs, {
        relationName: 'ReportQuestion_followupRun',
        fields: [reportQuestions.userId, reportQuestions.followupRunId],
        references: [runs.userId, runs.id],
    }),
    evidence: many(questionEvidence, { relationName: 'QuestionEvidence_question' }),
}));

export const questionEvidenceRelations = relations(questionEvidence, ({ one }) => ({
    owner: one(users, {
        relationName: 'User_QuestionEvidence',
        fields: [questionEvidence.userId],
        references: [users.id],
    }),
    question: one(reportQuestions, {
        relationName: 'QuestionEvidence_question',
        fields: [questionEvidence.userId, questionEvidence.questionId],
        references: [reportQuestions.userId, reportQuestions.id],
    }),
    evidence: one(evidence, {
        relationName: 'QuestionEvidence_evidence',
        fields: [questionEvidence.userId, questionEvidence.evidenceId],
        references: [evidence.userId, evidence.id],
    }),
}));
