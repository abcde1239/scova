import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
    foreignKey,
    index,
    jsonb,
    pgTable,
    text,
    timestamp,
    uniqueIndex,
    uuid,
    integer,
} from 'drizzle-orm/pg-core';
import type { TaskConfig } from '@scova/models';
import { projects } from './projects.ts';

export const projectResearchDrafts = pgTable(
    'project_research_drafts',
    {
        id: uuid('id').primaryKey().$defaultFn(randomUUID),
        userId: uuid('user_id').notNull(),
        projectId: uuid('project_id').notNull(),
        revision: integer('revision').notNull().default(1),
        config: jsonb('config').$type<TaskConfig>().notNull(),
        confirmedTaskId: uuid('confirmed_task_id'),
        confirmedRunId: uuid('confirmed_run_id'),
        confirmedStart: integer('confirmed_start'),
    },
    (table) => [
        index('project_research_drafts_project_idx').on(table.userId, table.projectId),
        foreignKey({
            name: 'project_research_drafts_project_fkey',
            columns: [table.userId, table.projectId],
            foreignColumns: [projects.userId, projects.id],
        }).onDelete('cascade'),
    ],
);

export const projectConversationTurns = pgTable(
    'project_conversation_turns',
    {
        id: uuid('id').primaryKey(),
        userId: uuid('user_id').notNull(),
        projectId: uuid('project_id').notNull(),
        input: jsonb('input')
            .$type<{
                message: string;
                kind: 'ask' | 'draft';
                reportId?: string;
                draftId?: string;
                revision?: number;
            }>()
            .notNull(),
        status: text('status').$type<'running' | 'completed' | 'failed' | 'canceled'>().notNull(),
        answer: text('answer'),
        draftId: uuid('draft_id'),
        createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
        expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    },
    (table) => [
        index('project_conversation_turns_project_idx').on(
            table.userId,
            table.projectId,
            table.createdAt.desc(),
            table.id.desc(),
        ),
        uniqueIndex('project_conversation_turns_running_key')
            .on(table.userId, table.projectId)
            .where(sql`status = 'running'`),
        foreignKey({
            name: 'project_conversation_turns_project_fkey',
            columns: [table.userId, table.projectId],
            foreignColumns: [projects.userId, projects.id],
        }).onDelete('cascade'),
    ],
);
