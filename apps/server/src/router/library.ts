import { Elysia, t } from 'elysia';
import {
    ApiErrorSchema,
    PageQuerySchema,
    BookmarkInputSchema,
    BookmarkCommandResponseSchema,
    BookmarkListResponseSchema,
    NoteInputSchema,
    NotePatchInputSchema,
    NoteSchema,
    NoteCommandResponseSchema,
    NoteListQuerySchema,
    NoteListResponseSchema,
    LibrarySnapshotDetailSchema,
    LibrarySnapshotListResponseSchema,
    LibrarySearchQuerySchema,
    LibrarySearchResponseSchema,
    IdempotencyHeadersSchema,
} from '@scova/models';
import type { ApiServices } from '@/app/services';
import { createLibraryHandlers } from '@/handler/library.ts';

const limit = t.Optional(
    t.Numeric({
        minimum: 1,
        maximum: Number.MAX_SAFE_INTEGER,
        description: '每页条数，默认50，上限100',
    }),
);
const page = t.Object({ ...PageQuerySchema.properties, limit }, { additionalProperties: false });
const notes = t.Object(
    { ...NoteListQuerySchema.properties, limit },
    { additionalProperties: false },
);
const search = t.Object(
    {
        ...LibrarySearchQuerySchema.properties,
        limit,
        bookmarked: t.Optional(t.BooleanString({ description: '按来源是否已收藏筛选' })),
    },
    { additionalProperties: false },
);
const revision = t.Object(
    {
        'if-match': t.Optional(
            t.String({
                pattern: '^"[1-9][0-9]*"$',
                description: '当前笔记ETag，缺失428，旧修订409',
            }),
        ),
    },
    { additionalProperties: true },
);
const idempotency = t.Object(
    { 'idempotency-key': t.Optional(IdempotencyHeadersSchema.properties['idempotency-key']) },
    { additionalProperties: true },
);
export function createLibraryPlugin(services: ApiServices) {
    const handlers = createLibraryHandlers(services);
    const errors = {
        400: ApiErrorSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        404: ApiErrorSchema,
        409: ApiErrorSchema,
        422: ApiErrorSchema,
        428: ApiErrorSchema,
    };
    const detail = (operationId: string, summary: string, description: string) => ({
        operationId,
        tags: ['资料库'],
        summary,
        description,
    });
    return new Elysia({ name: 'scova-library', prefix: '/api/v1', normalize: false })
        .get('/bookmarks', handlers.bookmarks, {
            query: page,
            response: { 200: BookmarkListResponseSchema, ...errors },
            detail: detail(
                'listBookmarks',
                '读取收藏',
                '分页读取当前账号收藏；按创建时间及ID排序。',
            ),
        })
        .post('/bookmarks', handlers.createBookmark, {
            body: BookmarkInputSchema,
            response: {
                200: BookmarkCommandResponseSchema,
                201: BookmarkCommandResponseSchema,
                ...errors,
            },
            detail: detail(
                'createBookmark',
                '收藏已有来源',
                '需要会话与CSRF，同账号同来源并发去重；不抓取URL，不创建来源。',
            ),
        })
        .delete('/bookmarks/:bookmarkId', handlers.deleteBookmark, {
            response: errors,
            detail: {
                ...detail(
                    'deleteBookmark',
                    '取消收藏',
                    '仅移除当前账号收藏，不删除来源、证据或基线。',
                ),
                responses: { 204: { description: '收藏已取消，无响应体' } },
            },
        })
        .get('/notes', handlers.notes, {
            query: notes,
            response: { 200: NoteListResponseSchema, ...errors },
            detail: detail(
                'listNotes',
                '读取纯文本笔记',
                '支持一种来源或报告筛选，按更新时间和ID分页。',
            ),
        })
        .post('/notes', handlers.createNote, {
            body: NoteInputSchema,
            headers: idempotency,
            response: { 200: NoteCommandResponseSchema, 201: NoteCommandResponseSchema, ...errors },
            detail: detail(
                'createNote',
                '创建纯文本笔记',
                '需要CSRF及Idempotency-Key；恰有一种同账号目标，同键异参数409，删除后旧键不能重建。',
            ),
        })
        .get('/notes/:noteId', handlers.note, {
            response: { 200: NoteSchema, ...errors },
            detail: detail('getNote', '读取笔记与修订', '返回当前账号笔记与ETag；跨账号统一404。'),
        })
        .patch('/notes/:noteId', handlers.patchNote, {
            body: NotePatchInputSchema,
            headers: revision,
            response: { 200: NoteSchema, ...errors },
            detail: detail(
                'patchNote',
                '编辑笔记正文',
                '需要CSRF和If-Match；保留原样纯文本，不解析HTML，目标不可修改。',
            ),
        })
        .delete('/notes/:noteId', handlers.deleteNote, {
            headers: revision,
            response: errors,
            detail: {
                ...detail(
                    'deleteNote',
                    '删除笔记',
                    '需要CSRF和If-Match，防止覆盖并发编辑；不删除关联资源。',
                ),
                responses: { 204: { description: '笔记已删除，无响应体' } },
            },
        })
        .get('/library/sources/:sourceId/snapshots', handlers.snapshots, {
            query: page,
            response: { 200: LibrarySnapshotListResponseSchema, ...errors },
            detail: detail(
                'listSourceSnapshots',
                '读取来源历史快照',
                '只返回当前账号成功观测，按实际观测时间排序；每个快照选取最近成功观测元数据。',
            ),
        })
        .get('/library/sources/:sourceId/snapshots/:snapshotId', handlers.snapshot, {
            response: { 200: LibrarySnapshotDetailSchema, ...errors },
            detail: detail(
                'getSourceSnapshot',
                '读取授权历史快照',
                '绑定账号、来源与成功观测；过期正文为空，保留引用、指纹与位置，不重新抓取网页。',
            ),
        })
        .get('/library/search', handlers.search, {
            query: search,
            response: { 200: LibrarySearchResponseSchema, ...errors },
            detail: detail(
                'searchLibrary',
                '搜索当前账号资料',
                'PostgreSQL simple全文检索加字面子串补充；过期正文不参与搜索，结果按观测或更新时间分页。',
            ),
        });
}
