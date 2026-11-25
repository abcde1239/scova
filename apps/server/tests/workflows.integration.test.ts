import { testWorkerExecution } from '../../worker/tests/support/worker-execution.ts';
import { prepareTestCheckpointSchema } from '../../worker/tests/support/checkpoint-schema.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import {
    closeDatabase,
    createDatabaseClient,
    eq,
    outbox,
    runs,
    runEvents,
    sessions,
    tasks,
    taskVersions,
    users,
    workflowRuns,
    workflowNotifications,
} from '@scova/db';
import { migrateDatabase } from '@scova/db/migrate';
import {
    parseContract,
    TaskConfigSchema,
    WorkflowDetailSchema,
    WorkflowRunSchema,
    WorkflowStartResponseSchema,
    WorkflowVersionListSchema,
    type LegacyWorkflowGraph,
    type WorkflowCanvasGraph,
} from '@scova/models';
import { createApiApp } from '@/app/index.ts';
import { createRunControl } from '@/app/run-control.ts';
import { readRunControlConfig } from '@/app/run-control-config.ts';
import { createDefaultServices } from '@/app/services.ts';
import { createWorkflowBatch } from '@/service/workflow-batch.ts';
import { tokenHash } from '@/utils/security.ts';
import { createWorkerApp } from '../../worker/src/app/index.ts';

const origin = 'https://scova.test';
const workflowsPath = '/api/v1/workflows';
const runPath = '/api/v1/workflow-runs';
const baseUrl =
    process.env.SCOVA_TEST_DATABASE_URL ??
    'postgresql://scova_test:scova_test@127.0.0.1:55432/scova_test';
const redisUrl = process.env.SCOVA_TEST_REDIS_URL ?? 'redis://127.0.0.1:56379';
const namespace = `scova_workflow_${randomUUID().replaceAll('-', '')}`;
const scopedUrl = new URL(baseUrl);
scopedUrl.searchParams.set('schema', namespace);
const databaseUrl = scopedUrl.toString();
const db = createDatabaseClient({ connectionString: databaseUrl });
const admin = new pg.Client({ connectionString: baseUrl });
const services = createDefaultServices({ db: () => db, origin });
const app = createApiApp('node', services);
const signal = new AbortController().signal;
let schemaCreated = false;

const config = parseContract(TaskConfigSchema, {
    title: '研究英语材料',
    topic: '英语材料',
    goal: '找到带字幕的免费材料',
    focusPoints: ['字幕'],
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
});

async function account() {
    const email = `${randomUUID()}@example.test`;
    const [user] = await db
        .insert(users)
        .values({ email, normalizedEmail: email, passwordHash: 'workflow-test-fixture' })
        .returning();
    const token = randomBytes(32).toString('base64url');
    const csrf = randomBytes(32).toString('base64url');
    await db.insert(sessions).values({
        userId: user!.id,
        tokenHash: tokenHash(token),
        csrfTokenHash: tokenHash(csrf),
        expiresAt: new Date(Date.now() + 3_600_000),
    });
    return { id: user!.id, token, csrf };
}
type Account = Awaited<ReturnType<typeof account>>;

