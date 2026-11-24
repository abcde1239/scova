import { randomBytes, randomUUID } from 'node:crypto';
import {
    and,
    eq,
    idempotencyRecords,
    projectResearchDrafts,
    projects,
    projectThreads,
    projectThreadItems,
    sessions,
    users,
} from '@scova/db';
import type { WorkspaceHome, WorkspaceIntakeInput, WorkspaceIntakeResult } from '@scova/models';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { createApiApp } from '@/app';
import { createDefaultServices } from '@/app/services';
import { appendProjectThreadItems } from '@/repo/project-threads';
import { csrfForSession, tokenHash } from '@/utils/security';
import { outboxDatabase } from '../../worker/tests/support/outbox-database';

const fixture = outboxDatabase();
const { db } = fixture;
const origin = 'https://scova.test';
const services = createDefaultServices({
    db: () => db,
    origin,
    reportQuestionModel: () => null,
    taskDraftModel: () => null,
});
const app = createApiApp('node', services).compile();

beforeAll(() => fixture.setup(), 120_000);
afterAll(async () => {
    try {
        await services.close();
    } finally {
        await fixture.cleanup();
    }
});

async function account() {
    const id = randomUUID();
    const email = `${id}@example.test`;
    const token = randomBytes(32).toString('base64url');
    const csrf = csrfForSession(token);
    await db.insert(users).values({ id, email, normalizedEmail: email, passwordHash: 'fixture' });
    await db.insert(sessions).values({
        userId: id,
        tokenHash: tokenHash(token),
        csrfTokenHash: tokenHash(csrf),
        expiresAt: new Date(Date.now() + 600_000),
    });
    return { id, cookie: `scova_session=${token}`, csrf };
}

type Account = Awaited<ReturnType<typeof account>>;

function request(path: string, owner?: Account, body?: unknown, key?: string, csrf = true) {
    const headers = new Headers({ origin });
    if (owner) headers.set('cookie', owner.cookie);
    if (body !== undefined) {
        headers.set('content-type', 'application/json');
        if (owner && csrf) headers.set('x-csrf-token', owner.csrf);
    }
    if (key) headers.set('idempotency-key', key);
    return app.handle(
        new Request(`${origin}/api/v1/${path}`, {
            headers,
            method: body === undefined ? 'GET' : 'POST',
            body: body === undefined ? undefined : JSON.stringify(body),
        }),
    );
}

async function read<T>(response: Response, expected = 200): Promise<T> {
    const result: unknown = await response.json();
    expect(response.status, JSON.stringify(result)).toBe(expected);
    return result as T;
}

function intake(owner: Account, body: WorkspaceIntakeInput, key = randomUUID()) {
    return request('workspace/intake', owner, body, key);
}

async function project(owner: Account, name: string) {
    const [row] = await db.insert(projects).values({ userId: owner.id, name }).returning();
    return row!;
}

function ready(result: WorkspaceIntakeResult) {
    if (result.kind !== 'ready') throw new Error(`Unexpected ${result.kind} receipt`);
    return result;
}

