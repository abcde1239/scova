import sharp from 'sharp';
import { migrateDatabase } from '@scova/db/migrate';
import { createDatabaseClient, connectDatabase, closeDatabase, and, eq } from '@scova/db';
import * as tables from '@scova/db';
import {
    REPORT_ATTACHMENT_INLINE_MAX_BYTES,
    REPORT_ATTACHMENT_MAX_BYTES,
    ReportJsonExportSchema,
    parseContract,
    serializeReportJson,
} from '@scova/models';
import { openSqliteState, readSqliteStatePath } from '@scova/db/sqlite-state';
import { createObjectStorage, type ObjectStorage } from '@scova/object-storage';
import { createReportResourceRepo } from '../src/repo/report-resources.ts';
import { cleanUnusedReportAttachments } from '../src/service/report-attachment-storage.ts';
import { createHash, randomUUID } from 'node:crypto';

import { Redis as RedisClient } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { createApiApp } from '../src/app/index.ts';
import { createDefaultServices } from '../src/app/services.ts';
import { reportPdfFixture } from './fixtures/report-pdf.ts';
import { firstRow, requireRow } from '../src/utils/database.ts';

const baseUrl =
    process.env.SCOVA_TEST_DATABASE_URL ??
    process.env.RUNTIME_DATABASE_URL ??
    'postgresql://scova_test:scova_test@127.0.0.1:55432/scova_test';
const redisUrl =
    process.env.SCOVA_TEST_REDIS_URL ?? process.env.RUNTIME_REDIS_URL ?? 'redis://127.0.0.1:56379';
const schema = `scova_reports_${randomUUID().replaceAll('-', '')}`;
const scopedUrl = new URL(baseUrl);
scopedUrl.searchParams.set('schema', schema);
const db = createDatabaseClient({ connectionString: scopedUrl.toString() });
const admin = new (require('pg').Client)({ connectionString: baseUrl });
const redis = new RedisClient(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
});
const sqlitePath = readSqliteStatePath();
let coordination: ReturnType<typeof openSqliteState> | undefined;
let bucket: ObjectStorage | null;
const origin = 'https://scova.test';
let schemaCreated = false;
let app: ReturnType<typeof createApiApp>;
let now: Date;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const config = {
    title: '官方资讯',
    topic: '来源证据',
    goal: '查阅官方原文',
    focusPoints: ['原文'],
    exclusions: [],
    sourcePreferences: { preferredUrls: [], excludedUrls: [], officialOnly: false },
    timeRange: { kind: 'rolling', days: 7 },
    timezone: 'UTC',
    schedule: { frequency: 'manual' },
    outputFormat: 'brief',
    budget: {
        maxSearches: 10,
        maxPages: 20,
        maxDurationSeconds: 300,
        maxInputTokens: 40000,
        maxOutputTokens: 8000,
    },
    notificationPreference: { mode: 'summary', runIssues: true },
};
type Auth = { cookie: string; csrf: string; userId: string };
const json = async (response: Response) => (await response.json()) as Record<string, any>;
const headers = (auth?: Auth) => ({
    origin,
    'content-type': 'application/json',
    ...(auth ? { cookie: auth.cookie, 'x-csrf-token': auth.csrf } : {}),
});
const request = (path: string, init: RequestInit = {}) =>
    app.handle(new Request(`${origin}/api/v1${path}`, init));
async function register(): Promise<Auth> {
    const response = await request('/auth/register', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
            email: `${randomUUID()}@example.test`,
            password: 'correct horse battery staple',
            defaultTimezone: 'UTC',
        }),
    });
    expect(response.status).toBe(201);
    const body = await json(response);
    return {
        cookie: response.headers.get('set-cookie')!.split(';')[0]!,
        csrf: body.csrfToken,
        userId: body.user.id,
    };
}
async function task(auth: Auth) {
    const response = await request('/tasks', {
        method: 'POST',
        headers: headers(auth),
        body: JSON.stringify({ config }),
    });
    expect(response.status).toBe(201);
    return (await json(response)).task as { id: string; currentVersionId: string };
}
async function fixture(
    auth: Auth,
    existingTask?: { id: string; currentVersionId: string },
    index = 0,
) {
    const ownedTask = existingTask ?? (await task(auth));
    const coverage = {
        completeness: 'partial',
        searchedQueries: ['官方资讯'],
        gaps: ['发布时间尚未核验'],
        exhausted: [],
    };
    const run = await db
        .insert(tables.runs)
        .values({
            userId: auth.userId,
            taskId: ownedTask.id,
            taskVersionId: ownedTask.currentVersionId,
            comparisonScopeHash: sha('scope'),
            mode: 'demo',
            trigger: 'manual',
            status: 'partial',
            budgetJson: config.budget,
            usageJson: {},
            outcome: 'inconclusive',
            coverageJson: coverage,
        })
        .returning()
        .then(firstRow);
    const url = `https://example.com/${randomUUID()}`;
    const text = '这是完整采集正文。活动日期尚需确认。';
    const quote = text.slice(0, 9);
    const source = await db
        .insert(tables.sources)
        .values({ userId: auth.userId, canonicalUrl: url, canonicalUrlHash: sha(url) })
        .returning()
        .then(firstRow);
    const snapshot = await db
        .insert(tables.sourceSnapshots)
        .values({
            userId: auth.userId,
            sourceId: source.id,
            title: '来源页面',
            contentHash: sha(text),
            extractorVersion: 'reader-v1',
            textBody: text,
            textExpiresAt: new Date('2026-10-27T00:00:00Z'),
            metadataJson: {
                mode: 'demo',
                originalUrl: url,
                fetchedUrl: url,
                collectedAt: now.toISOString(),
                truncated: false,
                untrusted: true,
            },
        })
        .returning()
        .then(firstRow);
    await db
        .insert(tables.runSources)
        .values({
            userId: auth.userId,
            runId: run.id,
            sourceId: source.id,
            snapshotId: snapshot.id,
            requestedUrl: `${url}?original=1`,
            fetchedUrl: url,
            observedAt: now,
            fetchStatus: 'succeeded',
            metadataJson: { mode: 'demo', truncated: false },
        })
        .returning()
        .then(firstRow);
    const evidence = await db
        .insert(tables.evidence)
        .values({
            userId: auth.userId,
            runId: run.id,
            snapshotId: snapshot.id,
            quote: quote,
            quoteHash: sha(quote),
            selectorJson: {
                type: 'text_offset',
                start: 0,
                end: quote.length,
                extractorVersion: 'reader-v1',
            },
        })
        .returning()
        .then(firstRow);
    const report = await db
        .insert(tables.reports)
        .values({
            userId: auth.userId,
            runId: run.id,
            taskId: ownedTask.id,
            taskVersionId: ownedTask.currentVersionId,
            title: '原文简报',
            summary: '已经采集来源，仍存在核验缺口',
            format: 'brief',
            completeness: 'partial',
            limitationsJson: ['演示资料', '发布时间尚未核验'],
            publishedAt: new Date(now.getTime() + index * 1000),
        })
        .returning()
        .then(firstRow);
    const claim = await db
        .insert(tables.claims)
        .values({
            userId: auth.userId,
            taskId: ownedTask.id,
            reportId: report.id,
            kind: 'fact',
            text: quote,
            confidenceLabel: '来自原文',
            order: 0,
        })
        .returning()
        .then(firstRow);
    const citation = await db
        .insert(tables.claimEvidence)
        .values({
            userId: auth.userId,
            claimId: claim.id,
            evidenceId: evidence.id,
            relation: 'supports',
        })
        .returning()
        .then(firstRow);
    const inbox = await db
        .insert(tables.inboxItems)
        .values({ userId: auth.userId, reportId: report.id, createdAt: report.publishedAt })
        .returning()
        .then(firstRow);
    return {
        task: ownedTask,
        run,
        source,
        snapshot,
        evidence,
        report,
        claim,
        citation,
        inbox,
        quote,
        url,
    };
}

