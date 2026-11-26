import { randomBytes, randomUUID } from 'node:crypto';
import type { CallContext, ModelProvider, StructuredInput } from '@scova/connectors';
import {
    and,
    eq,
    projectConversationTurns,
    projectThreadItems,
    projectThreadRunOrigins,
    runs,
    idempotencyRecords,
    reports,
    sessions,
    users,
} from '@scova/db';
import type { ProjectConversation, ProjectThread, ProjectThreadSnapshot } from '@scova/models';
import { serve } from 'srvx/node';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { createApiApp } from '@/app/index.ts';
import { createDefaultServices } from '@/app/services.ts';
import { appendProjectThreadItems } from '@/repo/project-threads.ts';
import { expireProjectTurns } from '@/service/project-turns.ts';
import { createRedisConnection } from '@/repo/redis.ts';
import { csrfForSession, tokenHash } from '@/utils/security.ts';
import { outboxDatabase } from '../../worker/tests/support/outbox-database.ts';
import { seedRun } from '../../worker/tests/support/run-database.ts';
import { libraryFixture } from './support/library.ts';
import { draftConfig } from './support/task-drafts.ts';

const fixture = outboxDatabase();
const { db } = fixture;
const redis = createRedisConnection(fixture.redisUrl);
const budgetPrefix = `scova:project-threads-test:${randomUUID()}:`;
const origin = 'https://scova.test';
const projectsPath = '/api/v1/projects';
const threadPath = (threadId: string) => `/api/v1/threads/${threadId}`;
const projectThreadsPath = (projectId: string) => `${projectsPath}/${projectId}/threads`;
const draftModels = new Map<string, ModelProvider>();
const answerLookups = new Map<string, () => ModelProvider | null | Promise<null>>();
const services = createDefaultServices({
    db: () => db,
    redis: () => redis,
    close: async () => redis.disconnect(),
    reportQuestionPolicy: { keyPrefix: budgetPrefix + 'answers:' },
    taskDraftPolicy: { keyPrefix: budgetPrefix + 'drafts:' },
    origin,
    reportQuestionModel: (userId) => (userId ? (answerLookups.get(userId)?.() ?? null) : null),
    projectAutoRunsPerDay: 1,
    taskDraftModel: (userId) => (userId ? (draftModels.get(userId) ?? null) : null),
    sse: { pollIntervalMs: 20, heartbeatMs: 100 },
});
let listener: ReturnType<typeof serve> | undefined;
let baseUrl: string;

beforeAll(async () => {
    await fixture.setup();
    const app = createApiApp('node', services).compile();
    listener = serve({
        hostname: '127.0.0.1',
        port: 0,
        silent: true,
        gracefulShutdown: false,
        fetch: app.fetch,
    });
    await listener.ready();
    if (!listener.url) throw new Error('Thread API did not bind a loopback socket');
    baseUrl = listener.url;
}, 120_000);

afterAll(async () => {
    try {
        await services.close();
    } finally {
        try {
            await listener?.close();
        } finally {
            await fixture.cleanup();
        }
    }
});

async function seedAccount() {
    const id = randomUUID();
    const email = `${id}@example.test`;
    await db.insert(users).values({ id, email, normalizedEmail: email, passwordHash: 'fixture' });
    return seedSession(id);
}

async function seedSession(id: string) {
    const token = randomBytes(32).toString('base64url');
    const csrf = csrfForSession(token);
    await db.insert(sessions).values({
        userId: id,
        tokenHash: tokenHash(token),
        csrfTokenHash: tokenHash(csrf),
        expiresAt: new Date(Date.now() + 600_000),
    });
    return { id, cookie: `scova_session=${token}`, csrf };
}
type Account = Awaited<ReturnType<typeof seedAccount>>;

type RequestOptions = {
    method?: 'GET' | 'POST' | 'PATCH' | 'PUT';
    body?: unknown;
    csrf?: boolean;
    lastEventId?: string;
};

function request(path: string, account?: Account, options: RequestOptions = {}) {
    const { method = 'GET', body, csrf = true, lastEventId } = options;
    const headers = new Headers({ origin });
    if (body !== undefined) headers.set('content-type', 'application/json');
    if (lastEventId !== undefined) headers.set('last-event-id', lastEventId);
    if (account) {
        headers.set('cookie', account.cookie);
        if (csrf && method !== 'GET') headers.set('x-csrf-token', account.csrf);
    }
    return fetch(new URL(path, baseUrl), {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
        headers,
        signal: AbortSignal.timeout(10_000),
    });
}

async function json<T>(response: Response, status = 200): Promise<T> {
    const body: unknown = await response.json();
    expect(response.status, `${response.url}: ${JSON.stringify(body)}`).toBe(status);
    return body as T;
}

async function expectError(response: Response, status: number, code?: string) {
    if (response.headers.get('content-type')?.includes('text/event-stream')) {
        await response.body?.cancel();
        expect(response.status).toBe(status);
        return;
    }
    const body = await json<{ code: string }>(response, status);
    if (code) expect(body.code).toBe(code);
}

async function createProject(owner: Account, name = 'Project threads') {
    return json<{ id: string }>(
        await request(projectsPath, owner, { method: 'POST', body: { name } }),
        201,
    );
}

async function createThread(owner: Account, projectId: string, title?: string) {
    return json<ProjectThread>(
        await request(projectThreadsPath(projectId), owner, {
            method: 'POST',
            body: title === undefined ? {} : { title },
        }),
        201,
    );
}

async function listThreads(owner: Account, projectId: string) {
    const { items } = await json<{ items: ProjectThread[] }>(
        await request(projectThreadsPath(projectId), owner),
    );
    return items;
}

