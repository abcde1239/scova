import { expect, test } from '@playwright/test';
import { mockFixtureSession } from './support/session-sample.ts';

const projectId = '00000000-0000-4000-8000-000000000011';
const threadId = '00000000-0000-4000-8000-000000000012';
const turnId = '00000000-0000-4000-8000-000000000013';
const actionId = '00000000-0000-4000-8000-000000000014';
const timestamp = '2026-11-24T08:00:00Z';
const project = { id: projectId, name: '开源许可证追踪', createdAt: timestamp };
const thread = {
    id: threadId,
    projectId,
    title: '新会话',
    isDefault: false,
    archivedAt: null,
    lastActivityAt: timestamp,
    createdAt: timestamp,
};
const receipt = { kind: 'ready', projectId, threadId, turnId };
const nextPath = `/projects/${projectId}/threads/${threadId}`;

test.beforeEach(async ({ page }) => {
    await page.route('**/api/v1/**', (route) =>
        route.fulfill({
            status: 404,
            json: { code: 'NOT_FOUND', message: 'Fixture route missing', requestId: 'fixture' },
        }),
    );
    await mockFixtureSession(page);
    await page.route('**/api/v1/projects?*', (route) =>
        route.fulfill({ json: { items: [project], nextCursor: null } }),
    );
    await page.route(`**/api/v1/projects/${projectId}/threads`, (route) =>
        route.fulfill({ json: { items: [thread] } }),
    );
    await page.route(`**/api/v1/threads/${threadId}`, (route) =>
        route.fulfill({ json: { thread, items: [], lastSeq: 0, hasMore: false } }),
    );
});

test('requests an explicit choice when automatic routing is uncertain, then opens the chosen thread', async ({
    page,
}) => {
    const seen: unknown[] = [];
    await page.route('**/api/v1/workspace/home', (route) =>
        route.fulfill({
            json: {
                pending: [
                    {
                        id: actionId,
                        projectId,
                        projectName: project.name,
                        threadId,
                        threadTitle: thread.title,
                    },
                ],
                recentProjects: [{ ...project, lastActivityAt: timestamp }],
            },
        }),
    );
    await page.route('**/api/v1/workspace/intake', (route) => {
        const body = route.request().postDataJSON();
        seen.push(body);
        return route.fulfill({
            json:
                body.destination.kind === 'auto'
                    ? {
                          kind: 'choose-project',
                          candidates: [{ id: project.id, name: project.name }],
                      }
                    : receipt,
        });
    });
    await page.route(`**/api/v1/threads/${threadId}/turns`, (route) => {
        seen.push(route.request().postDataJSON());
        return route.fulfill({ json: { turnId, status: 'completed' } });
    });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: '今天想研究什么？' })).toBeVisible();
    await expect(page.getByRole('link', { name: `打开会话：${thread.title}` })).toHaveAttribute(
        'href',
        nextPath,
    );
    await expect(page.getByLabel('研究需求')).toHaveAttribute('maxlength', '2000');
    await page.getByLabel('研究需求').fill('看看本周有什么变更');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(page.getByText('请选择已有项目，或新建一个项目。')).toBeVisible();
    const select = page.getByLabel('归入项目');
    await expect(select).toBeFocused();
    await select.selectOption(projectId);
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(page).toHaveURL(nextPath);
    expect(seen).toEqual([
        { message: '看看本周有什么变更', destination: { kind: 'auto' } },
        { message: '看看本周有什么变更', destination: { kind: 'project', projectId } },
        { turnId, message: '看看本周有什么变更' },
    ]);
});

test('starts from an empty mobile homepage and retries both requests without changing their identities', async ({
    page,
}) => {
    await page.setViewportSize({ width: 375, height: 760 });
    await page.route('**/api/v1/projects?*', (route) =>
        route.fulfill({ json: { items: [], nextCursor: null } }),
    );
    await page.route('**/api/v1/workspace/home', (route) =>
        route.fulfill({ json: { pending: [], recentProjects: [] } }),
    );
    const keys: string[] = [];
    const turns: unknown[] = [];
    await page.route('**/api/v1/workspace/intake', (route) => {
        keys.push(route.request().headers()['idempotency-key']!);
        return keys.length === 1
            ? route.abort('connectionreset')
            : route.fulfill({ json: receipt });
    });
    await page.route(`**/api/v1/threads/${threadId}/turns`, (route) => {
        turns.push(route.request().postDataJSON());
        return turns.length === 1
            ? route.abort('connectionreset')
            : route.fulfill({ json: { turnId, status: 'completed' } });
    });
    await page.goto('/');
    const independent = page.getByRole('link', { name: '创建独立任务' }).last();
    await expect(independent).toHaveAttribute('href', '/tasks/new');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        375,
    );
    await independent.click();
    await expect(page).toHaveURL('/tasks/new');
    await page.goBack();
    await page.getByRole('button', { name: '新建项目并开始对话' }).click();
    const message = page.getByLabel('研究需求');
    await expect(message).toBeFocused();
    await message.fill('追踪许可证变化');
    await page.getByLabel('新项目名称').fill(project.name);
    const send = page.getByRole('button', { name: '发送', exact: true });
    await send.click();
    await expect.poll(() => keys.length).toBe(1);
    await expect(send).toBeEnabled();
    await send.click();
    await expect(page.getByRole('link', { name: '打开已创建的会话' })).toBeVisible();
    await page.getByRole('button', { name: '重试发送' }).click();
    await expect(page).toHaveURL(nextPath);
    expect(keys).toEqual([expect.any(String), keys[0]]);
    expect(turns).toEqual([
        { turnId, message: '追踪许可证变化' },
        { turnId, message: '追踪许可证变化' },
    ]);
});

test('recovers a classified first message after a reload without changing either request identity', async ({
    page,
}) => {
    await page.route('**/api/v1/workspace/home', (route) =>
        route.fulfill({ json: { pending: [], recentProjects: [] } }),
    );
    const keys: string[] = [];
    const turns: unknown[] = [];
    await page.route('**/api/v1/workspace/intake', (route) => {
        keys.push(route.request().headers()['idempotency-key']!);
        return route.fulfill({ json: receipt });
    });
    await page.route(`**/api/v1/threads/${threadId}/turns`, (route) => {
        turns.push(route.request().postDataJSON());
        return turns.length === 1
            ? route.abort('connectionreset')
            : route.fulfill({ json: { turnId, status: 'completed' } });
    });
    await page.goto('/');
    await page.getByLabel('研究需求').fill('请总结研究结论');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(page.getByRole('button', { name: '重试发送' })).toBeVisible();
    await page.reload();
    await expect(page).toHaveURL(nextPath);
    expect(keys).toEqual([expect.any(String), keys[0]]);
    expect(turns).toEqual(Array.from({ length: 2 }, () => ({ turnId, message: '请总结研究结论' })));
    await page.goto('/');
    await expect(page.getByLabel('研究需求')).toBeVisible();
    expect(turns).toHaveLength(2);
});
