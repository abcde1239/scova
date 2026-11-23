import { expect, test, type Page } from '@playwright/test';
import type {
    WorkflowCanvasGraph,
    WorkflowRun,
    WorkflowTemplate,
    WorkflowTemplateSave,
    WorkflowTemplateStart,
} from '@scova/models';
import type { WorkflowDetail } from '../../apps/web/src/api/workflows.ts';
import { mockFixtureSession } from './support/session-sample.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const templateId = id(90);
const workflowId = id(91);
const versionId = id(92);
const runId = id(93);
const copyId = id(94);
const instant = '2026-11-23T00:00:00Z';
const graph: WorkflowCanvasGraph = {
    version: 2,
    nodes: [
        { id: 'start', type: 'start' },
        { id: 'end', type: 'end' },
    ],
    edges: [{ from: { nodeId: 'start', port: 'out' }, to: { nodeId: 'end', port: 'in' } }],
    layout: { positions: { start: { x: 0, y: 0 }, end: { x: 220, y: 0 } }, groups: [] },
};
const inventory: WorkflowTemplate = {
    id: templateId,
    version: 1,
    kind: 'builtin',
    title: '库存预警清单',
    description: '低库存提醒',
    delivery: 'CSV 文件',
    fields: [
        { key: 'csv', label: '库存 CSV', required: true },
        { key: 'inventoryColumn', label: '库存列名', required: true },
        { key: 'threshold', label: '预警阈值', required: true, default: 10 },
        { key: 'notify', label: '发送站内通知', required: false, default: false },
    ],
    graph,
    requiresBindings: false,
    workflowId: null,
};
const publishedVersion: NonNullable<WorkflowDetail['publishedVersion']> = {
    id: versionId,
    workflowId,
    version: 1,
    draftRevision: 1,
    title: '来源工作流',
    graph,
    bindings: [],
    publishedAt: instant,
};
const detail = (workflow: string, title: string): WorkflowDetail => ({
    workflow: { id: workflow, title, revision: 1, createdAt: instant, updatedAt: instant },
    draft: graph,
    publishedVersion: workflow === workflowId ? publishedVersion : null,
});
const run: WorkflowRun = {
    id: runId,
    workflowId,
    versionId,
    mode: 'live',
    status: 'succeeded',
    createdAt: instant,
    startedAt: instant,
    finishedAt: instant,
    failureCode: null,
    nodes: [],
};

async function fixtures(page: Page) {
    await mockFixtureSession(page);
    const state = {
        starts: [] as { key: string | undefined; body: WorkflowTemplateStart }[],
        saves: [] as WorkflowTemplateSave[],
        copies: 0,
        personal: null as WorkflowTemplate | null,
    };
    await page.route('**/api/v1/workflow-templates**', (route) => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        if (request.method() === 'GET')
            return route.fulfill({
                json: { items: state.personal ? [inventory, state.personal] : [inventory] },
            });
        expect(request.headers()['x-csrf-token']).toBe('fixture-only');
        if (path.endsWith('/start')) {
            expect(path).toBe(`/api/v1/workflow-templates/${templateId}/versions/1/start`);
            state.starts.push({
                key: request.headers()['idempotency-key'],
                body: request.postDataJSON(),
            });
            if (state.starts.length === 1)
                return route.fulfill({
                    status: 503,
                    json: {
                        code: 'SERVICE_UNAVAILABLE',
                        message: '启动响应暂时不可用',
                        requestId: 'fixture',
                    },
                });
            return route.fulfill({ status: 202, json: { run, reused: true } });
        }
        if (path.endsWith('/copy')) {
            expect(path).toBe(`/api/v1/workflow-templates/${templateId}/versions/1/copy`);
            state.copies += 1;
            return route.fulfill({
                status: 201,
                headers: { etag: '"1"' },
                json: detail(copyId, '库存预警清单'),
            });
        }
        expect(path).toBe('/api/v1/workflow-templates');
        const body = request.postDataJSON() as WorkflowTemplateSave;
        state.saves.push(body);
        state.personal = {
            ...inventory,
            id: id(95),
            kind: 'personal',
            title: body.title,
            description: body.description,
            delivery: body.delivery,
            fields: body.fields,
        };
        return route.fulfill({ status: 201, json: state.personal });
    });
    await page.route('**/api/v1/workflows**', (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path.endsWith(`/versions/${versionId}`))
            return route.fulfill({ json: publishedVersion });
        if (path.endsWith('/versions'))
            return route.fulfill({ json: { items: [publishedVersion], nextCursor: null } });
        if (path.endsWith('/runs') || path === '/api/v1/workflows')
            return route.fulfill({ json: { items: [], nextCursor: null } });
        const value = path.endsWith(copyId)
            ? detail(copyId, '库存预警清单')
            : detail(workflowId, '来源工作流');
        return route.fulfill({ headers: { etag: '"1"' }, json: value });
    });
    await page.route(`**/api/v1/workflow-runs/${runId}`, (route) => route.fulfill({ json: run }));
    await page.route('**/api/v1/tasks?**', (route) =>
        route.fulfill({ json: { items: [], nextCursor: null } }),
    );
    return state;
}