describe('报告证据与收件箱 API', () => {
    it('生成并引用账号私有图表，并发复用、保留过期资源、续期和级联删除', async () => {
        const owner = await register();
        const other = await register();
        const saved = await fixture(owner);
        const root = `/reports/${saved.report.id}/charts`;
        const generate = (auth?: Auth, csrf = auth?.csrf ?? '') =>
            request(`${root}/source-hosts`, {
                method: 'POST',
                headers: { ...headers(auth), 'x-csrf-token': csrf },
            });
        expect((await generate()).status).toBe(401);
        expect((await generate(owner, '')).status).toBe(403);
        expect((await generate(other)).status).toBe(404);
        const generated = await Promise.all([generate(owner), generate(owner)]);
        expect(generated.map((response) => response.status)).toEqual([200, 200]);
        const [first, second] = await Promise.all(generated.map(json));
        expect(first).toEqual(second);
        expect(first).toMatchObject({
            reportId: saved.report.id,
            reportVersion: saved.report.publishedAt.toISOString(),
            rendererVersion: 1,
            rows: [
                {
                    hostname: 'example.com',
                    count: 1,
                    sources: [{ sourceId: saved.source.id, evidenceIds: [saved.evidence.id] }],
                },
            ],
        });
        const download = first!.downloadUrl.replace(/^\/api\/v1/, '');
        const stable = `${root}/${first!.id}`;
        const read = (path: string, auth?: Auth) => request(path, { headers: headers(auth) });
        expect((await read(stable, other)).status).toBe(404);
        expect((await read(download, other)).status).toBe(404);
        expect((await read(download)).status).toBe(401);
        const chart = await read(download, owner);
        expect(chart.status).toBe(200);
        expect(chart.headers.get('content-type')).toBe('image/svg+xml');
        expect(chart.headers.get('content-disposition')).toContain('.svg');
        expect(await chart.text()).toContain('<desc id="description">example.com：1</desc>');
        await db
            .update(tables.reportResources)
            .set({
                createdAt: new Date(now.getTime() - 86_400_000),
                expiresAt: now,
            })
            .where(eq(tables.reportResources.id, first!.id));
        expect((await read(download, owner)).status).toBe(410);
        expect((await json(await read(stable, owner))).id).toBe(first!.id);
        expect((await json(await generate(owner))).id).toBe(first!.id);
        expect((await read(download, owner)).status).toBe(200);
        await db
            .delete(tables.claimEvidence)
            .where(eq(tables.claimEvidence.claimId, saved.claim.id));
        await db
            .update(tables.claims)
            .set({ kind: 'model_answer' })
            .where(eq(tables.claims.id, saved.claim.id));
        const empty = await json(await generate(owner));
        expect(empty.id).not.toBe(first!.id);
        expect(empty.rows).toEqual([]);
        expect((await json(await read(stable, owner))).rows).toEqual(first!.rows);
        await db.delete(tables.claims).where(eq(tables.claims.id, saved.claim.id));
        await db.delete(tables.inboxItems).where(eq(tables.inboxItems.id, saved.inbox.id));
        await db.delete(tables.reports).where(eq(tables.reports.id, saved.report.id));
        expect((await read(stable, owner)).status).toBe(404);
        expect(
            await db
                .select()
                .from(tables.reportResources)
                .where(eq(tables.reportResources.id, first!.id)),
        ).toEqual([]);
    });

    it('上传私有 CSV，按行定位，保留解析失败原件并拒绝越权、超限和非法类型', async () => {
        const owner = await register();
        const other = await register();
        const saved = await fixture(owner);
        const root = `/reports/${saved.report.id}/attachments`;
        const upload = (auth: Auth, body: string, type = 'text/csv', csrf = auth.csrf) =>
            request(`${root}?filename=${encodeURIComponent('参考资料.csv')}`, {
                method: 'POST',
                body,
                headers: { ...headers(auth), 'content-type': type, 'x-csrf-token': csrf },
            });
        const csv = '\ufefftitle,value\r\na,"first\r\nsecond"\r\n';
        expect((await upload(other, csv)).status).toBe(404);
        expect((await upload(owner, csv, 'text/csv', '')).status).toBe(403);
        expect((await upload(owner, csv, 'text/plain')).status).toBe(415);
        expect((await upload(owner, 'x'.repeat(REPORT_ATTACHMENT_MAX_BYTES + 1))).status).toBe(413);
        const response = await upload(owner, csv);
        expect(response.status).toBe(200);
        const item = await json(response);
        expect(item).toMatchObject({
            reportId: saved.report.id,
            filename: '参考资料.csv',
            byteLength: Buffer.byteLength(csv),
            status: 'ready',
            rowCount: 2,
            failureCode: null,
        });
        expect((await json(await upload(owner, csv))).id).toBe(item.id);
        const rows = `${root}/${item.id}/rows?start=2&end=10`;
        expect((await request(rows, { headers: headers(other) })).status).toBe(404);
        const body = await json(await request(rows, { headers: headers(owner) }));
        expect(body).toEqual({
            attachmentId: item.id,
            rowCount: 2,
            rows: [{ rowNumber: 2, startLine: 2, endLine: 3, cells: ['a', 'first\r\nsecond'] }],
        });
        expect(
            (await request(`${root}/${item.id}/rows?start=2.2&end=3`, { headers: headers(owner) }))
                .status,
        ).toBe(422);
        const download = item.downloadUrl.replace(/^\/api\/v1/, '');
        expect((await request(download, { headers: headers(other) })).status).toBe(404);
        const original = await request(download, { headers: headers(owner) });
        expect(original.status).toBe(200);
        expect(Buffer.from(await original.arrayBuffer())).toEqual(Buffer.from(csv));
        const failed = await json(await upload(owner, 'title,value\n"unfinished'));
        expect(failed).toMatchObject({
            status: 'failed',
            failureCode: 'INVALID_CSV',
            rowCount: null,
        });
        expect(
            (await request(`${root}/${failed.id}/rows?start=1&end=1`, { headers: headers(owner) }))
                .status,
        ).toBe(409);
        expect(
            (
                await request(failed.downloadUrl.replace(/^\/api\/v1/, ''), {
                    headers: headers(owner),
                })
            ).status,
        ).toBe(200);
        expect((await request(root, { headers: headers(other) })).status).toBe(404);
        expect((await json(await request(root, { headers: headers(owner) }))).items).toHaveLength(
            2,
        );
        expect(
            (await request(`${root}/${item.id}`, { method: 'DELETE', headers: headers(other) }))
                .status,
        ).toBe(404);
        expect(
            (await request(`${root}/${item.id}`, { method: 'DELETE', headers: headers(owner) }))
                .status,
        ).toBe(200);
        expect((await request(download, { headers: headers(owner) })).status).toBe(404);
        expect((await json(await request(root, { headers: headers(owner) }))).items).toEqual([
            failed,
        ]);
    });

    it('大附件只在私有桶写入一次并通过同源接口下载与回收', async () => {
        const owner = await register();
        const other = await register();
        const { report, claim, inbox } = await fixture(owner);
        const root = `/reports/${report.id}/attachments`;
        const body = 'x'.repeat(REPORT_ATTACHMENT_INLINE_MAX_BYTES + 1);
        const upload = (filename: string, auth = owner, bytes = body) =>
            request(`${root}?filename=${encodeURIComponent(filename)}`, {
                method: 'POST',
                body: bytes,
                headers: {
                    ...headers(auth),
                    'content-type': filename.endsWith('.md') ? 'text/markdown' : 'text/plain',
                },
            });
        const disabled = await upload('large.md');
        expect(disabled.status).toBe(503);
        expect(await json(disabled)).toMatchObject({ code: 'REPORT_ATTACHMENT_STORAGE_DISABLED' });

        const store = createObjectStorage({
            provider: 's3',
            region: 'us-east-1',
            bucket: 'test-attachments',
            credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
        });
        bucket = store;
        const objects = new Map<string, Uint8Array>();
        const put = vi.spyOn(store, 'upload').mockImplementation(async (input) => {
            const key = input.key!;
            objects.set(key, Uint8Array.from(input.body));
            return { key, size: input.body.byteLength, url: null, contentType: input.contentType };
        });
        const get = vi.spyOn(store, 'download').mockImplementation(async (key) => {
            const bytes = objects.get(key)!;
            return { size: bytes.byteLength, body: new Response(Uint8Array.from(bytes)).body! };
        });
        const remove = vi.spyOn(store, 'delete').mockImplementation(async (key) => {
            objects.delete(key);
        });
        try {
            const inline = await upload(
                'inline.txt',
                owner,
                'x'.repeat(REPORT_ATTACHMENT_INLINE_MAX_BYTES),
            );
            expect(inline.status).toBe(200);
            expect(put).not.toHaveBeenCalled();
            expect((await upload('large.md', other)).status).toBe(404);
            const responses = await Promise.all([upload('large.md'), upload('large.md')]);
            expect(responses.map(({ status }) => status)).toEqual([200, 200]);
            const [item, duplicate] = await Promise.all(responses.map(json));
            expect(item).toEqual(duplicate);
            expect(item).toMatchObject({
                format: 'md',
                status: 'download_only',
                byteLength: body.length,
            });
            expect(item).not.toHaveProperty('objectId');
            expect(put).toHaveBeenCalledExactlyOnceWith(
                expect.objectContaining({ contentType: 'text/markdown' }),
            );
            const [key] = objects.keys();
            expect(key?.split('/').slice(0, 2)).toEqual(['report-attachments', owner.userId]);
            const [row] = await db
                .select()
                .from(tables.reportResources)
                .where(eq(tables.reportResources.id, item!.id));
            expect(row).toMatchObject({ content: null, objectSize: body.length });
            expect(row?.objectId).toBe(key?.split('/').at(-1));
            const downloadUrl = item!.downloadUrl.replace(/^\/api\/v1/, '');
            expect((await request(downloadUrl, { headers: headers(other) })).status).toBe(404);
            expect(get).not.toHaveBeenCalled();
            const download = await request(downloadUrl, { headers: headers(owner) });
            expect(download.status).toBe(200);
            expect(download.headers.get('content-length')).toBe(String(body.length));
            expect(download.headers.get('content-disposition')).toContain('large.md');
            expect(await download.text()).toBe(body);
            expect(
                (
                    await request(`${root}/${item!.id}/rows?start=1&end=1`, {
                        headers: headers(owner),
                    })
                ).status,
            ).toBe(409);

            let failedKey = '';
            put.mockImplementationOnce(async (input) => {
                failedKey = input.key!;
                objects.set(failedKey, Uint8Array.from(input.body));
                throw new Error('upload committed upstream, but acknowledgment was lost');
            });
            expect((await upload('failed.txt')).status).toBe(503);
            const list = await json(await request(root, { headers: headers(owner) }));
            expect(list.items.map(({ filename }: { filename: string }) => filename).sort()).toEqual(
                ['inline.txt', 'large.md'],
            );
            const repo = createReportResourceRepo(() => db);
            let sweepTime = now;
            const sweep = () =>
                cleanUnusedReportAttachments(
                    { objectStorage: () => store, clock: () => sweepTime },
                    repo,
                    32,
                    new AbortController().signal,
                );
            await sweep();
            expect(remove).not.toHaveBeenCalled();
            // A later orphan must still be collected while the oldest one keeps failing.
            const laterId = randomUUID();
            const laterKey = `report-attachments/${owner.userId}/${laterId}`;
            objects.set(laterKey, new Uint8Array([1]));
            await db.insert(tables.reportAttachmentObjects).values({
                userId: owner.userId,
                id: laterId,
                createdAt: new Date(now.getTime() + 1),
            });
            const deleteObject = async (target: string) => {
                objects.delete(target);
            };
            remove.mockImplementation(async (target) => {
                if (target === failedKey) throw new Error('storage persistent failure');
                await deleteObject(target);
            });
            sweepTime = new Date(sweepTime.getTime() + 2 * 60 * 60 * 1000);
            const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
            await expect(sweep()).rejects.toThrow('1 个附件对象删除失败');
            expect(logged).toHaveBeenCalledOnce();
            logged.mockRestore();
            expect(objects.has(laterKey)).toBe(false);
            expect(objects.has(failedKey)).toBe(true);
            // The failed object is postponed for a full grace period instead of retried at once.
            await sweep();
            expect(objects.has(failedKey)).toBe(true);
            remove.mockImplementation(deleteObject);
            sweepTime = new Date(sweepTime.getTime() + 60 * 60 * 1000 + 1);
            await sweep();
            expect(objects.has(failedKey)).toBe(false);
            expect([...objects.keys()]).toEqual([key]);
            expect(
                (
                    await request(`${root}/${item!.id}`, {
                        method: 'DELETE',
                        headers: headers(owner),
                    })
                ).status,
            ).toBe(200);
            expect((await request(downloadUrl, { headers: headers(owner) })).status).toBe(404);
            await sweep();
            expect(objects.size).toBe(0);
            expect(await db.select().from(tables.reportAttachmentObjects)).toHaveLength(0);

            expect((await upload('cascade.txt')).status).toBe(200);
            const remaining = await Promise.all(
                Array.from({ length: 14 }, (_, index) =>
                    upload(`quota-${index}.txt`, owner, 'a\n'),
                ),
            );
            expect(remaining.every(({ status }) => status === 200)).toBe(true);
            const quota = await upload('quota-large.txt');
            expect(quota.status).toBe(409);
            expect(await json(quota)).toMatchObject({ code: 'REPORT_ATTACHMENT_QUOTA' });
            expect(objects.size).toBe(1);
            await db.delete(tables.claimEvidence).where(eq(tables.claimEvidence.claimId, claim.id));
            await db.delete(tables.claims).where(eq(tables.claims.id, claim.id));
            await db.delete(tables.inboxItems).where(eq(tables.inboxItems.id, inbox.id));
            await db.delete(tables.reports).where(eq(tables.reports.id, report.id));
            await sweep();
            expect(objects.size).toBe(0);
        } finally {
            store.destroy();
        }
    });

    it('慢速大附件上传期间同账号其他报告仍可导出', async () => {
        const owner = await register();
        const { report } = await fixture(owner);
        const { report: another } = await fixture(owner, undefined, 1);
        const store = createObjectStorage({
            provider: 's3',
            region: 'us-east-1',
            bucket: 'test-attachments',
            credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
        });
        bucket = store;
        let started!: () => void;
        let release!: () => void;
        const putStarted = new Promise<void>((resolve) => (started = resolve));
        const putReleased = new Promise<void>((resolve) => (release = resolve));
        vi.spyOn(store, 'upload').mockImplementation(async (input) => {
            started();
            await putReleased;
            return {
                key: input.key!,
                size: input.body.byteLength,
                url: null,
                contentType: input.contentType,
            };
        });
        try {
            const slow = request(`/reports/${report.id}/attachments?filename=slow.txt`, {
                method: 'POST',
                body: 'x'.repeat(REPORT_ATTACHMENT_INLINE_MAX_BYTES + 1),
                headers: { ...headers(owner), 'content-type': 'text/plain' },
            });
            await putStarted;
            const exported = await request(`/reports/${another.id}/exports/markdown`, {
                method: 'POST',
                headers: headers(owner),
            });
            expect(exported.status).toBe(200);
            release();
            expect((await slow).status).toBe(200);
            await db
                .delete(tables.reportExports)
                .where(eq(tables.reportExports.userId, owner.userId));
        } finally {
            release();
            store.destroy();
        }
    });

    it('预览新增文本格式并原样下载新增图片格式', async () => {
        const owner = await register();
        const { report } = await fixture(owner);
        const root = `/reports/${report.id}/attachments`;
        const upload = (filename: string, type: string, body: string | Uint8Array<ArrayBuffer>) =>
            request(`${root}?filename=${encodeURIComponent(filename)}`, {
                method: 'POST',
                body,
                headers: { ...headers(owner), 'content-type': type },
            });
        const download = (id: string) =>
            request(`${root}/${id}/download`, { headers: headers(owner) });
        const rows = (id: string) =>
            request(`${root}/${id}/rows?start=1&end=1`, { headers: headers(owner) });
        const texts = [
            ['a.MD', 'text/markdown', 'md', '# 标题'],
            ['说明.markdown', 'text/markdown', 'md', '<b>原文</b>'],
            ['资料.json', 'application/json', 'json', '{"标题":"参考"}'],
            ['数据.tsv', 'text/tab-separated-values', 'tsv', '名字\t数值'],
        ] as const;
        for (const [filename, type, format, line] of texts) {
            const body = `${line}\r\n`;
            const response = await upload(filename, type, body);
            expect(response.status).toBe(200);
            const item = await json(response);
            expect(item).toMatchObject({ filename, format, status: 'ready', rowCount: 1 });
            expect(await json(await rows(item.id))).toMatchObject({
                rows: [{ rowNumber: 1, startLine: 1, endLine: 1, cells: [line] }],
            });
            expect(await (await download(item.id)).text()).toBe(body);
        }
        const broken = await json(await upload('错误.json', 'application/json', '{"a":}'));
        expect(broken).toMatchObject({
            format: 'json',
            status: 'failed',
            failureCode: 'INVALID_JSON',
        });
        expect((await rows(broken.id)).status).toBe(409);
        expect(await (await download(broken.id)).text()).toBe('{"a":}');

        const image = sharp({ create: { width: 2, height: 2, channels: 3, background: '#f00' } });
        const images = [
            ['图.PNG', 'image/png', 'png'],
            ['图.jpg', 'image/jpeg', 'jpeg'],
            ['图.jpeg', 'image/jpeg', 'jpeg'],
            ['图.webp', 'image/webp', 'webp'],
        ] as const;
        for (const [filename, type, format] of images) {
            const body = Uint8Array.from(await image.clone().toFormat(format).toBuffer());
            const response = await upload(filename, type, body);
            expect(response.status).toBe(200);
            const item = await json(response);
            expect(item).toMatchObject({
                filename,
                format,
                status: 'download_only',
                rowCount: null,
            });
            expect((await rows(item.id)).status).toBe(409);
            const original = await download(item.id);
            expect(original.headers.get('content-type')).toBe('application/octet-stream');
            expect(original.headers.get('x-content-type-options')).toBe('nosniff');
            expect(new Uint8Array(await original.arrayBuffer())).toEqual(body);
        }
        const png = Uint8Array.from(await image.clone().png().toBuffer());
        expect((await upload('图.png', 'image/jpeg', png)).status).toBe(415);
        const mismatched = await upload('图.jpg', 'image/jpeg', png);
        expect(mismatched.status).toBe(422);
        expect(await json(mismatched)).toMatchObject({ code: 'REPORT_ATTACHMENT_INVALID_IMAGE' });
        expect((await upload('图.svg', 'image/svg+xml', '<svg/>')).status).toBe(422);
        expect((await json(await request(root, { headers: headers(owner) }))).items).toHaveLength(
            9,
        );
    });

    it('私有 TXT 和 PDF 共用附件鉴权、限额和重试去重', async () => {
        const owner = await register();
        const other = await register();
        const { report } = await fixture(owner);
        const root = `/reports/${report.id}/attachments`;
        const upload = (filename: string, type: string, body: string, auth = owner) =>
            request(`${root}?filename=${encodeURIComponent(filename)}`, {
                method: 'POST',
                body,
                headers: { ...headers(auth), 'content-type': type },
            });
        const text = '标题\r\n\r\n第二段\n';
        const textUploads = await Promise.all([
            upload('资料.TXT', 'text/plain; charset=utf-8', text),
            upload('资料.TXT', 'text/plain', text),
        ]);
        expect(textUploads.map((response) => response.status)).toEqual([200, 200]);
        const [txt, retry] = await Promise.all(textUploads.map(json));
        expect(txt).toEqual(retry);
        expect(txt).toMatchObject({ format: 'txt', status: 'ready', rowCount: 3 });
        expect(
            await json(
                await request(`${root}/${txt!.id}/rows?start=2&end=3`, {
                    headers: headers(owner),
                }),
            ),
        ).toEqual({
            attachmentId: txt!.id,
            rowCount: 3,
            rows: [
                { rowNumber: 2, startLine: 2, endLine: 2, cells: [''] },
                { rowNumber: 3, startLine: 3, endLine: 3, cells: ['第二段'] },
            ],
        });

        const pdf = reportPdfFixture();
        expect((await upload('资料.pdf', 'text/plain', pdf)).status).toBe(415);
        expect((await upload('资料.pdf', 'application/pdf', '%PDF-1.7\n%%EOF')).status).toBe(422);
        expect((await upload('资料.pdf', 'application/pdf', pdf, other)).status).toBe(404);
        expect(
            (
                await upload(
                    '资料.pdf',
                    'application/pdf',
                    pdf.padEnd(REPORT_ATTACHMENT_MAX_BYTES + 1),
                )
            ).status,
        ).toBe(413);
        const response = await upload('资料.pdf', 'application/pdf', pdf);
        expect(response.status).toBe(200);
        const item = await json(response);
        expect(item).toMatchObject({ format: 'pdf', status: 'download_only', rowCount: null });
        const preview = `${root}/${item.id}/rows?start=1&end=1`;
        expect((await request(preview, { headers: headers(owner) })).status).toBe(409);
        expect((await request(preview, { headers: headers(other) })).status).toBe(404);
        const download = `${root}/${item.id}/download`;
        expect((await request(download, { headers: headers(other) })).status).toBe(404);
        const original = await request(download, { headers: headers(owner) });
        expect(original.headers.get('content-type')).toBe('application/octet-stream');
        expect(original.headers.get('content-disposition')).toMatch(/^attachment;/);
        expect(original.headers.get('x-content-type-options')).toBe('nosniff');
        expect(await original.text()).toBe(pdf);
        expect((await json(await request(root, { headers: headers(owner) }))).items).toHaveLength(
            2,
        );
        expect(
            (await request(`${root}/${item.id}`, { method: 'DELETE', headers: headers(owner) }))
                .status,
        ).toBe(200);
        expect((await request(download, { headers: headers(owner) })).status).toBe(404);
    });

    it('导出原始报告：会话、CSRF、Owner、并发复用及过期回收', async () => {
        const owner = await register();
        const other = await register();
        const saved = await fixture(owner);
        const path = '/reports/' + saved.report.id + '/exports/markdown';
        const exportMarkdown = (auth?: Auth, override?: Record<string, string>) =>
            request(path, { method: 'POST', headers: { ...headers(auth), ...override } });
        expect((await exportMarkdown()).status).toBe(401);
        expect((await exportMarkdown(owner, { 'x-csrf-token': '' })).status).toBe(403);
        expect((await exportMarkdown(owner, { origin: 'https://other.test' })).status).toBe(403);
        expect((await exportMarkdown(other)).status).toBe(404);
        expect(await db.select().from(tables.reportExports)).toHaveLength(0);

        const attempts = await Promise.all([exportMarkdown(owner), exportMarkdown(owner)]);
        expect(attempts.map((response) => response.status)).toEqual([200, 200]);
        expect(attempts[0]!.headers.get('cache-control')).toBe('no-store');
        const [first, second] = await Promise.all(attempts.map(json));
        expect(first).toEqual(second);
        expect(first).toMatchObject({
            filename: 'scova-report-' + saved.report.id + '.md',
            reportId: saved.report.id,
            expiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
        });
        expect(first!.markdown).toContain('演示（非真实研究）');
        expect(first!.markdown).toContain('覆盖：部分');
        expect(first!.markdown).toContain(saved.quote);
        expect(first!.markdown).not.toContain('活动日期尚需确认。');
        expect(first!.byteLength).toBe(Buffer.byteLength(first!.markdown));
        expect(first!.sha256).toBe(sha(first!.markdown));
        const savedRows = await db.select().from(tables.reportExports);
        expect(savedRows).toHaveLength(1);
        expect(savedRows[0]).toMatchObject({
            id: first!.id,
            userId: owner.userId,
            content: first!.markdown,
        });
        expect((await exportMarkdown(other)).status).toBe(404);
        await db
            .update(tables.reportExports)
            .set({
                createdAt: new Date(now.getTime() - 86_400_000),
                expiresAt: now,
            })
            .where(eq(tables.reportExports.id, first!.id));
        const newResponse = await exportMarkdown(owner);
        expect(newResponse.status).toBe(200);
        const fresh = await json(newResponse);
        expect(fresh.id).not.toBe(first!.id);
        expect(fresh.sha256).toBe(first!.sha256);
        expect(
            await db
                .select()
                .from(tables.reportExports)
                .where(eq(tables.reportExports.id, first!.id)),
        ).toHaveLength(0);
    });

    it('同一报告的 JSON 与 Markdown 分别复用、鉴权和过期', async () => {
        const owner = await register();
        const other = await register();
        const saved = await fixture(owner);
        const [change] = await db
            .insert(tables.changeRecords)
            .values({
                userId: owner.userId,
                reportId: saved.report.id,
                sourceId: saved.source.id,
                kind: 'new',
                newSnapshotId: saved.snapshot.id,
                factKey: '新增资料',
                newValue: saved.quote,
                importance: 'important',
                reason: '本次观测',
            })
            .returning();
        await db.insert(tables.changeEvidence).values({
            userId: owner.userId,
            changeRecordId: change!.id,
            evidenceId: saved.evidence.id,
            side: 'new',
        });
        const download = (format: 'markdown' | 'json', auth?: Auth, csrf = auth?.csrf ?? '') =>
            request(`/reports/${saved.report.id}/exports/${format}`, {
                method: 'POST',
                headers: { ...headers(auth), 'x-csrf-token': csrf },
            });
        expect((await download('json')).status).toBe(401);
        expect((await download('json', owner, '')).status).toBe(403);
        expect((await download('json', other)).status).toBe(404);

        const responses = await Promise.all([
            download('markdown', owner),
            download('json', owner),
            download('json', owner),
        ]);
        for (const response of responses) {
            expect(response.status).toBe(200);
            expect(response.headers.get('content-type')).toContain('application/json');
            expect(response.headers.get('cache-control')).toBe('no-store');
        }
        const [markdown, jsonResponse, retry] = await Promise.all(responses.map(json));
        const exported = parseContract(ReportJsonExportSchema, jsonResponse);
        expect(retry).toEqual(exported);
        expect(markdown!.id).not.toBe(exported.id);
        expect(exported.expiresAt).toBe(new Date(now.getTime() + 86_400_000).toISOString());
        const { document } = exported;
        expect(document).toMatchObject({
            reportId: saved.report.id,
            mode: 'demo',
            coverage: { completeness: 'partial', gaps: ['发布时间尚未核验'] },
            conclusions: [{ id: saved.claim.id, evidenceIds: [saved.evidence.id] }],
            changes: [{ id: change!.id, oldValue: null, newEvidenceIds: [saved.evidence.id] }],
            citations: [{ id: saved.evidence.id, quote: saved.quote, quoteTruncated: false }],
        });
        const content = serializeReportJson(document);
        expect(content).not.toContain('活动日期尚需确认。');
        expect(content).not.toContain('searchedQueries');
        expect(exported.byteLength).toBe(Buffer.byteLength(content));
        expect(exported.sha256).toBe(sha(content));
        const rows = () =>
            db
                .select()
                .from(tables.reportExports)
                .where(eq(tables.reportExports.userId, owner.userId));
        expect(await rows()).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    format: 'markdown',
                    rendererVersion: 1,
                    id: markdown!.id,
                }),
                expect.objectContaining({
                    format: 'json',
                    rendererVersion: 1,
                    id: exported.id,
                    content,
                }),
            ]),
        );
        expect(await rows()).toHaveLength(2);
        expect((await download('json', other)).status).toBe(404);

        // Expire just JSON; the Markdown retry cleans it up without refreshing Markdown's TTL.
        await db
            .update(tables.reportExports)
            .set({ createdAt: new Date(now.getTime() - 86_400_000), expiresAt: now })
            .where(eq(tables.reportExports.id, exported.id));
        expect(await json(await download('markdown', owner))).toEqual(markdown);
        expect((await rows()).map(({ id }) => id)).toEqual([markdown!.id]);
        const refreshed = await json(await download('json', owner));
        expect(refreshed.id).not.toBe(exported.id);
        expect(refreshed.sha256).toBe(exported.sha256);

        // An authorized projection change invalidates JSON even while its old row is live.
        await db
            .update(tables.reports)
            .set({ summary: '修订后的报告摘要' })
            .where(eq(tables.reports.id, saved.report.id));
        const revised = await json(await download('json', owner));
        expect(revised.id).not.toBe(refreshed.id);
        expect(revised.sha256).not.toBe(refreshed.sha256);
        expect(revised.document.summary).toBe('修订后的报告摘要');
        expect((await rows()).map(({ id }) => id)).not.toContain(refreshed.id);
    });

    it('两种格式共享账号配额，且不会淘汰未过期快照', async () => {
        const owner = await register();
        const another = await register();
        const saved = await fixture(owner);
        const anotherReport = await fixture(another);
        const content = '已有快照';
        await db.insert(tables.reportExports).values(
            Array.from({ length: 32 }, (_, index) => ({
                userId: owner.userId,
                reportId: saved.report.id,
                rendererVersion: index + 2,
                content,
                byteLength: Buffer.byteLength(content),
                sha256: sha(content),
                createdAt: now,
                expiresAt: new Date(now.getTime() + 86_400_000),
            })),
        );
        const response = await request('/reports/' + saved.report.id + '/exports/markdown', {
            method: 'POST',
            headers: headers(owner),
        });
        expect(response.status).toBe(409);
        expect((await json(response)).code).toBe('REPORT_EXPORT_QUOTA');
        const jsonResponse = await request(`/reports/${saved.report.id}/exports/json`, {
            method: 'POST',
            headers: headers(owner),
        });
        expect(jsonResponse.status).toBe(409);
        expect((await json(jsonResponse)).code).toBe('REPORT_EXPORT_QUOTA');
        expect(
            await db
                .select()
                .from(tables.reportExports)
                .where(eq(tables.reportExports.userId, owner.userId)),
        ).toHaveLength(32);
        expect(
            (
                await request('/reports/' + anotherReport.report.id + '/exports/markdown', {
                    method: 'POST',
                    headers: headers(another),
                })
            ).status,
        ).toBe(200);
    });

    beforeAll(async () => {
        await admin.connect();
        await admin.query(`CREATE SCHEMA "${schema}"`);
        schemaCreated = true;
        await migrateDatabase({ connectionString: scopedUrl.toString() });
        await connectDatabase(db);
        if (sqlitePath) coordination = openSqliteState(sqlitePath);
        else await redis.connect();
    }, 120000);
    beforeEach(() => {
        now = new Date('2026-10-26T00:00:00.000Z');
        bucket = null;
        app = createApiApp(
            'node',
            createDefaultServices({
                origin,
                production: false,
                registrationEnabled: true,
                sessionTtlSeconds: 3600,
                clock: () => now,
                db: () => db,
                redis: () => redis,
                ...(coordination ? { sqliteState: () => coordination! } : {}),
                objectStorage: () => bucket,
                rateLimit: {
                    windowSeconds: 60,
                    loginAttempts: 50,
                    registerAttempts: 50,
                    globalAttempts: 100,
                    keyPrefix: `scova:reports:${randomUUID()}:`,
                },
            }),
        );
    });
    afterAll(async () => {
        coordination?.close();
        await closeDatabase(db);
        if (redis.status === 'ready') await redis.quit();
        else redis.disconnect();
        if (schemaCreated) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.end();
    });

    it('返回真实片段和快照元数据，正文清理后仍可引用且不泄漏内部字段', async () => {
        const auth = await register();
        const data = await fixture(auth);
        const read = () => request(`/reports/${data.report.id}`, { headers: headers(auth) });
        const response = await read();
        expect(response.status).toBe(200);
        const body = await json(response);
        expect(body).toMatchObject({
            mode: 'demo',
            outcome: 'inconclusive',
            coverage: { completeness: 'partial' },
            evidence: [
                {
                    quote: data.quote,
                    url: `${data.url}?original=1`,
                    snapshot: {
                        originalUrl: `${data.url}?original=1`,
                        fetchedUrl: data.url,
                        canonicalUrl: data.url,
                        contentHash: data.snapshot.contentHash,
                        publishedAt: null,
                        truncated: false,
                        selector: { start: 0, end: data.quote.length },
                    },
                },
            ],
        });
        expect(body.claims[0].evidenceIds).toEqual([data.evidence.id]);
        const encoded = JSON.stringify(body);
        for (const forbidden of [
            'textBody',
            'metadataJson',
            'leaseOwner',
            'checkpointRef',
            'userId',
            'passwordHash',
        ])
            expect(encoded).not.toContain(forbidden);
        await db
            .update(tables.sourceSnapshots)
            .set({ textBody: null, textExpiresAt: now })
            .where(and(eq(tables.sourceSnapshots.id, data.snapshot.id)))
            .returning()
            .then(firstRow);
        expect(await json(await read())).toEqual(body);
    });

    it('报告历史稳定分页、按任务筛选并拒绝跨用户或篡改的游标', async () => {
        const auth = await register();
        const other = await register();
        const first = await fixture(auth);
        const second = await fixture(auth, first.task, 1);
        const separate = await fixture(auth, undefined, 2);
        const outsider = await fixture(other);
        const page = await json(
            await request(`/reports?taskId=${first.task.id}&limit=1`, { headers: headers(auth) }),
        );
        expect(page.items.map((entry: any) => entry.id)).toEqual([second.report.id]);
        expect(page.items[0]).not.toHaveProperty('evidence');
        const next = await json(
            await request(`/reports?taskId=${first.task.id}&limit=1&cursor=${page.nextCursor}`, {
                headers: headers(auth),
            }),
        );
        expect(next.items.map((entry: any) => entry.id)).toEqual([first.report.id]);
        expect(next.nextCursor).toBeNull();
        expect(
            (
                await request(`/reports?taskId=${separate.task.id}&cursor=${page.nextCursor}`, {
                    headers: headers(auth),
                })
            ).status,
        ).toBe(400);
        expect(
            (await request(`/reports?taskId=${first.task.id}`, { headers: headers(other) })).status,
        ).toBe(404);
        const forged = (id: string, time: string) =>
            Buffer.from(JSON.stringify({ id, time, scope: 'reports:all' })).toString('base64url');
        expect(
            (
                await request(
                    `/reports?cursor=${forged(outsider.report.id, outsider.report.publishedAt.toISOString())}`,
                    { headers: headers(auth) },
                )
            ).status,
        ).toBe(400);
        expect(
            (
                await request(
                    `/reports?cursor=${forged(first.report.id, '2020-01-01T00:00:00.000Z')}`,
                    {
                        headers: headers(auth),
                    },
                )
            ).status,
        ).toBe(400);
        expect((await request('/reports?limit=1.5', { headers: headers(auth) })).status).toBe(422);
    });

    it('引用显示本轮观测的截断与声明日期，不沿用首次快照元数据', async () => {
        const auth = await register();
        const data = await fixture(auth);
        await db
            .update(tables.runSources)
            .set({
                metadataJson: {
                    mode: 'demo',
                    truncated: true,
                    publication: {
                        parserVersion: 'scova-publication-v1',
                        status: 'known',
                        instant: '2000-01-01T00:00:00Z',
                        observations: [
                            {
                                field: 'article:published_time',
                                rawValue: '2026-10-25T09:00:00+09:00',
                                locator: 'meta[0]',
                            },
                        ],
                    },
                },
            })
            .where(
                and(
                    and(
                        eq(tables.runSources.runId, data.run.id),
                        eq(tables.runSources.sourceId, data.source.id),
                    ),
                ),
            )
            .returning()
            .then(firstRow);
        const response = await request(`/reports/${data.report.id}`, { headers: headers(auth) });
        expect(response.status).toBe(200);
        const body = await json(response);
        expect(body.evidence[0].snapshot).toMatchObject({
            truncated: true,
            publishedAt: '2026-10-25T00:00:00.000Z',
        });
        expect(
            (
                await db.query.sourceSnapshots
                    .findFirst({ where: and(eq(tables.sourceSnapshots.id, data.snapshot.id)) })
                    .then(requireRow)
            ).metadataJson,
        ).toMatchObject({ truncated: false });
    });

    it('HTTP保留来源日期精度与独立更新时间，不信任存储的断言时刻', async () => {
        const auth = await register();
        const data = await fixture(auth);
        await db
            .update(tables.runSources)
            .set({
                metadataJson: {
                    mode: 'demo',
                    truncated: false,
                    publication: {
                        parserVersion: 'scova-publication-v2',
                        status: 'known',
                        instant: '2000-01-01T00:00:00Z',
                        observations: [
                            {
                                field: 'meta:published',
                                rawValue: '2026年11月08日',
                                locator: 'head meta[0]',
                            },
                            {
                                field: 'dateModified',
                                rawValue: '2026-11-09T10:30+0800',
                                locator: 'jsonld[0]$.dateModified',
                            },
                        ],
                    },
                },
            })
            .where(
                and(
                    eq(tables.runSources.runId, data.run.id),
                    eq(tables.runSources.sourceId, data.source.id),
                ),
            );
        const response = await request(`/reports/${data.report.id}`, { headers: headers(auth) });
        expect(response.status).toBe(200);
        expect((await json(response)).evidence[0].snapshot).toMatchObject({
            publishedAt: null,
            dateSource: 'meta:published',
            sourceDates: {
                published: {
                    status: 'known',
                    value: '2026-11-08',
                    instant: null,
                    precision: 'day',
                },
                modified: {
                    status: 'known',
                    value: '2026-11-09T02:30:00.000Z',
                    instant: '2026-11-09T02:30:00.000Z',
                    precision: 'instant',
                },
            },
        });
    });

    it('采集报告按已验证更新时间显示日期来源，仍不伪装为发布时间', async () => {
        const auth = await register();
        const data = await fixture(auth);
        const dateScreening = {
            window: { start: '2026-10-01T00:00:00Z', end: '2026-11-01T00:00:00Z' },
            accepted: 1,
            outside: 0,
            unconfirmed: 0,
            entries: [
                {
                    pageId: 'read-0',
                    url: data.url,
                    title: '来源页面',
                    publishedAt: '2026-10-25T00:00:00.000Z',
                    dateSource: 'dateModified',
                    status: 'accepted',
                },
            ],
        };
        await db
            .update(tables.runs)
            .set({
                coverageJson: {
                    completeness: 'partial',
                    searchedQueries: [],
                    gaps: ['未完成'],
                    exhausted: [],
                    dateScreening,
                },
            })
            .where(eq(tables.runs.id, data.run.id));
        await db
            .update(tables.runSources)
            .set({
                metadataJson: {
                    mode: 'demo',
                    truncated: false,
                    publication: {
                        parserVersion: 'scova-publication-v2',
                        status: 'unknown',
                        instant: null,
                        observations: [
                            {
                                field: 'dateModified',
                                rawValue: '2026-10-25T00:00:00Z',
                                locator: 'jsonld[0]$.dateModified',
                            },
                        ],
                    },
                },
            })
            .where(
                and(
                    eq(tables.runSources.runId, data.run.id),
                    eq(tables.runSources.sourceId, data.source.id),
                ),
            );
        const response = await request(`/reports/${data.report.id}`, { headers: headers(auth) });
        expect(response.status).toBe(200);
        expect((await json(response)).evidence[0].snapshot).toMatchObject({
            publishedAt: null,
            dateSource: 'dateModified',
            sourceDates: { modified: { status: 'known', value: '2026-10-25T00:00:00.000Z' } },
        });
    });

    it.each(['partial', 'mode', 'scope'])('拒绝不合法 %s 基线的旧侧引用', async (reason) => {
        const auth = await register();
        const current = await fixture(auth);
        const previous = await fixture(auth, current.task, 1);
        await db
            .update(tables.runs)
            .set({
                status: reason === 'partial' ? 'partial' : 'succeeded',
                mode: reason === 'mode' ? 'live' : 'demo',
                comparisonScopeHash:
                    reason === 'scope' ? sha('different-scope') : current.run.comparisonScopeHash,
                coverageJson: {
                    completeness: reason === 'partial' ? 'partial' : 'complete',
                    searchedQueries: ['query'],
                    gaps: [],
                    exhausted: [],
                },
            })
            .where(and(eq(tables.runs.id, previous.run.id)))
            .returning()
            .then(firstRow);
        if (reason === 'scope') {
            // Effective scope is enforced by a composite database foreign key before API mapping.
            await expect(
                db
                    .update(tables.runs)
                    .set({ baselineRunId: previous.run.id })
                    .where(and(eq(tables.runs.id, current.run.id)))
                    .returning()
                    .then(firstRow),
            ).rejects.toMatchObject({ cause: { code: '23503' } });
            return;
        }
        await db
            .update(tables.runs)
            .set({ baselineRunId: previous.run.id })
            .where(and(eq(tables.runs.id, current.run.id)))
            .returning()
            .then(firstRow);
        await db
            .update(tables.reports)
            .set({ baselineRunId: previous.run.id })
            .where(and(eq(tables.reports.id, current.report.id)))
            .returning()
            .then(firstRow);
        const change = await db
            .insert(tables.changeRecords)
            .values({
                userId: auth.userId,
                reportId: current.report.id,
                sourceId: current.source.id,
                kind: 'changed',
                oldSourceId: previous.source.id,
                oldSnapshotId: previous.snapshot.id,
                newSnapshotId: current.snapshot.id,
                factKey: 'test',
                oldValue: 'old',
                newValue: 'new',
                importance: 'important',
                reason: '测试非法基线引用',
            })
            .returning()
            .then(firstRow);
        await db
            .insert(tables.changeEvidence)
            .values({
                userId: auth.userId,
                changeRecordId: change.id,
                evidenceId: previous.evidence.id,
                side: 'old',
            })
            .returning()
            .then(firstRow);
        await db
            .insert(tables.changeEvidence)
            .values({
                userId: auth.userId,
                changeRecordId: change.id,
                evidenceId: current.evidence.id,
                side: 'new',
            })
            .returning()
            .then(firstRow);
        const response = await request(`/reports/${current.report.id}`, { headers: headers(auth) });
        expect(response.status).toBe(409);
        expect((await json(response)).code).toBe('INVALID_REPORT_EVIDENCE');
    });

    it.each(['valid', 'old_source', 'old_snapshot', 'new_source', 'new_snapshot', 'reversed'])(
        '逐项校验变化的双方来源与快照：%s',
        async (variant) => {
            const auth = await register();
            const previous = await fixture(auth);
            const current = await fixture(auth, previous.task, 1);
            await db
                .update(tables.runs)
                .set({
                    status: 'succeeded',
                    outcome: 'baseline',
                    coverageJson: {
                        completeness: 'complete',
                        searchedQueries: ['query'],
                        gaps: [],
                        exhausted: [],
                    },
                })
                .where(and(eq(tables.runs.id, previous.run.id)))
                .returning()
                .then(firstRow);
            await db
                .update(tables.reports)
                .set({ completeness: 'complete', limitationsJson: [] })
                .where(and(eq(tables.reports.id, previous.report.id)))
                .returning()
                .then(firstRow);
            await db
                .update(tables.runs)
                .set({ baselineRunId: previous.run.id })
                .where(and(eq(tables.runs.id, current.run.id)))
                .returning()
                .then(firstRow);
            await db
                .update(tables.reports)
                .set({ baselineRunId: previous.run.id })
                .where(and(eq(tables.reports.id, current.report.id)))
                .returning()
                .then(firstRow);
            async function alternateSnapshot(sourceId: string) {
                return db
                    .insert(tables.sourceSnapshots)
                    .values({
                        userId: auth.userId,
                        sourceId: sourceId,
                        title: '另一次正文版本',
                        contentHash: sha(randomUUID()),
                        extractorVersion: 'reader-v1',
                        metadataJson: {},
                    })
                    .returning()
                    .then(firstRow);
            }
            const oldSnapshot =
                variant === 'old_snapshot'
                    ? await alternateSnapshot(previous.source.id)
                    : previous.snapshot;
            const newSnapshot =
                variant === 'new_snapshot'
                    ? await alternateSnapshot(current.source.id)
                    : current.snapshot;
            const change = await db
                .insert(tables.changeRecords)
                .values({
                    userId: auth.userId,
                    reportId: current.report.id,
                    sourceId: variant === 'new_source' ? previous.source.id : current.source.id,
                    kind: 'changed',
                    oldSourceId: variant === 'old_source' ? current.source.id : previous.source.id,
                    oldSnapshotId: variant === 'old_source' ? current.snapshot.id : oldSnapshot.id,
                    newSnapshotId: variant === 'new_source' ? previous.snapshot.id : newSnapshot.id,
                    factKey: 'deadline',
                    oldValue: previous.quote,
                    newValue: current.quote,
                    importance: 'important',
                    reason: '基线与本次事实对比',
                })
                .returning()
                .then(firstRow);
            await db
                .insert(tables.changeEvidence)
                .values([
                    {
                        userId: auth.userId,
                        changeRecordId: change.id,
                        evidenceId: previous.evidence.id,
                        side: variant === 'reversed' ? 'new' : 'old',
                    },
                    {
                        userId: auth.userId,
                        changeRecordId: change.id,
                        evidenceId: current.evidence.id,
                        side: variant === 'reversed' ? 'old' : 'new',
                    },
                ])
                .returning({ id: tables.changeEvidence.id })
                .then((rows) => ({ count: rows.length }));
            const response = await request(`/reports/${current.report.id}`, {
                headers: headers(auth),
            });
            expect(response.status).toBe(variant === 'valid' ? 200 : 409);
            const body = await json(response);
            if (variant === 'valid') {
                expect(body.baselineRunId).toBe(previous.run.id);
                expect(body.baseline).toEqual({
                    runId: previous.run.id,
                    reportId: previous.report.id,
                    publishedAt: previous.report.publishedAt.toISOString(),
                });
                const other = await register();
                expect(
                    (await request(`/reports/${current.report.id}`, { headers: headers(other) }))
                        .status,
                ).toBe(404);
                expect(body.changes[0]).toMatchObject({
                    oldEvidenceIds: [previous.evidence.id],
                    newEvidenceIds: [current.evidence.id],
                });
            } else {
                expect(body.code).toBe('INVALID_REPORT_EVIDENCE');
                expect(body).not.toHaveProperty('evidence');
            }
        },
    );

    it('同账号其他 Run 的证据不能被报告引用，拒绝整个详情', async () => {
        const auth = await register();
        const first = await fixture(auth);
        const second = await fixture(auth, first.task, 1);
        await db
            .update(tables.claimEvidence)
            .set({ evidenceId: second.evidence.id })
            .where(and(eq(tables.claimEvidence.id, first.citation.id)))
            .returning()
            .then(firstRow);
        const response = await request(`/reports/${first.report.id}`, { headers: headers(auth) });
        expect(response.status).toBe(409);
        const body = await json(response);
        expect(body.code).toBe('INVALID_REPORT_EVIDENCE');
        expect(body).not.toHaveProperty('claims');
        expect(body).not.toHaveProperty('evidence');
    });

    it('损坏的原文指纹与定位不得作为有效引用返回', async () => {
        const auth = await register();
        const data = await fixture(auth);
        await db
            .update(tables.evidence)
            .set({ quoteHash: '0'.repeat(64) })
            .where(and(eq(tables.evidence.id, data.evidence.id)))
            .returning()
            .then(firstRow);
        expect(
            (await request(`/reports/${data.report.id}`, { headers: headers(auth) })).status,
        ).toBe(409);
        await db
            .update(tables.evidence)
            .set({
                quoteHash: sha(data.quote),
                selectorJson: {
                    type: 'text_offset',
                    start: 0,
                    end: 100,
                    extractorVersion: 'reader-v1',
                },
            })
            .where(and(eq(tables.evidence.id, data.evidence.id)))
            .returning()
            .then(firstRow);
        expect(
            (await request(`/reports/${data.report.id}`, { headers: headers(auth) })).status,
        ).toBe(409);
    });

    it('收件箱已读状态持久化、幂等并校验 CSRF 与 owner', async () => {
        const auth = await register();
        const other = await register();
        const data = await fixture(auth);
        const patch = (read: boolean, actor = auth) =>
            request(`/inbox/${data.inbox.id}`, {
                method: 'PATCH',
                headers: headers(actor),
                body: JSON.stringify({ read }),
            });
        expect(
            (await request(`/reports/${data.report.id}`, { headers: headers(other) })).status,
        ).toBe(404);
        expect((await request(`/reports/${randomUUID()}`, { headers: headers(auth) })).status).toBe(
            404,
        );
        expect((await request('/reports')).status).toBe(401);
        expect((await patch(true, other)).status).toBe(404);
        expect(
            (
                await request(`/inbox/${data.inbox.id}`, {
                    method: 'PATCH',
                    headers: { origin, cookie: auth.cookie, 'content-type': 'application/json' },
                    body: JSON.stringify({ read: true }),
                })
            ).status,
        ).toBe(403);
        const unread = await json(await request('/inbox?unread=true', { headers: headers(auth) }));
        expect(unread.items).toHaveLength(1);
        expect(unread.items[0]).toMatchObject({
            id: data.inbox.id,
            readAt: null,
            report: { id: data.report.id, mode: 'demo' },
        });
        const first = await json(await patch(true));
        now = new Date(now.getTime() + 1000);
        expect((await json(await patch(true))).readAt).toBe(first.readAt);
        expect(
            (
                await db.query.inboxItems
                    .findFirst({ where: and(eq(tables.inboxItems.id, data.inbox.id)) })
                    .then(requireRow)
            ).readAt?.toISOString(),
        ).toBe(first.readAt);
        expect(
            (await json(await request('/inbox?unread=true', { headers: headers(auth) }))).items,
        ).toEqual([]);
        expect(
            (await json(await request('/inbox?unread=false', { headers: headers(auth) }))).items,
        ).toHaveLength(1);
        expect((await json(await patch(false))).readAt).toBeNull();
    });

    it('收件箱分页的范围绑定不受上一条标记已读影响', async () => {
        const auth = await register();
        const first = await fixture(auth);
        const second = await fixture(auth, first.task, 1);
        const page = await json(
            await request('/inbox?unread=true&limit=1', { headers: headers(auth) }),
        );
        expect(page.items.map((entry: any) => entry.id)).toEqual([second.inbox.id]);
        await request(`/inbox/${second.inbox.id}`, {
            method: 'PATCH',
            headers: headers(auth),
            body: JSON.stringify({ read: true }),
        });
        const next = await json(
            await request(`/inbox?unread=true&limit=1&cursor=${page.nextCursor}`, {
                headers: headers(auth),
            }),
        );
        expect(next.items.map((entry: any) => entry.id)).toEqual([first.inbox.id]);
        expect(next.nextCursor).toBeNull();
        expect(
            (
                await request(`/inbox?unread=false&cursor=${page.nextCursor}`, {
                    headers: headers(auth),
                })
            ).status,
        ).toBe(400);
    });
});
