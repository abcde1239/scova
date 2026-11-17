import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
    pgTable,
    uuid,
    text,
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
import { users } from './identity.ts';
import { type JsonValue, fetchStatusEnum } from './enums.ts';
import { runs } from './runs.ts';

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
