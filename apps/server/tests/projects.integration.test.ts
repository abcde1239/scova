import type { CallContext, ModelProvider, StructuredInput } from '@scova/connectors';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import Redis from 'ioredis';
import {
    agentProviders,
    closeDatabase,
    createDatabaseClient,
    eq,
    idempotencyRecords,
    projectTasks,
    projectConversationTurns,
    outbox,
    runEvents,
    projects,
    reports,
    runs,
    sessions,
    taskVersions,
    tasks,
    users,
} from '@scova/db';
import { readDatabaseMigrations, scopeMigrationSql } from '@scova/db/migrate';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { createApiApp } from '@/app/index';
import { createDefaultServices, type ApiServiceOverrides } from '@/app/services';
import { createQuestionBudgetRepo } from '@/repo/report-questions';
import { createTaskDraftRepo } from '@/repo/task-drafts';
import { tokenHash } from '@/utils/security';

const origin = 'https://scova.test';
const path = '/api/v1/projects';
const now = new Date('2026-11-20T01:00:00.000Z');
const baseUrl =
    process.env.SCOVA_TEST_DATABASE_URL ??
    'postgresql://scova_test:scova_test@127.0.0.1:55432/scova_test';
const schema = `scova_projects_${randomUUID().replaceAll('-', '')}`;
const scopedUrl = new URL(baseUrl);
scopedUrl.searchParams.set('schema', schema);
const db = createDatabaseClient({ connectionString: scopedUrl.toString() });
const admin = new pg.Client({ connectionString: baseUrl });
const redis = new Redis(process.env.SCOVA_TEST_REDIS_URL ?? 'redis://127.0.0.1:56379', {
    lazyConnect: true,
});
const draftLookups = new Map<string, () => ModelProvider | null | Promise<ModelProvider | null>>();
function testServices(overrides: ApiServiceOverrides = {}) {
    return createDefaultServices({
        db: () => db,
        redis: () => redis,
        clock: () => now,
        origin,
        taskDraftModel: (userId) => (userId ? draftLookups.get(userId)?.() : undefined) ?? null,
        reportQuestionModel: () => null,
        ...overrides,
        taskDraftPolicy: { keyPrefix: `${schema}:draft:`, ...overrides.taskDraftPolicy },
        reportQuestionPolicy: {
            keyPrefix: `${schema}:question:`,
            ...overrides.reportQuestionPolicy,
        },
    });
}
const app = createApiApp('node', testServices());
let schemaCreated = false;

type Account = Awaited<ReturnType<typeof seedAccount>>;
let existingAccount: Account;
let existingTask: Awaited<ReturnType<typeof seedTask>>;

async function seedAccount() {
    const email = `${randomUUID()}@example.test`;
    const [user] = await db
        .insert(users)
        .values({ email, normalizedEmail: email, passwordHash: 'project-test-fixture' })
        .returning();
    const id = user!.id;
    const token = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(32).toString('base64url');
    await db.insert(sessions).values({
        userId: id,
        tokenHash: tokenHash(token),
        csrfTokenHash: tokenHash(csrfToken),
        expiresAt: new Date('2026-11-21T01:00:00.000Z'),
    });
    return { id, cookie: `scova_session=${token}`, csrfToken };
}

async function seedTask(userId: string, title: string, nextRunAt = now) {
    const [task] = await db.insert(tasks).values({ userId, title, nextRunAt }).returning();
    return task!;
}

async function seedHistory(task: NonNullable<Awaited<ReturnType<typeof seedTask>>>) {
    const { id: taskId, userId } = task;
    const comparisonScopeHash = 'a'.repeat(64);
    const [version] = await db
        .insert(taskVersions)
        .values({ userId, taskId, version: 1, configJson: {}, comparisonScopeHash })
        .returning();
    const taskVersionId = version!.id;
    await db
        .update(tasks)
        .set({ currentVersionId: taskVersionId, updatedAt: task.updatedAt })
        .where(eq(tasks.id, taskId));
    const [run] = await db
        .insert(runs)
        .values({
            userId,
            taskId,
            taskVersionId,
            comparisonScopeHash,
            mode: 'demo',
            trigger: 'manual',
            budgetJson: {},
            queuedAt: now,
        })
        .returning();
    const runId = run!.id;
    const [report] = await db
        .insert(reports)
        .values({
            userId,
            taskId,
            taskVersionId,
            runId,
            title: '研究报告',
            summary: '摘要',
            format: 'brief',
            completeness: 'complete',
            publishedAt: now,
        })
        .returning();
    return { runId, reportId: report!.id, taskVersionId };
}

function request(
    url: string,
    {
        account,
        method = 'GET',
        body,
        csrf = true,
        key,
        revision,
        server = app,
    }: {
        account?: Account;
        method?: string;
        body?: unknown;
        csrf?: boolean;
        key?: string;
        revision?: number;
        server?: typeof app;
    } = {},
) {
    const headers = new Headers({ origin });
    if (account) {
        headers.set('cookie', account.cookie);
        if (csrf) headers.set('x-csrf-token', account.csrfToken);
    }
    if (key) headers.set('idempotency-key', key);
    if (revision !== undefined) headers.set('if-match', `"${revision}"`);
    if (body !== undefined) headers.set('content-type', 'application/json');
    return server.handle(
        new Request(`${origin}${url}`, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
        }),
    );
}

async function createProject(account: Account, name: string) {
    const response = await request(path, { account, method: 'POST', body: { name } });
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    return response.json() as Promise<{ id: string; name: string; createdAt: string }>;
}

const membershipPath = (projectId: string, taskId: string) =>
    `${path}/${projectId}/tasks/${taskId}`;

beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    await admin.query(`SET search_path TO "${schema}"`);
    const migrations = await readDatabaseMigrations();
    const projectMigration = migrations.findIndex(({ name }) =>
        name.endsWith('_project_membership'),
    );
    expect(projectMigration).toBeGreaterThanOrEqual(0);
    // Exercise the additive migration with a task already present in the isolated schema.
    for (const migration of migrations.slice(0, projectMigration))
        await admin.query(scopeMigrationSql(migration.sql, schema));
    existingAccount = await seedAccount();
    existingTask = await seedTask(existingAccount.id, '迁移前任务');
    for (const migration of migrations.slice(projectMigration))
        await admin.query(scopeMigrationSql(migration.sql, schema));
}, 120_000);

afterAll(async () => {
    if (redis.status === 'ready') {
        const keys = await redis.keys(`${schema}:*`);
        if (keys.length) await redis.del(...keys);
    }
    redis.disconnect();
    await closeDatabase(db);
    if (schemaCreated) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
});

describe('Project owner-scoped API', () => {
    it('leaves an existing task unassigned and enforces ownership in PostgreSQL', async () => {
        expect(await db.select().from(tasks).where(eq(tasks.id, existingTask.id))).toEqual([
            existingTask,
        ]);
        expect(
            await db.select().from(projectTasks).where(eq(projectTasks.taskId, existingTask.id)),
        ).toEqual([]);
        const other = await seedAccount();
        const foreignProject = await createProject(other, '禁止跨账号关联');
        await expect(
            db.insert(projectTasks).values({
                projectId: foreignProject.id,
                userId: existingAccount.id,
                taskId: existingTask.id,
            }),
        ).rejects.toMatchObject({ cause: { code: '23503' } });
    });

    it('validates names, requires session and CSRF, and paginates projects and tasks by account and project', async () => {
        expect((await request(path)).status).toBe(401);
        const owner = await seedAccount();
        const other = await seedAccount();
        for (const name of ['  \t\n　', '测试\u0000项目']) {
            expect(
                (await request(path, { account: owner, method: 'POST', body: { name } })).status,
            ).toBe(422);
        }
        expect(
            (
                await request(path, {
                    account: owner,
                    method: 'POST',
                    body: { name: '测试' },
                    csrf: false,
                })
            ).status,
        ).toBe(403);
        const first = await createProject(owner, '　长期项目  ');
        expect(first.name).toBe('长期项目');
        const second = await createProject(owner, '另一个项目');
        await createProject(other, '另一个账号的项目');
        const firstPage = await request(`${path}?limit=1`, { account: owner });
        expect(firstPage.status).toBe(200);
        const firstBody = await firstPage.json();
        expect(firstBody.items).toEqual([second]);
        const secondPage = await request(`${path}?limit=1&cursor=${firstBody.nextCursor}`, {
            account: owner,
        });
        expect(await secondPage.json()).toEqual({ items: [first], nextCursor: null });
        expect(
            (await request(`${path}?cursor=${firstBody.nextCursor}`, { account: other })).status,
        ).toBe(400);
        expect((await request(`${path}/${first.id}`, { account: other })).status).toBe(404);
        const empty = await request(`${path}/${first.id}`, { account: owner });
        expect(await empty.json()).toEqual({
            project: first,
            tasks: { items: [], nextCursor: null },
            nextRun: null,
            recentRuns: [],
            recentReports: [],
        });
        const older = await seedTask(owner.id, '较早任务', new Date(now.getTime() - 60_000));
        const newer = await seedTask(owner.id, '较新任务');
        for (const task of [older, newer]) {
            expect(
                (
                    await request(membershipPath(first.id, task.id), {
                        account: owner,
                        method: 'PUT',
                    })
                ).status,
            ).toBe(204);
        }
        const detail = await (
            await request(`${path}/${first.id}?limit=1`, { account: owner })
        ).json();
        expect(detail.tasks.items).toEqual([
            { id: newer.id, title: newer.title, status: 'active', nextRunAt: now.toISOString() },
        ]);
        expect(detail.nextRun).toEqual({
            taskId: older.id,
            title: older.title,
            at: older.nextRunAt!.toISOString(),
        });
        const next = await (
            await request(`${path}/${first.id}?cursor=${detail.tasks.nextCursor}`, {
                account: owner,
            })
        ).json();
        expect(next.tasks.items[0].id).toBe(older.id);
        expect(
            (
                await request(`${path}/${second.id}?cursor=${detail.tasks.nextCursor}`, {
                    account: owner,
                })
            ).status,
        ).toBe(400);
    });

    it('moves current membership and recent history while preserving schedule, version, run and report records', async () => {
        const owner = await seedAccount();
        const other = await seedAccount();
        const first = await createProject(owner, '原项目');
        const second = await createProject(owner, '新项目');
        const task = await seedTask(owner.id, '研究任务');
        const history = await seedHistory(task);
        const foreignTask = await seedTask(other.id, '他人任务');
        expect(
            (
                await request(membershipPath(first.id, foreignTask.id), {
                    account: owner,
                    method: 'PUT',
                })
            ).status,
        ).toBe(404);
        expect(
            (await request(membershipPath(first.id, task.id), { account: other, method: 'PUT' }))
                .status,
        ).toBe(404);
        expect(
            (await request(`${path}/${first.id}`, { account: other, method: 'DELETE' })).status,
        ).toBe(404);
        expect(
            (
                await request(membershipPath(first.id, task.id), {
                    account: owner,
                    method: 'PUT',
                    csrf: false,
                })
            ).status,
        ).toBe(403);
        for (const project of [first, first, second]) {
            expect(
                (
                    await request(membershipPath(project.id, task.id), {
                        account: owner,
                        method: 'PUT',
                    })
                ).status,
            ).toBe(204);
        }
        expect(
            (await request(membershipPath(first.id, task.id), { account: owner, method: 'DELETE' }))
                .status,
        ).toBe(204);
        const original = await (await request(`${path}/${first.id}`, { account: owner })).json();
        expect(original.tasks.items).toEqual([]);
        expect(original.recentRuns).toEqual([]);
        expect(original.recentReports).toEqual([]);
        const result = await (await request(`${path}/${second.id}`, { account: owner })).json();
        expect(result.recentRuns).toEqual([
            {
                id: history.runId,
                taskId: task.id,
                title: task.title,
                status: 'queued',
                queuedAt: now.toISOString(),
            },
        ]);
        expect(result.recentReports).toEqual([
            {
                id: history.reportId,
                taskId: task.id,
                runId: history.runId,
                title: '研究报告',
                publishedAt: now.toISOString(),
            },
        ]);
        expect(
            (await request(`${path}/${second.id}`, { account: owner, method: 'DELETE' })).status,
        ).toBe(204);
        expect((await request(`${path}/${second.id}`, { account: owner })).status).toBe(404);
        expect(
            await db.select().from(projectTasks).where(eq(projectTasks.taskId, task.id)),
        ).toEqual([]);
        expect(await db.select().from(tasks).where(eq(tasks.id, task.id))).toEqual([
            { ...task, currentVersionId: history.taskVersionId },
        ]);
        expect(await db.select().from(runs).where(eq(runs.id, history.runId))).toHaveLength(1);
        expect(
            await db.select().from(reports).where(eq(reports.id, history.reportId)),
        ).toHaveLength(1);
    });

    it('waits for concurrent membership writes and never detaches a task from its newer project', async () => {
        const owner = await seedAccount();
        const first = await createProject(owner, '并发：原项目');
        const second = await createProject(owner, '并发：新项目');
        const task = await seedTask(owner.id, '并发任务');
        const link = (projectId: string, method = 'PUT') =>
            request(membershipPath(projectId, task.id), { account: owner, method });
        const results = await Promise.all([link(first.id), link(second.id)]);
        expect(results.map(({ status }) => status)).toEqual([204, 204]);
        const memberships = await db
            .select()
            .from(projectTasks)
            .where(eq(projectTasks.taskId, task.id));
        expect(memberships).toHaveLength(1);
        const currentId = memberships[0]!.projectId;
        const nextId = currentId === first.id ? second.id : first.id;
        const competing = await Promise.all([link(nextId), link(currentId, 'DELETE')]);
        expect(competing.map(({ status }) => status)).toEqual([204, 204]);
        expect(
            await db.select().from(projectTasks).where(eq(projectTasks.taskId, task.id)),
        ).toEqual([{ userId: owner.id, taskId: task.id, projectId: nextId }]);
        const [remove, assign] = await Promise.all([
            request(`${path}/${nextId}`, { account: owner, method: 'DELETE' }),
            link(nextId),
        ]);
        expect(remove.status).toBe(204);
        expect([204, 404]).toContain(assign.status);
        expect(
            await db.select().from(projectTasks).where(eq(projectTasks.taskId, task.id)),
        ).toEqual([]);
        expect(await db.select().from(projects).where(eq(projects.id, nextId))).toEqual([]);
    });
});