describe('workspace intake API', () => {
    it('allows only authenticated orders with a CSRF token and an idempotency key', async () => {
        const owner = await account();
        const body = {
            message: '研究新项目',
            destination: { kind: 'new-project', name: '安全边界' },
        };
        const anonymous = await request('workspace/home');
        expect(anonymous.status).toBe(401);
        expect(anonymous.headers.get('cache-control')).toBe('no-store');
        expect((await request('workspace/intake', owner, body, randomUUID(), false)).status).toBe(
            403,
        );
        expect((await request('workspace/intake', owner, body)).status).toBe(422);
        const oversize = { ...body, message: 'A'.repeat(2001) };
        expect((await request('workspace/intake', owner, oversize, randomUUID())).status).toBe(422);
        expect(await db.select().from(projects).where(eq(projects.userId, owner.id))).toHaveLength(
            0,
        );
    });

    it('routes only to the owner’s deterministically matched projects', async () => {
        const owner = await account();
        const other = await account();
        const a = await project(owner, '欧盟 AI 法规');
        const b = await project(other, a.name);
        const c = await project(other, '竞品定价观察');
        const r = ready(
            await read<WorkspaceIntakeResult>(
                await intake(owner, {
                    message: '请更新欧盟 AI 法规本周变化',
                    destination: { kind: 'auto' },
                }),
            ),
        );
        expect(r.projectId).toBe(a.id);
        expect(r.threadId).toEqual(expect.any(String));
        const choose = await read<WorkspaceIntakeResult>(
            await intake(owner, {
                message: c.name,
                destination: { kind: 'auto' },
            }),
        );
        expect(choose).toEqual({
            kind: 'choose-project',
            candidates: [{ id: a.id, name: a.name }],
        });
        const explicit = await intake(owner, {
            message: '查看报告',
            destination: { kind: 'project', projectId: b.id },
        });
        expect(explicit.status).toBe(404);
        expect(
            await db.select().from(projectThreads).where(eq(projectThreads.userId, other.id)),
        ).toHaveLength(0);
    });

    it('keeps ambiguous or missing matches side-effect-free and permits choosing an existing project', async () => {
        const owner = await account();
        const input = {
            message: '对比Alpha和Beta的变化',
            destination: { kind: 'auto' },
        } as const;
        const key = randomUUID();
        expect(await read(await intake(owner, input, key))).toEqual({
            kind: 'choose-project',
            candidates: [],
        });
        const a = await project(owner, 'Alpha');
        const b = await project(owner, 'Beta');
        const result = await read<WorkspaceIntakeResult>(await intake(owner, input, key));
        expect(result.kind).toBe('choose-project');
        if (result.kind !== 'choose-project') throw new Error('expected project choice');
        expect(result.candidates.map(({ id }) => id)).toEqual(expect.arrayContaining([a.id, b.id]));
        expect(
            await db.select().from(projectThreads).where(eq(projectThreads.userId, owner.id)),
        ).toHaveLength(0);
        const selection = ready(
            await read<WorkspaceIntakeResult>(
                await intake(
                    owner,
                    {
                        message: input.message,
                        destination: { kind: 'project', projectId: b.id },
                    },
                    key,
                ),
            ),
        );
        expect(selection.projectId).toBe(b.id);
    });

    it('requires a selection when the message explicitly excludes the one named project', async () => {
        const owner = await account();
        await intake(owner, {
            message: '初始会话',
            destination: { kind: 'new-project', name: '电池研究' },
        });
        expect(
            await read(
                await intake(owner, {
                    message: '不要在『电池研究』项目里开始，先让我选择',
                    destination: { kind: 'auto' },
                }),
            ),
        ).toMatchObject({ kind: 'choose-project' });
        expect(
            await db.select().from(projectThreads).where(eq(projectThreads.userId, owner.id)),
        ).toHaveLength(1);
    });

    it('atomically replays new project, thread, and first-turn identity across concurrent submissions', async () => {
        const owner = await account();
        const input = {
            message: '你好',
            destination: { kind: 'new-project', name: '  新项目  ' },
        } as const;
        const key = randomUUID();
        const [response, retry] = await Promise.all([
            intake(owner, input, key),
            intake(owner, input, key),
        ]);
        const first = ready(await read<WorkspaceIntakeResult>(response));
        expect(await read(retry)).toEqual(first);
        expect((await intake(owner, { ...input, message: '不同输入' }, key)).status).toBe(409);
        const owned = await db.select().from(projects).where(eq(projects.userId, owner.id));
        expect(owned.map(({ id, name }) => ({ id, name }))).toEqual([
            { id: first.projectId, name: '新项目' },
        ]);
        expect(
            await db.select().from(projectThreads).where(eq(projectThreads.userId, owner.id)),
        ).toHaveLength(1);
        expect(
            await db
                .select()
                .from(idempotencyRecords)
                .where(
                    and(
                        eq(idempotencyRecords.userId, owner.id),
                        eq(idempotencyRecords.scope, 'workspace:intake'),
                    ),
                ),
        ).toHaveLength(1);
        const turn = { turnId: first.turnId, message: input.message };
        const turnPath = `threads/${first.threadId}/turns`;
        expect(await read(await request(turnPath, owner, turn))).toMatchObject({
            turnId: first.turnId,
        });
        expect(await read(await request(turnPath, owner, turn))).toMatchObject({
            turnId: first.turnId,
        });
        const snapshot = await read<{ items: { payload: { role?: string } }[] }>(
            await request(`threads/${first.threadId}`, owner),
        );
        expect(snapshot.items.filter(({ payload }) => payload.role === 'user')).toHaveLength(1);
    });

    it('returns recent activity and only current, actionable plans across the owner’s projects', async () => {
        const owner = await account();
        const other = await account();
        const route = async (user: Account, name: string) =>
            ready(
                await read<WorkspaceIntakeResult>(
                    await intake(user, {
                        message: '研究需求',
                        destination: { kind: 'new-project', name },
                    }),
                ),
            );
        const older = await route(owner, '较早项目');
        const newer = await route(owner, '较近项目');
        const foreign = await route(other, '其他账号项目');
        async function addPlan(
            user: Account,
            target: typeof older,
            actionRevision: number,
            createdAt: Date,
        ) {
            const draftId = randomUUID();
            await db.insert(projectResearchDrafts).values({
                id: draftId,
                userId: user.id,
                projectId: target.projectId,
                threadId: target.threadId,
                revision: 2,
                config: {} as never,
            });
            await db.transaction((tx) =>
                appendProjectThreadItems(
                    tx,
                    user.id,
                    target.threadId,
                    [
                        {
                            kind: 'plan',
                            status: 'pending',
                            payload: { command: 'start_run', draftId, revision: actionRevision },
                        },
                    ],
                    createdAt,
                ),
            );
        }
        const now = Date.now();
        await addPlan(owner, older, 2, new Date(now + 2000));
        await addPlan(owner, newer, 1, new Date(now + 1000));
        await addPlan(other, foreign, 2, new Date(now + 3000));
        const scheduleId = randomUUID();
        await db.transaction((tx) =>
            appendProjectThreadItems(
                tx,
                owner.id,
                newer.threadId,
                [
                    {
                        id: scheduleId,
                        kind: 'schedule',
                        status: 'pending',
                        payload: { command: 'create_schedule' },
                    },
                ],
                new Date(now + 500),
            ),
        );
        const response = await request('workspace/home', owner);
        expect(response.headers.get('cache-control')).toBe('private, no-store');
        const home = await read<WorkspaceHome>(response);
        expect(home.recentProjects.map(({ id }) => id)).toEqual([older.projectId, newer.projectId]);
        expect(home.pending).toEqual([
            expect.objectContaining({ projectId: older.projectId, threadId: older.threadId }),
            expect.objectContaining({ id: scheduleId, projectId: newer.projectId }),
        ]);
        await db
            .update(projectThreads)
            .set({ archivedAt: new Date() })
            .where(eq(projectThreads.id, older.threadId));
        expect(
            (await read<WorkspaceHome>(await request('workspace/home', owner))).pending,
        ).toMatchObject([{ id: scheduleId }]);
        await db
            .update(projectThreadItems)
            .set({ status: 'applied' })
            .where(eq(projectThreadItems.id, scheduleId));
        expect((await read<WorkspaceHome>(await request('workspace/home', owner))).pending).toEqual(
            [],
        );
    });
});
