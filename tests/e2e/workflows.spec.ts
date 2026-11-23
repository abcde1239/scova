import { expect, test, type Page } from '@playwright/test';
import {
    isWorkflowCanvasGraph,
    type LegacyWorkflowGraph,
    type WorkflowCanvasGraph,
    type WorkflowGraph,
    type WorkflowRun,
    type WorkflowRunNode,
} from '@scova/models';
import type { WorkflowDetail, WorkflowDraft } from '../../apps/web/src/api/workflows.ts';
import { mockFixtureSession } from './support/session-sample.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const workflowId = id(11);
const versionId = id(12);
const runId = id(13);
const childId = id(14);
const tasks = [id(21), id(22)];
const instant = '2026-10-31T00:00:00Z';
const legacyGraph: LegacyWorkflowGraph = {
    nodes: [
        { id: 'start', type: 'start' },
        { id: 'end', type: 'end' },
    ],
    edges: [{ from: { nodeId: 'start', port: 'out' }, to: { nodeId: 'end', port: 'in' } }],
};

// HTTP contract samples exercise the real UI. Workflow orchestration is verified separately.
async function fixtures(page: Page, draft: WorkflowGraph = legacyGraph) {
    await mockFixtureSession(page);
    const state = {
        detail: {
            workflow: {
                id: workflowId,
                title: '研究工作流',
                revision: 1,
                createdAt: instant,
                updatedAt: instant,
            },
            draft,
            publishedVersion: null,
        } as WorkflowDetail,
        saveCalls: [] as { tag: string | undefined; body: WorkflowDraft }[],
        publishTags: [] as (string | undefined)[],
        startKeys: [] as (string | undefined)[],
        run: null as WorkflowRun | null,
    };
    const snapshot = () => ({
        json: state.detail,
        headers: { etag: `"${state.detail.workflow.revision}"` },
    });
    const error = (status: number, code: string, message: string) => ({
        status,
        json: { code, message, requestId: 'test-workflows' },
    });
    await page.route('**/api/v1/tasks?**', (route) =>
        route.fulfill({
            json: {
                items: tasks.map((taskId, index) => ({
                    id: taskId,
                    title: `调研任务 ${index + 1}`,
                    status: 'active',
                    revision: 1,
                    currentVersionId: id(30 + index),
                    nextRunAt: null,
                    createdAt: instant,
                    updatedAt: instant,
                })),
                nextCursor: null,
            },
        }),
    );
    await page.route('**/api/v1/workflows**', async (route) => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        const tag = request.headers()['if-match'];
        if (path === '/api/v1/workflows') {
            if (request.method() === 'GET')
                return route.fulfill({ json: { items: [], nextCursor: null } });
            const body = request.postDataJSON() as WorkflowDraft;
            state.detail.workflow.title = body.title;
            state.detail.draft = body.graph;
            return route.fulfill({ ...snapshot(), status: 201 });
        }
        if (path === `/api/v1/workflows/${workflowId}`) return route.fulfill(snapshot());
        if (path.endsWith('/draft')) {
            const body = request.postDataJSON() as WorkflowDraft;
            state.saveCalls.push({ tag, body });
            if (tag !== snapshot().headers.etag)
                return route.fulfill(error(412, 'REVISION_MISMATCH', '工作流草稿已更新'));
            state.detail.workflow.revision += 1;
            state.detail.workflow.title = body.title;
            state.detail.draft = body.graph;
            return route.fulfill(snapshot());
        }
        if (path.endsWith('/publish')) {
            state.publishTags.push(tag);
            const { workflow, draft } = state.detail;
            state.detail.publishedVersion = {
                id: versionId,
                workflowId,
                version: 2,
                draftRevision: workflow.revision,
                title: workflow.title,
                graph: draft,
                publishedAt: instant,
                bindings: draft.nodes.flatMap((node) =>
                    node.type === 'study'
                        ? [
                              {
                                  nodeId: node.id,
                                  taskId: node.taskId,
                                  taskVersionId: id(30 + tasks.indexOf(node.taskId)),
                              },
                          ]
                        : [],
                ),
            };
            return route.fulfill(snapshot());
        }
        if (path.endsWith('/versions')) {
            const latest = state.detail.publishedVersion;
            return route.fulfill({
                json: {
                    items: latest
                        ? [
                              latest,
                              { ...latest, id: id(40), version: 1, title: '尚未运行的发布版本' },
                          ]
                        : [],
                    nextCursor: null,
                },
            });
        }
        if (path.endsWith('/runs')) {
            if (request.method() === 'GET')
                return route.fulfill({
                    json: { items: state.run ? [state.run] : [], nextCursor: null },
                });
            const key = request.headers()['idempotency-key'];
            expect(key).toBeTruthy();
            expect(request.headers()['x-csrf-token']).toBe('fixture-only');
            const published = state.detail.publishedVersion!;
            expect(request.postDataJSON()).toEqual({
                versionId,
                ...(isWorkflowCanvasGraph(published.graph) ? { input: {} } : {}),
            });
            state.startKeys.push(key);
            const runningNode = published.graph.edges.find(({ from }) => from.nodeId === 'start')
                ?.to.nodeId;
            state.run ??= {
                id: runId,
                workflowId,
                versionId,
                mode: 'live',
                status: 'running',
                createdAt: instant,
                startedAt: instant,
                finishedAt: null,
                failureCode: null,
                nodes: published.graph.nodes.map((node): WorkflowRunNode => ({
                    id: node.id,
                    type: node.type,
                    status:
                        node.type === 'start'
                            ? 'succeeded'
                            : node.id === runningNode
                              ? 'running'
                              : 'pending',
                    attempt: node.id === runningNode ? 1 : 0,
                    startedAt: node.type === 'start' || node.id === runningNode ? instant : null,
                    finishedAt: node.type === 'start' ? instant : null,
                    taskId: node.type === 'study' ? node.taskId : null,
                    taskVersionId:
                        published.bindings.find((binding) => binding.nodeId === node.id)
                            ?.taskVersionId ?? null,
                    childRunId: node.id === runningNode ? childId : null,
                    childStatus: node.id === runningNode ? 'queued' : null,
                    failureCode: null,
                })),
            };
            if (state.startKeys.length === 1)
                return route.fulfill(error(503, 'SERVICE_UNAVAILABLE', '启动响应暂时不可用'));
            return route.fulfill({ status: 202, json: { run: state.run, reused: true } });
        }
        return route.fulfill(error(404, 'NOT_FOUND', '工作流不存在'));
    });
    await page.route(`**/api/v1/workflow-runs/${runId}**`, (route) => {
        if (!state.run) return route.fulfill(error(404, 'NOT_FOUND', '运行不存在'));
        if (route.request().method() === 'POST') state.run.status = 'cancel_requested';
        return route.fulfill({ json: state.run });
    });
    return state;
}