const taskConfig = {
    title: '开源动态',
    topic: '开源发布',
    goal: '查阅许可证变更',
    focusPoints: [],
    exclusions: [],
    sourcePreferences: { preferredUrls: [], excludedUrls: [], officialOnly: false },
    timeRange: { kind: 'rolling', days: 7 },
    timezone: 'Asia/Tokyo',
    schedule: { frequency: 'manual' },
    outputFormat: 'brief',
    budget: {
        maxSearches: 10,
        maxPages: 20,
        maxDurationSeconds: 300,
        maxInputTokens: 40_000,
        maxOutputTokens: 8_000,
    },
    notificationPreference: { mode: 'summary', runIssues: true },
};

describe('task-first entry', () => {
    it('starts an unassigned task atomically and replays the original run even after later assignment', async () => {
        const owner = await seedAccount();
        const other = await seedAccount();
        const url = '/api/v1/tasks/start';
        const body = { config: taskConfig };
        const options = { account: owner, method: 'POST', body, key: randomUUID() };
        expect((await request(url, { ...options, account: undefined })).status).toBe(401);
        expect((await request(url, { ...options, csrf: false })).status).toBe(403);
        expect((await request(url, { ...options, key: undefined })).status).toBe(422);
        expect((await request(url, { ...options, key: 'x' })).status).toBe(422);

        const submitted = await Promise.all(Array.from({ length: 4 }, () => request(url, options)));
        expect(submitted.map(({ status }) => status)).toEqual([201, 201, 201, 201]);
        const replies = await Promise.all(submitted.map((response) => response.json()));
        const result = replies[0];
        expect(replies).toEqual(Array(4).fill(result));
        expect(result.runId).toEqual(expect.any(String));
        const taskId = result.detail.task.id;
        expect(await db.select().from(tasks).where(eq(tasks.userId, owner.id))).toHaveLength(1);
        expect(
            await db.select().from(taskVersions).where(eq(taskVersions.taskId, taskId)),
        ).toHaveLength(1);
        expect(await db.select().from(projectTasks).where(eq(projectTasks.taskId, taskId))).toEqual(
            [],
        );
        expect(await db.select().from(runs).where(eq(runs.taskId, taskId))).toMatchObject([
            {
                id: result.runId,
                taskVersionId: result.detail.version.id,
                mode: 'live',
                status: 'queued',
            },
        ]);
        expect(
            await db.select().from(runEvents).where(eq(runEvents.runId, result.runId)),
        ).toMatchObject([{ type: 'run.queued' }]);
        expect(
            await db.select().from(outbox).where(eq(outbox.aggregateId, result.runId)),
        ).toHaveLength(1);
        const changed = await request(url, {
            ...options,
            body: { config: { ...taskConfig, title: '更改标题' } },
        });
        expect(changed.status).toBe(409);
        expect(await changed.json()).toMatchObject({ code: 'IDEMPOTENCY_PAYLOAD_MISMATCH' });
        expect((await request('/api/v1/tasks', options)).status).toBe(409);
        const otherResponse = await request(url, { ...options, account: other });
        expect(otherResponse.status).toBe(201);
        expect((await otherResponse.json()).runId).not.toBe(result.runId);

        const project = await createProject(owner, '后续归类');
        expect(
            (await request(membershipPath(project.id, taskId), { account: owner, method: 'PUT' }))
                .status,
        ).toBe(204);
        const edited = await request('/api/v1/tasks/' + taskId, {
            account: owner,
            method: 'PATCH',
            body: { config: { ...taskConfig, title: '归类后编辑' } },
            revision: result.detail.task.revision,
        });
        expect(edited.status).toBe(200);
        const editedTask = await edited.json();
        expect(editedTask.task.revision).toBe(2);
        const replayed = await request(url, options);
        expect(replayed.status).toBe(201);
        const replayedResult = await replayed.json();
        expect(replayedResult.runId).toBe(result.runId);
        expect(replayedResult.detail.version).toEqual(result.detail.version);
        expect(replayedResult.detail.task).toMatchObject({
            id: taskId,
            title: result.detail.task.title,
            revision: result.detail.task.revision,
            currentVersionId: result.detail.version.id,
        });
        expect(await db.select().from(tasks).where(eq(tasks.userId, owner.id))).toHaveLength(1);
    });

    it('restricts task project lookup and creates exactly one project when concurrent requests try to categorize a task', async () => {
        const owner = await seedAccount();
        const other = await seedAccount();
        const task = await seedTask(owner.id, '待归类任务');
        const url = '/api/v1/tasks/' + task.id + '/project';
        const create = { account: owner, method: 'POST', body: { name: '  归类项目  ' } };
        expect((await request(url)).status).toBe(401);
        expect((await request(url, { account: other })).status).toBe(404);
        expect((await request(url, { ...create, account: other })).status).toBe(404);
        expect((await request(url, { ...create, csrf: false })).status).toBe(403);
        expect((await request(url, { ...create, body: { name: '   ' } })).status).toBe(422);
        const unassigned = await request(url, { account: owner });
        expect(unassigned.status).toBe(200);
        expect(await unassigned.json()).toEqual({ project: null });

        const responses = await Promise.all([request(url, create), request(url, create)]);
        expect(
            responses.map(({ status }) => status).sort((first, second) => first - second),
        ).toEqual([201, 409]);
        const project = await responses.find(({ status }) => status === 201)!.json();
        expect(project).toMatchObject({ name: '归类项目', id: expect.any(String) });
        expect(await responses.find(({ status }) => status === 409)!.json()).toMatchObject({
            code: 'TASK_ALREADY_ASSIGNED',
        });
        expect(await db.select().from(projects).where(eq(projects.userId, owner.id))).toHaveLength(
            1,
        );
        expect(await db.select().from(projects).where(eq(projects.userId, other.id))).toEqual([]);
        expect(await (await request(url, { account: owner })).json()).toEqual({ project });
        expect((await request(url, create)).status).toBe(409);
        expect(
            (
                await request(membershipPath(project.id, task.id), {
                    account: owner,
                    method: 'DELETE',
                })
            ).status,
        ).toBe(204);
        expect(await (await request(url, { account: owner })).json()).toEqual({ project: null });
    });
});