async function snapshot(owner: Account, threadId: string, query = '') {
    return json<ProjectThreadSnapshot>(await request(`${threadPath(threadId)}${query}`, owner));
}

async function insertItems(owner: Account, threadId: string, seqs: number[]) {
    return db
        .insert(projectThreadItems)
        .values(
            seqs.map((seq) => ({
                userId: owner.id,
                threadId,
                seq,
                kind: 'message' as const,
                payload: { role: 'assistant', text: `Message ${seq}` },
                refs: [],
            })),
        )
        .returning();
}

function readEvents(response: Response) {
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    return {
        async next() {
            while (true) {
                const end = buffered.indexOf('\n\n');
                if (end !== -1) {
                    const fields = buffered.slice(0, end).split('\n');
                    buffered = buffered.slice(end + 2);
                    const field = (name: string) =>
                        fields
                            .find((line) => line.startsWith(`${name}:`))
                            ?.slice(name.length + 1)
                            .trimStart();
                    const data = field('data');
                    if (data === undefined || field('event') === 'heartbeat') continue;
                    return {
                        id: field('id'),
                        event: field('event'),
                        data: JSON.parse(data) as unknown,
                    };
                }
                const chunk = await reader.read();
                if (chunk.done) throw new Error('SSE ended before the expected item');
                buffered += decoder.decode(chunk.value, { stream: true });
            }
        },
        close: () => reader.cancel(),
    };
}

function frameFor(item: ProjectThreadSnapshot['items'][number]) {
    return { id: String(item.seq), event: 'item', data: item };
}

