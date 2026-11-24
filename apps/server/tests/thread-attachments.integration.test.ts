import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { CallContext, ModelProvider, StructuredInput } from '@scova/connectors';
import { eq, projectThreadAttachments, projectThreads, projects, sessions, users } from '@scova/db';
import { openSqliteState } from '@scova/db/sqlite-state';
import type { ProjectThreadAttachment, ProjectThreadSnapshot } from '@scova/models';
import type { ObjectStorage } from '@scova/object-storage';
import { serve } from 'srvx/node';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { createApiApp } from '@/app/index.ts';
import { createDefaultServices } from '@/app/services.ts';
import {
    cleanThreadAttachments,
    resolveThreadAttachmentContext,
} from '@/service/thread-attachments.ts';
import { csrfForSession, tokenHash } from '@/utils/security.ts';
import { outboxDatabase } from '../../worker/tests/support/outbox-database.ts';
import { reportPdfFixture } from './fixtures/report-pdf.ts';

const fixture = outboxDatabase();
const { db } = fixture;
const origin = 'https://scova.test';
const objects = new Map<string, Buffer>();
let puts = 0;
let failPut = false;
let failDelete = false;
let bucketEnabled = true;
let time = Date.now();
let baseObjectUrl: string;
let listener: ReturnType<typeof serve> | undefined;
const keyPrefix = 'private-fixture/';
const objectServer = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const body = url.searchParams.has('test-signature')
        ? objects.get(url.pathname.slice(1))
        : undefined;
    if (body) response.writeHead(200, { 'content-length': body.byteLength }).end(body);
    else response.writeHead(404).end();
});
const unused = (): never => {
    throw new Error('Unexpected storage operation');
};
const storage: ObjectStorage = {
    scope: unused,
    head: unused,
    getPublicUrl: unused,
    destroy() {},
    async presignUpload({ key, contentType, size }) {
        return {
            key: `${keyPrefix}${key}`,
            url: '',
            publicUrl: null,
            method: 'PUT',
            headers: { 'Content-Type': contentType },
            size,
            expiresIn: 60,
        };
    },
    async upload({ key, body, contentType }) {
        puts++;
        const storedKey = `${keyPrefix}${key}`;
        // Simulate a successful write with an uncertain response.
        objects.set(storedKey, Buffer.from(body));
        if (failPut) throw new Error('Storage acknowledgement unavailable');
        return { key: storedKey, url: null, contentType, size: body.byteLength };
    },
    async presignDownload(key) {
        return `${baseObjectUrl}/${key}?test-signature=1`;
    },
    async delete(key) {
        if (failDelete) throw new Error('Storage delete failed');
        objects.delete(key);
    },
};
const models = new Map<string, ModelProvider>();
let budgetState: ReturnType<typeof openSqliteState>;
const services = createDefaultServices({
    db: () => db,
    sqliteState: () => budgetState,
    origin,
    reportQuestionModel: (userId) => (userId ? (models.get(userId) ?? null) : null),
    objectStorage: () => (bucketEnabled ? storage : null),
    clock: () => new Date(time),
});

beforeAll(async () => {
    await fixture.setup();
    budgetState = openSqliteState(':memory:');
    await new Promise<void>((resolve) => objectServer.listen(0, '127.0.0.1', resolve));
    const address = objectServer.address();
    if (!address || typeof address === 'string') throw new Error('Object server did not bind');
    baseObjectUrl = `http://127.0.0.1:${address.port}`;
    const app = createApiApp('node', services).compile();
    listener = serve({
        hostname: '127.0.0.1',
        port: 0,
        silent: true,
        gracefulShutdown: false,
        fetch: app.fetch,
    });
    await listener.ready();
}, 60_000);

afterAll(async () => {
    try {
        await listener?.close();

        if (objectServer.listening)
            await new Promise<void>((resolve) => objectServer.close(() => resolve()));
        await services.close();
        budgetState?.close();
    } finally {
        await fixture.cleanup();
    }
});

async function seedThread() {
    const id = randomUUID();
    const email = `${id}@example.test`;
    const token = randomBytes(32).toString('base64url');
    const csrf = csrfForSession(token);
    await db.insert(users).values({ id, email, normalizedEmail: email, passwordHash: 'fixture' });
    await db.insert(sessions).values({
        userId: id,
        tokenHash: tokenHash(token),
        csrfTokenHash: tokenHash(csrf),
        expiresAt: new Date(time + 86_400_000),
    });
    const [project] = await db
        .insert(projects)
        .values({ userId: id, name: 'Attachments' })
        .returning();
    const [thread, sibling] = await db
        .insert(projectThreads)
        .values([
            { userId: id, projectId: project!.id, title: 'Primary' },
            { userId: id, projectId: project!.id, title: 'Sibling' },
        ])
        .returning();
    return {
        id,
        cookie: `scova_session=${token}`,
        csrf,
        projectId: project!.id,
        threadId: thread!.id,
        siblingId: sibling!.id,
    };
}
type Account = Awaited<ReturnType<typeof seedThread>>;

