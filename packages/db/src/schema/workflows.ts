import { randomUUID } from 'node:crypto';
import {
    boolean,
    check,
    foreignKey,
    index,
    integer,
    jsonb,
    pgTable,
    text,
    timestamp,
    uniqueIndex,
    uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type {
    WorkflowBinding,
    WorkflowCanvasGraph,
    WorkflowCanvasInput,
    WorkflowGraph,
    WorkflowRun,
    WorkflowRunNode,
} from '@scova/models';
import { serviceModeEnum } from './enums.ts';
import { users } from './identity.ts';

const instant = (name: string) =>
    timestamp(name, { withTimezone: true, precision: 6, mode: 'date' });

export const workflows = pgTable(
    'workflows',
    {
        id: uuid('id').notNull().primaryKey().$defaultFn(randomUUID),
        userId: uuid('user_id')
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        title: text('title').notNull(),
        draftJson: jsonb('draft_json').$type<WorkflowGraph>().notNull(),
        revision: integer('revision').notNull().default(1),
        createdAt: instant('created_at').notNull().defaultNow(),
        updatedAt: instant('updated_at').notNull().defaultNow(),
    },
    (table) => [
        uniqueIndex('workflows_user_id_id_key').on(table.userId, table.id),
        index('workflows_user_created_idx').on(
            table.userId,
            table.createdAt.desc(),
            table.id.desc(),
        ),
        check('workflows_revision_valid', sql`${table.revision} >= 1`),
    ],
);

export const workflowVersions = pgTable(
    'workflow_versions',
    {
        id: uuid('id').notNull().primaryKey().$defaultFn(randomUUID),
        userId: uuid('user_id').notNull(),
        workflowId: uuid('workflow_id').notNull(),
        version: integer('version').notNull(),
        draftRevision: integer('draft_revision').notNull(),
        title: text('title').notNull(),
        graphJson: jsonb('graph_json').$type<WorkflowGraph>().notNull(),
        // Historical Task identities remain readable after explicit permanent Task deletion.
        bindingsJson: jsonb('bindings_json').$type<WorkflowBinding[]>().notNull(),
        publishedAt: instant('published_at').notNull().defaultNow(),
    },
    (table) => [
        uniqueIndex('workflow_versions_owner_key').on(table.userId, table.workflowId, table.id),
        uniqueIndex('workflow_versions_sequence_key').on(table.workflowId, table.version),
        uniqueIndex('workflow_versions_revision_key').on(table.workflowId, table.draftRevision),
        foreignKey({
            name: 'workflow_versions_workflow_fkey',
            columns: [table.userId, table.workflowId],
            foreignColumns: [workflows.userId, workflows.id],
        }).onDelete('cascade'),
        check(
            'workflow_versions_valid',
            sql`${table.version} >= 1 AND ${table.draftRevision} >= 1`,
        ),
    ],
);

export const workflowRuns = pgTable(
    'workflow_runs',
    {
        id: uuid('id').notNull().primaryKey().$defaultFn(randomUUID),
        userId: uuid('user_id').notNull(),
        workflowId: uuid('workflow_id').notNull(),
        versionId: uuid('version_id'),
        mode: serviceModeEnum('mode').notNull(),
        status: text('status').$type<WorkflowRun['status']>().notNull().default('queued'),
        nodesJson: jsonb('nodes_json').$type<WorkflowRunNode[]>().notNull(),
        startKeyHash: text('start_key_hash').notNull(),
        inputJson: jsonb('input_json').$type<WorkflowCanvasInput>(),
        preview: boolean('preview').notNull().default(false),
        draftPreviewJson: jsonb('draft_preview_json').$type<{
            revision: number;
            graph: WorkflowCanvasGraph;
        }>(),
        createdAt: instant('created_at').notNull().defaultNow(),
        startedAt: instant('started_at'),
        finishedAt: instant('finished_at'),
        nextCheckAt: instant('next_check_at').notNull().defaultNow(),
        failureCode: text('failure_code'),
    },
    (table) => [
        foreignKey({
            name: 'workflow_runs_version_fkey',
            columns: [table.userId, table.workflowId, table.versionId],
            foreignColumns: [
                workflowVersions.userId,
                workflowVersions.workflowId,
                workflowVersions.id,
            ],
        }).onDelete('cascade'),
        foreignKey({
            name: 'workflow_runs_workflow_fkey',
            columns: [table.userId, table.workflowId],
            foreignColumns: [workflows.userId, workflows.id],
        }).onDelete('cascade'),
        check(
            'workflow_runs_source_valid',
            sql`(version_id IS NOT NULL AND draft_preview_json IS NULL) OR (version_id IS NULL AND preview AND draft_preview_json IS NOT NULL)`,
        ),
        uniqueIndex('workflow_runs_owner_id_key').on(table.userId, table.id),
        uniqueIndex('workflow_runs_start_key').on(
            table.userId,
            table.workflowId,
            table.startKeyHash,
        ),
        index('workflow_runs_history_idx').on(
            table.userId,
            table.workflowId,
            table.createdAt.desc(),
            table.id.desc(),
        ),
        index('workflow_runs_due_idx')
            .on(table.nextCheckAt, table.id)
            .where(sql.raw("status IN ('queued', 'running', 'cancel_requested')")),
        check(
            'workflow_runs_checkpoint_valid',
            sql.raw(
                "jsonb_typeof(nodes_json) = 'array' AND status IN ('queued', 'running', 'cancel_requested', 'succeeded', 'canceled', 'failed') AND (finished_at IS NULL) = (status IN ('queued', 'running', 'cancel_requested'))",
            ),
        ),
    ],
);

export type WorkflowRow = typeof workflows.$inferSelect;
export type WorkflowVersionRow = typeof workflowVersions.$inferSelect;
export type WorkflowRunRow = typeof workflowRuns.$inferSelect;
