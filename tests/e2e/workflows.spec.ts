import { expect, test, type Page } from '@playwright/test';
import type { WorkflowGraph, WorkflowRun, WorkflowRunNode } from '@scova/models';
import type { WorkflowDetail, WorkflowDraft } from '../../apps/web/src/api/workflows.ts';
import { mockFixtureSession } from './support/session-sample.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const workflowId = id(11);
const versionId = id(12);
const runId = id(13);
const childId = id(14);
const tasks = [id(21), id(22)];
const instant = '2026-10-31T00:00:00Z';
const graph: WorkflowGraph = {
    nodes: [
        { id: 'start', type: 'start' },
        { id: 'end', type: 'end' },
    ],
    edges: [{ from: { nodeId: 'start', port: 'out' }, to: { nodeId: 'end', port: 'in' } }],
};

// HTTP contract samples exercise the real UI. Workflow orchestration is verified separately.
async function fixtures(page: Page) {
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
            draft: graph,
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
            expect(request.postDataJSON()).toEqual({ versionId });
            state.startKeys.push(key);
            const published = state.detail.publishedVersion!;
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
                nodes: published.graph.nodes.map((node, index): WorkflowRunNode => ({
                    id: node.id,
                    type: node.type,
                    status: index === 0 ? 'succeeded' : index === 1 ? 'running' : 'pending',
                    attempt: index === 1 ? 1 : 0,
                    startedAt: index < 2 ? instant : null,
                    finishedAt: index === 0 ? instant : null,
                    taskId: node.type === 'study' ? node.taskId : null,
                    taskVersionId:
                        published.bindings.find((binding) => binding.nodeId === node.id)
                            ?.taskVersionId ?? null,
                    childRunId: index === 1 ? childId : null,
                    childStatus: index === 1 ? 'queued' : null,
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

test('serial editor saves order and runs a frozen version with idempotent retries', async ({
    page,
}, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const state = await fixtures(page);
    await page.goto('/workflows');
    await expect(page.getByText('暂无工作流', { exact: true })).toBeVisible();
    await page.getByLabel('新工作流名称').fill('研究工作流');
    await page.getByRole('button', { name: '创建工作流' }).click();
    await expect(page).toHaveURL(`/workflows/${workflowId}`);
    const add = page.getByRole('button', { name: '添加研究节点' });
    await add.focus();
    await page.keyboard.press('Enter');
    const first = page.getByLabel('研究 1 的任务');
    await expect(first).toBeFocused();
    await expect(first.getByRole('option', { name: '调研任务 1' })).toHaveCount(1);
    await first.press('ArrowDown');
    await first.press('Enter');
    await expect(first).toHaveValue(tasks[0]!);
    await add.click();
    const second = page.getByLabel('研究 2 的任务');
    await second.selectOption(tasks[1]!);
    const moveUp = page.getByRole('button', { name: '上移研究 2' });
    await moveUp.focus();
    await moveUp.press('Enter');
    await expect(first).toHaveValue(tasks[1]!);
    await expect(page.getByRole('button', { name: '下移研究 1' })).toBeFocused();
    const handle = page.locator('[draggable="true"]').nth(1);
    const firstStudy = page.locator('[data-node-id]').first();
    await handle.dragTo(firstStudy);
    const firstNode = page.getByRole('button', { name: /研究 1\s*调研任务 1/ });
    await firstNode.click();
    await expect(firstNode).toHaveAttribute('aria-pressed', 'true');
    await expect(first).toHaveValue(tasks[0]!);
    await page
        .locator('.workflow-board')
        .screenshot({ path: testInfo.outputPath('workflow-editor-1280.png') });
    await page.getByRole('button', { name: '保存草稿' }).click();
    await expect(page.getByText('已保存草稿', { exact: true })).toBeVisible();
    const save = state.saveCalls[0]!;
    expect(save.tag).toBe('"1"');
    expect(
        save.body.graph.nodes.flatMap((node) => (node.type === 'study' ? [node.taskId] : [])),
    ).toEqual(tasks);
    expect(save.body.graph.edges.map((edge) => edge.to.nodeId)).toEqual(
        save.body.graph.nodes.slice(1).map((node) => node.id),
    );
    await page.getByRole('button', { name: '发布版本' }).click();
    const version = page.getByLabel('发布版本');
    await expect(version).toHaveValue(versionId);
    await version.selectOption(id(40));
    await expect(page.getByText('尚未运行的发布版本', { exact: false })).toBeVisible();
    await version.selectOption(versionId);
    expect(state.publishTags).toEqual(['"2"']);
    await page.getByRole('button', { name: '启动运行' }).click();
    await expect(page.getByText('启动响应暂时不可用')).toBeVisible();
    await page.getByRole('button', { name: '重试启动' }).click();
    await expect(page.getByRole('heading', { name: '运行详情' })).toBeFocused();
    await expect(page.getByText('执行尝试 1')).toBeVisible();
    await expect(page.getByRole('link', { name: '查看研究执行（排队中）' })).toHaveAttribute(
        'href',
        `/runs/${childId}`,
    );
    expect(state.startKeys[0]).toBe(state.startKeys[1]);
    await page.getByRole('button', { name: '取消运行' }).click();
    await expect(page.getByText('取消中 · 实际运行')).toBeVisible();
    if (state.run) {
        state.run.status = 'canceled';
        state.run.finishedAt = instant;
    }
    await expect(page.getByText('已取消 · 实际运行')).toBeVisible({ timeout: 8_000 });
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
    await page.getByRole('button', { name: '保存草稿' }).click();
    await expect(page.getByText('草稿已在其他位置更新。', { exact: false })).toBeFocused();
    await expect(title).toHaveValue('本地草稿');
    await page.getByRole('button', { name: '重新载入草稿' }).click();
    await expect(title).toHaveValue('其他窗口保存的草稿');
    await expect(page.getByRole('button', { name: '发布版本' })).toBeDisabled();
    await page.getByRole('button', { name: '添加研究节点' }).click();
    await expect(page.getByLabel('研究 1 的任务')).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(360);
});

test('parallel groups can be created by keyboard, reopened and split into separate stages', async ({
    page,
}) => {
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

    const save = page.getByRole('button', { name: '保存草稿' });
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
