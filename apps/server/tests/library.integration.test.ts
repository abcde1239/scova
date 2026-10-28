import { migrateDatabase } from '@scova/db/migrate';
import {
    createDatabaseClient,
    connectDatabase,
    closeDatabase,
    queryRows,
    sql as querySql,
    and,
    eq,
    isNull,
    count,
} from '@scova/db';
import * as tables from '@scova/db';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

import { Redis as RedisClient } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { createApiApp } from '../src/app/index.ts';
import { createDefaultServices, type ApiServices } from '../src/app/context.ts';
import { createLibraryService } from '../src/service/library.ts';
import { draftConfig } from './support/task-drafts.ts';
import { libraryFixture } from './support/library.ts';
import { firstRow, requireRow } from '../src/utils/database.ts';
const require = createRequire(import.meta.url);
const baseUrl =
    process.env.SCOVA_TEST_DATABASE_URL ??
    process.env.RUNTIME_DATABASE_URL ??
    'postgresql://scova_test:scova_test@127.0.0.1:55432/scova_test';
const redisUrl =
    process.env.SCOVA_TEST_REDIS_URL ?? process.env.RUNTIME_REDIS_URL ?? 'redis://127.0.0.1:56379';
const schema = 'scova_library_' + randomUUID().replaceAll('-', '');
const scopedUrl = new URL(baseUrl);
scopedUrl.searchParams.set('schema', schema);
const db = createDatabaseClient({ connectionString: scopedUrl.toString() });
const admin = new (require('pg').Client)({ connectionString: baseUrl });
const redis = new RedisClient(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
});
const origin = 'https://scova.test';
let schemaCreated = false,
    services: ApiServices,
    app: ReturnType<typeof createApiApp>;
const json = async (response: Response) => (await response.json()) as Record<string, any>;
type Owner = { id: string; cookie: string; csrf: string };
const headers = (owner?: Owner, extra: Record<string, string> = {}) => ({
    origin,
    'content-type': 'application/json',
    ...(owner ? { cookie: owner.cookie, 'x-csrf-token': owner.csrf } : {}),
    ...extra,
});
const request = (path: string, init: RequestInit = {}) =>
    app.handle(new Request(origin + '/api/v1' + path, init));
async function register(): Promise<Owner> {
    const response = await request('/auth/register', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
            email: randomUUID() + '@example.test',
            password: 'correct horse battery staple',
            defaultTimezone: 'UTC',
        }),
    });
    expect(response.status).toBe(201);
    const body = await json(response);
    return {
        id: body.user.id,
        cookie: response.headers.get('set-cookie')!.split(';')[0]!,
        csrf: body.csrfToken,
    };
}
async function task(owner: Owner) {
    const response = await request('/tasks', {
        method: 'POST',
        headers: headers(owner),
        body: JSON.stringify({ config: draftConfig() }),
    });
    expect(response.status).toBe(201);
    return (await json(response)).task as { id: string; currentVersionId: string };
}
const bookmark = (owner: Owner, sourceId: string) =>
    request('/bookmarks', {
        method: 'POST',
        headers: headers(owner),
        body: JSON.stringify({ sourceId }),
    });
const note = (
    owner: Owner,
    target: { kind: 'source' | 'report'; id: string },
    body = '  纯文本笔记 <b>保持原样</b>  ',
    key = randomUUID(),
) =>
    request('/notes', {
        method: 'POST',
        headers: headers(owner, { 'idempotency-key': key }),
        body: JSON.stringify({ target, body }),
    });
const search = (owner: Owner, q: string, extra = '') =>
    request('/library/search?q=' + encodeURIComponent(q) + extra, { headers: headers(owner) });
const snapshotPath = (sourceId: string, snapshotId?: string) =>
    '/library/sources/' + sourceId + '/snapshots' + (snapshotId ? '/' + snapshotId : '');