describe('project thread API', () => {
    it('creates threads with explicit and omitted titles and lists only the requested project', async () => {
        const owner = await seedAccount();
        const project = await createProject(owner);
        const siblingProject = await createProject(owner, 'Sibling project');
        expect(await listThreads(owner, project.id)).toEqual([]);

        const named = await createThread(owner, project.id, 'Research notes');
        const untitled = await createThread(owner, project.id);
        await createThread(owner, siblingProject.id, 'Other project notes');
        expect(named).toMatchObject({
            projectId: project.id,
            title: 'Research notes',
            archivedAt: null,
            isDefault: false,
        });
        expect(untitled).toMatchObject({
            projectId: project.id,
            title: expect.stringMatching(/\S/),
            archivedAt: null,
            isDefault: false,
        });
        expect(named.id).not.toBe(untitled.id);
        expect(await listThreads(owner, project.id)).toEqual(
            expect.arrayContaining([named, untitled]),
        );
        expect(await listThreads(owner, project.id)).toHaveLength(2);
        expect(await snapshot(owner, named.id)).toEqual({
            thread: named,
            items: [],
            lastSeq: 0,
            hasMore: false,
        });
    });

    it('persists rename, archive and unarchive while keeping history available', async () => {
        const owner = await seedAccount();
        const project = await createProject(owner);
        const thread = await createThread(owner, project.id, 'Before rename');
        await insertItems(owner, thread.id, [1]);
        const url = threadPath(thread.id);
        const renamed = await json<ProjectThread>(
            await request(url, owner, { method: 'PATCH', body: { title: 'After rename' } }),
        );
        expect(renamed).toEqual({ ...thread, title: 'After rename' });

        const archived = await json<ProjectThread>(
            await request(url, owner, { method: 'PATCH', body: { archived: true } }),
        );
        expect(archived).toEqual({ ...renamed, archivedAt: expect.any(String) });
        expect(Number.isFinite(Date.parse(archived.archivedAt!))).toBe(true);
        expect(await listThreads(owner, project.id)).toEqual([archived]);
        const archivedSnapshot = await snapshot(owner, thread.id);
        expect(archivedSnapshot.thread).toEqual(archived);
        expect(archivedSnapshot.items.map(({ seq }) => seq)).toEqual([1]);

        const unarchived = await json<ProjectThread>(
            await request(url, owner, { method: 'PATCH', body: { archived: false } }),
        );
        expect(unarchived).toEqual(renamed);
        expect(await snapshot(owner, thread.id)).toEqual({ ...archivedSnapshot, thread: renamed });
    });

    it('requires a session and hides resources across accounts on every endpoint', async () => {
        const owner = await seedAccount();
        const other = await seedAccount();
        const project = await createProject(owner);
        const thread = await createThread(owner, project.id, 'Private thread');
        await insertItems(owner, thread.id, [1]);
        const missingProjectId = randomUUID();
        const missingThreadId = randomUUID();
        const routes = [
            { path: projectThreadsPath(project.id), missing: projectThreadsPath(missingProjectId) },
            {
                path: projectThreadsPath(project.id),
                missing: projectThreadsPath(missingProjectId),
                options: { method: 'POST', body: { title: 'Cross-account create' } },
            },
            { path: threadPath(thread.id), missing: threadPath(missingThreadId) },
            {
                path: threadPath(thread.id),
                missing: threadPath(missingThreadId),
                options: {
                    method: 'PATCH',
                    body: { title: 'Cross-account rename', archived: true },
                },
            },
            {
                path: `${threadPath(thread.id)}/events?after=0`,
                missing: `${threadPath(missingThreadId)}/events?after=0`,
            },
        ] satisfies { path: string; missing: string; options?: RequestOptions }[];
        for (const { path, missing, options } of routes) {
            await expectError(await request(path, undefined, options), 401);
            await expectError(await request(path, other, options), 404, 'NOT_FOUND');
            await expectError(await request(missing, owner, options), 404, 'NOT_FOUND');
        }
        expect(await listThreads(owner, project.id)).toEqual([thread]);
        expect(await snapshot(owner, thread.id)).toMatchObject({ thread, lastSeq: 1 });
    });

    it('rejects missing CSRF and invalid write bodies without changing owned threads', async () => {
        const owner = await seedAccount();
        const project = await createProject(owner);
        const thread = await createThread(owner, project.id, 'Original');
        const list = projectThreadsPath(project.id);
        const detail = threadPath(thread.id);
        await expectError(
            await request(list, owner, { method: 'POST', body: { title: 'Blocked' }, csrf: false }),
            403,
            'CSRF_REJECTED',
        );
        await expectError(
            await request(detail, owner, {
                method: 'PATCH',
                body: { archived: true },
                csrf: false,
            }),
            403,
            'CSRF_REJECTED',
        );
        await expectError(
            await request(list, owner, { method: 'POST', body: { title: '  ' } }),
            422,
            'VALIDATION_ERROR',
        );
        for (const body of [{}, { archived: 'true' }, { title: ' ' }]) {
            await expectError(
                await request(detail, owner, { method: 'PATCH', body }),
                422,
                'VALIDATION_ERROR',
            );
        }
        expect(await listThreads(owner, project.id)).toEqual([thread]);
    });

    it('paginates an ascending, thread-scoped snapshot with exclusive resume cursors', async () => {
        const owner = await seedAccount();
        const project = await createProject(owner);
        const thread = await createThread(owner, project.id, 'Paged thread');
        const sibling = await createThread(owner, project.id, 'Sibling thread');
        const seeded = await insertItems(owner, thread.id, [5, 1, 4, 2, 3]);
        await insertItems(owner, sibling.id, [1, 6]);
        const first = await snapshot(owner, thread.id, '?limit=2');
        const second = await snapshot(owner, thread.id, `?after=${first.lastSeq}&limit=2`);
        const last = await snapshot(owner, thread.id, `?after=${second.lastSeq}&limit=1`);
        const exhausted = await snapshot(owner, thread.id, `?after=${last.lastSeq}&limit=1`);

        expect(
            [first, second, last, exhausted].map(({ lastSeq, hasMore }) => ({ lastSeq, hasMore })),
        ).toEqual([
            { lastSeq: 2, hasMore: true },
            { lastSeq: 4, hasMore: true },
            { lastSeq: 5, hasMore: false },
            { lastSeq: 5, hasMore: false },
        ]);
        expect([first, second, last, exhausted].map((page) => page.thread)).toEqual(
            Array.from({ length: 4 }, () => thread),
        );
        const items = [...first.items, ...second.items, ...last.items];
        expect(items).toEqual(
            seeded
                .sort((a, b) => a.seq - b.seq)
                .map(({ userId: _userId, createdAt, ...row }) => ({
                    ...row,
                    createdAt: createdAt.toISOString(),
                })),
        );
        expect(exhausted.items).toEqual([]);
        expect((await snapshot(owner, thread.id)).items).toEqual(items);
    });

    it('rejects malformed snapshot and stream cursors before opening a stream', async () => {
        const owner = await seedAccount();
        const project = await createProject(owner);
        const thread = await createThread(owner, project.id);
        const url = threadPath(thread.id);
        for (const query of ['?after=-1', '?after=1.5', '?after=2147483648', '?after=1&after=2']) {
            await expectError(await request(`${url}${query}`, owner), 400, 'INVALID_EVENT_CURSOR');
            await expectError(
                await request(`${url}/events${query}`, owner),
                400,
                'INVALID_EVENT_CURSOR',
            );
        }
        for (const query of ['?limit=0', '?limit=101']) {
            await expectError(await request(`${url}${query}`, owner), 400, 'INVALID_THREAD_QUERY');
        }
        await expectError(
            await request(`${url}/events`, owner, { lastEventId: 'not-a-sequence' }),
            400,
            'INVALID_EVENT_CURSOR',
        );
    });

    it('streams replay and a newly committed item over HTTP, then resumes via Last-Event-ID', async () => {
        const owner = await seedAccount();
        const project = await createProject(owner);
        const thread = await createThread(owner, project.id);
        const sibling = await createThread(owner, project.id);
        const url = `${threadPath(thread.id)}/events`;
        await insertItems(owner, thread.id, [3, 1, 2]);
        await insertItems(owner, sibling.id, [2, 4]);
        const initial = await snapshot(owner, thread.id);
        const stream = readEvents(await request(`${url}?after=1`, owner, { lastEventId: '0' }));
        let cursor: string | undefined;
        try {
            expect(await stream.next()).toEqual(frameFor(initial.items[1]!));
            expect(await stream.next()).toEqual(frameFor(initial.items[2]!));
            await insertItems(owner, thread.id, [4]);
            const live = await stream.next();
            const updated = await snapshot(owner, thread.id, '?after=3');
            expect(live).toEqual(frameFor(updated.items[0]!));
            expect(live.id).toBe('4');
            cursor = live.id;
        } finally {
            await stream.close();
        }

        await insertItems(owner, thread.id, [5]);
        const next = await snapshot(owner, thread.id, '?after=4');
        const resumed = readEvents(await request(url, owner, { lastEventId: cursor }));
        try {
            expect(await resumed.next()).toEqual(frameFor(next.items[0]!));
        } finally {
            await resumed.close();
        }
    });

    it('allocates distinct sequences to concurrent transactions and keeps activity monotonic', async () => {
        const owner = await seedAccount();
        const project = await createProject(owner);
        const thread = await createThread(owner, project.id);
        const initialTime = Date.parse(thread.lastActivityAt);
        const append = async (text: string, offset: number) => {
            await db.transaction((tx) =>
                appendProjectThreadItems(
                    tx,
                    owner.id,
                    thread.id,
                    [{ kind: 'notice', payload: { text }, status: null }],
                    new Date(initialTime + offset),
                ),
            );
        };

        const concurrent = ['First writer', 'Second writer', 'Third writer'];
        await Promise.all(concurrent.map((text, index) => append(text, (index + 1) * 1000)));
        const latest = await snapshot(owner, thread.id);
        expect(latest.items.map(({ seq }) => seq)).toEqual([1, 2, 3]);
        expect(new Set(latest.items.map(({ payload }) => payload.text))).toEqual(
            new Set(concurrent),
        );
        expect(latest.thread.lastActivityAt).toBe(new Date(initialTime + 3000).toISOString());

        await append('Late writer with older timestamp', 500);
        const final = await snapshot(owner, thread.id);
        expect(final.items).toEqual([
            ...latest.items,
            expect.objectContaining({
                seq: 4,
                kind: 'notice',
                payload: { text: 'Late writer with older timestamp' },
            }),
        ]);
        expect(final.lastSeq).toBe(4);
        expect(final.thread.lastActivityAt).toBe(latest.thread.lastActivityAt);
    });

    it('redacts an assistant answer and its report reference after the task moves projects', async () => {
        const { user, task, version, run } = await seedRun(db);
        const owner = await seedSession(user.id);
        const source = await createProject(owner, 'Report source project');
        const destination = await createProject(owner, 'Report destination project');
        const thread = await createThread(owner, source.id);
        const now = new Date();
        const [report] = await db
            .insert(reports)
            .values({
                userId: owner.id,
                taskId: task.id,
                taskVersionId: version.id,
                runId: run.id,
                title: 'Saved report',
                summary: 'Restricted result from the saved report.',
                format: 'brief',
                completeness: 'complete',
                publishedAt: now,
            })
            .returning();
        const moveTask = (projectId: string) =>
            request(`${projectsPath}/${projectId}/tasks/${task.id}`, owner, { method: 'PUT' });
        expect((await moveTask(source.id)).status).toBe(204);
        const ref = { kind: 'report', id: report!.id };
        await db.transaction((tx) =>
            appendProjectThreadItems(
                tx,
                owner.id,
                thread.id,
                [
                    {
                        kind: 'message',
                        payload: { role: 'user', text: 'What does the report say?' },
                    },
                    {
                        kind: 'message',
                        payload: { role: 'assistant', text: report!.summary },
                        refs: [ref],
                        status: 'completed',
                    },
                ],
                now,
            ),
        );
        const before = await snapshot(owner, thread.id);
        expect(before.items).toMatchObject([
            { seq: 1, payload: { role: 'user', text: 'What does the report say?' }, refs: [] },
            { seq: 2, payload: { role: 'assistant', text: report!.summary }, refs: [ref] },
        ]);

        expect((await moveTask(destination.id)).status).toBe(204);
        const after = await snapshot(owner, thread.id);
        expect(after).toEqual({
            ...before,
            items: [
                before.items[0],
                {
                    ...before.items[1],
                    payload: { role: 'assistant', text: '原引用报告已移出项目。' },
                    refs: [],
                },
            ],
        });
    });
    it('keeps the legacy ask API and mirrors one completed turn into the default thread', async () => {
        const owner = await seedAccount();
        const project = await createProject(owner);
        const sibling = await createThread(owner, project.id, 'Separate conversation');
        const legacyUrl = `${projectsPath}/${project.id}/conversation`;
        const body = { turnId: randomUUID(), kind: 'ask', message: 'What has this project found?' };
        const expectedAnswer = '项目还没有可引用的报告。可以选择「起草研究」开始准备任务。';
        const legacy = await json<ProjectConversation>(
            await request(`${legacyUrl}/turns`, owner, { method: 'POST', body }),
        );
        expect(legacy.drafts).toEqual([]);
        expect(legacy.turns).toEqual([
            {
                id: body.turnId,
                kind: 'ask',
                message: body.message,
                status: 'completed',
                answer: expectedAnswer,
                draftId: null,
                reportId: null,
            },
        ]);
        expect(await json(await request(legacyUrl, owner))).toEqual(legacy);
        expect(
            await json(await request(`${legacyUrl}/turns`, owner, { method: 'POST', body })),
        ).toEqual(legacy);

        const threads = await listThreads(owner, project.id);
        expect(threads).toHaveLength(2);
        const defaults = threads.filter(({ isDefault }) => isDefault);
        expect(defaults).toHaveLength(1);
        const [thread] = defaults;
        const timeline = await snapshot(owner, thread!.id);
        expect(timeline).toMatchObject({
            thread,
            lastSeq: 2,
            hasMore: false,
            items: [
                {
                    turnId: body.turnId,
                    seq: 1,
                    kind: 'message',
                    payload: { role: 'user', text: body.message },
                },
                {
                    turnId: body.turnId,
                    seq: 2,
                    kind: 'message',
                    payload: { role: 'assistant', text: expectedAnswer },
                    status: 'completed',
                },
            ],
        });
        expect((await snapshot(owner, sibling.id)).items).toEqual([]);
        expect(
            await db
                .select({ threadId: projectConversationTurns.threadId })
                .from(projectConversationTurns)
                .where(
                    and(
                        eq(projectConversationTurns.userId, owner.id),
                        eq(projectConversationTurns.id, body.turnId),
                    ),
                ),
        ).toEqual([{ threadId: thread!.id }]);
    });
});