describe('project task submissions', () => {
    it('creates and queues once across concurrent HTTP submissions, and rejects key reuse with a different action', async () => {
        const owner = await seedAccount();
        const other = await seedAccount();
        const project = await createProject(owner, '项目执行');
        const url = `${path}/${project.id}/tasks`;
        const body = { config: taskConfig, start: true };
        const options = { account: owner, method: 'POST', body, key: randomUUID() };
        expect((await request(url, { ...options, key: undefined })).status).toBe(428);
        expect((await request(url, { ...options, account: other })).status).toBe(404);
        expect((await request(url, { ...options, csrf: false })).status).toBe(403);
        const attempts = await Promise.all([request(url, options), request(url, options)]);
        expect(attempts.map((response) => response.status)).toEqual([201, 201]);
        const [first, second] = await Promise.all(attempts.map((response) => response.json()));
        expect(first).toEqual(second);
        expect(first.runId).toEqual(expect.any(String));
        expect(await db.select().from(tasks).where(eq(tasks.userId, owner.id))).toHaveLength(1);
        const [run] = await db.select().from(runs).where(eq(runs.id, first.runId));
        expect(run).toMatchObject({
            taskId: first.detail.task.id,
            taskVersionId: first.detail.version.id,
            status: 'queued',
            mode: 'live',
        });
        const [membership] = await db
            .select()
            .from(projectTasks)
            .where(eq(projectTasks.taskId, run!.taskId));
        expect(membership).toMatchObject({ projectId: project.id });
        expect(
            await db.select().from(outbox).where(eq(outbox.aggregateId, first.runId)),
        ).toHaveLength(1);
        expect(
            await db.select().from(runEvents).where(eq(runEvents.runId, first.runId)),
        ).toMatchObject([{ type: 'run.queued', seq: 1 }]);
        expect((await request(url, { ...options, body: { ...body, start: false } })).status).toBe(
            409,
        );
        const saved = await request(url, {
            ...options,
            key: randomUUID(),
            body: { ...body, start: false },
        });
        expect(await saved.json()).toMatchObject({ runId: null });
        expect(await db.select().from(runs).where(eq(runs.userId, owner.id))).toHaveLength(1);
    });

    it('applies server idempotency to five unassigned task submissions', async () => {
        const owner = await seedAccount();
        const options = {
            account: owner,
            method: 'POST',
            body: { config: taskConfig },
            key: randomUUID(),
        };
        const url = '/api/v1/tasks';
        const responses = await Promise.all(Array.from({ length: 5 }, () => request(url, options)));
        expect(responses.map((response) => response.status)).toEqual([201, 201, 201, 201, 201]);
        const results = await Promise.all(responses.map((response) => response.json()));
        expect(results).toEqual(Array(5).fill(results[0]));
        const changed = { config: { ...taskConfig, title: '不同内容' } };
        expect((await request(url, { ...options, body: changed })).status).toBe(409);
        expect(await db.select().from(tasks).where(eq(tasks.userId, owner.id))).toHaveLength(1);
        expect(
            await db.select().from(taskVersions).where(eq(taskVersions.userId, owner.id)),
        ).toHaveLength(1);
        expect(
            await db.select().from(projectTasks).where(eq(projectTasks.userId, owner.id)),
        ).toHaveLength(0);
    });

    it('releases a task idempotency reservation on rollback so the same submission can succeed', async () => {
        const owner = await seedAccount();
        const agentProviderId = randomUUID();
        const options = {
            account: owner,
            method: 'POST',
            body: { config: { ...taskConfig, agentProviderId } },
            key: randomUUID(),
        };
        const url = '/api/v1/tasks';
        const unavailable = await request(url, options);
        expect(unavailable.status).toBe(422);
        expect(await db.select().from(tasks).where(eq(tasks.userId, owner.id))).toHaveLength(0);
        expect(
            await db
                .select()
                .from(idempotencyRecords)
                .where(eq(idempotencyRecords.userId, owner.id)),
        ).toHaveLength(0);

        await db.insert(agentProviders).values({
            id: agentProviderId,
            userId: owner.id,
            name: '项目测试配置',
            protocol: 'openai_json',
            baseUrl: 'https://example.test/v1',
            model: 'fixture',
            encryptedApiKey: 'fixture-encrypted',
        });
        const retried = await request(url, options);
        expect(retried.status).toBe(201);
        const result = await retried.json();
        expect(result.version.config.agentProviderId).toBe(agentProviderId);
        expect(await (await request(url, options)).json()).toEqual(result);
        expect(await db.select().from(tasks).where(eq(tasks.userId, owner.id))).toHaveLength(1);
        expect(
            await db
                .select()
                .from(idempotencyRecords)
                .where(eq(idempotencyRecords.userId, owner.id)),
        ).toMatchObject([
            { scope: 'task:create', status: 'completed', resourceId: result.task.id },
        ]);
    });
});