async function addVersion(userId: string, taskId: string, version: number) {
    const [stored] = await db
        .insert(taskVersions)
        .values({
            userId,
            taskId,
            version,
            comparisonScopeHash: 'a'.repeat(64),
            configJson: { ...config, goal: `${config.goal}版本 ${version}` },
        })
        .returning();
    await db.update(tasks).set({ currentVersionId: stored!.id }).where(eq(tasks.id, taskId));
    return stored!.id;
}
async function task(userId: string, withConfig = true) {
    const [stored] = await db.insert(tasks).values({ userId, title: config.title }).returning();
    const id = stored!.id;
    return { id, version: withConfig ? await addVersion(userId, id, 1) : null };
}
function graph(...taskIds: string[]): LegacyWorkflowGraph {
    const nodes: LegacyWorkflowGraph['nodes'] = [
        { id: 'start', type: 'start' },
        ...taskIds.map((taskId, index) => ({
            id: `study_${index}`,
            type: 'study' as const,
            taskId,
        })),
        { id: 'end', type: 'end' },
    ];
    const edges: LegacyWorkflowGraph['edges'] = nodes.slice(1).map((node, index) => ({
        from: { nodeId: nodes[index]!.id, port: 'out' },
        to: { nodeId: node.id, port: 'in' },
    }));
    return { nodes: nodes.reverse(), edges: edges.reverse() };
}
function request(
    path: string,
    user?: Account,
    method = 'GET',
    body?: unknown,
    extra: Record<string, string> = {},
) {
    const headers = new Headers(extra);
    if (user) {
        headers.set('cookie', `scova_session=${user.token}`);
        headers.set('origin', origin);
        if (!headers.has('x-csrf-token')) headers.set('x-csrf-token', user.csrf);
    }
    if (body !== undefined) headers.set('content-type', 'application/json');
    return app.handle(
        new Request(`${origin}${path}`, {
            method,
            headers,
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
    );
}
async function create(user: Account, graph: LegacyWorkflowGraph | WorkflowCanvasGraph) {
    const response = await request(workflowsPath, user, 'POST', { title: '研究工作流', graph });
    expect(response.status).toBe(201);
    expect(response.headers.get('etag')).toBe('"1"');
    return parseContract(WorkflowDetailSchema, await response.json());
}
async function publish(user: Account, workflowId: string, revision = 1) {
    const response = await request(
        `${workflowsPath}/${workflowId}/publish`,
        user,
        'POST',
        undefined,
        { 'if-match': `"${revision}"` },
    );
    expect(response.status).toBe(200);
    return parseContract(WorkflowDetailSchema, await response.json()).publishedVersion!;
}
async function start(user: Account, workflowId: string, versionId: string, key = randomUUID()) {
    const response = await request(
        `${workflowsPath}/${workflowId}/runs`,
        user,
        'POST',
        { versionId, mode: 'live' },
        { 'idempotency-key': key },
    );
    expect(response.status).toBe(202);
    return parseContract(WorkflowStartResponseSchema, await response.json());
}
async function get(user: Account, id: string) {
    const response = await request(`${runPath}/${id}`, user);
    expect(response.status).toBe(200);
    return parseContract(WorkflowRunSchema, await response.json());
}

beforeAll(async () => {
    await admin.connect();
    await migrateDatabase({ connectionString: databaseUrl });
    schemaCreated = true;
});
afterAll(async () => {
    await services.close();
    await closeDatabase(db);
    try {
        if (schemaCreated) await admin.query(`DROP SCHEMA "${namespace}" CASCADE`);
    } finally {
        await admin.end();
    }
});

describe('工作流 HTTP、PostgreSQL 与研究队列', () => {
    it('要求会话、CSRF、图完整性、研究任务归属和有效配置', async () => {
        const [owner, stranger] = await Promise.all([account(), account()]);
        const foreignTask = await task(stranger.id);
        const missingConfig = await task(owner.id, false);
        const noCsrf = await request(
            workflowsPath,
            owner,
            'POST',
            { title: '研究工作流', graph: graph(foreignTask.id) },
            { 'x-csrf-token': 'wrong' },
        );
        expect(noCsrf.status).toBe(403);
        expect((await request(workflowsPath)).status).toBe(401);
        const foreign = await create(owner, graph(foreignTask.id));
        const absent = await create(owner, graph(missingConfig.id));
        const invalid = await create(owner, { nodes: [], edges: [] });
        expect((await request(`${workflowsPath}/${foreign.workflow.id}`, stranger)).status).toBe(
            404,
        );
        for (const [id, status, code] of [
            [foreign.workflow.id, 404, 'NOT_FOUND'],
            [absent.workflow.id, 422, 'TASK_VERSION_MISSING'],
            [invalid.workflow.id, 422, 'WORKFLOW_INVALID_GRAPH'],
        ] as const) {
            const response = await request(
                `${workflowsPath}/${id}/publish`,
                owner,
                'POST',
                undefined,
                { 'if-match': '"1"' },
            );
            expect(response.status).toBe(status);
            expect(await response.json()).toMatchObject({ code });
        }
        const list = await request(`${workflowsPath}?limit=2`, owner);
        expect(list.status).toBe(200);
        const listing = (await list.json()) as { items: { id: string }[]; nextCursor: string };
        expect(listing.items).toHaveLength(2);
        const next = await request(`${workflowsPath}?limit=2&cursor=${listing.nextCursor}`, owner);
        expect(await next.json()).toMatchObject({
            items: [{ id: foreign.workflow.id }],
            nextCursor: null,
        });
    });

    it('冻结版本，原子重放启动，在重建批次后复用完成节点且避免重复入队', async () => {
        const owner = await account();
        const [first, second] = await Promise.all([task(owner.id), task(owner.id)]);
        const draft = await create(owner, graph(first.id, second.id));
        const id = draft.workflow.id;
        const pinned = await publish(owner, id);
        expect((await publish(owner, id)).id).toBe(pinned.id);
        const secondTaskVersion = await addVersion(owner.id, second.id, 2);
        const edited = await request(
            `${workflowsPath}/${id}/draft`,
            owner,
            'PATCH',
            { title: '更新研究工作流', graph: graph(second.id) },
            { 'if-match': '"1"' },
        );
        expect(edited.status).toBe(200);
        expect(edited.headers.get('etag')).toBe('"2"');
        expect(
            (
                await request(
                    `${workflowsPath}/${id}/draft`,
                    owner,
                    'PATCH',
                    { title: '覆盖草稿', graph: graph(first.id) },
                    { 'if-match': '"1"' },
                )
            ).status,
        ).toBe(412);
        const newer = await publish(owner, id, 2);
        expect(newer.bindings[0]?.taskVersionId).toBe(secondTaskVersion);
        expect(
            await (await request(`${workflowsPath}/${id}/versions/${pinned.id}`, owner)).json(),
        ).toEqual(pinned);

        const listPath = `${workflowsPath}/${id}/versions?limit=1`;
        const list = await request(listPath, owner);
        expect(list.status).toBe(200);
        expect(parseContract(WorkflowVersionListSchema, await list.json())).toEqual({
            items: [newer],
            nextCursor: newer.id,
        });
        const older = await request(`${listPath}&cursor=${newer.id}`, owner);
        expect(parseContract(WorkflowVersionListSchema, await older.json())).toEqual({
            items: [pinned],
            nextCursor: null,
        });
        expect((await request(listPath, await account())).status).toBe(404);
        const unrelated = await create(owner, graph(first.id));
        const unrelatedVersion = await publish(owner, unrelated.workflow.id);
        expect((await request(`${listPath}&cursor=${unrelatedVersion.id}`, owner)).status).toBe(
            400,
        );

        const demo = await request(
            `${workflowsPath}/${id}/runs`,
            owner,
            'POST',
            { versionId: pinned.id, mode: 'demo' },
            { 'idempotency-key': randomUUID() },
        );
        expect(demo.status).toBe(422);
        const key = randomUUID();
        const [a, b] = await Promise.all([
            start(owner, id, pinned.id, key),
            start(owner, id, pinned.id, key),
        ]);
        expect(a.run.id).toBe(b.run.id);
        expect(a.reused).not.toBe(b.reused);
        const mismatch = await request(
            `${workflowsPath}/${id}/runs`,
            owner,
            'POST',
            { versionId: newer.id, mode: 'live' },
            { 'idempotency-key': key },
        );
        expect(mismatch.status).toBe(409);
        const duplicateBatch = () =>
            createWorkflowBatch(db, { batchSize: 1, intervalMs: 1 })(signal);
        await Promise.all([duplicateBatch(), duplicateBatch()]);
        const firstCheckpoint = await get(owner, a.run.id);
        const firstChild = firstCheckpoint.nodes[1]!.childRunId!;
        const eventsPath = `/api/v1/runs/${firstChild}/events?after=0`;
        const reader = await account();
        expect((await request(eventsPath, reader)).status).toBe(404);
        const events = await request(eventsPath, owner);
        expect(events.headers.get('content-type')).toContain('text/event-stream');
        const stream = events.body!.getReader();
        try {
            expect(new TextDecoder().decode((await stream.read()).value)).toContain('run.queued');
        } finally {
            await stream.cancel();
        }
        expect(firstCheckpoint.nodes.map((node) => node.id)).toEqual([
            'start',
            'study_0',
            'study_1',
            'end',
        ]);
        const [child] = await db.select().from(runs).where(eq(runs.id, firstChild));
        expect(
            await db.select().from(runEvents).where(eq(runEvents.runId, firstChild)),
        ).toMatchObject([{ type: 'run.queued', occurredAt: child!.queuedAt }]);
        expect(
            await db.select().from(outbox).where(eq(outbox.aggregateId, firstChild)),
        ).toMatchObject([{ eventType: 'run.enqueue', availableAt: child!.queuedAt }]);
        expect(await db.select().from(runs).where(eq(runs.userId, owner.id))).toHaveLength(1);

        // Given a durable Worker result, a fresh Server batch resumes from the actual child record.
        await db
            .update(runs)
            .set({
                status: 'succeeded',
                finishedAt: new Date(),
                coverageJson: { completeness: 'complete' },
            })
            .where(eq(runs.id, firstChild));
        await duplicateBatch();
        const nextCheckpoint = await get(owner, a.run.id);
        const secondChild = nextCheckpoint.nodes[2]!.childRunId!;
        expect(nextCheckpoint.nodes[1]).toMatchObject({
            status: 'succeeded',
            childRunId: firstChild,
            attempt: 1,
        });
        expect(nextCheckpoint.nodes[2]).toMatchObject({
            status: 'running',
            taskVersionId: second.version,
        });
        expect(
            (await db.select().from(runs).where(eq(runs.id, secondChild)))[0]?.taskVersionId,
        ).toBe(second.version);
        await db
            .update(runs)
            .set({
                status: 'succeeded',
                finishedAt: new Date(),
                coverageJson: { completeness: 'complete' },
            })
            .where(eq(runs.id, secondChild));
        await duplicateBatch();
        const complete = await get(owner, a.run.id);
        expect(complete.status).toBe('succeeded');
        expect(complete.nodes.every((node) => node.status === 'succeeded')).toBe(true);
        expect(await db.select().from(runs).where(eq(runs.userId, owner.id))).toHaveLength(2);
    });

    it('从冻结并行版本启动两个子执行，重建批次后等候汇合，再取消下一个阶段', async () => {
        const owner = await account();
        const [first, second, last] = await Promise.all([
            task(owner.id),
            task(owner.id),
            task(owner.id),
        ]);
        const serial = graph(first.id, second.id, last.id);
        const parallel: LegacyWorkflowGraph = {
            nodes: serial.nodes.toReversed(),
            edges: [
                ...serial.edges.filter((edge) => edge.from.nodeId !== 'study_0'),
                { from: { nodeId: 'start', port: 'out' }, to: { nodeId: 'study_1', port: 'in' } },
                { from: { nodeId: 'study_0', port: 'out' }, to: { nodeId: 'study_2', port: 'in' } },
            ],
        };
        const draft = await create(owner, parallel);
        const workflowId = draft.workflow.id;
        const pinned = await publish(owner, workflowId);
        await addVersion(owner.id, first.id, 2);
        const edit = await request(
            `${workflowsPath}/${workflowId}/draft`,
            owner,
            'PATCH',
            { title: '串行草稿', graph: serial },
            { 'if-match': '"1"' },
        );
        expect(edit.status).toBe(200);
        const currentVersion = await publish(owner, workflowId, 2);
        expect(currentVersion.graph.edges).toEqual(serial.edges);
        expect(pinned.graph.edges).toEqual(parallel.edges);

        const key = randomUUID();
        const { run } = await start(owner, workflowId, pinned.id, key);
        expect((await start(owner, workflowId, pinned.id, key)).run.id).toBe(run.id);
        const signal = new AbortController().signal;
        const tick = () =>
            createWorkflowBatch(db, { batchSize: 10, intervalMs: 1000, clock })(signal);
        let at = Date.now() + 60_000;
        const clock = () => new Date(at);
        await tick();
        const launched = await get(owner, run.id);
        const [left, right] = launched.nodes.slice(1, 3);
        expect(left).toMatchObject({
            status: 'running',
            parallelGroup: 'study_0',
            taskVersionId: first.version,
        });
        expect(right).toMatchObject({
            status: 'running',
            parallelGroup: 'study_0',
            taskVersionId: second.version,
        });
        expect(left?.childRunId).toBeTruthy();
        expect(right?.childRunId).toBeTruthy();
        expect(left?.childRunId).not.toBe(right?.childRunId);
        for (const child of [left!, right!]) {
            expect(
                await db.select().from(runs).where(eq(runs.id, child.childRunId!)),
            ).toMatchObject([{ taskVersionId: child.taskVersionId, status: 'queued' }]);
            expect(
                await db.select().from(outbox).where(eq(outbox.aggregateId, child.childRunId!)),
            ).toMatchObject([{ eventType: 'run.enqueue' }]);
        }

        async function settle(childId: string, status: 'succeeded' | 'canceled') {
            await db
                .update(runs)
                .set({
                    status,
                    finishedAt: clock(),
                    coverageJson: status === 'succeeded' ? { completeness: 'complete' } : null,
                })
                .where(eq(runs.id, childId));
            at += 1000;
            await tick();
        }
        await settle(left!.childRunId!, 'succeeded');
        const waiting = await get(owner, run.id);
        expect(waiting.nodes.map((node) => node.status)).toEqual([
            'succeeded',
            'succeeded',
            'running',
            'pending',
            'pending',
        ]);
        expect(waiting.nodes[2]?.childRunId).toBe(right?.childRunId);
        expect(await db.select().from(runs).where(eq(runs.userId, owner.id))).toHaveLength(2);
        await settle(right!.childRunId!, 'succeeded');
        const joined = await get(owner, run.id);
        expect(joined.nodes[3]).toMatchObject({ status: 'running', taskVersionId: last.version });
        expect(await db.select().from(runs).where(eq(runs.userId, owner.id))).toHaveLength(3);
        const canceled = await request(`${runPath}/${run.id}/cancel`, owner, 'POST');
        expect(canceled.status).toBe(200);
        await settle(joined.nodes[3]!.childRunId!, 'canceled');
        expect((await get(owner, run.id)).status).toBe('canceled');
    });
    it('拒绝复用同 Task 活动 Run，也拒绝冒充当前节点的同账号 Run', async () => {
        const owner = await account();
        const first = await task(owner.id);
        const draft = await create(owner, graph(first.id));
        const version = await publish(owner, draft.workflow.id);
        const a = await start(owner, draft.workflow.id, version.id);
        const b = await start(owner, draft.workflow.id, version.id);
        const batch = createWorkflowBatch(db, { batchSize: 2, intervalMs: 1 });
        await batch(signal);
        const candidates = await Promise.all([get(owner, a.run.id), get(owner, b.run.id)]);
        const active = candidates.find((run) => run.status === 'running')!;
        expect(candidates.find((run) => run.status === 'failed')?.failureCode).toBe(
            'RUN_ALREADY_ACTIVE',
        );
        const real = (await db.select().from(runs).where(eq(runs.userId, owner.id)))[0]!;
        const [impersonator] = await db
            .insert(runs)
            .values({
                userId: owner.id,
                taskId: first.id,
                taskVersionId: first.version!,
                status: 'succeeded',
                finishedAt: new Date(),
                coverageJson: { completeness: 'complete' },
                trigger: 'manual',
                mode: 'live',
                comparisonScopeHash: real.comparisonScopeHash,
                budgetJson: {},
            })
            .returning();
        const forged = active.nodes.map((node) =>
            node.type === 'study' ? { ...node, childRunId: impersonator!.id } : node,
        );
        await db
            .update(workflowRuns)
            .set({ nodesJson: forged, nextCheckAt: new Date(0) })
            .where(eq(workflowRuns.id, active.id));
        await batch(signal);
        expect(await get(owner, active.id)).toMatchObject({
            status: 'failed',
            failureCode: 'CHILD_RUN_UNAVAILABLE',
        });
        expect((await db.select().from(runs).where(eq(runs.id, real.id)))[0]?.status).toBe(
            'queued',
        );
        await db
            .update(runs)
            .set({ status: 'canceled', finishedAt: new Date() })
            .where(eq(runs.id, real.id));
    });

    it.each(['redis', 'sqlite'] as const)(
        '%s：Server 和 Worker 处理取消并跳过后续节点',
        async (transport) => {
            const owner = await account();
            const first = await task(owner.id);
            const draft = await create(owner, graph(first.id, first.id));
            const version = await publish(owner, draft.workflow.id);
            const { run } = await start(owner, draft.workflow.id, version.id);
            const queueName = `${namespace}_${transport}`;
            const directory =
                transport === 'sqlite'
                    ? mkdtempSync(join(tmpdir(), 'scova-sqlite-workflow-'))
                    : undefined;
            const sqliteStatePath = directory ? join(directory, 'state.sqlite') : undefined;
            const redis = directory ? undefined : new Redis(redisUrl, { maxRetriesPerRequest: 1 });
            const queue = redis ? new Queue(queueName, { connection: redis }) : undefined;
            const selectedRedisUrl = sqliteStatePath ? '' : redisUrl;
            const control = createRunControl(
                readRunControlConfig({
                    DATABASE_URL: databaseUrl,
                    REDIS_URL: selectedRedisUrl,
                    SCOVA_SQLITE_STATE_PATH: sqliteStatePath,
                    WORKER_QUEUE_NAME: queueName,
                    WORKER_POLL_INTERVAL_MS: '25',
                    WORKER_FAILURE_DELAY_MS: '25',
                }),
            );
            let activeContext:
                | { runId: string; taskVersionId: string; signal: AbortSignal }
                | undefined;
            const checkpointSchema = `scova_agent_${randomUUID().replaceAll('-', '')}`;
            await prepareTestCheckpointSchema(databaseUrl, checkpointSchema);
            const execution = await testWorkerExecution(db, {
                DATABASE_URL: databaseUrl,
                AGENT_CHECKPOINT_SCHEMA: checkpointSchema,
                WORKER_QUEUE_NAME: queueName,
                SCOVA_SQLITE_STATE_PATH: sqliteStatePath,
            });
            const worker = createWorkerApp({
                config: {
                    executionUrl: execution.url,
                    executionToken: execution.token,
                    redisUrl: selectedRedisUrl,
                    queueName,
                    runLeaseSeconds: 3,
                    runConcurrency: 2,
                },
                logger: { info() {} },
                executor: {
                    async execute(context: {
                        userId: string;
                        runId: string;
                        taskVersionId: string;
                        signal: AbortSignal;
                    }) {
                        if (context.userId !== owner.id) return;
                        activeContext = context;
                        await new Promise<void>((resolve) => {
                            if (context.signal.aborted) resolve();
                            else
                                context.signal.addEventListener('abort', () => resolve(), {
                                    once: true,
                                });
                        });
                    },
                },
            });
            try {
                control.start();
                await worker.start();
                await vi.waitFor(() => expect(activeContext).toBeDefined(), { timeout: 10_000 });
                const running = await get(owner, run.id);
                const childId = running.nodes[1]?.childRunId;
                expect(activeContext).toMatchObject({
                    runId: childId,
                    taskVersionId: first.version,
                });
                const stranger = await account();
                expect(
                    (await request(`${runPath}/${run.id}/cancel`, stranger, 'POST')).status,
                ).toBe(404);
                const response = await request(`${runPath}/${run.id}/cancel`, owner, 'POST');
                expect(response.status).toBe(200);
                expect(await response.json()).toMatchObject({ status: 'cancel_requested' });
                expect((await request(`${runPath}/${run.id}/cancel`, owner, 'POST')).status).toBe(
                    200,
                );
                await vi.waitFor(
                    async () =>
                        expect(await get(owner, run.id)).toMatchObject({ status: 'canceled' }),
                    { timeout: 10_000 },
                );
                expect(activeContext?.signal.aborted).toBe(true);
                const completed = await get(owner, run.id);
                expect(completed.nodes.map((node) => node.status)).toEqual([
                    'succeeded',
                    'canceled',
                    'skipped',
                    'skipped',
                ]);
                expect(
                    (await db.select().from(outbox).where(eq(outbox.aggregateId, childId!))).filter(
                        (entry) => entry.eventType === 'run.cancel_requested',
                    ),
                ).toHaveLength(1);
                expect(await db.select().from(runs).where(eq(runs.userId, owner.id))).toHaveLength(
                    1,
                );
            } finally {
                try {
                    await Promise.all([control.stop(), worker.stop()]);
                    await execution.stop();
                    await admin.query(`DROP SCHEMA IF EXISTS "${checkpointSchema}" CASCADE`);
                    await queue?.obliterate({ force: true });
                } finally {
                    await queue?.close();
                    redis?.disconnect();
                    if (directory) rmSync(directory, { recursive: true, force: true });
                }
            }
        },
    );
});

describe('自定义工作流画布', () => {
    const canvas: WorkflowCanvasGraph = {
        version: 2,
        nodes: [
            { id: 'start', type: 'start' },
            { id: 'all', type: 'csv', config: { filters: [] } },
            {
                id: 'west',
                type: 'csv',
                config: {
                    source: 'all',
                    filters: [{ column: 'region', operator: 'equals', value: 'west' }],
                },
            },
            { id: 'gate', type: 'merge' },
            {
                id: 'deliver',
                type: 'deliver',
                config: { format: 'csv', filename: 'west.csv', source: 'west' },
            },
            {
                id: 'notice',
                type: 'notify',
                config: { source: 'deliver', title: '已交付', body: '有 {{west.count}} 行' },
            },
            { id: 'end', type: 'end' },
        ],
        edges: [
            ['start', 'all'],
            ['all', 'west'],
            ['start', 'gate'],
            ['west', 'gate'],
            ['gate', 'deliver'],
            ['deliver', 'notice'],
            ['notice', 'end'],
        ].map(([from, to]) => ({
            from: { nodeId: from!, port: 'out' },
            to: { nodeId: to!, port: 'in' },
        })),
        layout: {
            positions: { west: { x: -25, y: 320 } },
            groups: [{ id: 'region', title: '区域筛选', nodeIds: ['all', 'west'] }],
        },
    };
    const input = { csv: 'name,region\nApple,west\nBanana,east\n' };

    async function submit(user: Account, workflowId: string, body: object, key = randomUUID()) {
        const response = await request(`${workflowsPath}/${workflowId}/runs`, user, 'POST', body, {
            'idempotency-key': key,
        });
        expect(response.status).toBe(202);
        return parseContract(WorkflowStartResponseSchema, await response.json());
    }

    it('保留布局、固定执行版本，并在重进批次后恢复，只为正式运行创建通知', async () => {
        const owner = await account();
        const stranger = await account();
        const { workflow } = await create(owner, canvas);
        const pending = await submit(owner, workflow.id, {
            draftRevision: 1,
            preview: true,
            input,
        });
        const published = await publish(owner, workflow.id);
        expect(published.graph).toEqual(canvas);
        const key = randomUUID();
        const live = await submit(owner, workflow.id, { versionId: published.id, input }, key);
        expect(
            (await submit(owner, workflow.id, { versionId: published.id, input }, key)).reused,
        ).toBe(true);
        expect(
            (
                await request(
                    `${workflowsPath}/${workflow.id}/runs`,
                    owner,
                    'POST',
                    { versionId: published.id, input: { ...input, notify: false } },
                    { 'idempotency-key': key },
                )
            ).status,
        ).toBe(409);
        const quiet = await submit(owner, workflow.id, {
            versionId: published.id,
            input: { ...input, notify: false },
        });
        const canceled = await submit(owner, workflow.id, { versionId: published.id, input });
        expect((await request(`${runPath}/${canceled.run.id}/cancel`, owner, 'POST')).status).toBe(
            200,
        );
        await createWorkflowBatch(db, { batchSize: 2, intervalMs: 0 })(signal);
        const resume = createWorkflowBatch(db, { batchSize: 50, intervalMs: 0 });
        await resume(signal);
        expect(await resume(signal)).toBe(0);

        const preview = await get(owner, pending.run.id);
        expect(preview).toMatchObject({
            status: 'succeeded',
            versionId: null,
            preview: true,
            draftSnapshot: canvas,
        });
        expect(preview.nodes.find((node) => node.id === 'notice')?.output?.notification).toEqual({
            title: '已交付',
            body: '有 1 行',
            artifactNodeId: 'deliver',
        });
        const result = await get(owner, live.run.id);
        expect(result.status).toBe('succeeded');
        expect(result.nodes.find((node) => node.id === 'deliver')?.output?.artifact).toMatchObject({
            filename: 'west.csv',
            content: 'name,region\r\nApple,west\r\n',
        });
        expect(
            (await get(owner, quiet.run.id)).nodes.find((node) => node.id === 'notice')?.status,
        ).toBe('skipped');
        expect((await get(owner, canceled.run.id)).status).toBe('canceled');
        const notices = await db
            .select()
            .from(workflowNotifications)
            .where(eq(workflowNotifications.userId, owner.id));
        expect(notices).toMatchObject([
            { workflowRunId: live.run.id, nodeId: 'notice', artifactNodeId: 'deliver' },
        ]);
        expect((await request(`${runPath}/${live.run.id}`, stranger)).status).toBe(404);
    });

    it('accepts valid JSON through the workflow API and persists a filtered JSON delivery', async () => {
        const owner = await account();
        const graph = structuredClone(canvas);
        const delivery = graph.nodes.find((node) => node.type === 'deliver');
        if (!delivery) throw new Error('Missing delivery node');
        delivery.config.format = 'json';
        delivery.config.filename = 'west.json';
        const { workflow } = await create(owner, graph);
        const version = await publish(owner, workflow.id);
        const invalid = await request(
            `${workflowsPath}/${workflow.id}/runs`,
            owner,
            'POST',
            { versionId: version.id, input: { json: '{' } },
            { 'idempotency-key': randomUUID() },
        );
        expect(invalid.status).toBe(422);
        expect(await invalid.json()).toMatchObject({ code: 'WORKFLOW_INVALID_JSON' });

        const ambiguous = await request(
            `${workflowsPath}/${workflow.id}/runs`,
            owner,
            'POST',
            { versionId: version.id, input: { csv: 'name\nApple', json: '[]' } },
            { 'idempotency-key': randomUUID() },
        );
        expect(ambiguous.status).toBe(422);
        expect(await ambiguous.json()).toMatchObject({ code: 'WORKFLOW_INVALID_INPUT' });

        const { run } = await submit(owner, workflow.id, {
            versionId: version.id,
            input: { json: '[{"name":"Apple","region":"west"},{"name":"Banana","region":"east"}]' },
        });
        await createWorkflowBatch(db, { batchSize: 50, intervalMs: 0 })(signal);
        const finished = await get(owner, run.id);
        expect(finished.status).toBe('succeeded');
        expect(finished.nodes.find((node) => node.id === 'deliver')?.output?.artifact).toEqual({
            filename: 'west.json',
            format: 'json',
            content: '[{"name":"Apple","region":"west"}]',
        });
    });

    it('发布时拒绝循环和缺少有效上游的工作流', async () => {
        const owner = await account();
        const invalid = structuredClone(canvas);
        invalid.edges.push({
            from: { nodeId: 'gate', port: 'out' },
            to: { nodeId: 'west', port: 'in' },
        });
        const { workflow } = await create(owner, invalid);
        const response = await request(
            `${workflowsPath}/${workflow.id}/publish`,
            owner,
            'POST',
            undefined,
            { 'if-match': '"1"' },
        );
        expect(response.status).toBe(422);
        expect(await response.json()).toMatchObject({ code: 'WORKFLOW_INVALID_GRAPH' });
    });
});
