import {
    databaseClock,
    isSqliteDatabase,
    queryRows,
    rowLock,
    timestampCursor,
    sql as querySql,
    and,
    eq,
    lt,
    asc,
    type DatabaseExecutor,
    type SQL,
} from '@scova/db';
import * as tables from '@scova/db';
import { randomUUID } from 'node:crypto';
import type { ApiServices } from '@/app/services';
import type { LibrarySearchQuery, LibraryTarget, NoteListQuery, NoteInput } from '@scova/models';
import type { LibraryCursor } from '@/utils/library.ts';
import { firstRow, requireRow } from '@/utils/database.ts';

const activeBody = (db: DatabaseExecutor) =>
    querySql`(ss.text_body IS NOT NULL AND (ss.text_expires_at IS NULL OR ss.text_expires_at > ${databaseClock(db, 'statement')}))`;
const latestObservation = querySql`
  JOIN run_sources observation ON observation.id = (
    SELECT rs.id FROM run_sources rs
    WHERE rs.user_id=ss.user_id AND rs.source_id=ss.source_id AND rs.snapshot_id=ss.id
      AND rs.fetch_status='succeeded' AND rs.fetched_url IS NOT NULL
    ORDER BY rs.observed_at DESC, rs.id DESC LIMIT 1
  ) AND observation.user_id=ss.user_id
  JOIN runs observation_run ON observation_run.user_id=observation.user_id AND observation_run.id=observation.run_id`;
const snapshotProjection = (db: DatabaseExecutor, includeBody: boolean) => querySql`
 ss.id, ss.user_id AS "userId", ss.source_id AS "sourceId", ss.title, ss.content_hash AS "contentHash",
 ss.extractor_version AS "extractorVersion", ss.text_expires_at AS "textExpiresAt",
 CASE WHEN ${includeBody} AND ${activeBody(db)} THEN ss.text_body ELSE NULL END AS "textBody",
 ${activeBody(db)} AS "bodyAvailable",
 s.canonical_url AS "canonicalUrl", observation.id AS "observationId", observation.run_id AS "runId",
 observation.requested_url AS "originalUrl", observation.fetched_url AS "fetchedUrl",
 observation.observed_at AS "observedAt", observation.metadata_json AS metadata, observation_run.mode,
 ${timestampCursor(db, querySql`observation.observed_at`)} AS "cursorTime"`;
const bookmarkProjection = (db: DatabaseExecutor) => querySql`
 b.id, b.source_id AS "sourceId", b.created_at AS "createdAt",
 s.canonical_url AS "canonicalUrl", latest.title, latest.snapshot_id AS "latestSnapshotId",
 latest.observed_at AS "lastObservedAt", ${timestampCursor(db, querySql`b.created_at`)} AS "cursorTime"`;
const bookmarkJoins = querySql`
 JOIN sources s ON s.user_id=b.user_id AND s.id=b.source_id
 LEFT JOIN (
   SELECT rs.id, rs.user_id, rs.snapshot_id, rs.observed_at, ss.title
   FROM run_sources rs JOIN source_snapshots ss ON ss.user_id=rs.user_id AND ss.source_id=rs.source_id AND ss.id=rs.snapshot_id
 ) latest ON latest.id = (
   SELECT rs.id FROM run_sources rs
   WHERE rs.user_id=b.user_id AND rs.source_id=b.source_id AND rs.fetch_status='succeeded' AND rs.snapshot_id IS NOT NULL
   ORDER BY rs.observed_at DESC,rs.id DESC LIMIT 1
 ) AND latest.user_id=b.user_id`;
const noteProjection = (
    db: DatabaseExecutor,
) => querySql`n.id,n.user_id AS "userId",n.source_id AS "sourceId",n.report_id AS "reportId",
 n.body,n.revision,n.created_at AS "createdAt",n.updated_at AS "updatedAt",
 ${timestampCursor(db, querySql`n.updated_at`)} AS "cursorTime"`;

