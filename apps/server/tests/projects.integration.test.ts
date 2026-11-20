import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import {
    closeDatabase,
    createDatabaseClient,
    eq,
    projectTasks,
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
import { createDefaultServices } from '@/app/services';
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
const app = createApiApp('node', createDefaultServices({ db: () => db, clock: () => now, origin }));
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
    }: {
        account?: Account;
        method?: string;
        body?: unknown;
        csrf?: boolean;
    } = {},
) {
    const headers = new Headers({ origin });
    if (account) {
        headers.set('cookie', account.cookie);
        if (csrf) headers.set('x-csrf-token', account.csrfToken);
    }
    if (body !== undefined) headers.set('content-type', 'application/json');
    return app.handle(
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
    await admin.query(scopeMigrationSql(migrations[projectMigration]!.sql, schema));
}, 120_000);

afterAll(async () => {
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
            recentRuns: [],
            recentReports: [],
        });
        const older = await seedTask(owner.id, '较早任务');
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