function path(threadId: string, id?: string) {
    return `/api/v1/threads/${threadId}/attachments${id ? `/${id}` : ''}`;
}
function upload(
    account: Account,
    content: string,
    options: { filename?: string; mime?: string; csrf?: boolean; threadId?: string } = {},
) {
    const {
        filename = '议题.txt',
        mime = 'text/plain',
        csrf = true,
        threadId = account.threadId,
    } = options;
    const query = new URLSearchParams({ filename });
    return fetch(new URL(`${path(threadId)}?${query}`, listener!.url), {
        method: 'POST',
        body: content,
        headers: {
            origin,
            cookie: account.cookie,
            'content-type': mime,
            ...(csrf ? { 'x-csrf-token': account.csrf } : {}),
        },
    });
}
function get(pathname: string, account?: Account) {
    return fetch(new URL(pathname, listener!.url), {
        headers: account ? { cookie: account.cookie } : {},
    });
}
async function json(response: Response) {
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    return body as ProjectThreadAttachment;
}

const content = '示例🙂'.repeat(510);

describe('thread attachment HTTP and cleanup', () => {
    it('uploads and downloads private bytes with deduplication and bounded text', async () => {
        const account = await seedThread();
        const before = puts;
        const uploads = await Promise.all([upload(account, content), upload(account, content)]);
        const [first, second] = await Promise.all(uploads.map(json));
        expect(first).toEqual(second);
        expect(puts - before).toBe(1);
        expect(Object.keys(first!).sort()).toEqual([
            'byteLength',
            'createdAt',
            'filename',
            'format',
            'id',
            'textAvailable',
            'threadId',
        ]);
        expect(first).toMatchObject({
            threadId: account.threadId,
            filename: '议题.txt',
            textAvailable: true,
        });
        const attachmentPath = path(account.threadId, first!.id);
        expect(await json(await get(attachmentPath, account))).toEqual(first);
        const download = await get(`${attachmentPath}/download`, account);
        expect(download.status).toBe(200);
        expect(download.headers.get('content-disposition')).toContain(
            "filename*=UTF-8''%E8%AE%AE%E9%A2%98.txt",
        );
        expect(download.headers.get('cache-control')).toBe('private, no-store');
        expect(download.headers.get('location')).toBeNull();
        expect(await download.text()).toBe(content);
        const context = await resolveThreadAttachmentContext(db, account.id, account.threadId, [
            first!.id,
        ]);
        expect(context).toEqual([
            { id: first!.id, filename: '议题.txt', excerpt: '示例🙂'.repeat(400) },
        ]);
    });

    it('resolves CSV text and keeps valid PDF attachments download-only', async () => {
        const owner = await seedThread();
        const csv = await json(
            await upload(owner, 'count,source\n1,test', {
                filename: 'sources.csv',
                mime: 'text/csv',
            }),
        );
        const pdfBytes = reportPdfFixture();
        const pdf = await json(
            await upload(owner, pdfBytes, { filename: '资料.pdf', mime: 'application/pdf' }),
        );
        expect([csv.textAvailable, pdf.textAvailable]).toEqual([true, false]);
        expect(
            await resolveThreadAttachmentContext(db, owner.id, owner.threadId, [csv.id, pdf.id]),
        ).toEqual([
            { id: csv.id, filename: 'sources.csv', excerpt: 'count,source\n1,test' },
            { id: pdf.id, filename: '资料.pdf', excerpt: null },
        ]);
        expect(await (await get(`${path(owner.threadId, pdf.id)}/download`, owner)).text()).toBe(
            pdfBytes,
        );
    });

    it('uses only authorized excerpts in a turn and keeps its attachment reference in snapshots', async () => {
        const owner = await seedThread();
        const attachmentText = 'Project file has three data rows.';
        const attachment = await json(await upload(owner, attachmentText));
        const ref = { kind: 'attachment', id: attachment.id };
        const attempts: StructuredInput[] = [];
        models.set(owner.id, {
            async generateStructured<T>(input: StructuredInput, context: CallContext = {}) {
                await context.beforeAttempt?.('model');
                attempts.push(input);
                return {
                    mode: 'live',
                    data: { answer: 'Checked attachment' } as T,
                    usage: { inputTokens: 1, outputTokens: 1, estimated: false },
                };
            },
        });
        const send = (threadId: string) =>
            fetch(new URL(`/api/v1/threads/${threadId}/turns`, listener!.url), {
                method: 'POST',
                headers: {
                    origin,
                    cookie: owner.cookie,
                    'content-type': 'application/json',
                    'x-csrf-token': owner.csrf,
                },
                body: JSON.stringify({
                    turnId: randomUUID(),
                    message: '请总结附件。',
                    refs: [ref],
                }),
            });
        try {
            expect((await send(owner.siblingId)).status).toBe(404);
            expect(attempts).toHaveLength(0);
            const sent = await send(owner.threadId);
            const receipt = await sent.json();
            expect(sent.status, JSON.stringify(receipt)).toBe(200);
            expect(receipt).toMatchObject({ status: 'completed' });
            expect(attempts).toHaveLength(1);
            expect(attempts[0]!.untrustedSources).toEqual([
                expect.objectContaining({
                    attachments: [{ filename: attachment.filename, excerpt: attachmentText }],
                }),
            ]);
            const snapshot = await get(`/api/v1/threads/${owner.threadId}`, owner);
            expect(snapshot.status).toBe(200);
            const timeline = (await snapshot.json()) as ProjectThreadSnapshot;
            expect(timeline.items.find(({ payload }) => payload.role === 'user')?.refs).toEqual([
                ref,
            ]);
            expect(JSON.stringify(timeline)).not.toContain(attachmentText);
            expect(
                await (await get(`${path(owner.threadId, attachment.id)}/download`, owner)).text(),
            ).toBe(attachmentText);
        } finally {
            models.delete(owner.id);
        }
    });

    it('rejects unowned references and validates session, CSRF, size, MIME and archive', async () => {
        const owner = await seedThread();
        const other = await seedThread();
        const attachment = await json(await upload(owner, 'valid'));
        expect((await get(path(owner.threadId, attachment.id))).status).toBe(401);
        expect((await get(`${path(owner.threadId, attachment.id)}/download`, other)).status).toBe(
            404,
        );
        expect((await get(path(owner.siblingId, attachment.id), owner)).status).toBe(404);
        await expect(
            resolveThreadAttachmentContext(db, owner.id, owner.siblingId, [attachment.id]),
        ).rejects.toMatchObject({ status: 404 });
        expect((await upload(other, 'private', { threadId: owner.threadId })).status).toBe(404);
        expect((await upload(owner, 'no csrf', { csrf: false })).status).toBe(403);
        expect((await upload(owner, 'a'.repeat(256 * 1024 + 1))).status).toBe(413);
        expect((await upload(owner, 'no MIME', { mime: 'application/octet-stream' })).status).toBe(
            415,
        );
        expect(
            (await upload(owner, '%PDF-fake', { filename: 'fake.pdf', mime: 'application/pdf' }))
                .status,
        ).toBe(422);
        await db
            .update(projectThreads)
            .set({ archivedAt: new Date(time) })
            .where(eq(projectThreads.id, owner.threadId));
        expect((await upload(owner, 'archived')).status).toBe(409);
        expect((await get(path(owner.threadId, attachment.id), owner)).status).toBe(200);
    });

    it('fails closed without storage and safely retries an uncertain upload', async () => {
        const owner = await seedThread();
        bucketEnabled = false;
        try {
            expect((await upload(owner, 'content')).status).toBe(503);
        } finally {
            bucketEnabled = true;
        }
        failPut = true;
        try {
            expect((await upload(owner, 'content')).status).toBe(503);
        } finally {
            failPut = false;
        }
        const [pending] = await db
            .select()
            .from(projectThreadAttachments)
            .where(eq(projectThreadAttachments.threadId, owner.threadId));
        expect(pending?.readyAt).toBeNull();
        expect((await get(path(owner.threadId, pending!.id), owner)).status).toBe(404);
        expect((await json(await upload(owner, 'content'))).id).toBe(pending!.id);
    });

    it('reaps an abandoned upload whose bucket write may have succeeded', async () => {
        const owner = await seedThread();
        failPut = true;
        try {
            expect((await upload(owner, 'abandoned')).status).toBe(503);
        } finally {
            failPut = false;
        }
        const [pending] = await db
            .select()
            .from(projectThreadAttachments)
            .where(eq(projectThreadAttachments.threadId, owner.threadId));
        expect(objects.has(pending!.storageKey)).toBe(true);
        await cleanThreadAttachments(services);
        expect(objects.has(pending!.storageKey)).toBe(true);
        time += 16 * 60_000;
        await cleanThreadAttachments(services);
        expect(objects.has(pending!.storageKey)).toBe(false);
        expect((await json(await upload(owner, 'abandoned'))).id).not.toBe(pending!.id);
    });

    it('retries cleanup after a project deletion and keeps other thread attachments readable', async () => {
        const owner = await seedThread();
        const item = await json(await upload(owner, 'cleanup me'));
        const other = await seedThread();
        const keep = await json(await upload(other, 'keep me'));
        const [row] = await db
            .select()
            .from(projectThreadAttachments)
            .where(eq(projectThreadAttachments.id, item.id));
        const key = row!.storageKey;
        expect(objects.has(key)).toBe(true);
        await db.delete(projects).where(eq(projects.id, owner.projectId));
        expect((await get(`${path(owner.threadId, item.id)}/download`, owner)).status).toBe(404);
        time += 16 * 60_000;
        failDelete = true;
        try {
            await cleanThreadAttachments(services);
            expect(objects.has(key)).toBe(true);
        } finally {
            failDelete = false;
        }
        time += 16 * 60_000;
        await cleanThreadAttachments(services);
        expect(objects.has(key)).toBe(false);
        expect(await json(await get(path(other.threadId, keep.id), other))).toEqual(keep);
        expect(
            await db
                .select()
                .from(projectThreadAttachments)
                .where(eq(projectThreadAttachments.id, item.id)),
        ).toEqual([]);
    });
});
