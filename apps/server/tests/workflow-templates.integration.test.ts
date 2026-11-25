import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vite-plus/test';
import {
    agentProviders,
    closeDatabase,
    createDatabaseClient,
    eq,
    sessions,
    users,
    workflowNotifications,
    workflowRuns,
    workflowTemplateExecutions,
    workflows,
    workflowVersions,
} from '@scova/db';
import { migrateDatabase } from '@scova/db/migrate';
import {
    parseContract,
    WorkflowDetailSchema,
    WorkflowListSchema,
    WorkflowStartResponseSchema,
    WorkflowTemplateListSchema,
    WorkflowTemplateSchema,
    type WorkflowCanvasGraph,
    type WorkflowTemplate,
} from '@scova/models';
import { createApiApp } from '@/app/index.ts';
import { createDefaultServices } from '@/app/services.ts';
import { createWorkflowBatch } from '@/service/workflow-batch.ts';
import { tokenHash } from '@/utils/security.ts';

const origin = 'https://scova.test';
const path = '/api/v1/workflow-templates';
const baseUrl =
    process.env.SCOVA_TEST_DATABASE_URL ??
    'postgresql://scova_test:scova_test@127.0.0.1:55432/scova_test';
const namespace = `scova_templates_${randomUUID().replaceAll('-', '')}`;
const databaseUrl = new URL(baseUrl);
databaseUrl.searchParams.set('schema', namespace);
const db = createDatabaseClient({ connectionString: databaseUrl.toString() });
const admin = new pg.Client({ connectionString: baseUrl });
const services = createDefaultServices({ db: () => db, origin });
const app = createApiApp('node', services);
let connected = false;

beforeAll(async () => {
    await admin.connect();
    connected = true;
    await migrateDatabase({ connectionString: databaseUrl.toString() });
});

afterAll(async () => {
    await services.close();
    await closeDatabase(db);
    if (connected) {
        try {
            await admin.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
        } finally {
            await admin.end();
        }
    }
});