describe('project agent turns and action decisions', () => {
    it('isolates active turns by thread and stops a running turn without a late answer', async () => {
        const owner = await seedAccount();
        const project = await createProject(owner);
        const first = await createThread(owner, project.id, 'First');
        const second = await createThread(owner, project.id, 'Second');
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<null>();
        let calls = 0;
        answerLookups.set(owner.id, () => {
            if (++calls > 1) return Promise.resolve(null);
            entered.resolve();
            return release.promise;
        });
        const body = { turnId: randomUUID(), message: '请概括目前项目保存的结论。' };
        const send = (threadId: string, input = body) =>
            request(`${threadPath(threadId)}/turns`, owner, { method: 'POST', body: input });
        const initial = send(first.id);
        try {
            await Promise.race([
                entered.promise,
                initial.then(async (response) => {
                    throw new Error(`Turn never entered model: ${await response.clone().text()}`);
                }),
            ]);
            await expectError(
                await send(first.id, { ...body, turnId: randomUUID() }),
                409,
                'TURN_BUSY',
            );
            expect(await json(await send(first.id))).toEqual({
                turnId: body.turnId,
                status: 'running',
            });
            const siblingTurn = { ...body, turnId: randomUUID() };
            expect(await json(await send(second.id, siblingTurn))).toEqual({
                turnId: siblingTurn.turnId,
                status: 'completed',
            });
            await expectError(
                await request(`${threadPath(second.id)}/turns/${body.turnId}/cancel`, owner, {
                    method: 'POST',
                }),
                404,
            );
            const canceled = await request(
                `${threadPath(first.id)}/turns/${body.turnId}/cancel`,
                owner,
                { method: 'POST' },
            );
            expect(await json(canceled)).toEqual({ turnId: body.turnId, status: 'canceled' });
        } finally {
            release.resolve(null);
            answerLookups.delete(owner.id);
        }
        expect(await json(await initial)).toEqual({ turnId: body.turnId, status: 'canceled' });
        const timeline = await snapshot(owner, first.id);
        expect(timeline.items.map(({ kind, status }) => ({ kind, status }))).toEqual([
            { kind: 'message', status: 'running' },
            { kind: 'message', status: 'canceled' },
        ]);
    });

    it('freezes run origin and records exactly one decision on parallel approvals', async () => {
        const owner = await seedAccount();
        const other = await seedAccount();
        const project = await createProject(owner);
        const thread = await createThread(owner, project.id);
        const sibling = await createThread(owner, project.id);
        const body = { turnId: randomUUID(), message: '请调研过去一年可重复使用航天器的公开进展' };
        const turnUrl = `${threadPath(thread.id)}/turns`;
        const send = () => request(turnUrl, owner, { method: 'POST', body });
        expect(await json(await send())).toEqual({ turnId: body.turnId, status: 'completed' });
        expect(await json(await send())).toEqual({ turnId: body.turnId, status: 'completed' });
        const before = await snapshot(owner, thread.id);
        const action = before.items.find((item) => item.kind === 'plan');
        expect(action).toMatchObject({
            status: 'pending',
            payload: { command: 'start_run', revision: 1 },
        });
        const actionUrl = (id: string, decision: 'approve' | 'reject') =>
            `${threadPath(id)}/items/${action!.id}/${decision}`;
        await expectError(
            await request(actionUrl(thread.id, 'approve'), other, { method: 'POST' }),
            404,
        );
        await expectError(
            await request(actionUrl(sibling.id, 'approve'), owner, { method: 'POST' }),
            404,
        );
        const [left, right] = await Promise.all(
            [0, 1].map(async () =>
                json<{ actionId: string; taskId: string; runId: string; status: string }>(
                    await request(actionUrl(thread.id, 'approve'), owner, { method: 'POST' }),
                ),
            ),
        );
        expect(left).toEqual(right);
        expect(left).toMatchObject({
            actionId: action!.id,
            status: 'applied',
            taskId: expect.any(String),
            runId: expect.any(String),
        });
        await expectError(
            await request(actionUrl(thread.id, 'reject'), owner, { method: 'POST' }),
            409,
            'ACTION_CONFLICT',
        );
        expect(
            await db.select({ id: runs.id }).from(runs).where(eq(runs.userId, owner.id)),
        ).toEqual([{ id: left!.runId }]);
        expect(
            await db
                .select()
                .from(projectThreadRunOrigins)
                .where(eq(projectThreadRunOrigins.runId, left!.runId)),
        ).toMatchObject([
            {
                userId: owner.id,
                projectId: project.id,
                threadId: thread.id,
                draftId: action!.payload.draftId,
                draftRevision: 1,
            },
        ]);
        const after = await snapshot(owner, thread.id);
        expect(after.items.slice(before.items.length)).toMatchObject([
            { kind: 'plan', status: 'applied', payload: left },
            {
                kind: 'run',
                status: 'queued',
                turnId: body.turnId,
                payload: { runId: left!.runId, taskId: left!.taskId, status: 'queued' },
            },
        ]);
        const legacy = await json<ProjectConversation>(
            await request(`${projectsPath}/${project.id}/conversation`, owner),
        );
        expect(legacy.drafts).toEqual([]);
        expect(legacy.turns).toEqual([]);
    });

    it('replays rejection and never starts the rejected proposal', async () => {
        const owner = await seedAccount();
        const project = await createProject(owner);
        const thread = await createThread(owner, project.id);
        await json(
            await request(`${threadPath(thread.id)}/turns`, owner, {
                method: 'POST',
                body: { turnId: randomUUID(), message: '请起草新能源汽车电池回收研究' },
            }),
        );
        const item = (await snapshot(owner, thread.id)).items.find(({ kind }) => kind === 'plan');
        expect(item?.status).toBe('pending');
        const path = `${threadPath(thread.id)}/items/${item!.id}`;
        const reject = () => request(`${path}/reject`, owner, { method: 'POST' });
        expect(await json(await reject())).toEqual({
            actionId: item!.id,
            status: 'rejected',
            runId: null,
            taskId: null,
        });
        expect(await json(await reject())).toEqual({
            actionId: item!.id,
            status: 'rejected',
            runId: null,
            taskId: null,
        });
        await expectError(
            await request(`${path}/approve`, owner, { method: 'POST' }),
            409,
            'ACTION_CONFLICT',
        );
        expect(await db.select().from(runs).where(eq(runs.userId, owner.id))).toEqual([]);
    });

    it('offers a one-click research draft when an empty project cannot answer', async () => {
        const owner = await seedAccount();
        const project = await createProject(owner);
        const thread = await createThread(owner, project.id);
        const send = (message: string) =>
            request(`${threadPath(thread.id)}/turns`, owner, {
                method: 'POST',
                body: { turnId: randomUUID(), message },
            });
        const topic = '过去七天开源许可证变更，优先官方发布说明';
        expect(await json(await send(topic))).toMatchObject({ status: 'completed' });
        const clarification = (await snapshot(owner, thread.id)).items.at(-1);
        expect(clarification).toMatchObject({
            kind: 'disambiguation',
            payload: {
                role: 'assistant',
                text: expect.stringContaining('项目还没有可查询的报告'),
                choices: [{ label: '起草研究', message: `起草研究计划：${topic}` }],
            },
        });
        const [choice] = clarification!.payload.choices as { message: string }[];
        expect(await json(await send(choice!.message))).toMatchObject({ status: 'completed' });
        const plan = (await snapshot(owner, thread.id)).items.find(({ kind }) => kind === 'plan');
        expect(plan).toMatchObject({ status: 'pending' });
        expect(await db.select().from(runs).where(eq(runs.userId, owner.id))).toEqual([]);
    });

    it('expires at most the selected overdue turns per batch, oldest first', async () => {
        const owner = await seedAccount();
        const project = await createProject(owner);
        const threads = [
            await createThread(owner, project.id, 'Overdue A'),
            await createThread(owner, project.id, 'Overdue B'),
        ];
        const past = new Date(Date.now() - 60_000);
        const ids: string[] = [randomUUID(), randomUUID()];
        await db.insert(projectConversationTurns).values(
            ids.map((id, index) => ({
                id,
                userId: owner.id,
                projectId: project.id,
                threadId: threads[index]!.id,
                input: { kind: 'auto' as const, message: `overdue ${index}` },
                status: 'running' as const,
                createdAt: past,
                executionDeadlineAt: new Date(past.getTime() + index),
            })),
        );
        const statuses = async () => {
            const rows = await db
                .select({
                    id: projectConversationTurns.id,
                    status: projectConversationTurns.status,
                })
                .from(projectConversationTurns)
                .where(eq(projectConversationTurns.userId, owner.id));
            return ids.map((id) => rows.find((row) => row.id === id)?.status);
        };
        // Other suites may leave older overdue turns; drain them so this batch reaches ours.
        const signal = new AbortController().signal;
        while ((await statuses())[0] === 'running') await expireProjectTurns(db, 1, signal);
        expect(await statuses()).toEqual(['failed', 'running']);
        await expireProjectTurns(db, 1, signal);
        expect(await statuses()).toEqual(['failed', 'failed']);
        const [first] = (await snapshot(owner, threads[0]!.id)).items.filter(
            ({ kind, payload }) => kind === 'message' && payload.role === 'assistant',
        );
        expect(first).toMatchObject({
            turnId: ids[0],
            payload: { text: '本轮已超时，可重新发送。' },
        });
    });
});

