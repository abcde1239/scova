import { Type, type Static } from '@sinclair/typebox';
import {
    describeProperties,
    pageSchema,
    PageQuerySchema,
    UuidSchema,
    InstantSchema,
    HttpUrlSchema,
    NonEmptyTextSchema,
    RevisionSchema,
    ModeSchema,
} from './common.ts';
import { EvidenceSelectorSchema } from './reports.ts';

export const LibraryTargetSchema = Type.Union(
    [
        Type.Object(
            { kind: Type.Literal('source'), id: UuidSchema },
            { additionalProperties: false, description: '来源目标' },
        ),
        Type.Object(
            { kind: Type.Literal('report'), id: UuidSchema },
            { additionalProperties: false, description: '报告目标' },
        ),
    ],
    { description: '恰有一种同账号目标；创建后不可修改目标' },
);
export const LibrarySourceSchema = Type.Object(
    {
        id: UuidSchema,
        canonicalUrl: HttpUrlSchema,
        title: Type.Union([NonEmptyTextSchema, Type.Null()], {
            description: '最近成功观测快照的标题，无快照时为空',
        }),
        latestSnapshotId: Type.Union([UuidSchema, Type.Null()], {
            description: '最近成功观测的快照ID',
        }),
        lastObservedAt: Type.Union([InstantSchema, Type.Null()], {
            description: '最近成功观测时间',
        }),
    },
    { additionalProperties: false, description: '来源摘要，不抓取URL' },
);
export const BookmarkInputSchema = Type.Object(
    { sourceId: UuidSchema },
    { additionalProperties: false, description: '收藏已有且同账号的来源' },
);
export const BookmarkSchema = Type.Object(
    {
        id: UuidSchema,
        sourceId: UuidSchema,
        createdAt: InstantSchema,
        source: LibrarySourceSchema,
    },
    { additionalProperties: false, description: '按用户和来源唯一的收藏' },
);
export const BookmarkCommandResponseSchema = Type.Object(
    {
        bookmark: BookmarkSchema,
        reused: Type.Boolean({ description: '是否复用已有收藏' }),
    },
    { additionalProperties: false, description: '收藏创建或重复收藏的结果' },
);
export const BookmarkListResponseSchema = pageSchema(BookmarkSchema);
const NoteBodySchema = Type.String({
    minLength: 1,
    maxLength: 20_000,
    pattern: '\\S',
    description: '纯文本笔记，最多20000字符和80000 UTF-8字节，不解析或执行HTML/Markdown',
});
export const NoteInputSchema = Type.Object(
    {
        target: LibraryTargetSchema,
        body: NoteBodySchema,
    },
    { additionalProperties: false, description: '新建恰有一个来源或报告目标的笔记' },
);
export const NotePatchInputSchema = Type.Object(
    { body: NoteBodySchema },
    { additionalProperties: false, description: '只编辑正文，目标不可变；需要If-Match' },
);
export const NoteSchema = Type.Object(
    {
        id: UuidSchema,
        target: LibraryTargetSchema,
        body: NoteBodySchema,
        revision: RevisionSchema,
        createdAt: InstantSchema,
        updatedAt: InstantSchema,
    },
    { additionalProperties: false, description: '可乐观锁编辑的纯文本笔记' },
);
export const NoteCommandResponseSchema = Type.Object(
    { note: NoteSchema, reused: Type.Boolean({ description: '是否重放同一幂等键的原笔记' }) },
    {
        additionalProperties: false,
        description: '创建笔记需Idempotency-Key；同键异参数409，笔记删除后旧键不能复建',
    },
);
export const NoteListQuerySchema = Type.Object(
    {
        ...PageQuerySchema.properties,
        sourceId: Type.Optional(UuidSchema),
        reportId: Type.Optional(UuidSchema),
    },
    { additionalProperties: false, description: '笔记分页，可按一种来源或报告筛选' },
);
export const NoteListResponseSchema = pageSchema(NoteSchema);
export const LibrarySnapshotSchema = Type.Object(
    {
        id: UuidSchema,
        sourceId: UuidSchema,
        observationId: UuidSchema,
        runId: UuidSchema,
        title: NonEmptyTextSchema,
        canonicalUrl: HttpUrlSchema,
        originalUrl: HttpUrlSchema,
        fetchedUrl: HttpUrlSchema,
        contentHash: Type.String({
            pattern: '^[a-f0-9]{64}$',
            description: '保存正文的SHA256指纹',
        }),
        extractorVersion: NonEmptyTextSchema,
        observedAt: InstantSchema,
        publishedAt: Type.Union([InstantSchema, Type.Null()]),
        textExpiresAt: Type.Union([InstantSchema, Type.Null()], { description: '正文保留期限' }),
        bodyStatus: Type.Union([Type.Literal('available'), Type.Literal('expired')], {
            description: '正文可用或已经过期/清理',
        }),
        mode: ModeSchema,
        truncated: Type.Boolean({ description: '所选观测的正文截断标记' }),
    },
    {
        additionalProperties: false,
        description: '历史快照与最近成功观测，不把发布时间当作采集时间',
    },
);
export const LibraryQuoteSchema = Type.Object(
    {
        id: UuidSchema,
        runId: UuidSchema,
        quote: Type.String({ minLength: 1, maxLength: 2000, description: '保留的原文引用片段' }),
        quoteHash: Type.String({ pattern: '^[a-f0-9]{64}$', description: '引用片段指纹' }),
        selector: EvidenceSelectorSchema,
    },
    { additionalProperties: false, description: '正文清理后仍可解释的历史证据' },
);
export const LibrarySnapshotDetailSchema = Type.Object(
    {
        snapshot: LibrarySnapshotSchema,
        textBody: Type.Union([Type.String({ description: '保留期内的纯文本正文' }), Type.Null()]),
        quotes: Type.Array(LibraryQuoteSchema, {
            maxItems: 100,
            description: '最多100条保留证据，按采集时间排序',
        }),
        quotesTruncated: Type.Boolean({ description: '是否还有更多证据未在本次响应中返回' }),
    },
    { additionalProperties: false, description: '授权历史快照，过期正文为空，引用片段保留' },
);
export const LibrarySnapshotListResponseSchema = pageSchema(LibrarySnapshotSchema);
export const LibrarySearchQuerySchema = Type.Object(
    {
        ...PageQuerySchema.properties,
        q: Type.String({
            minLength: 1,
            maxLength: 200,
            pattern: '\\S',
            description: '最多200字符、800 UTF-8字节，最多8个空白分隔关键词',
        }),
        kind: Type.Optional(Type.Union([Type.Literal('source'), Type.Literal('note')])),
        bookmarked: Type.Optional(
            Type.Boolean({ description: '是否只搜索已收藏来源，笔记按其来源目标判断' }),
        ),
    },
    {
        additionalProperties: false,
        description: '同账号全文检索与字面子串补充，按最新观测/笔记更新时间排序',
    },
);
export const LibrarySearchHitSchema = Type.Object(
    {
        kind: Type.Union([Type.Literal('source'), Type.Literal('note')]),
        id: UuidSchema,
        sourceId: Type.Union([UuidSchema, Type.Null()]),
        reportId: Type.Union([UuidSchema, Type.Null()]),
        snapshotId: Type.Union([UuidSchema, Type.Null()]),
        title: NonEmptyTextSchema,
        excerpt: Type.String({ maxLength: 500, description: '纯文本命中上下文，不包含HTML高亮' }),
        matchedBy: Type.Union([Type.Literal('fts'), Type.Literal('substring')], {
            description: 'PostgreSQL simple FTS或字面子串命中',
        }),
        updatedAt: InstantSchema,
    },
    { additionalProperties: false, description: '同账号来源快照或笔记的有界搜索结果' },
);
export const LibrarySearchResponseSchema = pageSchema(LibrarySearchHitSchema);
for (const schema of [
    LibraryTargetSchema,
    LibrarySourceSchema,
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
    LibrarySnapshotSchema,
    LibraryQuoteSchema,
    LibrarySnapshotDetailSchema,
    LibrarySnapshotListResponseSchema,
    LibrarySearchQuerySchema,
    LibrarySearchHitSchema,
    LibrarySearchResponseSchema,
])
    describeProperties(schema);
export type LibraryTarget = Static<typeof LibraryTargetSchema>;
export type NoteInput = Static<typeof NoteInputSchema>;
export type NoteListQuery = Static<typeof NoteListQuerySchema>;
export type LibrarySearchQuery = Static<typeof LibrarySearchQuerySchema>;