test('a new canvas saves explicit dependencies and runs a frozen version with idempotent retries', async ({
    page,
}, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const state = await fixtures(page);
    await page.goto('/workflows');
    await expect(page.getByText('暂无工作流', { exact: true })).toBeVisible();
    await page.getByLabel('新工作流名称').fill('研究工作流');
    await page.getByRole('button', { name: '创建工作流' }).click();
    await expect(page).toHaveURL(`/workflows/${workflowId}`);
    expect(isWorkflowCanvasGraph(state.detail.draft)).toBe(true);
    const canvas = page.getByRole('region', { name: '工作流画布编辑器' });
    const list = canvas.getByRole('region', { name: '工作流步骤' });
    await canvas.getByRole('button', { name: '步骤列表', exact: true }).click();
    await list.getByRole('button', { name: /^结束/ }).click();
    await canvas.getByRole('button', { name: '移除 开始 到 结束 的连线' }).press('Enter');

    const add = canvas
        .getByRole('region', { name: '节点库' })
        .getByRole('button', { name: /研究/ });
    const task = canvas.getByRole('combobox', { name: '研究任务' });
    const name = canvas.getByRole('textbox', { name: '节点名称' });
    const upstream = canvas.getByRole('combobox', { name: '添加上游连线' });
    const connect = canvas.getByRole('button', { name: '连接', exact: true });
    await add.press('Enter');
    await expect(task.getByRole('option', { name: '调研任务 1' })).toHaveCount(1);
    await task.selectOption(tasks[0]!);
    await name.fill('第一项研究');
    await name.press('Enter');
    await upstream.selectOption({ label: '开始' });
    await connect.press('Enter');
    await add.click();
    await task.selectOption(tasks[1]!);
    await name.fill('第二项研究');
    await name.press('Enter');
    await upstream.selectOption({ label: '第一项研究' });
    await connect.click();
    await list.getByRole('button', { name: /^结束/ }).click();
    await upstream.selectOption({ label: '第二项研究' });
    await connect.click();
    await canvas.getByRole('button', { name: '画布', exact: true }).click();
    await canvas.getByRole('button', { name: '自动排列' }).click();
    await canvas.screenshot({ path: testInfo.outputPath('workflow-editor-1280.png') });

    await page.getByRole('button', { name: '保存草稿', exact: true }).click();
    await expect(page.getByText('已保存草稿', { exact: true })).toBeVisible();
    const save = state.saveCalls[0]!;
    expect(save.tag).toBe('"1"');
    expect(isWorkflowCanvasGraph(save.body.graph)).toBe(true);
    const studies = save.body.graph.nodes.filter((node) => node.type === 'study');
    expect(studies.map((node) => node.taskId)).toEqual(tasks);
    const chain = ['start', ...studies.map(({ id }) => id), 'end'];
    expect(save.body.graph.edges.map(({ from, to }) => [from.nodeId, to.nodeId])).toEqual(
        chain.slice(1).map((nodeId, index) => [chain[index], nodeId]),
    );
    await page.getByRole('button', { name: '发布版本' }).click();
    const version = page.getByRole('combobox', { name: '发布版本', exact: true });
    await expect(version).toHaveValue(versionId);
    await version.selectOption(id(40));
    await expect(page.getByText('尚未运行的发布版本', { exact: false })).toBeVisible();
    await version.selectOption(versionId);
    expect(state.publishTags).toEqual(['"2"']);
    await page.getByRole('button', { name: '启动运行' }).click();
    await expect(page.getByText('启动响应暂时不可用')).toBeVisible();
    await page.getByRole('button', { name: '启动运行' }).click();
    await expect(page.getByRole('heading', { name: '运行详情' })).toBeFocused();
    await expect(page.getByText('执行尝试 1')).toBeVisible();
    await expect(page.getByRole('link', { name: '查看研究执行', exact: true })).toHaveAttribute(
        'href',
        `/runs/${childId}`,
    );
    expect(state.startKeys[0]).toBe(state.startKeys[1]);
    await page.getByRole('button', { name: '取消运行' }).click();
    await expect(page.getByText('取消中 · 正式运行')).toBeVisible();
    if (state.run) {
        state.run.status = 'canceled';
        state.run.finishedAt = instant;
    }
    await expect(page.getByText('已取消 · 正式运行')).toBeVisible({ timeout: 8_000 });
});

