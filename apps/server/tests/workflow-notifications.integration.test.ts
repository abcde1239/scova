import { randomBytes, randomUUID } from 'node:crypto';
import { eq, sql as querySql } from '@scova/db';
import * as tables from '@scova/db';
import type { LegacyWorkflowGraph } from '@scova/models';
import { afterAll, beforeAll, expect, it } from 'vite-plus/test';
import { createApiApp } from '../src/app/index.ts';
import { createDefaultServices } from '../src/app/services.ts';
import { insertWorkflowNotification } from '../src/repo/workflow-notifications.ts';
import { firstRow, requireRow } from '../src/utils/database.ts';
import { tokenHash } from '../src/utils/security.ts';
import { outboxDatabase } from '../../worker/tests/support/outbox-database.ts';

const fixture = outboxDatabase();
const db = fixture.db;
const origin = 'https://workflow-notifications.test';
const now = new Date();
const app = createApiApp('node', createDefaultServices({ db: () => db, origin, clock: () => now }));
const json = async (response: Response) => (await response.json()) as Record<string, any>;
const request = (path: string, init: RequestInit) =>
    app.handle(new Request(`${origin}/api/v1${path}`, init));
const headers = (auth: { cookie: string; csrf: string }) => ({
    origin,
    cookie: auth.cookie,
    'x-csrf-token': auth.csrf,
    'content-type': 'application/json',
});

beforeAll(() => fixture.setup(), 120_000);
afterAll(() => fixture.cleanup());

async function account(id: string) {
    const token = randomBytes(32).toString('base64url');
    const csrf = randomBytes(32).toString('base64url');
    await db.insert(tables.sessions).values({
        userId: id,
        tokenHash: tokenHash(token),
        csrfTokenHash: tokenHash(csrf),
        expiresAt: new Date(now.getTime() + 3_600_000),
    });
    return { id, cookie: `scova_session=${token}`, csrf };
}

it('paginates research and workflow notices together, persists read state, and isolates owners', async () => {
    const { aggregateId: researchRunId } = await fixture.seed(now);
    const seed = await db.query.runs.findFirst({ where: eq(tables.runs.id, researchRunId) });
    const researchRun = requireRow(seed);
    const owner = await account(researchRun.userId);
    const other = await account((await fixture.seed()).userId);
    await db
        .update(tables.runs)
        .set({ status: 'failed', finishedAt: now })
        .where(eq(tables.runs.id, researchRun.id));
    const research = await db
        .insert(tables.notifications)
        .values({
            userId: researchRun.userId,
            runId: researchRun.id,
            kind: 'run_issue',
            createdAt: now,
        })
        .returning()
        .then(firstRow);
    const graph: LegacyWorkflowGraph = {
        nodes: [
            { id: 'start', type: 'start' },
            { id: 'end', type: 'end' },
        ],
        edges: [{ from: { nodeId: 'start', port: 'out' }, to: { nodeId: 'end', port: 'in' } }],
    };
    const workflow = await db
        .insert(tables.workflows)
        .values({
            userId: owner.id,
            title: '通知测试',
            draftJson: graph,
        })
        .returning()
        .then(firstRow);
    const version = await db
        .insert(tables.workflowVersions)
        .values({
            userId: owner.id,
            workflowId: workflow.id,
            title: workflow.title,
            version: 1,
            draftRevision: 1,
            graphJson: workflow.draftJson,
            bindingsJson: [],
        })
        .returning()
        .then(firstRow);
    const run = (preview = false) =>
        db
            .insert(tables.workflowRuns)
            .values({
                userId: owner.id,
                workflowId: workflow.id,
                versionId: version.id,
                mode: 'demo',
                preview,
                nodesJson: [],
                startKeyHash: randomUUID(),
            })
            .returning()
            .then(firstRow);
    const first = await run();
    const second = await run();
    const preview = await run(true);
    const delivery = {
        userId: owner.id,
        workflowRunId: first.id,
        nodeId: 'notify',
        artifactNodeId: 'deliver',
        title: '周报已生成',
        body: '请查看本周周报。',
        createdAt: new Date('2026-01-01T00:00:00.123Z'),
    };
    const insert = (input = delivery) =>
        db.transaction((tx) => insertWorkflowNotification(tx, input));
    await expect(insert({ ...delivery, workflowRunId: preview.id })).rejects.toThrow();
    await expect(insert({ ...delivery, userId: other.id })).rejects.toThrow();
    await expect(
        db.insert(tables.workflowNotifications).values({ ...delivery, userId: other.id }),
    ).rejects.toThrow();
    await expect(
        db.transaction(async (tx) => {
            await insertWorkflowNotification(tx, { ...delivery, nodeId: 'rolled-back' });
            throw new Error('checkpoint rolled back');
        }),
    ).rejects.toThrow('checkpoint rolled back');
    const [id, retryId] = await Promise.all([insert(), insert()]);
    expect(retryId).toBe(id);
    expect(await insert({ ...delivery, title: '不会覆盖正文' })).toBe(id);
    const nextId = await insert({ ...delivery, workflowRunId: second.id });
    expect(nextId).not.toBe(id);

    const researchId = research.id;
    await db.execute(
        querySql`UPDATE workflow_notifications SET created_at = '2026-01-01T00:00:00.123900Z' WHERE id = ${id}::uuid`,
    );
    await db.execute(
        querySql`UPDATE notifications SET created_at = '2026-01-01T00:00:00.123500Z' WHERE id = ${researchId}::uuid`,
    );
    const list = (query: string, auth = owner) =>
        request(`/notifications${query}`, { headers: headers(auth) });
    const firstPage = await list('?unread=true&limit=1');
    expect(firstPage.status).toBe(200);
    const page = await json(firstPage);
    expect(page.items).toEqual([
        {
            id,
            kind: 'workflow',
            workflowRunId: first.id,
            nodeId: 'notify',
            artifactNodeId: 'deliver',
            title: delivery.title,
            body: delivery.body,
            readAt: null,
            createdAt: delivery.createdAt.toISOString(),
        },
    ]);
    const patch = (read: boolean, auth = owner) =>
        request(`/notifications/${id}`, {
            method: 'PATCH',
            headers: headers(auth),
            body: JSON.stringify({ read }),
        });
    expect((await patch(true, other)).status).toBe(404);
    const marked = await patch(true);
    expect(marked.status).toBe(200);
    expect((await json(marked)).readAt).toBe(now.toISOString());
    const remainingQuery = `?unread=true&cursor=${encodeURIComponent(page.nextCursor)}`;
    expect((await list(remainingQuery, other)).status).toBe(400);
    expect(
        (await json(await list(remainingQuery))).items.map((item: { id: string }) => item.id),
    ).toEqual([researchId, nextId]);
    expect(
        (await json(await list('?kind=workflow&unread=false'))).items.map(
            (item: { id: string }) => item.id,
        ),
    ).toEqual([id]);
    expect((await json(await patch(false))).readAt).toBeNull();
    expect(
        (await json(await list('?kind=workflow'))).items.map((item: { id: string }) => item.id),
    ).toEqual([id, nextId]);
    expect((await json(await list('?kind=workflow', other))).items).toEqual([]);
});
