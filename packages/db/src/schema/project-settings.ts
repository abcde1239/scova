import { sql } from 'drizzle-orm';
import {
    check,
    foreignKey,
    jsonb,
    pgTable,
    primaryKey,
    text,
    timestamp,
    uuid,
} from 'drizzle-orm/pg-core';
import { projects } from './projects.ts';

export const projectSettings = pgTable(
    'project_settings',
    {
        userId: uuid('user_id').notNull(),
        projectId: uuid('project_id').notNull(),
        goal: text('goal').notNull().default(''),
        requirements: text('requirements').notNull().default(''),
        preferredSources: jsonb('preferred_sources').$type<string[]>().notNull().default([]),
        defaultAutonomy: text('default_autonomy', { enum: ['ask', 'budgeted', 'autonomous'] })
            .notNull()
            .default('budgeted'),
        updatedAt: timestamp('updated_at', { withTimezone: true, precision: 6, mode: 'date' })
            .notNull()
            .defaultNow(),
    },
    (table) => [
        primaryKey({ name: 'project_settings_pkey', columns: [table.userId, table.projectId] }),
        foreignKey({
            name: 'project_settings_project_fkey',
            columns: [table.userId, table.projectId],
            foreignColumns: [projects.userId, projects.id],
        }).onDelete('cascade'),
        check('project_settings_goal_length', sql`char_length(${table.goal}) <= 600`),
        check(
            'project_settings_requirements_length',
            sql`char_length(${table.requirements}) <= 1200`,
        ),
        check(
            'project_settings_source_count',
            sql`CASE WHEN jsonb_typeof(${table.preferredSources}) = 'array' THEN jsonb_array_length(${table.preferredSources}) <= 8 ELSE false END`,
        ),
        check(
            'project_settings_autonomy_valid',
            sql`${table.defaultAutonomy} IN ('ask', 'budgeted', 'autonomous')`,
        ),
    ],
);