test('draft conflict preserves local input and can reload on a narrow viewport', async ({
    page,
}) => {
    await page.setViewportSize({ width: 360, height: 800 });
    const state = await fixtures(page);
    await page.goto(`/workflows/${workflowId}`);
    const title = page.getByLabel('工作流名称', { exact: true });
    await title.fill('本地草稿');
    state.detail.workflow.revision = 2;
    state.detail.workflow.title = '其他窗口保存的草稿';
    await page.getByRole('button', { name: '保存草稿', exact: true }).click();
    await expect(page.getByText('草稿已在其他位置更新。', { exact: false })).toBeFocused();
    await expect(title).toHaveValue('本地草稿');
    await page.getByRole('button', { name: '重新载入草稿' }).click();
    await expect(title).toHaveValue('其他窗口保存的草稿');
    await expect(page.getByRole('button', { name: '发布版本' })).toBeDisabled();
    await page.getByRole('button', { name: '添加研究节点' }).click();
    await expect(page.getByLabel('研究 1 的任务')).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(360);
});

test('a seeded legacy graph can form parallel stages, reopen and split them', async ({ page }) => {
    const state = await fixtures(page);
    await page.goto(`/workflows/${workflowId}`);
    const add = page.getByRole('button', { name: '添加研究节点' });
    await add.click();
    await page.getByLabel('研究 1 的任务').selectOption(tasks[0]!);
    await add.click();
    await page.getByLabel('研究 2 的任务').selectOption(tasks[1]!);

    const merge = page.getByRole('button', { name: '与上一阶段并行' });
    await merge.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByText('已合并为包含 2 项研究的并行组')).toBeVisible();
    await expect(page.getByLabel('研究 2 的任务')).toBeFocused();
    const groupLabels = page.getByText(/研究 [12] · 阶段 1（并行）/);
    await expect(groupLabels).toHaveCount(2);

    const save = page.getByRole('button', { name: '保存草稿', exact: true });
    const publish = page.getByRole('button', { name: '发布版本' });
    await save.click();
    await expect(publish).toBeEnabled();
    const fork = state.saveCalls[0]!.body.graph;
    expect(fork.edges.filter(({ from }) => from.nodeId === 'start')).toHaveLength(2);
    expect(fork.edges.filter(({ to }) => to.nodeId === 'end')).toHaveLength(2);
    await publish.click();
    await expect(publish).toBeDisabled();
    await expect.poll(() => state.detail.publishedVersion?.graph).toEqual(fork);

    await page.reload();
    await expect(groupLabels).toHaveCount(2);
    await page.getByRole('button', { name: '移到下一独立阶段' }).click();
    await expect(groupLabels).toHaveCount(0);
    await save.click();
    await expect(publish).toBeEnabled();
    expect(state.saveCalls[1]!.body.graph.edges).toHaveLength(3);
    expect(state.detail.publishedVersion?.graph).toEqual(fork);
});

