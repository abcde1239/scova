import { randomUUID } from 'node:crypto';
import { Prisma } from '@scova/db';
import type { ApiServices } from '@/app/context.ts';
import type { LibrarySearchQuery, LibraryTarget, NoteListQuery, NoteInput } from '@scova/models';
import type { LibraryCursor } from '@/utils/library.ts';

const timeText = (column: Prisma.Sql) =>
    Prisma.sql`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const activeBody = Prisma.sql`(ss.text_body IS NOT NULL AND (ss.text_expires_at IS NULL OR ss.text_expires_at > statement_timestamp()))`;
const latestObservation = Prisma.sql`
  JOIN LATERAL (
    SELECT rs.id, rs.run_id, rs.observed_at, rs.requested_url, rs.fetched_url, rs.metadata_json, r.mode
    FROM run_sources rs JOIN runs r ON r.user_id=rs.user_id AND r.id=rs.run_id
    WHERE rs.user_id=ss.user_id AND rs.source_id=ss.source_id AND rs.snapshot_id=ss.id
      AND rs.fetch_status='succeeded' AND rs.fetched_url IS NOT NULL
    ORDER BY rs.observed_at DESC, rs.id DESC LIMIT 1
  ) observation ON true`;
const snapshotProjection = (includeBody: boolean) => Prisma.sql`
 ss.id, ss.user_id AS "userId", ss.source_id AS "sourceId", ss.title, ss.content_hash AS "contentHash",
 ss.extractor_version AS "extractorVersion", ss.text_expires_at AS "textExpiresAt",
 CASE WHEN ${includeBody}::boolean AND ${activeBody} THEN ss.text_body ELSE NULL END AS "textBody",
 ${activeBody} AS "bodyAvailable",
 s.canonical_url AS "canonicalUrl", observation.id AS "observationId", observation.run_id AS "runId",
 observation.requested_url AS "originalUrl", observation.fetched_url AS "fetchedUrl",
 observation.observed_at AS "observedAt", observation.metadata_json AS metadata, observation.mode,
 ${timeText(Prisma.sql`observation.observed_at`)} AS "cursorTime"`;
const bookmarkProjection = Prisma.sql`
 b.id, b.source_id AS "sourceId", b.created_at AS "createdAt",
 s.canonical_url AS "canonicalUrl", latest.title, latest.snapshot_id AS "latestSnapshotId",
 latest.observed_at AS "lastObservedAt", ${timeText(Prisma.sql`b.created_at`)} AS "cursorTime"`;
const bookmarkJoins = Prisma.sql`
 JOIN sources s ON s.user_id=b.user_id AND s.id=b.source_id
 LEFT JOIN LATERAL (
   SELECT rs.snapshot_id, rs.observed_at, ss.title
   FROM run_sources rs JOIN source_snapshots ss ON ss.user_id=rs.user_id AND ss.source_id=rs.source_id AND ss.id=rs.snapshot_id
   JOIN runs r ON r.user_id=rs.user_id AND r.id=rs.run_id
   WHERE rs.user_id=b.user_id AND rs.source_id=b.source_id AND rs.fetch_status='succeeded'
   ORDER BY rs.observed_at DESC,rs.id DESC LIMIT 1
 ) latest ON true`;
const noteProjection = Prisma.sql`n.id,n.user_id AS "userId",n.source_id AS "sourceId",n.report_id AS "reportId",
 n.body,n.revision,n.created_at AS "createdAt",n.updated_at AS "updatedAt",
 ${timeText(Prisma.sql`n.updated_at`)} AS "cursorTime"`;
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
    metadata: Prisma.JsonValue;
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
    return Prisma.sql`${query.sourceId ? Prisma.sql`AND n.source_id=${query.sourceId}::uuid` : Prisma.empty}
 ${query.reportId ? Prisma.sql`AND n.report_id=${query.reportId}::uuid` : Prisma.empty}`;
}
function noteStore(tx: Prisma.TransactionClient) {
    return {
        async claim(userId: string, keyHash: string, payloadHash: string, expiresAt: Date) {
            const rows = await tx.$queryRaw<{ id: string }[]>`
       INSERT INTO idempotency_records(id,user_id,scope,key_hash,payload_hash,status,expires_at)
       VALUES(${randomUUID()}::uuid,${userId}::uuid,'notes:create',${keyHash},${payloadHash},'pending',${expiresAt})
       ON CONFLICT(user_id,scope,key_hash) DO NOTHING RETURNING id`;
            const record = await tx.idempotencyRecord.findUniqueOrThrow({
                where: { userId_scope_keyHash: { userId, scope: 'notes:create', keyHash } },
            });
            return { record, created: rows.length === 1 };
        },
        find: (userId: string, id: string) => tx.note.findFirst({ where: { userId, id } }),
        create: (userId: string, input: NoteInput) =>
            tx.note.create({
                data: {
                    userId,
                    body: input.body,
                    ...(input.target.kind === 'source'
                        ? { sourceId: input.target.id }
                        : { reportId: input.target.id }),
                },
            }),
        complete: (id: string, resourceId: string) =>
            tx.idempotencyRecord.update({
                where: { id },
                data: { status: 'completed', resourceId, responseCode: 201 },
            }),
    };
}

/** Owner is required in every public operation; no network fetching or Source/Report hard deletion. */
export function createLibraryRepo(services: Pick<ApiServices, 'db'>) {
    return {
        async target(userId: string, target: LibraryTarget) {
            return target.kind === 'source'
                ? services
                      .db()
                      .source.findFirst({ where: { id: target.id, userId }, select: { id: true } })
                : services
                      .db()
                      .report.findFirst({ where: { id: target.id, userId }, select: { id: true } });
        },
        async bookmark(userId: string, id: string) {
            const [row] = await services.db().$queryRaw<StoredLibraryBookmark[]>`
       SELECT ${bookmarkProjection} FROM bookmarks b ${bookmarkJoins}
       WHERE b.user_id=${userId}::uuid AND b.id=${id}::uuid`;
            return row;
        },
        async createBookmark(userId: string, sourceId: string) {
            return services.db().$transaction(async (tx) => {
                const rows = await tx.$queryRaw<{ id: string }[]>`
         INSERT INTO bookmarks(id,user_id,source_id) VALUES(${randomUUID()}::uuid,${userId}::uuid,${sourceId}::uuid)
         ON CONFLICT(user_id,source_id) DO NOTHING RETURNING id`;
                const row = await tx.bookmark.findUniqueOrThrow({
                    where: { userId_sourceId: { userId, sourceId } },
                });
                return { id: row.id, reused: rows.length === 0 };
            });
        },
        async bookmarks(userId: string, take: number, cursor?: LibraryCursor) {
            const boundary = cursor
                ? Prisma.sql`AND (b.created_at,b.id)<(${cursor.time}::timestamptz,${cursor.id}::uuid)`
                : Prisma.empty;
            return services.db().$queryRaw<StoredLibraryBookmark[]>`
       SELECT ${bookmarkProjection} FROM bookmarks b ${bookmarkJoins}
       WHERE b.user_id=${userId}::uuid ${boundary} ORDER BY b.created_at DESC,b.id DESC LIMIT ${take}`;
        },
        async bookmarkAnchor(userId: string, cursor: LibraryCursor) {
            return (
                (
                    await services.db().$queryRaw<{ id: string }[]>`SELECT id FROM bookmarks
       WHERE user_id=${userId}::uuid AND id=${cursor.id}::uuid AND created_at=${cursor.time}::timestamptz`
                ).length === 1
            );
        },
        deleteBookmark: (userId: string, id: string) =>
            services.db().bookmark.deleteMany({ where: { userId, id } }),
        noteCommand: <T>(work: (store: ReturnType<typeof noteStore>) => Promise<T>) =>
            services.db().$transaction((tx) => work(noteStore(tx))),
        async note(userId: string, id: string) {
            const [row] = await services.db().$queryRaw<StoredLibraryNote[]>`
       SELECT ${noteProjection} FROM notes n WHERE n.user_id=${userId}::uuid AND n.id=${id}::uuid`;
            return row;
        },
        async notes(userId: string, query: NoteListQuery, take: number, cursor?: LibraryCursor) {
            const boundary = cursor
                ? Prisma.sql`AND (n.updated_at,n.id)<(${cursor.time}::timestamptz,${cursor.id}::uuid)`
                : Prisma.empty;
            return services.db().$queryRaw<
                StoredLibraryNote[]
            >`SELECT ${noteProjection} FROM notes n
       WHERE n.user_id=${userId}::uuid ${filterNote(query)} ${boundary} ORDER BY n.updated_at DESC,n.id DESC LIMIT ${take}`;
        },
        async noteAnchor(userId: string, query: NoteListQuery, cursor: LibraryCursor) {
            return (
                (
                    await services.db().$queryRaw<
                        { id: string }[]
                    >`SELECT n.id FROM notes n WHERE n.user_id=${userId}::uuid
       AND n.id=${cursor.id}::uuid AND n.updated_at=${cursor.time}::timestamptz ${filterNote(query)}`
                ).length === 1
            );
        },
        async changeNote(userId: string, id: string, revision: number, body?: string) {
            return services.db().$transaction(async (tx) => {
                const changed =
                    body === undefined
                        ? await tx.note.deleteMany({ where: { userId, id, revision } })
                        : await tx.note.updateMany({
                              where: {
                                  userId,
                                  id,
                                  revision,
                                  AND: { revision: { lt: 2147483647 } },
                              },
                              data: { body, revision: { increment: 1 } },
                          });
                return {
                    changed: changed.count === 1,
                    current: await tx.note.findFirst({ where: { userId, id } }),
                };
            });
        },
        async snapshots(userId: string, sourceId: string, take: number, cursor?: LibraryCursor) {
            const boundary = cursor
                ? Prisma.sql`AND (observation.observed_at,ss.id)<(${cursor.time}::timestamptz,${cursor.id}::uuid)`
                : Prisma.empty;
            return services.db().$queryRaw<StoredLibrarySnapshot[]>`
       SELECT ${snapshotProjection(false)} FROM source_snapshots ss
       JOIN sources s ON s.user_id=ss.user_id AND s.id=ss.source_id ${latestObservation}
       WHERE ss.user_id=${userId}::uuid AND ss.source_id=${sourceId}::uuid ${boundary}
       ORDER BY observation.observed_at DESC,ss.id DESC LIMIT ${take}`;
        },
        async snapshot(userId: string, sourceId: string, id: string) {
            const [row] = await services.db().$queryRaw<StoredLibrarySnapshot[]>`
       SELECT ${snapshotProjection(true)} FROM source_snapshots ss
       JOIN sources s ON s.user_id=ss.user_id AND s.id=ss.source_id ${latestObservation}
       WHERE ss.user_id=${userId}::uuid AND ss.source_id=${sourceId}::uuid AND ss.id=${id}::uuid`;
            return row;
        },
        async snapshotAnchor(userId: string, sourceId: string, cursor: LibraryCursor) {
            const rows = await services.db().$queryRaw<{ id: string }[]>`
       SELECT ss.id FROM source_snapshots ss ${latestObservation}
       WHERE ss.user_id=${userId}::uuid AND ss.source_id=${sourceId}::uuid AND ss.id=${cursor.id}::uuid
       AND observation.observed_at=${cursor.time}::timestamptz`;
            return rows.length === 1;
        },
        quotes(userId: string, sourceId: string, snapshotId: string) {
            return services.db().evidence.findMany({
                where: {
                    userId,
                    snapshotId,
                    observation: {
                        userId,
                        sourceId,
                        snapshotId,
                        fetchStatus: 'succeeded',
                        run: { userId },
                    },
                },
                orderBy: [{ capturedAt: 'asc' }, { id: 'asc' }],
                take: 101,
            });
        },
        async search(
            userId: string,
            query: LibrarySearchQuery,
            terms: string[],
            take: number,
            cursor?: LibraryCursor,
        ) {
            const tsquery = Prisma.sql`plainto_tsquery('simple'::regconfig,${query.q})`;
            const titleFts = Prisma.sql`to_tsvector('simple'::regconfig,coalesce(ss.title,'')) @@ ${tsquery}`;
            const fullFts = Prisma.sql`(${activeBody} AND to_tsvector('simple'::regconfig,coalesce(ss.title,'') || ' ' || coalesce(ss.text_body,'')) @@ ${tsquery})`;
            const sourceFts = Prisma.sql`(${titleFts} OR ${fullFts})`;
            const sourceText = Prisma.sql`(coalesce(ss.title,'') || ' ' || CASE WHEN ${activeBody} THEN ss.text_body ELSE '' END)`;
            const sourceSub = Prisma.join(
                terms.map((term) => Prisma.sql`strpos(lower(${sourceText}),lower(${term}))>0`),
                ' AND ',
            );
            const noteFts = Prisma.sql`to_tsvector('simple'::regconfig,n.body) @@ ${tsquery}`;
            const noteSub = Prisma.join(
                terms.map((term) => Prisma.sql`strpos(lower(n.body),lower(${term}))>0`),
                ' AND ',
            );
            const bookmarkFilter =
                query.bookmarked === undefined
                    ? Prisma.empty
                    : Prisma.sql`AND ${query.bookmarked ? Prisma.empty : Prisma.sql`NOT`} EXISTS(SELECT 1 FROM bookmarks b WHERE b.user_id=ss.user_id AND b.source_id=ss.source_id)`;
            const noteBookmark =
                query.bookmarked === undefined
                    ? Prisma.empty
                    : Prisma.sql`AND ${query.bookmarked ? Prisma.empty : Prisma.sql`NOT`} EXISTS(SELECT 1 FROM bookmarks b WHERE b.user_id=n.user_id AND b.source_id=n.source_id)`;
            const kind = query.kind ? Prisma.sql`AND kind=${query.kind}` : Prisma.empty;
            const boundary = cursor
                ? Prisma.sql`AND (time,kind,id)<(${cursor.time}::timestamptz,${cursor.kind},${cursor.id}::uuid)`
                : Prisma.empty;
            return services.db().$transaction(async (tx) => {
                await tx.$executeRaw`SELECT set_config('statement_timeout','3000',true)`;
                return tx.$queryRaw<StoredLibraryHit[]>`
       WITH hits AS (
         SELECT 'source'::text AS kind,ss.id,ss.source_id AS "sourceId",NULL::uuid AS "reportId",ss.id AS "snapshotId",
           ss.title,${sourceText} AS text,CASE WHEN ${sourceFts} THEN 'fts' ELSE 'substring' END AS "matchedBy",
           observation.observed_at AS time
         FROM source_snapshots ss ${latestObservation}
         WHERE ss.user_id=${userId}::uuid ${bookmarkFilter} AND (${sourceFts} OR (${sourceSub}))
         UNION ALL
         SELECT 'note',n.id,n.source_id,n.report_id,NULL::uuid,coalesce(r.title,s.canonical_url,'笔记'),n.body,
           CASE WHEN ${noteFts} THEN 'fts' ELSE 'substring' END,n.updated_at
         FROM notes n LEFT JOIN sources s ON s.user_id=n.user_id AND s.id=n.source_id
           LEFT JOIN reports r ON r.user_id=n.user_id AND r.id=n.report_id
         WHERE n.user_id=${userId}::uuid ${noteBookmark} AND (${noteFts} OR (${noteSub}))
       )
       SELECT kind,id,"sourceId","reportId","snapshotId",title,
         substring(text FROM greatest(1,strpos(lower(text),lower(${terms[0]}))-80) FOR 500) AS text,
         "matchedBy",time AS "updatedAt",
         ${timeText(Prisma.sql`time`)} AS "cursorTime"
       FROM hits WHERE true ${kind} ${boundary} ORDER BY time DESC,kind DESC,id DESC LIMIT ${take}`;
            });
        },
        async searchAnchor(userId: string, query: LibrarySearchQuery, cursor: LibraryCursor) {
            if (cursor.kind === 'note') return this.noteAnchor(userId, {}, cursor);
            if (cursor.kind !== 'source') return false;
            const [row] = await services.db().$queryRaw<
                { sourceId: string }[]
            >`SELECT source_id AS "sourceId" FROM source_snapshots WHERE user_id=${userId}::uuid AND id=${cursor.id}::uuid`;
            return row ? this.snapshotAnchor(userId, row.sourceId, cursor) : false;
        },
        async purgeExpiredBodies(limit: number, userId?: string) {
            return services.db().$transaction(async (tx) => {
                await tx.$executeRaw`SELECT set_config('statement_timeout','3000',true)`;
                const rows = await tx.$queryRaw<{ id: string }[]>`
         UPDATE source_snapshots ss SET text_body=NULL WHERE ss.id IN (
           SELECT id FROM source_snapshots WHERE text_body IS NOT NULL AND text_expires_at<=clock_timestamp()
           ${userId ? Prisma.sql`AND user_id=${userId}::uuid` : Prisma.empty}
           ORDER BY text_expires_at,id LIMIT ${limit} FOR UPDATE SKIP LOCKED
         ) RETURNING ss.id`;
                return { cleared: rows.length };
            });
        },
    };
}
