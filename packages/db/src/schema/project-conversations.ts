import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
    boolean,
    check,
    foreignKey,
    index,
    integer,
    jsonb,
    pgTable,
    primaryKey,
    text,
    timestamp,
    uniqueIndex,
    uuid,
} from 'drizzle-orm/pg-core';
import type { ProjectThreadItem, SendProjectTurn, TaskConfig } from '@scova/models';
import { projects } from './projects.ts';
import { runs } from './runs.ts';

export const projectResearchDrafts = pgTable(
    'project_research_drafts',
    {
        id: uuid('id').primaryKey().$defaultFn(randomUUID),
        userId: uuid('user_id').notNull(),
        projectId: uuid('project_id').notNull(),
        threadId: uuid('thread_id').notNull(),
        revision: integer('revision').notNull().default(1),
        config: jsonb('config').$type<TaskConfig>().notNull(),
        confirmedTaskId: uuid('confirmed_task_id'),
        confirmedRunId: uuid('confirmed_run_id'),
        confirmedStart: integer('confirmed_start'),
    },
    (table) => [
        index('project_research_drafts_thread_idx').on(
            table.userId,
            table.projectId,
            table.threadId,
        ),
        foreignKey({
            name: 'project_research_drafts_owner_thread_fkey',
            columns: [table.userId, table.projectId, table.threadId],
            foreignColumns: [projectThreads.userId, projectThreads.projectId, projectThreads.id],
        }).onDelete('cascade'),
        foreignKey({
            name: 'project_research_drafts_project_fkey',
            columns: [table.userId, table.projectId],
            foreignColumns: [projects.userId, projects.id],
        }).onDelete('cascade'),
    ],
);

export const projectThreads = pgTable(
    'project_threads',
    {
        id: uuid('id').primaryKey().$defaultFn(randomUUID),
        userId: uuid('user_id').notNull(),
        projectId: uuid('project_id').notNull(),
        title: text('title').notNull(),
        isDefault: boolean('is_default').notNull().default(false),
        archivedAt: timestamp('archived_at', { withTimezone: true, mode: 'date' }),
        lastActivityAt: timestamp('last_activity_at', { withTimezone: true, mode: 'date' })
            .notNull()
            .defaultNow(),
        createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
            .notNull()
            .defaultNow(),
    },
    (table) => [
        foreignKey({
            name: 'project_threads_owner_project_fkey',
            columns: [table.userId, table.projectId],
            foreignColumns: [projects.userId, projects.id],
        }).onDelete('cascade'),
        uniqueIndex('project_threads_owner_project_id_key').on(
            table.userId,
            table.projectId,
            table.id,
        ),
        uniqueIndex('project_threads_owner_id_key').on(table.userId, table.id),
        uniqueIndex('project_threads_default_key')
            .on(table.userId, table.projectId)
            .where(sql`is_default`),
        index('project_threads_project_activity_idx').on(
            table.userId,
            table.projectId,
            table.lastActivityAt.desc(),
            table.id.desc(),
        ),
    ],
);

export type ProjectThreadRow = typeof projectThreads.$inferSelect;