test('canvas persists two-dimensional layout and edited edges across reopening', async ({
    page,
}) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const initial: WorkflowCanvasGraph = {
        version: 2,
        nodes: [
            { id: 'start', type: 'start' },
            { id: 'clean', type: 'csv', config: { filters: [] } },
            { id: 'end', type: 'end' },
        ],
        edges: [
            { from: { nodeId: 'start', port: 'out' }, to: { nodeId: 'clean', port: 'in' } },
            { from: { nodeId: 'clean', port: 'out' }, to: { nodeId: 'end', port: 'in' } },
        ],
        layout: {
            positions: {
                start: { x: 40, y: 60 },
                clean: { x: 320, y: 60 },
                end: { x: 600, y: 60 },
            },
            groups: [],
        },
    };
    const state = await fixtures(page, initial);
    await page.goto(`/workflows/${workflowId}`);
    const canvas = page.getByRole('region', { name: '工作流画布编辑器' });
    await canvas.getByRole('button', { name: '画布', exact: true }).click();
    const handle = canvas.getByRole('button', { name: '移动整理 CSV，使用方向键' });
    const node = canvas.locator('.canvas-node').filter({
        has: page.getByRole('button', { name: '移动整理 CSV，使用方向键' }),
    });
    const edges = canvas.locator('.canvas-edge-line');
    const left = async () =>
        node.evaluate((element) => Number.parseInt((element as HTMLElement).style.left, 10));
    const top = async () =>
        node.evaluate((element) => Number.parseInt((element as HTMLElement).style.top, 10));
    await expect(edges).toHaveCount(2);
    await expect.poll(left).toBe(320);
    await handle.scrollIntoViewIfNeeded();
    const bounds = await handle.boundingBox();
    expect(bounds).not.toBeNull();
    const x = bounds!.x + bounds!.width / 2;
    const y = bounds!.y + bounds!.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 38, y + 81, { steps: 8 });
    await page.mouse.up();
    await expect.poll(left).toBeGreaterThan(320);
    await expect.poll(top).toBeGreaterThan(60);
    const moved = { x: await left(), y: await top() };
    await expect(edges).toHaveCount(2);
    await canvas.getByRole('button', { name: '撤销' }).click();
    await expect.poll(left).toBe(320);
    await expect.poll(top).toBe(60);
    await canvas.getByRole('button', { name: '重做' }).click();
    await expect.poll(top).toBe(moved.y);

    await canvas.getByRole('button', { name: '开始的输出端口' }).click();
    await canvas.getByRole('button', { name: '结束的输入端口' }).click();
    await expect(edges).toHaveCount(3);
    const remove = canvas.getByRole('button', { name: '移除 开始 到 结束 的连线' });
    await remove.press('Enter');
    await expect(edges).toHaveCount(2);
    await canvas.getByRole('button', { name: '撤销' }).click();
    await expect(edges).toHaveCount(3);
    await page.getByRole('button', { name: '保存草稿', exact: true }).click();
    await expect(page.getByText('已保存草稿', { exact: true })).toBeVisible();
    const saved = state.saveCalls[0]!.body.graph;
    if (!isWorkflowCanvasGraph(saved)) throw new Error('Expected a V2 workflow draft');
    expect(saved.layout.positions.clean).toEqual(moved);
    expect(saved.edges).toEqual([
        ...initial.edges,
        { from: { nodeId: 'start', port: 'out' }, to: { nodeId: 'end', port: 'in' } },
    ]);

    await page.reload();
    await canvas.getByRole('button', { name: '画布', exact: true }).click();
    await expect.poll(left).toBe(moved.x);
    await expect.poll(top).toBe(moved.y);
    await expect(edges).toHaveCount(3);
    await expect(canvas.getByRole('button', { name: '撤销' })).toBeDisabled();
    await canvas.getByRole('button', { name: '结束的输入端口' }).press('Enter');
    await expect(remove).toBeVisible();
});

