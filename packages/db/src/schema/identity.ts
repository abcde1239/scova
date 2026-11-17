import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
    pgTable,
    uuid,
    text,
    integer,
    boolean,
    timestamp,
    jsonb,
    index,
    uniqueIndex,
    foreignKey,
    check,
    type PgTableExtraConfigValue,
} from 'drizzle-orm/pg-core';
import { type JsonValue } from './enums.ts';

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

export const searchConfigurations = pgTable(
    'search_configurations',
    {
        userId: uuid('user_id')
            .notNull()
            .primaryKey()
            .references(() => users.id, { onDelete: 'cascade' }),
        id: uuid('id').notNull().$defaultFn(randomUUID),
        defaultMode: text('default_mode').$type<'api' | 'searxng'>().notNull(),
        protocol: text('protocol').$type<'deepseek' | 'perplexity' | 'tavily'>(),
        baseUrl: text('base_url'),
        contentMode: text('content_mode').$type<'reader' | 'prefer_api'>(),
        encryptedApiKey: text('encrypted_api_key'),
        revision: integer('revision').notNull().default(1),
        updatedAt: timestamp('updated_at', { withTimezone: true, precision: 6, mode: 'date' })
            .notNull()
            .defaultNow(),
    },
    (table) => [
        uniqueIndex('search_configurations_id_key').on(table.id),
        check('search_configuration_revision_positive', sql`${table.revision} > 0`),
        check('search_configuration_mode_valid', sql`${table.defaultMode} IN ('api', 'searxng')`),
        check(
            'search_configuration_api_complete',
            sql`(${table.protocol} IS NULL AND ${table.baseUrl} IS NULL AND ${table.contentMode} IS NULL AND ${table.encryptedApiKey} IS NULL AND ${table.defaultMode} = 'searxng') OR (${table.protocol} IS NOT NULL AND ${table.protocol} IN ('deepseek', 'perplexity', 'tavily') AND ${table.baseUrl} IS NOT NULL AND length(${table.baseUrl}) > 0 AND ${table.contentMode} IS NOT NULL AND ${table.contentMode} IN ('reader', 'prefer_api') AND ${table.encryptedApiKey} IS NOT NULL AND length(${table.encryptedApiKey}) > 0)`,
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
