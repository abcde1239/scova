import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
    check,
    foreignKey,
    index,
    integer,
    jsonb,
    pgTable,
    primaryKey,
    text,
    timestamp,
    uuid,
} from 'drizzle-orm/pg-core';
import type { WorkflowCanvasGraph, WorkflowTemplateField } from '@scova/models';
import { users } from './identity.ts';
import { workflowVersions } from './workflows.ts';

export const workflowTemplates = pgTable(
    'workflow_templates',
    {
        id: uuid('id').primaryKey().$defaultFn(randomUUID),
        userId: uuid('user_id')
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        version: integer('version').notNull().default(1),
        title: text('title').notNull(),
        description: text('description').notNull(),
        delivery: text('delivery').notNull(),
        graphJson: jsonb('graph_json').$type<WorkflowCanvasGraph>().notNull(),
        fieldsJson: jsonb('fields_json').$type<WorkflowTemplateField[]>().notNull(),
        createdAt: timestamp('created_at', { withTimezone: true, precision: 6, mode: 'date' })
            .notNull()
            .defaultNow(),
    },
    (table) => [
        check('workflow_templates_version_valid', sql`${table.version} >= 1`),
        index('workflow_templates_user_created_idx').on(
            table.userId,
            table.createdAt.desc(),
            table.id.desc(),
        ),
    ],
);

// Built-in identities are code-owned. Both template kinds pin one owner-scoped workflow version.
export const workflowTemplateExecutions = pgTable(
    'workflow_template_executions',
    {
        userId: uuid('user_id').notNull(),
        templateId: uuid('template_id').notNull(),
        templateVersion: integer('template_version').notNull(),
        workflowId: uuid('workflow_id').notNull(),
        versionId: uuid('version_id').notNull(),
    },
    (table) => [
        primaryKey({ columns: [table.userId, table.templateId, table.templateVersion] }),
        index('workflow_template_executions_workflow_idx').on(table.userId, table.workflowId),
        check('workflow_template_executions_version_valid', sql`${table.templateVersion} >= 1`),
        foreignKey({
            name: 'workflow_template_executions_version_fkey',
            columns: [table.userId, table.workflowId, table.versionId],
            foreignColumns: [
                workflowVersions.userId,
                workflowVersions.workflowId,
                workflowVersions.id,
            ],
        }).onDelete('cascade'),
    ],
);