test('canvas source pickers match the material each upstream node can produce', async ({
    page,
}) => {
    const nodes: WorkflowCanvasGraph['nodes'] = [
        { id: 'start', type: 'start' },
        { id: 'table', type: 'csv', label: '上游表格', config: { filters: [] } },
        {
            id: 'csv-file',
            type: 'deliver',
            label: '上游 CSV 文件',
            config: { source: 'table', format: 'csv', filename: 'table.csv' },
        },
        { id: 'study', type: 'study', taskId: tasks[0]! },
        {
            id: 'markdown-file',
            type: 'deliver',
            label: '上游 Markdown 文件',
            config: { source: 'study', format: 'markdown', filename: 'study.md' },
        },
        {
            id: 'generated',
            type: 'generate',
            label: '上游生成',
            config: { sources: [], instructions: '总结' },
        },
        { id: 'merge', type: 'merge' },
        { id: 'csv-target', type: 'csv', label: '下游整理', config: { filters: [] } },
        {
            id: 'csv-delivery',
            type: 'deliver',
            label: '下游 CSV 交付',
            config: { source: '', format: 'csv', filename: '' },
        },
        {
            id: 'markdown-delivery',
            type: 'deliver',
            label: '下游 Markdown 交付',
            config: { source: '', format: 'markdown', filename: '' },
        },
        { id: 'notice', type: 'notify', config: { title: '结果已就绪', body: '查看交付文件' } },
        {
            id: 'generate-target',
            type: 'generate',
            label: '下游生成',
            config: { sources: [], instructions: '' },
        },
        { id: 'end', type: 'end' },
    ];
    const inputs = nodes.slice(0, 7);
    const targets = nodes.slice(7, -1);
    const edge = (from: string, to: string): WorkflowCanvasGraph['edges'][number] => ({
        from: { nodeId: from, port: 'out' },
        to: { nodeId: to, port: 'in' },
    });
    await fixtures(page, {
        version: 2,
        nodes,
        edges: [
            ...inputs.slice(1).map((node, index) => edge(inputs[index]!.id, node.id)),
            edge('study', 'merge'),
            ...targets.flatMap((node) => [edge('merge', node.id), edge(node.id, 'end')]),
        ],
        layout: { positions: {}, groups: [] },
    });
    await page.goto(`/workflows/${workflowId}`);
    const canvas = page.getByRole('region', { name: '工作流画布编辑器' });
    await canvas.getByRole('button', { name: '步骤列表', exact: true }).click();
    const list = canvas.getByRole('region', { name: '工作流步骤' });
    const material = canvas.getByRole('combobox', { name: '数据来源' });
    for (const [name, choices] of [
        ['下游整理', ['使用本次运行的 CSV', '开始', '上游表格', '上游 CSV 文件']],
        ['下游 CSV 交付', ['选择上游节点', '上游表格', '上游 CSV 文件']],
        ['下游 Markdown 交付', ['选择上游节点', '开始', '研究', '上游 Markdown 文件', '上游生成']],
        ['通知', ['不附加交付文件', '上游 CSV 文件', '上游 Markdown 文件']],
    ] as const) {
        await list.getByRole('button', { name: new RegExp(`^${name}`) }).click();
        await expect(material.getByRole('option')).toHaveText([...choices]);
    }
    await list.getByRole('button', { name: /^下游生成/ }).click();
    const generation = canvas.getByRole('group', { name: '生成来源' });
    await expect(generation.getByRole('checkbox', { name: '汇合' })).toHaveCount(0);
    await expect(generation.getByRole('checkbox', { name: '上游 Markdown 文件' })).toBeVisible();
});