describe('project Agent evidence boundaries', () => {
    it('matches a report topic from a complete natural-language question', async () => {
        const { user, task, version } = await seedRun(db);
        const owner = await seedSession(user.id);
        const project = await createProject(owner);
        const thread = await createThread(owner, project.id);
        const { report } = await libraryFixture(db, user.id, {
            id: task.id,
            currentVersionId: version.id,
        });
        const summary = '样本记录仅支持实验室条件下的阶段性结论。';
        await db
            .update(reports)
            .set({ title: '固态电池', summary })
            .where(eq(reports.id, report.id));
        expect(
            (
                await request(`${projectsPath}/${project.id}/tasks/${task.id}`, owner, {
                    method: 'PUT',
                })
            ).status,
        ).toBe(204);
        expect(
            await json(
                await request(`${threadPath(thread.id)}/turns`, owner, {
                    method: 'POST',
                    body: { turnId: randomUUID(), message: '请总结固态电池的研究结论' },
                }),
            ),
        ).toMatchObject({ status: 'completed' });
        expect((await snapshot(owner, thread.id)).items).toContainEqual(
            expect.objectContaining({
                payload: { role: 'assistant', text: summary },
                refs: [{ kind: 'report', id: report.id }],
            }),
        );
    });

    it('uses a selected source in a research draft and prevents approval after the source leaves the project', async () => {
        const { user, task, version } = await seedRun(db);
        const owner = await seedSession(user.id);
        const project = await createProject(owner);
        const destination = await createProject(owner);
        const thread = await createThread(owner, project.id);
        const sourceText = 'The measured annual rail energy was 112 MWh.';
        const { report, snapshot: source } = await libraryFixture(
            db,
            user.id,
            { id: task.id, currentVersionId: version.id },
            { title: 'Rail energy source', text: sourceText },
        );
        const moveTask = (id: string) =>
            request(`${projectsPath}/${id}/tasks/${task.id}`, owner, { method: 'PUT' });
        expect((await moveTask(project.id)).status).toBe(204);
        const modelInputs: StructuredInput[] = [];
        draftModels.set(owner.id, {
            async generateStructured<T>(input: StructuredInput, context: CallContext = {}) {
                await context.beforeAttempt?.('model');
                modelInputs.push(input);
                return {
                    mode: 'live',
                    data: draftConfig({ title: 'Compare railway energy' }) as T,
                    usage: { inputTokens: 100, outputTokens: 100, estimated: false },
                };
            },
        });
        try {
            expect(
                await json(
                    await request(`${threadPath(thread.id)}/turns`, owner, {
                        method: 'POST',
                        body: {
                            turnId: randomUUID(),
                            message: 'Research the energy efficiency trend.',
                            refs: [{ kind: 'source', reportId: report.id, snapshotId: source.id }],
                        },
                    }),
                ),
            ).toMatchObject({ status: 'completed' });
            expect(modelInputs).toHaveLength(1);
            expect(modelInputs[0]?.untrustedSources).toMatchObject([
                { projectReferences: { sources: [{ title: source.title, excerpt: sourceText }] } },
            ]);
            const plan = (await snapshot(owner, thread.id)).items.find(
                ({ kind }) => kind === 'plan',
            );
            expect(plan).toMatchObject({
                status: 'pending',
                refs: [{ kind: 'report', id: report.id }],
            });
            expect((await moveTask(destination.id)).status).toBe(204);
            const current = (await snapshot(owner, thread.id)).items.find(
                ({ id }) => id === plan!.id,
            );
            expect(current).toMatchObject({ kind: 'disambiguation', refs: [] });
            await expectError(
                await request(`${threadPath(thread.id)}/items/${plan!.id}/approve`, owner, {
                    method: 'POST',
                }),
                404,
            );
        } finally {
            draftModels.delete(owner.id);
        }
    });
    it('reads a saved paragraph by anchor and redacts it after project membership changes', async () => {
        const { user, task, version, run } = await seedRun(db);
        const owner = await seedSession(user.id);
        const project = await createProject(owner, 'Research source');
        const destination = await createProject(owner, 'Move destination');
        const thread = await createThread(owner, project.id);
        const [report] = await db
            .insert(reports)
            .values({
                userId: owner.id,
                taskId: task.id,
                taskVersionId: version.id,
                runId: run.id,
                title: 'Saved result',
                summary: 'First paragraph.\n\nSecond paragraph is project-scoped.',
                format: 'brief',
                completeness: 'complete',
                publishedAt: new Date(),
            })
            .returning();
        const moveTask = (id: string) =>
            request(`${projectsPath}/${id}/tasks/${task.id}`, owner, { method: 'PUT' });
        expect((await moveTask(project.id)).status).toBe(204);
        const send = (paragraphIndex: number) =>
            request(`${threadPath(thread.id)}/turns`, owner, {
                method: 'POST',
                body: {
                    turnId: randomUUID(),
                    message: 'Read the referenced text.',
                    refs: [
                        {
                            kind: 'report',
                            id: report!.id,
                            anchor: { kind: 'summary', paragraphIndex },
                        },
                    ],
                },
            });
        await expectError(await send(3), 422, 'REPORT_PARAGRAPH_UNAVAILABLE');
        expect(await json(await send(1))).toMatchObject({ status: 'completed' });
        const before = await snapshot(owner, thread.id);
        expect(before.items).toMatchObject([
            {
                kind: 'message',
                payload: { role: 'user' },
                refs: [{ anchor: { paragraphIndex: 1 } }],
            },
            { kind: 'tool_step', payload: { tool: 'read_report' } },
            {
                kind: 'message',
                payload: { role: 'assistant', text: 'Second paragraph is project-scoped.' },
            },
        ]);
        expect((await moveTask(destination.id)).status).toBe(204);
        await expectError(await send(1), 404);
        expect((await snapshot(owner, thread.id)).items).toMatchObject([
            { payload: { role: 'user', text: 'Read the referenced text.' }, refs: [] },
            { kind: 'tool_step', refs: [] },
            { payload: { role: 'assistant', text: '原引用报告已移出项目。' }, refs: [] },
        ]);
    });

    it('settles controlled model calls and refuses responses that exceed the reserved output', async () => {
        const owner = await seedAccount();
        const project = await createProject(owner);
        const thread = await createThread(owner, project.id);
        let modelCalls = 0;
        answerLookups.set(owner.id, () => ({
            async generateStructured<T>(input: StructuredInput, context: CallContext = {}) {
                await context.beforeAttempt?.('model');
                const outputTokens = modelCalls++ === 0 ? 1 : input.maxOutputTokens + 1;
                return {
                    mode: 'live',
                    data: { answer: 'Checked project answer' } as T,
                    usage: { inputTokens: 1, outputTokens, estimated: false },
                };
            },
        }));
        try {
            const send = () =>
                request(`${threadPath(thread.id)}/turns`, owner, {
                    method: 'POST',
                    body: { turnId: randomUUID(), message: '请总结我们已有的结论。' },
                });
            expect(await json(await send())).toMatchObject({ status: 'completed' });
            expect(await json(await send())).toMatchObject({ status: 'failed' });
            const timeline = (await snapshot(owner, thread.id)).items;
            expect(timeline.filter(({ kind }) => kind !== 'message')).toEqual([]);
            expect(
                timeline.filter(({ payload }) => payload.text === 'Checked project answer'),
            ).toHaveLength(1);
            expect(await db.select().from(runs).where(eq(runs.userId, owner.id))).toEqual([]);
            expect(modelCalls).toBe(2);
        } finally {
            answerLookups.delete(owner.id);
        }
    });
});