async function libraryRows<T>(db: DatabaseExecutor, query: SQL) {
    const rows = await queryRows<T>(db, query);
    if (!isSqliteDatabase(db)) return rows;
    return rows.map((row) => {
        const fields = row as Record<string, unknown>;
        for (const key of [
            'createdAt',
            'updatedAt',
            'lastObservedAt',
            'textExpiresAt',
            'observedAt',
        ]) {
            if (typeof fields[key] === 'string') fields[key] = new Date(fields[key]);
        }
        if (typeof fields.metadata === 'string') fields.metadata = JSON.parse(fields.metadata);
        if (typeof fields.bodyAvailable === 'number')
            fields.bodyAvailable = Boolean(fields.bodyAvailable);
        return row;
    });
}
export interface StoredLibraryBookmark {
    id: string;
    sourceId: string;
    createdAt: Date;
    canonicalUrl: string;
    title: string | null;
    latestSnapshotId: string | null;
    lastObservedAt: Date | null;
    cursorTime: string;
}
export interface StoredLibraryNote {
    id: string;
    userId: string;
    sourceId: string | null;
    reportId: string | null;
    body: string;
    revision: number;
    createdAt: Date;
    updatedAt: Date;
    cursorTime: string;
}
export interface StoredLibrarySnapshot {
    id: string;
    userId: string;
    sourceId: string;
    title: string;
    contentHash: string;
    extractorVersion: string;
    textExpiresAt: Date | null;
    textBody: string | null;
    bodyAvailable: boolean;
    canonicalUrl: string;
    observationId: string;
    runId: string;
    originalUrl: string;
    fetchedUrl: string;
    observedAt: Date;
    metadata: tables.JsonValue;
    mode: 'demo' | 'live';
    cursorTime: string;
}
export interface StoredLibraryHit {
    kind: 'source' | 'note';
    id: string;
    sourceId: string | null;
    reportId: string | null;
    snapshotId: string | null;
    title: string;
    text: string;
    matchedBy: 'fts' | 'substring';
    updatedAt: Date;
    cursorTime: string;
}
function filterNote(query: Pick<NoteListQuery, 'sourceId' | 'reportId'>) {
    return querySql`${query.sourceId ? querySql`AND n.source_id=${query.sourceId}` : querySql.empty()}
 ${query.reportId ? querySql`AND n.report_id=${query.reportId}` : querySql.empty()}`;
}
function noteStore(tx: DatabaseExecutor) {
    return {
        async claim(userId: string, keyHash: string, payloadHash: string, expiresAt: Date) {
            const rows = await queryRows<{ id: string }>(
                tx,
                querySql`
       INSERT INTO idempotency_records(id,user_id,scope,key_hash,payload_hash,status,expires_at)
       VALUES(${randomUUID()},${userId},'notes:create',${keyHash},${payloadHash},'pending',${expiresAt})
       ON CONFLICT(user_id,scope,key_hash) DO NOTHING RETURNING id`,
            );
            const record = await tx.query.idempotencyRecords
                .findFirst({
                    where: and(
                        and(
                            eq(tables.idempotencyRecords.userId, userId),
                            eq(tables.idempotencyRecords.scope, 'notes:create'),
                            eq(tables.idempotencyRecords.keyHash, keyHash),
                        ),
                    ),
                })
                .then(requireRow);
            return { record, created: rows.length === 1 };
        },
        find: (userId: string, id: string) =>
            tx.query.notes
                .findFirst({ where: and(eq(tables.notes.userId, userId), eq(tables.notes.id, id)) })
                .then((row) => row ?? null),
        create: (userId: string, input: NoteInput) =>
            tx
                .insert(tables.notes)
                .values({
                    userId,
                    body: input.body,
                    ...(input.target.kind === 'source'
                        ? { sourceId: input.target.id }
                        : { reportId: input.target.id }),
                })
                .returning()
                .then(firstRow),
        complete: (id: string, resourceId: string) =>
            tx
                .update(tables.idempotencyRecords)
                .set({ status: 'completed', resourceId: resourceId, responseCode: 201 })
                .where(and(eq(tables.idempotencyRecords.id, id)))
                .returning()
                .then(firstRow),
    };
}