async function pages(owner: Owner, path: string) {
    const ids: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 20; i++) {
        const response = await request(
            path +
                (path.includes('?') ? '&' : '?') +
                'limit=1' +
                (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''),
            { headers: headers(owner) },
        );
        expect(response.status).toBe(200);
        const body = await json(response);
        ids.push(...body.items.map((entry: { id: string }) => entry.id));
        cursor = body.nextCursor;
        if (!cursor) return ids;
    }
    throw new Error('资料分页未在有界页数内结束');
}
describe('资料库HTTP、PostgreSQL全文检索、历史授权与清理', () => {
    beforeAll(async () => {
        await admin.connect();
        await admin.query('CREATE SCHEMA "' + schema + '"');
        schemaCreated = true;
        await migrateDatabase({ connectionString: scopedUrl.toString() });
        await connectDatabase(db);
        await redis.connect();
    }, 120_000);
    beforeEach(() => {
        services = createDefaultServices({
            origin,
            production: false,
            db: () => db,
            redis: () => redis,
            rateLimit: {
                keyPrefix: 'scova:library-auth:' + randomUUID() + ':',
                registerAttempts: 100,
                loginAttempts: 100,
                globalAttempts: 1000,
            },
        });
        app = createApiApp('node', services);
    });
    afterAll(async () => {
        await closeDatabase(db);
        if (redis.status === 'wait' || redis.status === 'end') redis.disconnect();
        else await redis.quit();
        if (schemaCreated && /^scova_library_[0-9a-f]{32}$/.test(schema))
            await admin.query('DROP SCHEMA "' + schema + '" CASCADE');
        await admin.end();
    });
    it('并发重复收藏唯一且取消收藏不删除来源和报告', async () => {
        const owner = await register(),
            data = await libraryFixture(db, owner.id, await task(owner));
        const responses = await Promise.all([
            bookmark(owner, data.source.id),
            bookmark(owner, data.source.id),
            bookmark(owner, data.source.id),
        ]);
        expect(responses.map((row) => row.status).sort((a, b) => a - b)).toEqual([200, 200, 201]);
        const commands = await Promise.all(responses.map(json));
        expect(new Set(commands.map((row) => row.bookmark.id)).size).toBe(1);
        expect(
            await db
                .select({ count: count() })
                .from(tables.bookmarks)
                .where(
                    and(
                        eq(tables.bookmarks.userId, owner.id),
                        eq(tables.bookmarks.sourceId, data.source.id),
                    ),
                )
                .then(([row]) => row!.count),
        ).toBe(1);
        const list = await json(await request('/bookmarks', { headers: headers(owner) }));
        expect(list.items[0].source).toMatchObject({
            id: data.source.id,
            latestSnapshotId: data.snapshot.id,
            title: data.snapshot.title,
        });
        const removed = await request('/bookmarks/' + commands[0]!.bookmark.id, {
            method: 'DELETE',
            headers: headers(owner),
        });
        expect(removed.status).toBe(204);
        expect(await removed.text()).toBe('');
        expect(
            await db.query.sources
                .findFirst({ where: and(eq(tables.sources.id, data.source.id)) })
                .then((row) => row ?? null),
        ).not.toBeNull();
        expect(
            await db.query.reports
                .findFirst({ where: and(eq(tables.reports.id, data.report.id)) })
                .then((row) => row ?? null),
        ).not.toBeNull();
    });
    it('写入要求会话CSRF，目标恰一且跨owner资源404', async () => {
        const owner = await register(),
            other = await register(),
            data = await libraryFixture(db, owner.id, await task(owner));
        expect(
            (
                await request('/bookmarks', {
                    method: 'POST',
                    headers: headers(),
                    body: JSON.stringify({ sourceId: data.source.id }),
                })
            ).status,
        ).toBe(401);
        expect(
            (
                await request('/bookmarks', {
                    method: 'POST',
                    headers: { origin, 'content-type': 'application/json', cookie: owner.cookie },
                    body: JSON.stringify({ sourceId: data.source.id }),
                })
            ).status,
        ).toBe(403);
        expect((await bookmark(other, data.source.id)).status).toBe(404);
        expect((await note(other, { kind: 'source', id: data.source.id })).status).toBe(404);
        expect((await note(other, { kind: 'report', id: data.report.id })).status).toBe(404);
        for (const body of [
            { body: '笔记' },
            { sourceId: data.source.id, reportId: data.report.id, body: '笔记' },
            {
                target: { kind: 'source', id: data.source.id, reportId: data.report.id },
                body: '笔记',
            },
            { target: { kind: 'source', id: data.source.id }, body: '笔记', userId: other.id },
        ])
            expect(
                (
                    await request('/notes', {
                        method: 'POST',
                        headers: headers(owner, { 'idempotency-key': randomUUID() }),
                        body: JSON.stringify(body),
                    })
                ).status,
            ).toBe(422);
        expect(
            await db
                .select({ count: count() })
                .from(tables.notes)
                .where(and(eq(tables.notes.userId, other.id)))
                .then(([row]) => row!.count),
        ).toBe(0);
    });
    it('笔记持久幂等同键异参409，删除后旧键不能重建', async () => {
        const owner = await register(),
            data = await libraryFixture(db, owner.id, await task(owner)),
            key = randomUUID(),
            target = { kind: 'source' as const, id: data.source.id };
        expect(
            (
                await request('/notes', {
                    method: 'POST',
                    headers: headers(owner),
                    body: JSON.stringify({ target, body: '原文' }),
                })
            ).status,
        ).toBe(428);
        const responses = await Promise.all([
            note(owner, target, '原文', key),
            note(owner, target, '原文', key),
        ]);
        expect(responses.map((row) => row.status).sort((a, b) => a - b)).toEqual([200, 201]);
        const commands = await Promise.all(responses.map(json));
        expect(commands[0]!.note.id).toBe(commands[1]!.note.id);
        expect((await note(owner, target, '其他内容', key)).status).toBe(409);
        expect(
            await db
                .select({ count: count() })
                .from(tables.notes)
                .where(and(eq(tables.notes.userId, owner.id)))
                .then(([row]) => row!.count),
        ).toBe(1);
        expect(
            (
                await request('/notes/' + commands[0]!.note.id, {
                    method: 'DELETE',
                    headers: headers(owner, { 'if-match': '"1"' }),
                })
            ).status,
        ).toBe(204);
        const old = await note(owner, target, '原文', key);
        expect(old.status).toBe(409);
        expect((await json(old)).code).toBe('IDEMPOTENCY_RESOURCE_DELETED');
        expect(
            await db
                .select({ count: count() })
                .from(tables.notes)
                .where(and(eq(tables.notes.userId, owner.id)))
                .then(([row]) => row!.count),
        ).toBe(0);
        expect((await note(owner, target, '原文', randomUUID())).status).toBe(201);
    });
    it('幂等键按owner隔离，一个来源可有多条笔记也支持报告目标', async () => {
        const owner = await register(),
            other = await register(),
            first = await libraryFixture(db, owner.id, await task(owner)),
            second = await libraryFixture(db, other.id, await task(other)),
            key = randomUUID();
        const own = await note(owner, { kind: 'source', id: first.source.id }, '同一内容', key),
            theirs = await note(other, { kind: 'source', id: second.source.id }, '同一内容', key);
        expect(own.status).toBe(201);
        expect(theirs.status).toBe(201);
        const original = (await json(own)).note;
        expect(
            (await note(owner, { kind: 'source', id: first.source.id }, '同一内容')).status,
        ).toBe(201);
        expect(
            (await note(owner, { kind: 'report', id: first.report.id }, '报告笔记')).status,
        ).toBe(201);
        expect((await request('/notes/' + original.id, { headers: headers(other) })).status).toBe(
            404,
        );
        expect(
            (await request('/notes?reportId=' + first.report.id, { headers: headers(other) }))
                .status,
        ).toBe(404);
        expect(
            (await request('/notes?sourceId=' + first.source.id, { headers: headers(other) }))
                .status,
        ).toBe(404);
    });
    it('笔记原样纯文本，CAS编辑和删除不覆盖新修订且目标不可改', async () => {
        const owner = await register(),
            other = await register(),
            data = await libraryFixture(db, owner.id, await task(owner));
        const created = await json(await note(owner, { kind: 'report', id: data.report.id }));
        expect(created.note.body).toBe('  纯文本笔记 <b>保持原样</b>  ');
        const path = '/notes/' + created.note.id;
        expect(
            (
                await request(path, {
                    method: 'PATCH',
                    headers: headers(owner),
                    body: JSON.stringify({ body: '新正文' }),
                })
            ).status,
        ).toBe(428);
        const edits = await Promise.all(
            ['新正文A', '新正文B'].map((body) =>
                request(path, {
                    method: 'PATCH',
                    headers: headers(owner, { 'if-match': '"1"' }),
                    body: JSON.stringify({ body }),
                }),
            ),
        );
        expect(edits.map((row) => row.status).sort((a, b) => a - b)).toEqual([200, 409]);
        expect((await request(path, { headers: headers(owner) })).headers.get('etag')).toBe('"2"');
        expect(
            (
                await request(path, {
                    method: 'DELETE',
                    headers: headers(owner, { 'if-match': '"1"' }),
                })
            ).status,
        ).toBe(409);
        expect(
            (
                await request(path, {
                    method: 'DELETE',
                    headers: headers(other, { 'if-match': '"2"' }),
                })
            ).status,
        ).toBe(404);
        expect(
            (
                await request(path, {
                    method: 'PATCH',
                    headers: headers(owner, { 'if-match': '"2"' }),
                    body: JSON.stringify({
                        body: '内容',
                        target: { kind: 'source', id: data.source.id },
                    }),
                })
            ).status,
        ).toBe(422);
        expect(
            (
                await request(path, {
                    method: 'DELETE',
                    headers: headers(owner, { 'if-match': '"2"' }),
                })
            ).status,
        ).toBe(204);
        expect(
            await db.query.reports
                .findFirst({ where: and(eq(tables.reports.id, data.report.id)) })
                .then((row) => row ?? null),
        ).not.toBeNull();
    });
    it('历史快照绑定来源owner，按成功观测时间而非UUID排序', async () => {
        const owner = await register(),
            other = await register(),
            ownedTask = await task(owner);
        const older = await libraryFixture(db, owner.id, ownedTask, {
            snapshotId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
            text: '旧正文',
            observedAt: new Date('2026-01-01T00:00:00Z'),
        });
        const newer = await libraryFixture(db, owner.id, ownedTask, {
            source: older.source,
            snapshotId: '00000000-0000-4000-8000-000000000001',
            text: '新正文',
            observedAt: new Date('2026-01-02T00:00:00Z'),
        });
        const different = await libraryFixture(db, owner.id, ownedTask, {
            text: '不同来源正文',
        });
        const list = await json(
            await request(snapshotPath(older.source.id), { headers: headers(owner) }),
        );
        expect(list.items.map((row: { id: string }) => row.id)).toEqual([
            newer.snapshot.id,
            older.snapshot.id,
        ]);
        expect(list.items[0].bodyStatus).toBe('available');
        expect(list.items[0]).not.toHaveProperty('textBody');
        expect(
            (
                await json(
                    await request(snapshotPath(older.source.id, older.snapshot.id), {
                        headers: headers(owner),
                    }),
                )
            ).textBody,
        ).toBe('旧正文');
        expect(
            (
                await request(snapshotPath(older.source.id, older.snapshot.id), {
                    headers: headers(other),
                })
            ).status,
        ).toBe(404);
        expect(
            (
                await request(snapshotPath(older.source.id, different.snapshot.id), {
                    headers: headers(owner),
                })
            ).status,
        ).toBe(404);
        expect(
            (await request(snapshotPath(older.source.id), { headers: headers(other) })).status,
        ).toBe(404);
    });
    it('重复观测选最近成功元数据，失败观测不覆盖成功历史', async () => {
        const owner = await register(),
            ownedTask = await task(owner),
            data = await libraryFixture(db, owner.id, ownedTask, {
                observedAt: new Date('2026-01-01T00:00:00Z'),
            });
        const run = await db
            .insert(tables.runs)
            .values({
                userId: owner.id,
                taskId: ownedTask.id,
                taskVersionId: ownedTask.currentVersionId,
                comparisonScopeHash: data.run.comparisonScopeHash,
                status: 'failed',
                trigger: 'manual',
                mode: 'demo',
                budgetJson: draftConfig().budget,
                usageJson: {},
            })
            .returning()
            .then(firstRow);
        const recent = await db
            .insert(tables.runSources)
            .values({
                userId: owner.id,
                runId: run.id,
                sourceId: data.source.id,
                snapshotId: data.snapshot.id,
                requestedUrl: data.source.canonicalUrl + '?again',
                fetchedUrl: data.source.canonicalUrl,
                observedAt: new Date('2026-01-02T00:00:00Z'),
                fetchStatus: 'succeeded',
                metadataJson: { mode: 'demo', truncated: true },
            })
            .returning()
            .then(firstRow);
        const response = await json(
            await request(snapshotPath(data.source.id, data.snapshot.id), {
                headers: headers(owner),
            }),
        );
        expect(response.snapshot.observationId).toBe(recent.id);
        expect(response.snapshot.truncated).toBe(true);
        await db
            .update(tables.runSources)
            .set({ fetchStatus: 'failed' })
            .where(and(eq(tables.runSources.id, recent.id)))
            .returning()
            .then(firstRow);
        const fallback = await json(
            await request(snapshotPath(data.source.id, data.snapshot.id), {
                headers: headers(owner),
            }),
        );
        expect(fallback.snapshot.observationId).toBe(data.observation.id);
        expect(fallback.snapshot.truncated).toBe(false);
    });
    it('真实FTS英文命中，中文simple miss由字面子串补充且不跨用户', async () => {
        const owner = await register(),
            other = await register();
        const own = await libraryFixture(db, owner.id, await task(owner), {
            title: '中文标题资料',
            text: '最新小样本学习研究进展。Robotics evidence.',
        });
        const theirs = await libraryFixture(db, other.id, await task(other), {
            title: '中文标题私有资料',
            text: '最新小样本学习研究私有内容。Robotics private.',
        });
        const saved = (
            await json(
                await note(
                    owner,
                    { kind: 'source', id: own.source.id },
                    '这是一段中文笔记召回样本。',
                ),
            )
        ).note;
        const [probe] = await queryRows<{ vector: string; fts: boolean; substring: boolean }>(
            db,
            querySql`
     SELECT to_tsvector('simple','最新小样本学习研究')::text AS vector,
     to_tsvector('simple','最新小样本学习研究') @@ plainto_tsquery('simple','小样本') AS fts,
     strpos('最新小样本学习研究','小样本')>0 AS substring`,
        );
        expect(probe!.fts).toBe(false);
        expect(probe!.substring).toBe(true);
        expect(probe!.vector).toContain('最新小样本学习研究');
        const english = await json(await search(owner, 'Robotics'));
        expect(english.items).toContainEqual(
            expect.objectContaining({ id: own.snapshot.id, kind: 'source', matchedBy: 'fts' }),
        );
        expect(english.items.some((row: { id: string }) => row.id === theirs.snapshot.id)).toBe(
            false,
        );
        expect((await json(await search(owner, '小样本'))).items).toContainEqual(
            expect.objectContaining({ id: own.snapshot.id, matchedBy: 'substring' }),
        );
        expect(
            (await json(await search(owner, '中文标题'))).items.some(
                (row: { id: string }) => row.id === own.snapshot.id,
            ),
        ).toBe(true);
        expect((await json(await search(owner, '笔记召回'))).items).toContainEqual(
            expect.objectContaining({
                id: saved.id,
                kind: 'note',
                matchedBy: 'substring',
                excerpt: expect.stringContaining('笔记召回'),
            }),
        );
        expect((await json(await search(other, '笔记召回'))).items).toHaveLength(0);
    });
    it('百分号下划线和SQL文本按字面检索，收藏/类型筛选有界', async () => {
        const owner = await register(),
            data = await libraryFixture(db, owner.id, await task(owner), {
                text: '只有这里出现100%_literal的标记。',
            });
        const saved = (
            await json(await note(owner, { kind: 'source', id: data.source.id }, '普通笔记'))
        ).note;
        expect(
            (await json(await search(owner, '%_literal'))).items.map(
                (row: { id: string }) => row.id,
            ),
        ).toEqual([data.snapshot.id]);
        expect((await json(await search(owner, "' OR 1=1 --"))).items).toHaveLength(0);
        expect((await json(await search(owner, '普通笔记', '&kind=source'))).items).toHaveLength(0);
        expect(
            (await json(await search(owner, '普通笔记', '&bookmarked=true'))).items,
        ).toHaveLength(0);
        await bookmark(owner, data.source.id);
        expect(
            (await json(await search(owner, '普通笔记', '&kind=note&bookmarked=true'))).items[0].id,
        ).toBe(saved.id);
        expect((await search(owner, 'a b c d e f g h i')).status).toBe(422);
    });
    it('PG微秒分页不漏同一毫秒内收藏、笔记、快照或搜索项', async () => {
        const owner = await register(),
            ownedTask = await task(owner),
            first = await libraryFixture(db, owner.id, ownedTask, {
                text: 'precisionprobe 第一正文',
            });
        const second = await libraryFixture(db, owner.id, ownedTask, {
            text: 'precisionprobe 第二正文',
        });
        const firstB = (await json(await bookmark(owner, first.source.id))).bookmark,
            secondB = (await json(await bookmark(owner, second.source.id))).bookmark;
        const firstN = (
            await json(
                await note(owner, { kind: 'source', id: first.source.id }, 'precisionprobe 笔记一'),
            )
        ).note;
        const secondN = (
            await json(
                await note(owner, { kind: 'source', id: first.source.id }, 'precisionprobe 笔记二'),
            )
        ).note;
        await db.execute(
            querySql`UPDATE bookmarks SET created_at='2026-02-01T00:00:00.123456Z'::timestamptz WHERE id=${firstB.id}::uuid`,
        );
        await db.execute(
            querySql`UPDATE bookmarks SET created_at='2026-02-01T00:00:00.123455Z'::timestamptz WHERE id=${secondB.id}::uuid`,
        );
        await db.execute(
            querySql`UPDATE notes SET updated_at='2026-02-01T00:00:00.123454Z'::timestamptz WHERE id=${firstN.id}::uuid`,
        );
        await db.execute(
            querySql`UPDATE notes SET updated_at='2026-02-01T00:00:00.123453Z'::timestamptz WHERE id=${secondN.id}::uuid`,
        );
        await db.execute(
            querySql`UPDATE run_sources SET observed_at='2026-02-01T00:00:00.123452Z'::timestamptz WHERE id=${first.observation.id}::uuid`,
        );
        await db.execute(
            querySql`UPDATE run_sources SET observed_at='2026-02-01T00:00:00.123451Z'::timestamptz WHERE id=${second.observation.id}::uuid`,
        );
        const third = await libraryFixture(db, owner.id, ownedTask, {
            source: first.source,
            text: 'precisionprobe 第三正文',
        });
        await db.execute(
            querySql`UPDATE run_sources SET observed_at='2026-02-01T00:00:00.123450Z'::timestamptz WHERE id=${third.observation.id}::uuid`,
        );
        expect(await pages(owner, '/bookmarks')).toEqual([firstB.id, secondB.id]);
        expect(await pages(owner, '/notes')).toEqual([firstN.id, secondN.id]);
        expect(await pages(owner, snapshotPath(first.source.id))).toEqual([
            first.snapshot.id,
            third.snapshot.id,
        ]);
        expect(await pages(owner, '/library/search?q=precisionprobe')).toEqual([
            firstN.id,
            secondN.id,
            first.snapshot.id,
            second.snapshot.id,
            third.snapshot.id,
        ]);
    });
    it('游标绑定owner和查询，笔记anchor修改后旧游标拒绝继续', async () => {
        const owner = await register(),
            other = await register(),
            data = await libraryFixture(db, owner.id, await task(owner));
        await note(owner, { kind: 'source', id: data.source.id }, 'cursorprobe 第一');
        await note(owner, { kind: 'source', id: data.source.id }, 'cursorprobe 第二');
        const page = await json(await request('/notes?limit=1', { headers: headers(owner) }));
        expect(page.nextCursor).toBeTruthy();
        expect(
            (
                await request('/notes?limit=1&cursor=' + encodeURIComponent(page.nextCursor), {
                    headers: headers(other),
                })
            ).status,
        ).toBe(400);
        await request('/notes/' + page.items[0].id, {
            method: 'PATCH',
            headers: headers(owner, { 'if-match': '"1"' }),
            body: JSON.stringify({ body: '已修改' }),
        });
        expect(
            (
                await request('/notes?cursor=' + encodeURIComponent(page.nextCursor), {
                    headers: headers(owner),
                })
            ).status,
        ).toBe(400);
        await note(owner, { kind: 'source', id: data.source.id }, 'cursorprobe 第三');
        const searchPage = await json(await search(owner, 'cursorprobe', '&limit=1'));
        expect(searchPage.nextCursor).toBeTruthy();
        expect(
            (
                await search(
                    owner,
                    'different',
                    '&cursor=' + encodeURIComponent(searchPage.nextCursor),
                )
            ).status,
        ).toBe(400);
    });
    it('过期正文立即不读不搜，清理保留引用元数据manifest与有效基线', async () => {
        const owner = await register(),
            ownedTask = await task(owner),
            data = await libraryFixture(db, owner.id, ownedTask, {
                complete: true,
                text: 'expiredbodyonly 原文证据片段',
                title: '保留标题',
            });
        const baseline = await db
            .insert(tables.baselines)
            .values({
                userId: owner.id,
                taskId: ownedTask.id,
                comparisonScopeHash: data.run.comparisonScopeHash,
                completeRunId: data.run.id,
            })
            .returning()
            .then(firstRow);
        const selected = (await json(await bookmark(owner, data.source.id))).bookmark,
            saved = (
                await json(
                    await note(
                        owner,
                        { kind: 'source', id: data.source.id },
                        '用户自己的笔记仍保留',
                    ),
                )
            ).note;
        expect(
            (
                await json(
                    await request(snapshotPath(data.source.id, data.snapshot.id), {
                        headers: headers(owner),
                    }),
                )
            ).textBody,
        ).not.toBeNull();
        await db.execute(
            querySql`UPDATE source_snapshots SET text_expires_at=clock_timestamp()-interval '1 second' WHERE id=${data.snapshot.id}::uuid`,
        );
        const expired = await json(
            await request(snapshotPath(data.source.id, data.snapshot.id), {
                headers: headers(owner),
            }),
        );
        expect(expired.textBody).toBeNull();
        expect(expired.snapshot.bodyStatus).toBe('expired');
        expect(expired.quotes[0].quote).toBe(data.quote);
        expect((await json(await search(owner, 'expiredbodyonly'))).items).toHaveLength(0);
        expect((await json(await search(owner, '保留标题'))).items[0].id).toBe(data.snapshot.id);
        expect(
            (
                await db.query.sourceSnapshots
                    .findFirst({ where: and(eq(tables.sourceSnapshots.id, data.snapshot.id)) })
                    .then(requireRow)
            ).textBody,
        ).not.toBeNull();
        expect(
            (
                await createLibraryService(services).purgeExpiredSnapshotBodies({
                    limit: 1,
                    userId: owner.id,
                })
            ).cleared,
        ).toBe(1);
        const after = await db.query.sourceSnapshots
            .findFirst({ where: and(eq(tables.sourceSnapshots.id, data.snapshot.id)) })
            .then(requireRow);
        expect(after.textBody).toBeNull();
        expect(after.contentHash).toBe(data.snapshot.contentHash);
        const report = await request('/reports/' + data.report.id, { headers: headers(owner) });
        expect(report.status).toBe(200);
        expect((await json(report)).evidence[0].quote).toBe(data.quote);
        expect(
            (
                await db.query.evidence
                    .findFirst({ where: and(eq(tables.evidence.id, data.evidence.id)) })
                    .then(requireRow)
            ).selectorJson,
        ).toEqual(data.evidence.selectorJson);
        expect(
            (
                await db.query.reports
                    .findFirst({ where: and(eq(tables.reports.id, data.report.id)) })
                    .then(requireRow)
            ).comparisonJson,
        ).toEqual(data.manifest);
        expect(
            (
                await db.query.baselines
                    .findFirst({ where: and(eq(tables.baselines.id, baseline.id)) })
                    .then(requireRow)
            ).completeRunId,
        ).toBe(data.run.id);
        await request('/bookmarks/' + selected.id, { method: 'DELETE', headers: headers(owner) });
        await request('/notes/' + saved.id, {
            method: 'DELETE',
            headers: headers(owner, { 'if-match': '"1"' }),
        });
        expect(
            await db.query.sources
                .findFirst({ where: and(eq(tables.sources.id, data.source.id)) })
                .then((row) => row ?? null),
        ).not.toBeNull();
        expect(
            (
                await db.query.baselines
                    .findFirst({ where: and(eq(tables.baselines.id, baseline.id)) })
                    .then(requireRow)
            ).completeRunId,
        ).toBe(data.run.id);
    });
    it('内部清理owner和batch边界生效且未过期正文不清理', async () => {
        const owner = await register(),
            other = await register(),
            ownedTask = await task(owner);
        const first = await libraryFixture(db, owner.id, ownedTask),
            second = await libraryFixture(db, owner.id, ownedTask),
            future = await libraryFixture(db, owner.id, ownedTask),
            theirs = await libraryFixture(db, other.id, await task(other));
        for (const row of [first, second, theirs])
            await db.execute(
                querySql`UPDATE source_snapshots SET text_expires_at=clock_timestamp()-interval '1 day' WHERE id=${row.snapshot.id}::uuid`,
            );
        const library = createLibraryService(services);
        expect(
            (await library.purgeExpiredSnapshotBodies({ limit: 1, userId: owner.id })).cleared,
        ).toBe(1);
        expect(
            await db
                .select({ count: count() })
                .from(tables.sourceSnapshots)
                .where(
                    and(
                        eq(tables.sourceSnapshots.userId, owner.id),
                        isNull(tables.sourceSnapshots.textBody),
                    ),
                )
                .then(([row]) => row!.count),
        ).toBe(1);
        expect(
            (
                await db.query.sourceSnapshots
                    .findFirst({ where: and(eq(tables.sourceSnapshots.id, theirs.snapshot.id)) })
                    .then(requireRow)
            ).textBody,
        ).not.toBeNull();
        expect(
            (
                await db.query.sourceSnapshots
                    .findFirst({ where: and(eq(tables.sourceSnapshots.id, future.snapshot.id)) })
                    .then(requireRow)
            ).textBody,
        ).not.toBeNull();
        expect(
            (await library.purgeExpiredSnapshotBodies({ limit: 100, userId: owner.id })).cleared,
        ).toBe(1);
        expect(
            (await library.purgeExpiredSnapshotBodies({ limit: 100, userId: owner.id })).cleared,
        ).toBe(0);
    });
    it('坏正文或引用hash拒绝整个历史详情，无成功观测不可读取', async () => {
        const owner = await register(),
            data = await libraryFixture(db, owner.id, await task(owner));
        await db
            .update(tables.sourceSnapshots)
            .set({ textBody: '被篡改' })
            .where(and(eq(tables.sourceSnapshots.id, data.snapshot.id)))
            .returning()
            .then(firstRow);
        expect(
            (
                await request(snapshotPath(data.source.id, data.snapshot.id), {
                    headers: headers(owner),
                })
            ).status,
        ).toBe(409);
        await db
            .update(tables.sourceSnapshots)
            .set({ textBody: null })
            .where(and(eq(tables.sourceSnapshots.id, data.snapshot.id)))
            .returning()
            .then(firstRow);
        await db
            .update(tables.evidence)
            .set({ quoteHash: '0'.repeat(64) })
            .where(and(eq(tables.evidence.id, data.evidence.id)))
            .returning()
            .then(firstRow);
        expect(
            (
                await request(snapshotPath(data.source.id, data.snapshot.id), {
                    headers: headers(owner),
                })
            ).status,
        ).toBe(409);
        await db
            .update(tables.runSources)
            .set({ fetchStatus: 'failed' })
            .where(and(eq(tables.runSources.id, data.observation.id)))
            .returning()
            .then(firstRow);
        expect(
            (
                await request(snapshotPath(data.source.id, data.snapshot.id), {
                    headers: headers(owner),
                })
            ).status,
        ).toBe(404);
        expect(
            (await json(await request(snapshotPath(data.source.id), { headers: headers(owner) })))
                .items,
        ).toHaveLength(0);
    });
});