export const projectConversationTurns = pgTable(
    'project_conversation_turns',
    {
        id: uuid('id').primaryKey(),
        userId: uuid('user_id').notNull(),
        projectId: uuid('project_id').notNull(),
        threadId: uuid('thread_id').notNull(),
        input: jsonb('input')
            .$type<{
                message: string;
                kind: 'ask' | 'draft' | 'auto';
                refs?: SendProjectTurn['refs'];
                autonomy?: SendProjectTurn['autonomy'];
                autonomyOverride?: SendProjectTurn['autonomy'];
                reportId?: string;
                draftId?: string;
                revision?: number;
            }>()
            .notNull(),
        status: text('status').$type<'running' | 'completed' | 'failed' | 'canceled'>().notNull(),
        answer: text('answer'),
        draftId: uuid('draft_id'),
        createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
        expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
        executionDeadlineAt: timestamp('execution_deadline_at', {
            withTimezone: true,
            mode: 'date',
        }),
    },
    (table) => [
        index('project_conversation_turns_project_idx').on(
            table.userId,
            table.projectId,
            table.createdAt.desc(),
            table.id.desc(),
        ),
        uniqueIndex('project_conversation_turns_owner_thread_id_key').on(
            table.userId,
            table.threadId,
            table.id,
        ),
        foreignKey({
            name: 'project_conversation_turns_owner_thread_fkey',
            columns: [table.userId, table.projectId, table.threadId],
            foreignColumns: [projectThreads.userId, projectThreads.projectId, projectThreads.id],
        }).onDelete('cascade'),
        uniqueIndex('project_conversation_turns_running_key')
            .on(table.userId, table.threadId)
            .where(sql`status = 'running'`),
        index('project_conversation_turns_running_deadline_idx')
            .on(table.executionDeadlineAt)
            .where(sql`status = 'running'`),
        foreignKey({
            name: 'project_conversation_turns_project_fkey',
            columns: [table.userId, table.projectId],
            foreignColumns: [projects.userId, projects.id],
        }).onDelete('cascade'),
    ],
);

export const projectThreadItems = pgTable(
    'project_thread_items',
    {
        id: uuid('id').primaryKey().$defaultFn(randomUUID),
        userId: uuid('user_id').notNull(),
        threadId: uuid('thread_id').notNull(),
        turnId: uuid('turn_id'),
        seq: integer('seq').notNull(),
        kind: text('kind').$type<ProjectThreadItem['kind']>().notNull(),
        payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
        refs: jsonb('refs').$type<unknown[]>().notNull().default([]),
        status: text('status'),
        createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
            .notNull()
            .defaultNow(),
    },
    (table) => [
        foreignKey({
            name: 'project_thread_items_owner_thread_fkey',
            columns: [table.userId, table.threadId],
            foreignColumns: [projectThreads.userId, projectThreads.id],
        }).onDelete('cascade'),
        // Migration SQL restricts SET NULL to turn_id, which Drizzle cannot express.
        foreignKey({
            name: 'project_thread_items_owner_turn_fkey',
            columns: [table.userId, table.threadId, table.turnId],
            foreignColumns: [
                projectConversationTurns.userId,
                projectConversationTurns.threadId,
                projectConversationTurns.id,
            ],
        }).onDelete('set null'),
        uniqueIndex('project_thread_items_thread_seq_key').on(table.threadId, table.seq),
        index('project_thread_items_owner_turn_idx').on(table.userId, table.threadId, table.turnId),
        check('project_thread_items_seq_positive', sql`seq > 0`),
    ],
);

export type ProjectThreadItemRow = typeof projectThreadItems.$inferSelect;

export const projectThreadRunOrigins = pgTable(
    'project_thread_run_origins',
    {
        userId: uuid('user_id').notNull(),
        runId: uuid('run_id').notNull(),
        projectId: uuid('project_id').notNull(),
        threadId: uuid('thread_id').notNull(),
        draftId: uuid('draft_id').notNull(),
        draftRevision: integer('draft_revision').notNull(),
    },
    (table) => [
        primaryKey({ columns: [table.userId, table.runId] }),
        index('project_thread_run_origins_owner_thread_idx').on(
            table.userId,
            table.projectId,
            table.threadId,
        ),
        foreignKey({
            name: 'project_thread_run_origins_owner_run_fkey',
            columns: [table.userId, table.runId],
            foreignColumns: [runs.userId, runs.id],
        }).onDelete('cascade'),
        foreignKey({
            name: 'project_thread_run_origins_owner_thread_fkey',
            columns: [table.userId, table.projectId, table.threadId],
            foreignColumns: [projectThreads.userId, projectThreads.projectId, projectThreads.id],
        }).onDelete('cascade'),
    ],
);