test('template form uploads CSV and retries the same input with the same key', async ({ page }) => {
    const state = await fixtures(page);
    await page.goto('/workflows');
    await page.getByRole('button', { name: '使用模板' }).click();
    const form = page.getByRole('form', { name: '库存预警清单' });
    await expect(form.getByLabel('预警阈值')).toHaveValue('10');
    await expect(form.getByLabel('发送站内通知')).not.toBeChecked();
    const csv = '商品,库存\n测试商品,3';
    await form
        .getByLabel('库存 CSV')
        .setInputFiles({ name: 'inventory.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
    await form.getByLabel('库存列名').fill('库存');
    await form.getByLabel('预警阈值').fill('7');
    await form.getByRole('button', { name: '运行模板' }).click();
    await expect(page.getByRole('alert')).toHaveText('启动响应暂时不可用');
    await form.getByRole('button', { name: '运行或重试' }).click();
    await expect(page).toHaveURL(`/workflow-runs/${runId}`);
    expect(state.starts).toHaveLength(2);
    expect(state.starts[0]!.key).toBeTruthy();
    expect(state.starts[0]).toEqual(state.starts[1]);
    expect(state.starts[0]!.body).toEqual({
        input: { csv, inventoryColumn: '库存', threshold: 7, notify: false },
    });
});

test('copies a template to its editor and saves personal field definitions from a published workflow', async ({
    page,
}) => {
    const state = await fixtures(page);
    await page.goto('/workflows');
    await page.getByRole('button', { name: '使用模板' }).click();
    await page.getByRole('button', { name: '复制到画布' }).click();
    await expect(page).toHaveURL(`/workflows/${copyId}`);
    expect(state.copies).toBe(1);

    await page.goto(`/workflows/${workflowId}`);
    await page.getByText('保存为我的模板', { exact: true }).click();
    const form = page.getByRole('form', { name: '从已发布版本保存' });
    await form.getByLabel('模板名称').fill('我的库存模板');
    await form.getByLabel('适用场景').fill('月末补货');
    await form.getByLabel('交付说明').fill('补货清单');
    await form.getByLabel('预警阈值', { exact: true }).check();
    await form.getByLabel('预警阈值必填').check();
    await form.getByLabel('默认阈值').fill('7');
    await form.getByRole('button', { name: '保存模板' }).click();
    await expect(page.getByRole('heading', { name: '我的库存模板' })).toBeVisible();
    expect(state.saves).toEqual([
        {
            workflowId,
            versionId,
            title: '我的库存模板',
            description: '月末补货',
            delivery: '补货清单',
            fields: [{ key: 'threshold', label: '预警阈值', required: true, default: 7 }],
        },
    ]);
});