async function account() {
    const email = `${randomUUID()}@example.test`;
    const [user] = await db
        .insert(users)
        .values({ email, normalizedEmail: email, passwordHash: 'test' })
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

function request(url: string, user: Account, method = 'GET', body?: unknown, key?: string) {
    const headers = new Headers({
        origin,
        cookie: `scova_session=${user.token}`,
        'x-csrf-token': user.csrf,
    });
    if (body !== undefined) headers.set('content-type', 'application/json');
    if (key) headers.set('idempotency-key', key);
    return app.handle(
        new Request(`${origin}${url}`, {
            method,
            headers,
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
    );
}

async function list(user: Account) {
    const response = await request(path, user);
    expect(response.status).toBe(200);
    return parseContract(WorkflowTemplateListSchema, await response.json()).items;
}

function action(template: WorkflowTemplate, command: 'start' | 'copy') {
    return `${path}/${template.id}/versions/${template.version}/${command}`;
}

it('pins the inventory snapshot once under concurrent retries and starts distinct input runs', async () => {
    const [owner, other] = await Promise.all([account(), account()]);
    const templates = await list(owner);
    expect(
        templates.map(({ title, version, workflowId }) => ({ title, version, workflowId })),
    ).toEqual([
        { title: '库存预警清单', version: 1, workflowId: null },
        { title: '项目周报', version: 1, workflowId: null },
    ]);
    const inventory = templates[0]!;
    const url = action(inventory, 'start');
    const input = { csv: '商品,库存\n库存低,3\n库存充足,15', inventoryColumn: '库存' };
    const key = randomUUID();
    const send = (values: unknown, idempotencyKey = key) =>
        request(url, owner, 'POST', { input: values }, idempotencyKey);
    expect((await request(url, owner, 'POST', { input })).status).toBe(428);
    expect((await send({ csv: input.csv })).status).toBe(422);
    expect((await send({ ...input, text: 'unexposed' })).status).toBe(422);
    const responses = await Promise.all([
        send(input),
        send({ ...input, threshold: 10, notify: false }),
    ]);
    const results = await Promise.all(
        responses.map(async (response) => {
            expect(response.status).toBe(202);
            return parseContract(WorkflowStartResponseSchema, await response.json());
        }),
    );
    const first = results[0]!.run;
    expect(new Set(results.map(({ run }) => run.id))).toEqual(new Set([first.id]));
    expect(results.filter(({ reused }) => reused)).toHaveLength(1);
    expect((await send({ ...input, threshold: 2 })).status).toBe(409);
    const secondResponse = await send({ ...input, threshold: 2, notify: true }, randomUUID());
    expect(secondResponse.status).toBe(202);
    const second = parseContract(WorkflowStartResponseSchema, await secondResponse.json()).run;
    expect(second.id).not.toBe(first.id);
    expect(second.workflowId).toBe(first.workflowId);
    expect(second.versionId).toBe(first.versionId);
    expect(
        await db
            .select()
            .from(workflowTemplateExecutions)
            .where(eq(workflowTemplateExecutions.userId, owner.id)),
    ).toHaveLength(1);
    expect((await list(owner))[0]!.workflowId).toBe(first.workflowId);
    expect((await list(other))[0]!.workflowId).toBeNull();
    expect((await request(`/api/v1/workflow-runs/${first.id}`, other)).status).toBe(404);
    const visible = parseContract(
        WorkflowListSchema,
        await (await request('/api/v1/workflows', owner)).json(),
    );
    expect(visible.items).toEqual([]);

    const batch = createWorkflowBatch(db, {
        batchSize: 30,
        intervalMs: 0,
        generator: () => async () => {
            throw new Error('inventory must not invoke a model');
        },
    });
    await batch(new AbortController().signal);
    const stored = await db.select().from(workflowRuns).where(eq(workflowRuns.userId, owner.id));
    expect(stored.map(({ status }) => status)).toEqual(['succeeded', 'succeeded']);
    expect(
        stored.find(({ id }) => id === first.id)?.nodesJson.find(({ id }) => id === 'deliver')
            ?.output?.artifact?.content,
    ).toBe('商品,库存\r\n库存低,3\r\n');
    const notices = await db
        .select()
        .from(workflowNotifications)
        .where(eq(workflowNotifications.userId, owner.id));
    expect(notices.map(({ workflowRunId }) => workflowRunId)).toEqual([second.id]);
});

it('requires an owned model and passes the selected weekly period to generation', async () => {
    const [owner, other] = await Promise.all([account(), account()]);
    const [provider] = await db
        .insert(agentProviders)
        .values({
            userId: owner.id,
            name: '测试模型',
            model: 'stub',
            baseUrl: 'https://example.test',
            encryptedApiKey: 'unused-in-test',
        })
        .returning();
    const template = (await list(owner))[1]!;
    const url = action(template, 'start');
    const input = { csv: '任务,状态\n设计,完成', period: '2026 年第 48 周' };
    expect((await request(url, owner, 'POST', { input }, randomUUID())).status).toBe(422);
    const body = { input: { ...input, providerId: provider!.id } };
    expect((await request(url, other, 'POST', body, randomUUID())).status).toBe(422);
    const response = await request(url, owner, 'POST', body, randomUUID());
    expect(response.status).toBe(202);
    const { run } = parseContract(WorkflowStartResponseSchema, await response.json());
    const generated: string[] = [];
    const batch = createWorkflowBatch(db, {
        batchSize: 30,
        intervalMs: 0,
        generator:
            (userId) =>
            async ({ instructions, context, providerId }) => {
                generated.push(userId, instructions, context, providerId ?? '');
                return '# 项目周报\n\n设计完成';
            },
    });
    await batch(new AbortController().signal);
    expect(generated).toEqual([
        owner.id,
        expect.stringContaining(input.period),
        expect.stringContaining('设计'),
        provider!.id,
    ]);
    const [stored] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, run.id));
    expect(stored?.status).toBe('succeeded');
    expect(stored?.nodesJson.find(({ id }) => id === 'deliver')?.output?.artifact).toEqual({
        filename: '项目周报.md',
        format: 'markdown',
        content: '# 项目周报\n\n设计完成',
    });
});

it('copies an immutable owned published snapshot and clears research bindings', async () => {
    const [owner, other] = await Promise.all([account(), account()]);
    const builtin = (await list(owner))[0]!;
    const graph: WorkflowCanvasGraph = {
        ...builtin.graph,
        nodes: builtin.graph.nodes.map((node) =>
            node.id === 'filter' ? { id: node.id, type: 'study', taskId: randomUUID() } : node,
        ),
    };
    // Seed a frozen valid research graph without coupling this fixture to task publication.
    graph.nodes = graph.nodes.filter((node) => !['deliver', 'notify'].includes(node.id));
    graph.edges = [
        { from: { nodeId: 'start', port: 'out' }, to: { nodeId: 'filter', port: 'in' } },
        { from: { nodeId: 'filter', port: 'out' }, to: { nodeId: 'end', port: 'in' } },
    ];
    delete graph.layout.positions.deliver;
    delete graph.layout.positions.notify;
    graph.layout.groups = [{ id: 'research', title: '研究组', nodeIds: ['filter'] }];
    const taskId = graph.nodes.find((node) => node.type === 'study')!.taskId;
    const [source] = await db
        .insert(workflows)
        .values({ userId: owner.id, title: '原始草稿', draftJson: graph })
        .returning();
    const [version] = await db
        .insert(workflowVersions)
        .values({
            userId: owner.id,
            workflowId: source!.id,
            version: 1,
            draftRevision: source!.revision,
            title: '已发布',
            graphJson: graph,
            bindingsJson: [{ nodeId: 'filter', taskId, taskVersionId: randomUUID() }],
        })
        .returning();
    const fields = [{ key: 'notify', label: '站内通知', required: false, default: false }];
    const body = {
        workflowId: source!.id,
        versionId: version!.id,
        title: '个人研究模板',
        description: '',
        delivery: '',
        fields,
    };
    expect((await request(path, other, 'POST', body)).status).toBe(404);
    expect(
        (await request(path, owner, 'POST', { ...body, fields: [...fields, ...fields] })).status,
    ).toBe(422);
    const response = await request(path, owner, 'POST', body);
    expect(response.status).toBe(201);
    const personal = parseContract(WorkflowTemplateSchema, await response.json());
    expect(personal.requiresBindings).toBe(true);
    expect(personal.fields).toEqual(fields);
    expect(JSON.stringify(personal.graph)).not.toContain(taskId);
    expect(personal.graph.layout).toEqual(graph.layout);
    expect((await list(other)).map(({ kind }) => kind)).toEqual(['builtin', 'builtin']);
    expect(
        (await request(action(personal, 'start'), owner, 'POST', { input: {} }, randomUUID()))
            .status,
    ).toBe(422);
    expect((await request(action(personal, 'copy'), other, 'POST')).status).toBe(404);
    await db
        .update(workflows)
        .set({ draftJson: builtin.graph, revision: 2 })
        .where(eq(workflows.id, source!.id));
    const copied = await request(action(personal, 'copy'), owner, 'POST');
    expect(copied.status).toBe(201);
    const detail = parseContract(WorkflowDetailSchema, await copied.json());
    expect(detail.workflow.id).not.toBe(source!.id);
    expect(detail.publishedVersion).toBeNull();
    expect(detail.draft).toEqual(personal.graph);
    const [published] = await db
        .select()
        .from(workflowVersions)
        .where(eq(workflowVersions.id, version!.id));
    expect(published?.graphJson).toEqual(graph);
    expect(published?.bindingsJson[0]?.taskId).toBe(taskId);
});

it('runs a personal JSON template and rejects invalid JSON before creating its execution', async () => {
    const owner = await account();
    const graph: WorkflowCanvasGraph = {
        version: 2,
        nodes: [
            { id: 'start', type: 'start' },
            {
                id: 'file',
                type: 'deliver',
                config: { source: 'start', format: 'json', filename: 'result.json' },
            },
            { id: 'end', type: 'end' },
        ],
        edges: [
            { from: { nodeId: 'start', port: 'out' }, to: { nodeId: 'file', port: 'in' } },
            { from: { nodeId: 'file', port: 'out' }, to: { nodeId: 'end', port: 'in' } },
        ],
        layout: { positions: {}, groups: [] },
    };
    const [source] = await db
        .insert(workflows)
        .values({ userId: owner.id, title: 'JSON 原文', draftJson: graph })
        .returning();
    const [version] = await db
        .insert(workflowVersions)
        .values({
            userId: owner.id,
            workflowId: source!.id,
            version: 1,
            draftRevision: 1,
            title: source!.title,
            graphJson: graph,
            bindingsJson: [],
        })
        .returning();
    const saved = await request(path, owner, 'POST', {
        workflowId: source!.id,
        versionId: version!.id,
        title: '处理 JSON',
        description: '保留原文',
        delivery: 'JSON 文件',
        fields: [{ key: 'json', label: 'JSON 文件', required: true }],
    });
    expect(saved.status).toBe(201);
    const template = parseContract(WorkflowTemplateSchema, await saved.json());
    const start = (json: string) =>
        request(action(template, 'start'), owner, 'POST', { input: { json } }, randomUUID());
    const invalid = await start('{');
    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toMatchObject({ code: 'WORKFLOW_INVALID_JSON' });
    expect((await list(owner)).find((item) => item.id === template.id)?.workflowId).toBeNull();

    const content = '{"区域":"西区"}';
    const response = await start(content);
    expect(response.status).toBe(202);
    const { run } = parseContract(WorkflowStartResponseSchema, await response.json());
    await createWorkflowBatch(db, { batchSize: 50, intervalMs: 0 })(new AbortController().signal);
    const [stored] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, run.id));
    expect(stored?.status).toBe('succeeded');
    expect(stored?.nodesJson.find((node) => node.id === 'file')?.output?.artifact).toEqual({
        filename: 'result.json',
        format: 'json',
        content,
    });
});