describe('project Agent autonomy on the conversation API', () => {
    it('requires approval in ask mode and admits one automatic research across concurrent threads', async () => {
        const owner = await seedAccount();
        const project = await createProject(owner);
        const [ask, first, second] = await Promise.all(
            ['Ask', 'First', 'Second'].map((name) => createThread(owner, project.id, name)),
        );
        draftModels.set(owner.id, {
            async generateStructured<T>(_input: StructuredInput, context: CallContext = {}) {
                await context.beforeAttempt?.('model');
                return {
                    mode: 'live',
                    data: {
                        title: '轨道交通能耗研究',
                        topic: '轨道交通车辆能耗',
                        goal: '核对轨道交通车辆的公开能耗指标',
                    } as T,
                    usage: { inputTokens: 100, outputTokens: 100, estimated: false },
                };
            },
        });
        const send = async (
            thread: ProjectThread,
            autonomy: 'ask' | 'budgeted',
            message = '请立即开始研究轨道交通车辆的能耗指标',
        ) => {
            const input = { turnId: randomUUID(), message, autonomy };
            const url = `${threadPath(thread.id)}/turns`;
            expect(
                await json(await request(url, owner, { method: 'POST', body: input })),
            ).toMatchObject({ status: 'completed' });
            expect(
                await json(await request(url, owner, { method: 'POST', body: input })),
            ).toMatchObject({ status: 'completed' });
            return (await snapshot(owner, thread.id)).items.filter(({ kind }) => kind === 'plan');
        };
        try {
            expect(await send(ask!, 'ask')).toMatchObject([{ status: 'pending' }]);
            const ambiguous = await createThread(owner, project.id, 'Ambiguous');
            expect(await send(ambiguous, 'budgeted', '请现在开始研究这个')).toEqual([]);
            expect((await snapshot(owner, ambiguous.id)).items.at(-1)).toMatchObject({
                kind: 'disambiguation',
            });
            const deferred = await createThread(owner, project.id, 'Deferred');
            expect(
                await send(
                    deferred,
                    'budgeted',
                    '请立即开始研究轨道交通车辆的能耗指标，但先不要启动',
                ),
            ).toMatchObject([{ status: 'pending' }]);
            const all = (
                await Promise.all([send(first!, 'budgeted'), send(second!, 'budgeted')])
            ).flat();
            expect(
                all.map(({ status }) => status).sort((a, b) => (a ?? '').localeCompare(b ?? '')),
            ).toEqual(['applied', 'pending']);
            const [startedRun] = await db.select().from(runs).where(eq(runs.userId, owner.id));
            expect(startedRun).toBeDefined();
            const queuedItems = (
                await Promise.all([first!, second!].map(({ id }) => snapshot(owner, id)))
            ).flatMap(({ items }) => items.filter(({ kind }) => kind === 'run'));
            expect(queuedItems).toMatchObject([
                { status: 'queued', payload: { runId: startedRun!.id, status: 'queued' } },
            ]);
            expect(
                await db
                    .select()
                    .from(idempotencyRecords)
                    .where(
                        and(
                            eq(idempotencyRecords.userId, owner.id),
                            eq(idempotencyRecords.scope, 'project-agent:auto-run-budget'),
                        ),
                    ),
            ).toHaveLength(1);
        } finally {
            draftModels.delete(owner.id);
        }
    });

    it('creates a reviewable weekly plan from a turn and reverses the approval via the same timeline', async () => {
        const owner = await seedAccount();
        const project = await createProject(owner);
        const thread = await createThread(owner, project.id);
        const url = threadPath(thread.id);
        const send = (message: string) =>
            request(`${url}/turns`, owner, {
                method: 'POST',
                body: { turnId: randomUUID(), message, autonomy: 'ask' },
            });
        expect(await json(await send('安排每周一更新公共交通技术动态'))).toMatchObject({
            status: 'completed',
        });
        expect(
            (await snapshot(owner, thread.id)).items.some(({ kind }) => kind === 'disambiguation'),
        ).toBe(true);
        expect(await json(await send('安排每周一 09:30 更新公共交通技术动态'))).toMatchObject({
            status: 'completed',
        });
        const schedule = (await snapshot(owner, thread.id)).items.find(
            ({ kind }) => kind === 'schedule',
        );
        expect(schedule).toMatchObject({
            status: 'pending',
            payload: {
                command: 'create_schedule',
                task: {
                    config: { schedule: { frequency: 'weekly', weekday: 1, localTime: '09:30' } },
                },
            },
        });
        const base = `${url}/items/${schedule!.id}`;
        expect(
            await json(await request(`${base}/approve`, owner, { method: 'POST' })),
        ).toMatchObject({ status: 'applied', undoable: true });
        expect(await json(await request(`${base}/undo`, owner, { method: 'POST' }))).toMatchObject({
            status: 'undone',
            undoable: false,
        });
        expect(
            (await snapshot(owner, thread.id)).items
                .filter(({ kind }) => kind === 'schedule')
                .map(({ status }) => status),
        ).toEqual(['undone', 'applied', 'undone']);
        expect(await db.select().from(runs).where(eq(runs.userId, owner.id))).toEqual([]);
    });
});