/** Owner is required in every public operation; no network fetching or Source/Report hard deletion. */
export function createLibraryRepo(services: Pick<ApiServices, 'db'>) {
    return {
        async target(userId: string, target: LibraryTarget) {
            return target.kind === 'source'
                ? services
                      .db()
                      .query.sources.findFirst({
                          where: and(
                              eq(tables.sources.id, target.id),
                              eq(tables.sources.userId, userId),
                          ),
                          columns: { id: true },
                      })
                      .then((row) => row ?? null)
                : services
                      .db()
                      .query.reports.findFirst({
                          where: and(
                              eq(tables.reports.id, target.id),
                              eq(tables.reports.userId, userId),
                          ),
                          columns: { id: true },
                      })
                      .then((row) => row ?? null);
        },
        async bookmark(userId: string, id: string) {
            const [row] = await libraryRows<StoredLibraryBookmark>(
                services.db(),
                querySql`
       SELECT ${bookmarkProjection(services.db())} FROM bookmarks b ${bookmarkJoins}
       WHERE b.user_id=${userId} AND b.id=${id}`,
            );
            return row;
        },
        async createBookmark(userId: string, sourceId: string) {
            return services.db().transaction(async (tx) => {
                const rows = await queryRows<{ id: string }>(
                    tx,
                    querySql`
         INSERT INTO bookmarks(id,user_id,source_id) VALUES(${randomUUID()},${userId},${sourceId})
         ON CONFLICT(user_id,source_id) DO NOTHING RETURNING id`,
                );
                const row = await tx.query.bookmarks
                    .findFirst({
                        where: and(
                            and(
                                eq(tables.bookmarks.userId, userId),
                                eq(tables.bookmarks.sourceId, sourceId),
                            ),
                        ),
                    })
                    .then(requireRow);
                return { id: row.id, reused: rows.length === 0 };
            });
        },
        async bookmarks(userId: string, take: number, cursor?: LibraryCursor) {
            const boundary = cursor
                ? querySql`AND (b.created_at,b.id)<(${cursor.time},${cursor.id})`
                : querySql.empty();
            return libraryRows<StoredLibraryBookmark>(
                services.db(),
                querySql`
       SELECT ${bookmarkProjection(services.db())} FROM bookmarks b ${bookmarkJoins}
       WHERE b.user_id=${userId} ${boundary} ORDER BY b.created_at DESC,b.id DESC LIMIT ${take}`,
            );
        },
        async bookmarkAnchor(userId: string, cursor: LibraryCursor) {
            return (
                (
                    await queryRows<{ id: string }>(
                        services.db(),
                        querySql`SELECT id FROM bookmarks
       WHERE user_id=${userId} AND id=${cursor.id} AND created_at=${cursor.time}`,
                    )
                ).length === 1
            );
        },
        deleteBookmark: (userId: string, id: string) =>
            services
                .db()
                .delete(tables.bookmarks)
                .where(and(eq(tables.bookmarks.userId, userId), eq(tables.bookmarks.id, id)))
                .returning()
                .then((rows) => ({ count: rows.length })),
        noteCommand: <T>(work: (store: ReturnType<typeof noteStore>) => Promise<T>) =>
            services.db().transaction((tx) => work(noteStore(tx))),
        async note(userId: string, id: string) {
            const [row] = await libraryRows<StoredLibraryNote>(
                services.db(),
                querySql`
       SELECT ${noteProjection(services.db())} FROM notes n WHERE n.user_id=${userId} AND n.id=${id}`,
            );
            return row;
        },
        async notes(userId: string, query: NoteListQuery, take: number, cursor?: LibraryCursor) {
            const boundary = cursor
                ? querySql`AND (n.updated_at,n.id)<(${cursor.time},${cursor.id})`
                : querySql.empty();
            return libraryRows<StoredLibraryNote>(
                services.db(),
                querySql`SELECT ${noteProjection(services.db())} FROM notes n
       WHERE n.user_id=${userId} ${filterNote(query)} ${boundary} ORDER BY n.updated_at DESC,n.id DESC LIMIT ${take}`,
            );
        },
        async noteAnchor(userId: string, query: NoteListQuery, cursor: LibraryCursor) {
            return (
                (
                    await queryRows<{ id: string }>(
                        services.db(),
                        querySql`SELECT n.id FROM notes n WHERE n.user_id=${userId}
       AND n.id=${cursor.id} AND n.updated_at=${cursor.time} ${filterNote(query)}`,
                    )
                ).length === 1
            );
        },
        async changeNote(userId: string, id: string, revision: number, body?: string) {
            return services.db().transaction(async (tx) => {
                const changed =
                    body === undefined
                        ? await tx
                              .delete(tables.notes)
                              .where(
                                  and(
                                      eq(tables.notes.userId, userId),
                                      eq(tables.notes.id, id),
                                      eq(tables.notes.revision, revision),
                                  ),
                              )
                              .returning()
                              .then((rows) => ({ count: rows.length }))
                        : await tx
                              .update(tables.notes)
                              .set({
                                  body: body,
                                  revision: querySql`${tables.notes.revision} + ${1}`,
                              })
                              .where(
                                  and(
                                      eq(tables.notes.userId, userId),
                                      eq(tables.notes.id, id),
                                      eq(tables.notes.revision, revision),
                                      and(and(lt(tables.notes.revision, 2147483647))),
                                  ),
                              )
                              .returning()
                              .then((rows) => ({ count: rows.length }));
                return {
                    changed: changed.count === 1,
                    current: await tx.query.notes
                        .findFirst({
                            where: and(eq(tables.notes.userId, userId), eq(tables.notes.id, id)),
                        })
                        .then((row) => row ?? null),
                };
            });
        },
        async snapshots(userId: string, sourceId: string, take: number, cursor?: LibraryCursor) {
            const boundary = cursor
                ? querySql`AND (observation.observed_at,ss.id)<(${cursor.time},${cursor.id})`
                : querySql.empty();
            return libraryRows<StoredLibrarySnapshot>(
                services.db(),
                querySql`
       SELECT ${snapshotProjection(services.db(), false)} FROM source_snapshots ss
       JOIN sources s ON s.user_id=ss.user_id AND s.id=ss.source_id ${latestObservation}
       WHERE ss.user_id=${userId} AND ss.source_id=${sourceId} ${boundary}
       ORDER BY observation.observed_at DESC,ss.id DESC LIMIT ${take}`,
            );
        },
        async snapshot(userId: string, sourceId: string, id: string) {
            const [row] = await libraryRows<StoredLibrarySnapshot>(
                services.db(),
                querySql`
       SELECT ${snapshotProjection(services.db(), true)} FROM source_snapshots ss
       JOIN sources s ON s.user_id=ss.user_id AND s.id=ss.source_id ${latestObservation}
       WHERE ss.user_id=${userId} AND ss.source_id=${sourceId} AND ss.id=${id}`,
            );
            return row;
        },
        async snapshotAnchor(userId: string, sourceId: string, cursor: LibraryCursor) {
            const rows = await queryRows<{ id: string }>(
                services.db(),
                querySql`
       SELECT ss.id FROM source_snapshots ss ${latestObservation}
       WHERE ss.user_id=${userId} AND ss.source_id=${sourceId} AND ss.id=${cursor.id}
       AND observation.observed_at=${cursor.time}`,
            );
            return rows.length === 1;
        },
        quotes(userId: string, sourceId: string, snapshotId: string) {
            return services
                .db()
                .select({ evidence: tables.evidence })
                .from(tables.evidence)
                .innerJoin(
                    tables.runSources,
                    and(
                        eq(tables.evidence.userId, tables.runSources.userId),
                        eq(tables.evidence.runId, tables.runSources.runId),
                        eq(tables.evidence.snapshotId, tables.runSources.snapshotId),
                    ),
                )
                .innerJoin(
                    tables.runs,
                    and(
                        eq(tables.runSources.userId, tables.runs.userId),
                        eq(tables.runSources.runId, tables.runs.id),
                    ),
                )
                .where(
                    and(
                        eq(tables.evidence.userId, userId),
                        eq(tables.evidence.snapshotId, snapshotId),
                        eq(tables.runSources.userId, userId),
                        eq(tables.runSources.sourceId, sourceId),
                        eq(tables.runSources.snapshotId, snapshotId),
                        eq(tables.runSources.fetchStatus, 'succeeded'),
                        eq(tables.runs.userId, userId),
                    ),
                )
                .orderBy(asc(tables.evidence.capturedAt), asc(tables.evidence.id))
                .limit(101)
                .then((rows) => rows.map((row) => row.evidence));
        },
        async search(
            userId: string,
            query: LibrarySearchQuery,
            terms: string[],
            take: number,
            cursor?: LibraryCursor,
        ) {
            const db = services.db();
            const sqlite = isSqliteDatabase(db);
            const position = (text: SQL, term: string) =>
                sqlite
                    ? querySql`instr(lower(${text}), lower(${term}))`
                    : querySql`strpos(lower(${text}), lower(${term}))`;
            const tsquery = querySql`plainto_tsquery('simple'::regconfig,${query.q})`;
            const titleFts = querySql`to_tsvector('simple'::regconfig,coalesce(ss.title,'')) @@ ${tsquery}`;
            const fullFts = querySql`(${activeBody(db)} AND to_tsvector('simple'::regconfig,coalesce(ss.title,'') || ' ' || coalesce(ss.text_body,'')) @@ ${tsquery})`;
            const sourceFts = sqlite ? querySql`false` : querySql`(${titleFts} OR ${fullFts})`;
            const sourceText = querySql`(coalesce(ss.title,'') || ' ' || CASE WHEN ${activeBody(db)} THEN ss.text_body ELSE '' END)`;
            const sourceSub = querySql.join(
                terms.map((term) => querySql`${position(sourceText, term)}>0`),
                querySql.raw(' AND '),
            );
            const noteFts = sqlite
                ? querySql`false`
                : querySql`to_tsvector('simple'::regconfig,n.body) @@ ${tsquery}`;
            const noteSub = querySql.join(
                terms.map((term) => querySql`${position(querySql`n.body`, term)}>0`),
                querySql.raw(' AND '),
            );
            const bookmarkFilter =
                query.bookmarked === undefined
                    ? querySql.empty()
                    : querySql`AND ${query.bookmarked ? querySql.empty() : querySql`NOT`} EXISTS(SELECT 1 FROM bookmarks b WHERE b.user_id=ss.user_id AND b.source_id=ss.source_id)`;
            const noteBookmark =
                query.bookmarked === undefined
                    ? querySql.empty()
                    : querySql`AND ${query.bookmarked ? querySql.empty() : querySql`NOT`} EXISTS(SELECT 1 FROM bookmarks b WHERE b.user_id=n.user_id AND b.source_id=n.source_id)`;
            const kind = query.kind ? querySql`AND kind=${query.kind}` : querySql.empty();
            const boundary = cursor
                ? querySql`AND (time,kind,id)<(${cursor.time},${cursor.kind},${cursor.id})`
                : querySql.empty();
            return services.db().transaction(async (tx) => {
                if (!isSqliteDatabase(tx))
                    await tx.execute(querySql`SELECT set_config('statement_timeout','3000',true)`);
                return libraryRows<StoredLibraryHit>(
                    tx,
                    querySql`
       WITH hits AS (
         SELECT 'source' AS kind,ss.id,ss.source_id AS "sourceId",NULL AS "reportId",ss.id AS "snapshotId",
           ss.title,${sourceText} AS text,CASE WHEN ${sourceFts} THEN 'fts' ELSE 'substring' END AS "matchedBy",
           observation.observed_at AS time
         FROM source_snapshots ss ${latestObservation}
         WHERE ss.user_id=${userId} ${bookmarkFilter} AND (${sourceFts} OR (${sourceSub}))
         UNION ALL
         SELECT 'note',n.id,n.source_id,n.report_id,NULL,coalesce(r.title,s.canonical_url,'笔记'),n.body,
           CASE WHEN ${noteFts} THEN 'fts' ELSE 'substring' END,n.updated_at
         FROM notes n LEFT JOIN sources s ON s.user_id=n.user_id AND s.id=n.source_id
           LEFT JOIN reports r ON r.user_id=n.user_id AND r.id=n.report_id
         WHERE n.user_id=${userId} ${noteBookmark} AND (${noteFts} OR (${noteSub}))
       )
       SELECT kind,id,"sourceId","reportId","snapshotId",title,
         ${
             sqlite
                 ? querySql`substr(text, max(1, ${position(querySql`text`, terms[0])}-80), 500)`
                 : querySql`substr(text, greatest(1, ${position(querySql`text`, terms[0])}-80), 500)`
         } AS text,
         "matchedBy",time AS "updatedAt",
         ${timestampCursor(tx, querySql`time`)} AS "cursorTime"
       FROM hits WHERE true ${kind} ${boundary} ORDER BY time DESC,kind DESC,id DESC LIMIT ${take}`,
                );
            });
        },
        async searchAnchor(userId: string, query: LibrarySearchQuery, cursor: LibraryCursor) {
            if (cursor.kind === 'note') return this.noteAnchor(userId, {}, cursor);
            if (cursor.kind !== 'source') return false;
            const [row] = await queryRows<{ sourceId: string }>(
                services.db(),
                querySql`SELECT source_id AS "sourceId" FROM source_snapshots WHERE user_id=${userId} AND id=${cursor.id}`,
            );
            return row ? this.snapshotAnchor(userId, row.sourceId, cursor) : false;
        },
        async purgeExpiredBodies(limit: number, userId?: string) {
            return services.db().transaction(async (tx) => {
                if (!isSqliteDatabase(tx))
                    await tx.execute(querySql`SELECT set_config('statement_timeout','3000',true)`);
                const rows = await queryRows<{ id: string }>(
                    tx,
                    querySql`
         UPDATE source_snapshots SET text_body=NULL WHERE id IN (
           SELECT id FROM source_snapshots WHERE text_body IS NOT NULL AND text_expires_at<=${databaseClock(tx)}
           ${userId ? querySql`AND user_id=${userId}` : querySql.empty()}
           ORDER BY text_expires_at,id LIMIT ${limit} ${rowLock(tx, 'update', true)}
         ) RETURNING id`,
                );
                return { cleared: rows.length };
            });
        },
    };
}
