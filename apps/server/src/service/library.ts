import { createHash } from 'node:crypto';
import {
    BookmarkInputSchema,
    BookmarkSchema,
    BookmarkCommandResponseSchema,
    BookmarkListResponseSchema,
    NoteInputSchema,
    NotePatchInputSchema,
    NoteSchema,
    NoteCommandResponseSchema,
    NoteListQuerySchema,
    NoteListResponseSchema,
    PageQuerySchema,
    LibrarySnapshotSchema,
    LibrarySnapshotDetailSchema,
    LibrarySearchQuerySchema,
    LibrarySearchResponseSchema,
    LibrarySnapshotListResponseSchema,
    EvidenceSelectorSchema,
    IdempotencyHeadersSchema,
    parseContract,
    type LibraryTarget,
} from '@scova/contracts';
import { validatePublication } from '@scova/connectors';
import type { Note } from '@scova/models';
import type { ApiServices } from '@/app/context.ts';
import {
    createLibraryRepo,
    type StoredLibraryBookmark,
    type StoredLibraryNote,
    type StoredLibrarySnapshot,
} from '@/repo/library.ts';
import {
    invalidLibraryCursor,
    libraryScope,
    readLibraryCursor,
    writeLibraryCursor,
    librarySearchTerms,
    libraryExcerpt,
} from '@/utils/library.ts';
import { ApiError } from '@/utils/errors.ts';
import { isUuid, tokenHash } from '@/utils/security.ts';

const missing = () => new ApiError(404, 'NOT_FOUND', '资源不存在');
const invalidSnapshot = () =>
    new ApiError(409, 'INVALID_SOURCE_SNAPSHOT', '历史快照或引用暂不可用');
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
function id(value: string) {
    if (!isUuid(value)) throw missing();
    return value;
}
function revision(value: number) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647)
        throw new ApiError(409, 'REVISION_CONFLICT', '笔记修订已变化，请刷新后重试');
    return value;
}
function bookmark(row: StoredLibraryBookmark) {
    return parseContract(BookmarkSchema, {
        id: row.id,
        sourceId: row.sourceId,
        createdAt: row.createdAt.toISOString(),
        source: {
            id: row.sourceId,
            canonicalUrl: row.canonicalUrl,
            title: row.title,
            latestSnapshotId: row.latestSnapshotId,
            lastObservedAt: row.lastObservedAt?.toISOString() ?? null,
        },
    });
}
function note(row: StoredLibraryNote | Note) {
    return parseContract(NoteSchema, {
        id: row.id,
        target: row.sourceId
            ? { kind: 'source', id: row.sourceId }
            : { kind: 'report', id: row.reportId },
        body: row.body,
        revision: row.revision,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
    });
}
function snapshot(row: StoredLibrarySnapshot) {
    try {
        const metadata = row.metadata as Record<string, unknown>;
        if (
            !metadata ||
            metadata.mode !== row.mode ||
            typeof metadata.truncated !== 'boolean' ||
            (row.textBody !== null && sha(row.textBody) !== row.contentHash)
        )
            throw invalidSnapshot();
        return parseContract(LibrarySnapshotSchema, {
            id: row.id,
            sourceId: row.sourceId,
            observationId: row.observationId,
            runId: row.runId,
            title: row.title,
            canonicalUrl: row.canonicalUrl,
            originalUrl: row.originalUrl,
            fetchedUrl: row.fetchedUrl,
            contentHash: row.contentHash,
            extractorVersion: row.extractorVersion,
            observedAt: row.observedAt.toISOString(),
            publishedAt: validatePublication(metadata.publication).instant,
            textExpiresAt: row.textExpiresAt?.toISOString() ?? null,
            bodyStatus: row.bodyAvailable ? 'available' : 'expired',
            mode: row.mode,
            truncated: metadata.truncated,
        });
    } catch {
        throw invalidSnapshot();
    }
}
const take = (limit?: number) => Math.min(limit ?? 50, 100);
function checkBody(body: string) {
    if (Buffer.byteLength(body, 'utf8') > 80_000)
        throw new ApiError(422, 'NOTE_TOO_LARGE', '笔记不得超过80000 UTF-8字节');
}