describe('project conversation', () => {
    async function reportFixture() {
        const owner = await seedAccount();
        const project = await createProject(owner, '问答控制');
        const task = await seedTask(owner.id, '报告任务');
        const { reportId } = await seedHistory(task);
        await request(membershipPath(project.id, task.id), { account: owner, method: 'PUT' });
        return {
            owner,
            project,
            url: `${path}/${project.id}/conversation`,
            body: { turnId: randomUUID(), kind: 'ask', message: '报告结论？', reportId },
        };
    }

    it.each(['question', 'draft'] as const)(
        'uses only the question budget when the %s budget is exhausted',
        async (exhausted) => {
            const { owner, url, body } = await reportFixture();
            let calls = 0;
            const services = testServices({
                taskDraftPolicy: { userRequests: 1 },
                reportQuestionPolicy: { userRequests: 1 },
                reportQuestionModel: () => ({
                    async generateStructured<T>(
                        _input: StructuredInput,
                        context: CallContext = {},
                    ) {
                        await context.beforeAttempt?.('model');
                        calls++;
                        return {
                            mode: 'live',
                            data: { answer: '测试回答' } as T,
                            usage: { inputTokens: 1, outputTokens: 1, estimated: false },
                        };
                    },
                }),
            });
            const budget =
                exhausted === 'question'
                    ? createQuestionBudgetRepo(services)
                    : createTaskDraftRepo(services);
            await budget.begin(owner.id, new AbortController().signal);
            const response = await request(`${url}/turns`, {
                account: owner,
                method: 'POST',
                body,
                server: createApiApp('node', services),
            });
            expect(response.status).toBe(200);
            expect(await response.json()).toMatchObject({
                turns: [
                    {
                        id: body.turnId,
                        status: exhausted === 'question' ? 'failed' : 'completed',
                        answer:
                            exhausted === 'question'
                                ? '报告问答额度已用尽，请稍后重试'
                                : '测试回答',
                    },
                ],
            });
            expect(calls).toBe(exhausted === 'question' ? 0 : 1);
        },
    );

    it.each([
        ['same-instance', 'ask'],
        ['another-instance', 'ask'],
        ['another-instance', 'draft'],
        ['timeout', 'ask'],
        ['deleted', 'ask'],
    ] as const)('stops the model and rejects late answers after %s (%s)', async (stop, kind) => {
        const { owner, project, url, body: question } = await reportFixture();
        const body = {
            ...question,
            kind,
            reportId: kind === 'ask' ? question.reportId : undefined,
        };
        const entered = Promise.withResolvers<AbortSignal>();
        const release = Promise.withResolvers<void>();
        const model: ModelProvider = {
            async generateStructured<T>(_input: StructuredInput, context: CallContext = {}) {
                await context.beforeAttempt?.('model');
                entered.resolve(context.signal!);
                await release.promise;
                return {
                    mode: 'live',
                    data: { answer: '迟到回答' } as T,
                    usage: { inputTokens: 1, outputTokens: 1, estimated: false },
                };
            },
        };
        const services = testServices({
            taskDraftPolicy: { timeoutMs: 10_000 },
            reportQuestionPolicy: { timeoutMs: stop === 'timeout' ? 600 : 10_000 },
            reportQuestionModel: () => model,
            taskDraftModel: () => model,
        });
        const server = createApiApp('node', services);
        const pending = request(`${url}/turns`, {
            account: owner,
            method: 'POST',
            body,
            server,
        });
        try {
            const signal = await Promise.race([
                entered.promise,
                pending.then(() => {
                    throw new Error('模型未启动');
                }),
            ]);
            const [running] = await db
                .select()
                .from(projectConversationTurns)
                .where(eq(projectConversationTurns.id, body.turnId));
            if (stop === 'deleted') {
                await db.delete(projects).where(eq(projects.id, project.id));
            } else if (stop !== 'timeout') {
                const canceled = await request(`${url}/turns/${body.turnId}/cancel`, {
                    account: owner,
                    method: 'POST',
                    server: stop === 'same-instance' ? server : createApiApp('node', services),
                });
                expect(await canceled.json()).toMatchObject({
                    turns: [{ status: 'canceled' }],
                });
            }
            await expect.poll(() => signal.aborted, { timeout: 2000 }).toBe(true);
            expect(running?.expiresAt.getTime()).toBe(
                now.getTime() + services.reportQuestionPolicy.timeoutMs + 5000,
            );
            const response = await pending;
            if (stop === 'deleted') expect(response.status).toBe(404);
            else
                expect(await response.json()).toMatchObject({
                    turns: [{ status: stop === 'timeout' ? 'failed' : 'canceled' }],
                    drafts: [],
                });
        } finally {
            release.resolve();
            await pending;
        }
        const rows = await db
            .select()
            .from(projectConversationTurns)
            .where(eq(projectConversationTurns.id, body.turnId));
        expect(rows.every((row) => row.answer !== '迟到回答')).toBe(true);
    });

    it('does not dispatch a model returned after another instance canceled the turn', async () => {
        const { owner, url, body } = await reportFixture();
        const entered = Promise.withResolvers<void>();
        const lookup = Promise.withResolvers<ModelProvider>();
        let calls = 0;
        const services = testServices({
            reportQuestionModel: () => {
                entered.resolve();
                return lookup.promise;
            },
        });
        const pending = request(`${url}/turns`, {
            account: owner,
            method: 'POST',
            body,
            server: createApiApp('node', services),
        });
        try {
            await Promise.race([
                entered.promise,
                pending.then(() => {
                    throw new Error('模型查找未启动');
                }),
            ]);
            await request(`${url}/turns/${body.turnId}/cancel`, {
                account: owner,
                method: 'POST',
                server: createApiApp('node', services),
            });
            expect(await (await pending).json()).toMatchObject({ turns: [{ status: 'canceled' }] });
        } finally {
            lookup.resolve({
                generateStructured() {
                    calls++;
                    throw new Error('取消后不应调用模型');
                },
            });
            await pending;
        }
        // Let the suspended lookup continuation run before asserting no outbound attempt.
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(calls).toBe(0);
    });

    it('reopens read-only answers and persists one draft shared by editor and confirmation', async () => {
        const owner = await seedAccount();
        const other = await seedAccount();
        const project = await createProject(owner, '会话项目');
        const base = `${path}/${project.id}`;
        const conversation = `${base}/conversation`;
        const post = (kind: string, message: string) => ({
            account: owner,
            method: 'POST',
            body: { turnId: randomUUID(), kind, message },
        });
        expect((await request(conversation, { account: other })).status).toBe(404);
        const asking = post('ask', '有哪些成果？');
        const asked = await request(`${conversation}/turns`, asking);
        expect(await asked.json()).toMatchObject({
            turns: [{ id: asking.body.turnId, status: 'completed' }],
            drafts: [],
        });
        expect(await db.select().from(tasks).where(eq(tasks.userId, owner.id))).toHaveLength(0);
        const drafting = post('draft', '查找开源许可证变化');
        const created = await request(`${conversation}/turns`, drafting);
        expect(created.status).toBe(200);
        const result = await created.json();
        expect(result.turns).toHaveLength(2);
        expect(result.drafts).toHaveLength(1);
        expect(await (await request(`${conversation}/turns`, drafting)).json()).toEqual(result);
        expect(await (await request(conversation, { account: owner })).json()).toEqual(result);
        const draft = result.drafts[0];
        const draftUrl = `${base}/drafts/${draft.id}`;
        const edit = { method: 'PATCH', account: owner, body: { config: taskConfig, revision: 1 } };
        expect((await request(draftUrl, { ...edit, account: other })).status).toBe(404);
        expect(await (await request(draftUrl, edit)).json()).toMatchObject({
            revision: 2,
            config: taskConfig,
        });
        expect((await request(draftUrl, edit)).status).toBe(409);
        const confirmUrl = `${draftUrl}/confirm`;
        const confirm = { method: 'POST', account: owner, body: { revision: 2, start: true } };
        expect(
            (await request(confirmUrl, { ...confirm, body: { ...confirm.body, revision: 1 } }))
                .status,
        ).toBe(409);
        const responses = await Promise.all([
            request(confirmUrl, confirm),
            request(confirmUrl, confirm),
        ]);
        expect(responses.map(({ status }) => status)).toEqual([200, 200]);
        const [first, second] = await Promise.all(responses.map((response) => response.json()));
        expect(first).toEqual(second);
        expect(first.detail.version.config).toEqual(taskConfig);
        expect(await (await request(conversation, { account: owner })).json()).toMatchObject({
            drafts: [{ id: draft.id, taskId: first.detail.task.id, runId: first.runId }],
        });
        expect(
            await db.select().from(outbox).where(eq(outbox.aggregateId, first.runId)),
        ).toHaveLength(1);
        expect(await db.select().from(tasks).where(eq(tasks.userId, owner.id))).toHaveLength(1);
        expect(await db.select().from(runs).where(eq(runs.userId, owner.id))).toHaveLength(1);
    });

    it.each([false, true])(
        'replays confirmed drafts after receipt deletion (start=%s)',
        async (start) => {
            const owner = await seedAccount();
            const other = await seedAccount();
            const project = await createProject(owner, '持久确认');
            const base = `${path}/${project.id}`;
            const drafted = await request(`${base}/conversation/turns`, {
                method: 'POST',
                account: owner,
                body: { turnId: randomUUID(), kind: 'draft', message: '跟踪开源许可证变化' },
            });
            expect(drafted.status).toBe(200);
            const {
                drafts: [draft],
            } = await drafted.json();
            const url = `${base}/drafts/${draft.id}/confirm`;
            const options = {
                account: owner,
                method: 'POST',
                body: { revision: draft.revision, start },
            };
            const submitted = await request(url, options);
            expect(submitted.status).toBe(200);
            const first = await submitted.json();
            const taskId = first.detail.task.id;
            expect(first.runId).toEqual(start ? expect.any(String) : null);
            const removed = await db
                .delete(idempotencyRecords)
                .where(eq(idempotencyRecords.userId, owner.id))
                .returning();
            expect(removed).toMatchObject([
                { scope: 'task:create', resourceId: first.runId ?? taskId },
            ]);

            const replay = await request(url, options);
            expect(replay.status).toBe(200);
            expect(await replay.json()).toEqual(first);
            expect((await request(url, { ...options, account: other })).status).toBe(404);
            expect(
                (await request(url, { ...options, body: { ...options.body, start: !start } }))
                    .status,
            ).toBe(409);

            const nextConfig = { ...first.detail.version.config, title: '任务后来编辑' };
            const taskUrl = `/api/v1/tasks/${taskId}`;
            const changed = await request(taskUrl, {
                method: 'PATCH',
                account: owner,
                revision: first.detail.task.revision,
                body: { config: nextConfig },
            });
            expect(changed.status).toBe(200);
            const current = await changed.json();
            expect(current.version.id).not.toBe(first.detail.version.id);
            const afterEdit = await request(url, options);
            expect(afterEdit.status).toBe(200);
            expect(await afterEdit.json()).toMatchObject({
                runId: first.runId,
                detail: {
                    task: {
                        id: taskId,
                        currentVersionId: first.detail.version.id,
                        revision: first.detail.task.revision,
                        title: first.detail.task.title,
                    },
                    version: first.detail.version,
                },
            });
            expect(await db.select().from(tasks).where(eq(tasks.userId, owner.id))).toHaveLength(1);
            expect(await db.select().from(runs).where(eq(runs.userId, owner.id))).toHaveLength(
                Number(start),
            );
            expect(await db.select().from(outbox).where(eq(outbox.userId, owner.id))).toHaveLength(
                Number(start),
            );

            const membership = membershipPath(project.id, taskId);
            expect((await request(membership, { method: 'DELETE', account: owner })).status).toBe(
                204,
            );
            expect((await request(url, options)).status).toBe(409);
            expect((await request(membership, { method: 'PUT', account: owner })).status).toBe(204);
            if (start) {
                await db.transaction(async (tx) => {
                    await tx.delete(outbox).where(eq(outbox.aggregateId, first.runId));
                    await tx.delete(runEvents).where(eq(runEvents.runId, first.runId));
                    await tx.delete(runs).where(eq(runs.id, first.runId));
                });
                expect((await request(url, options)).status).toBe(404);
            }
            const removedTask = await request(taskUrl, {
                method: 'DELETE',
                account: owner,
                revision: current.task.revision,
            });
            expect(removedTask.status).toBe(204);
            expect((await request(url, options)).status).toBe(404);
            expect(await db.select().from(tasks).where(eq(tasks.userId, owner.id))).toHaveLength(0);
            expect(await db.select().from(runs).where(eq(runs.userId, owner.id))).toHaveLength(0);
            expect(
                await db
                    .select()
                    .from(idempotencyRecords)
                    .where(eq(idempotencyRecords.userId, owner.id)),
            ).toHaveLength(0);
        },
    );

    it('keeps a pending draft accessible beyond turn history and retains its revision on failed changes', async () => {
        const owner = await seedAccount();
        const project = await createProject(owner, '草案恢复');
        const url = `${path}/${project.id}/conversation`;
        const post = (message: string, target?: { id: string; revision: number }) =>
            request(`${url}/turns`, {
                method: 'POST',
                account: owner,
                body: { turnId: randomUUID(), kind: 'draft', message, target },
            });
        const first = await (await post('建立可编辑的初始草案')).json();
        const [draft] = first.drafts;
        await db.insert(projectConversationTurns).values(
            Array.from({ length: 40 }, (_, index) => ({
                id: randomUUID(),
                userId: owner.id,
                projectId: project.id,
                input: { kind: 'ask' as const, message: '后续问题' },
                status: 'completed' as const,
                createdAt: new Date(now.getTime() + index + 1),
                expiresAt: now,
            })),
        );
        const reopened = await (await request(url, { account: owner })).json();
        expect(reopened.turns).toHaveLength(40);
        expect(reopened.turns.every((turn: { draftId: string | null }) => !turn.draftId)).toBe(
            true,
        );
        expect(reopened.drafts).toEqual([draft]);
        // Clear the newer fixture turns so the subsequent request stays visible under the fixed test clock.
        await db
            .delete(projectConversationTurns)
            .where(eq(projectConversationTurns.projectId, project.id));
        const target = { id: draft.id, revision: draft.revision };
        const revised = await (await post('扩大研究范围', target)).json();
        expect(revised.turns).toMatchObject([{ status: 'failed', target }]);
        expect(revised.drafts).toEqual([draft]);
    });

    it('allows one active turn, cancels without publishing a draft, and expires abandoned turns', async () => {
        const owner = await seedAccount();
        const project = await createProject(owner, '轮次控制');
        const url = `${path}/${project.id}/conversation`;
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<null>();
        draftLookups.set(owner.id, () => {
            entered.resolve();
            return release.promise;
        });
        const turnId = randomUUID();
        const first = {
            method: 'POST',
            account: owner,
            body: { turnId, kind: 'draft', message: '暂时阻塞的模型请求' },
        };
        const pending = request(`${url}/turns`, first);
        try {
            await Promise.race([
                entered.promise,
                pending.then(() => {
                    throw new Error('轮次未进入模型选择');
                }),
            ]);
            expect(await (await request(url, { account: owner })).json()).toMatchObject({
                turns: [{ id: turnId, status: 'running' }],
                drafts: [],
            });
            expect(
                (
                    await request(`${url}/turns`, {
                        ...first,
                        body: { ...first.body, turnId: randomUUID() },
                    })
                ).status,
            ).toBe(409);
            expect(
                await (
                    await request(`${url}/turns/${turnId}/cancel`, {
                        method: 'POST',
                        account: owner,
                    })
                ).json(),
            ).toMatchObject({
                turns: [{ id: turnId, status: 'canceled' }],
                drafts: [],
            });
        } finally {
            draftLookups.delete(owner.id);
            release.resolve(null);
        }
        expect(await (await pending).json()).toMatchObject({
            turns: [{ id: turnId, status: 'canceled' }],
            drafts: [],
        });
        const abandoned = randomUUID();
        await db.insert(projectConversationTurns).values({
            id: abandoned,
            userId: owner.id,
            projectId: project.id,
            input: { kind: 'ask', message: '进程退出前的轮次' },
            status: 'running',
            createdAt: new Date(now.getTime() - 2000),
            expiresAt: new Date(now.getTime() - 1000),
        });
        const next = randomUUID();
        expect(
            await (
                await request(`${url}/turns`, {
                    ...first,
                    body: { turnId: next, kind: 'ask', message: '重新打开并提问' },
                })
            ).json(),
        ).toMatchObject({
            turns: expect.arrayContaining([
                expect.objectContaining({ id: abandoned, status: 'failed' }),
                expect.objectContaining({ id: next, status: 'completed' }),
            ]),
        });
    });

    it('applies a targeted model revision to the same draft while retaining its manually configured fields', async () => {
        const owner = await seedAccount();
        const project = await createProject(owner, '定向草案调整');
        const base = `${path}/${project.id}`;
        const turn = (message: string, target?: { id: string; revision: number }) =>
            request(`${base}/conversation/turns`, {
                method: 'POST',
                account: owner,
                body: { turnId: randomUUID(), kind: 'draft', message, target },
            });
        const first = await (await turn('草拟许可证研究')).json();
        const [draft] = first.drafts;
        const manual = {
            ...taskConfig,
            searchMode: 'searxng',
            sourcePreferences: {
                ...taskConfig.sourcePreferences,
                preferredUrls: ['https://example.org/releases'],
            },
            schedule: { frequency: 'weekly', localTime: '09:00', weekday: 1 },
        };
        const saved = await request(`${base}/drafts/${draft.id}`, {
            method: 'PATCH',
            account: owner,
            body: { revision: 1, config: manual },
        });
        expect(saved.status).toBe(200);
        const goal = '只追踪许可证义务变化';
        let input: StructuredInput | undefined;
        draftLookups.set(owner.id, () => ({
            async generateStructured<T>(request: StructuredInput, context: CallContext = {}) {
                input = request;
                await context.beforeAttempt?.('model');
                return {
                    data: { goal } as T,
                    mode: 'live',
                    usage: { inputTokens: 100, outputTokens: 100, estimated: false },
                };
            },
        }));
        try {
            const target = { id: draft.id, revision: 2 };
            const result = await (await turn(goal, target)).json();
            expect(input?.untrustedSources?.[0]).toMatchObject({ defaults: manual });
            expect(result.turns).toContainEqual(
                expect.objectContaining({ status: 'completed', draftId: draft.id, target }),
            );
            expect(result.drafts).toMatchObject([
                { id: draft.id, revision: 3, config: { ...manual, goal } },
            ]);
            expect(await db.select().from(tasks).where(eq(tasks.userId, owner.id))).toHaveLength(0);
        } finally {
            draftLookups.delete(owner.id);
        }
    });

    it('rejects report references after the task is moved out of the project', async () => {
        const owner = await seedAccount();
        const first = await createProject(owner, '报告原项目');
        const second = await createProject(owner, '报告新项目');
        const task = await seedTask(owner.id, '报告任务');
        const { reportId } = await seedHistory(task);
        await request(membershipPath(first.id, task.id), { account: owner, method: 'PUT' });
        const url = `${path}/${first.id}/conversation`;
        const ask = {
            account: owner,
            method: 'POST',
            body: { turnId: randomUUID(), kind: 'ask', message: '报告的结论？', reportId },
        };
        expect(await (await request(`${url}/turns`, ask)).json()).toMatchObject({
            turns: [{ answer: '摘要', reportId }],
        });
        await request(membershipPath(second.id, task.id), { account: owner, method: 'PUT' });
        expect(await (await request(url, { account: owner })).json()).toMatchObject({
            turns: [{ answer: '原引用报告已移出项目。', reportId: null }],
        });
        expect(
            (await request(`${url}/turns`, { ...ask, body: { ...ask.body, turnId: randomUUID() } }))
                .status,
        ).toBe(404);
    });
});
