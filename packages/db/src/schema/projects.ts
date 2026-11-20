import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
    check,
    foreignKey,
    index,
    pgTable,
    primaryKey,
    text,
    timestamp,
    uniqueIndex,
    uuid,
} from 'drizzle-orm/pg-core';
import { users } from './identity.ts';
import { tasks } from './tasks.ts';

export const projects = pgTable(
    'projects',
    {
        id: uuid('id').primaryKey().$defaultFn(randomUUID),
        userId: uuid('user_id').notNull(),
        name: text('name').notNull(),
        createdAt: timestamp('created_at', { withTimezone: true, precision: 6, mode: 'date' })
            .notNull()
            .defaultNow(),
    },
    (table) => [
        uniqueIndex('projects_user_id_id_key').on(table.userId, table.id),
        index('projects_owner_page_idx').on(table.userId, table.createdAt.desc(), table.id.desc()),
        foreignKey({
            name: 'projects_user_id_fkey',
            columns: [table.userId],
            foreignColumns: [users.id],
        }).onDelete('cascade'),
        check('projects_name_nonempty', sql.raw('length(btrim(name)) > 0')),
    ],
);

export const projectTasks = pgTable(
    'project_tasks',
    {
        userId: uuid('user_id').notNull(),
        taskId: uuid('task_id').notNull(),
        projectId: uuid('project_id').notNull(),
    },
    (table) => [
        primaryKey({ name: 'project_tasks_pkey', columns: [table.userId, table.taskId] }),
        index('project_tasks_project_idx').on(table.userId, table.projectId, table.taskId),
        foreignKey({
            name: 'project_tasks_project_fkey',
            columns: [table.userId, table.projectId],
            foreignColumns: [projects.userId, projects.id],
        }).onDelete('cascade'),
        foreignKey({
            name: 'project_tasks_task_fkey',
            columns: [table.userId, table.taskId],
            foreignColumns: [tasks.userId, tasks.id],
        }).onDelete('cascade'),
    ],
);