/** 资料库规则；所有owner来自会话，保留期清理仅供内部部署入口调用。 */
export function createLibraryService(services: ApiServices) {
    const repo = createLibraryRepo(services);
    async function target(userId: string, value: LibraryTarget) {
        if (!(await repo.target(userId, { ...value, id: id(value.id) }))) throw missing();
    }
    return {
        async createBookmark(userId: string, body: unknown) {
            const input = parseContract(BookmarkInputSchema, body);
            await target(userId, { kind: 'source', id: input.sourceId });
            const result = await repo.createBookmark(userId, input.sourceId);
            const row = await repo.bookmark(userId, result.id);
            if (!row) throw missing();
            return parseContract(BookmarkCommandResponseSchema, {
                bookmark: bookmark(row),
                reused: result.reused,
            });
        },
        async bookmarks(userId: string, input: unknown) {
            const query = parseContract(PageQuerySchema, input);
            const scope = libraryScope(userId, 'bookmarks', null),
                cursor = readLibraryCursor(query.cursor, scope);
            if (cursor && !(await repo.bookmarkAnchor(userId, cursor)))
                throw invalidLibraryCursor();
            const limit = take(query.limit),
                rows = await repo.bookmarks(userId, limit + 1, cursor),
                page = rows.slice(0, limit),
                last = page.at(-1);
            return parseContract(BookmarkListResponseSchema, {
                items: page.map(bookmark),
                nextCursor:
                    rows.length > limit && last
                        ? writeLibraryCursor({ id: last.id, time: last.cursorTime }, scope)
                        : null,
            });
        },
        async deleteBookmark(userId: string, bookmarkId: string) {
            if ((await repo.deleteBookmark(userId, id(bookmarkId))).count !== 1) throw missing();
        },
        async createNote(userId: string, body: unknown, key: string) {
            const input = parseContract(NoteInputSchema, body);
            checkBody(input.body);
            parseContract(IdempotencyHeadersSchema, { 'idempotency-key': key });
            await target(userId, input.target);
            const result = await repo.noteCommand(async (store) => {
                const { record, created } = await store.claim(
                    userId,
                    tokenHash(key),
                    sha(JSON.stringify([input.target.kind, input.target.id, input.body])),
                    new Date(services.clock().getTime() + 86400_000),
                );
                if (!created) {
                    if (
                        record.payloadHash !==
                        sha(JSON.stringify([input.target.kind, input.target.id, input.body]))
                    )
                        throw new ApiError(
                            409,
                            'IDEMPOTENCY_PAYLOAD_MISMATCH',
                            '同一幂等键不能提交不同笔记',
                        );
                    if (!record.resourceId || record.status !== 'completed')
                        throw new ApiError(409, 'IDEMPOTENCY_PENDING', '笔记创建命令暂不可重放');
                    const existing = await store.find(userId, record.resourceId);
                    if (!existing)
                        throw new ApiError(
                            409,
                            'IDEMPOTENCY_RESOURCE_DELETED',
                            '原笔记已删除，请为新笔记使用新的幂等键',
                        );
                    return { note: note(existing), reused: true };
                }
                const createdNote = await store.create(userId, input);
                await store.complete(record.id, createdNote.id);
                return { note: note(createdNote), reused: false };
            });
            return parseContract(NoteCommandResponseSchema, result);
        },
        async notes(userId: string, input: unknown) {
            const query = parseContract(NoteListQuerySchema, input);
            if (query.sourceId && query.reportId)
                throw new ApiError(422, 'NOTE_TARGET_REQUIRED', '笔记筛选只能选择一种来源或报告');
            if (query.sourceId) await target(userId, { kind: 'source', id: query.sourceId });
            if (query.reportId) await target(userId, { kind: 'report', id: query.reportId });
            const scope = libraryScope(userId, 'notes', [
                    query.sourceId ?? null,
                    query.reportId ?? null,
                ]),
                cursor = readLibraryCursor(query.cursor, scope);
            if (cursor && !(await repo.noteAnchor(userId, query, cursor)))
                throw invalidLibraryCursor();
            const limit = take(query.limit),
                rows = await repo.notes(userId, query, limit + 1, cursor),
                page = rows.slice(0, limit),
                last = page.at(-1);
            return parseContract(NoteListResponseSchema, {
                items: page.map(note),
                nextCursor:
                    rows.length > limit && last
                        ? writeLibraryCursor({ id: last.id, time: last.cursorTime }, scope)
                        : null,
            });
        },
        async note(userId: string, noteId: string) {
            const row = await repo.note(userId, id(noteId));
            if (!row) throw missing();
            return note(row);
        },
        async patchNote(userId: string, noteId: string, body: unknown, expectedRevision: number) {
            const input = parseContract(NotePatchInputSchema, body);
            checkBody(input.body);
            const result = await repo.changeNote(
                userId,
                id(noteId),
                revision(expectedRevision),
                input.body,
            );
            if (!result.changed) {
                if (!result.current) throw missing();
                throw new ApiError(409, 'REVISION_CONFLICT', '笔记已被其他请求修改，请刷新后重试');
            }
            if (!result.current) throw missing();
            return note(result.current);
        },
        async deleteNote(userId: string, noteId: string, expectedRevision: number) {
            const result = await repo.changeNote(userId, id(noteId), revision(expectedRevision));
            if (!result.changed) {
                if (!result.current) throw missing();
                throw new ApiError(409, 'REVISION_CONFLICT', '笔记已被其他请求修改，请刷新后重试');
            }
        },
        async snapshots(userId: string, sourceId: string, input: unknown) {
            await target(userId, { kind: 'source', id: sourceId });
            const query = parseContract(PageQuerySchema, input),
                scope = libraryScope(userId, 'snapshots', sourceId),
                cursor = readLibraryCursor(query.cursor, scope);
            if (cursor && !(await repo.snapshotAnchor(userId, sourceId, cursor)))
                throw invalidLibraryCursor();
            const limit = take(query.limit),
                rows = await repo.snapshots(userId, sourceId, limit + 1, cursor),
                page = rows.slice(0, limit),
                last = page.at(-1);
            return parseContract(LibrarySnapshotListResponseSchema, {
                items: page.map(snapshot),
                nextCursor:
                    rows.length > limit && last
                        ? writeLibraryCursor({ id: last.id, time: last.cursorTime }, scope)
                        : null,
            });
        },
        async snapshot(userId: string, sourceId: string, snapshotId: string) {
            const row = await repo.snapshot(userId, id(sourceId), id(snapshotId));
            if (!row) throw missing();
            const mapped = snapshot(row),
                quotes = await repo.quotes(userId, sourceId, snapshotId);
            try {
                const savedQuotes = quotes.slice(0, 100).map((entry) => {
                    const selector = parseContract(EvidenceSelectorSchema, entry.selectorJson);
                    if (
                        sha(entry.quote) !== entry.quoteHash ||
                        selector.end - selector.start !== entry.quote.length ||
                        selector.extractorVersion !== row.extractorVersion ||
                        (row.textBody !== null &&
                            row.textBody.slice(selector.start, selector.end) !== entry.quote)
                    )
                        throw invalidSnapshot();
                    return {
                        id: entry.id,
                        runId: entry.runId,
                        quote: entry.quote,
                        quoteHash: entry.quoteHash,
                        selector,
                    };
                });
                return parseContract(LibrarySnapshotDetailSchema, {
                    snapshot: mapped,
                    textBody: row.textBody,
                    quotes: savedQuotes,
                    quotesTruncated: quotes.length > 100,
                });
            } catch {
                throw invalidSnapshot();
            }
        },
        async search(userId: string, input: unknown) {
            const query = parseContract(LibrarySearchQuerySchema, input),
                terms = librarySearchTerms(query.q);
            const scope = libraryScope(userId, 'search', [
                    query.q,
                    query.kind ?? null,
                    query.bookmarked ?? null,
                ]),
                cursor = readLibraryCursor(query.cursor, scope);
            if (cursor && !(await repo.searchAnchor(userId, query, cursor)))
                throw invalidLibraryCursor();
            const limit = take(query.limit),
                rows = await repo.search(userId, query, terms, limit + 1, cursor),
                page = rows.slice(0, limit),
                last = page.at(-1);
            return parseContract(LibrarySearchResponseSchema, {
                items: page.map((row) => ({
                    kind: row.kind,
                    id: row.id,
                    sourceId: row.sourceId,
                    reportId: row.reportId,
                    snapshotId: row.snapshotId,
                    title: row.title,
                    excerpt: libraryExcerpt(row.text, terms),
                    matchedBy: row.matchedBy,
                    updatedAt: row.updatedAt.toISOString(),
                })),
                nextCursor:
                    rows.length > limit && last
                        ? writeLibraryCursor(
                              { id: last.id, time: last.cursorTime, kind: last.kind },
                              scope,
                          )
                        : null,
            });
        },
        async purgeExpiredSnapshotBodies(options: { limit?: number; userId?: string } = {}) {
            const limit = options.limit ?? 100;
            if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
                throw new Error('正文清理批次必须为1至1000');
            if (options.userId) id(options.userId);
            return repo.purgeExpiredBodies(limit, options.userId);
        },
    };
}
