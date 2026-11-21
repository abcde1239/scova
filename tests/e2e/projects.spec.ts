import { expect, test, type Page } from '@playwright/test';
import type { Project } from '@scova/models';
import { mockFixtureSession } from './support/session-sample.ts';

const projectView = (page: Page, name: string) =>
    page.getByRole('group', { name: '项目视图' }).getByRole('button', { name, exact: true });

const projectId = '00000000-0000-4000-8000-000000000011';
const taskId = '00000000-0000-4000-8000-000000000012';
const runId = '00000000-0000-4000-8000-000000000013';
const reportId = '00000000-0000-4000-8000-000000000014';
const time = '2026-11-20T01:00:00.000Z';
const project = { id: projectId, name: '长期研究', createdAt: time };
const task = {
    id: taskId,
    title: '本地任务',
    status: 'active',
    nextRunAt: null,
    currentVersionId: '00000000-0000-4000-8000-000000000015',
    revision: 1,
    createdAt: time,
    updatedAt: time,
};

test('项目用户旅程使用项目契约关联和解除任务，查看近期成果，并删除项目', async ({
    page,
}, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await mockFixtureSession(page);
    let created = false;
    let linked = false;
    await page.route('**/api/v1/tasks?*', (route) =>
        route.fulfill({ json: { items: [task], nextCursor: null } }),
    );
    await page.route('**/api/v1/projects**', async (route) => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        const method = request.method();
        if (method !== 'GET') expect(request.headers()['x-csrf-token']).toBe('fixture-only');
        if (path.endsWith(`/tasks/${taskId}`)) {
            linked = method === 'PUT';
            await route.fulfill({ status: 204 });
        } else if (method === 'POST') {
            expect(request.postDataJSON()).toEqual({ name: project.name });
            created = true;
            await route.fulfill({ status: 201, json: project });
        } else if (method === 'DELETE') {
            created = false;
            await route.fulfill({ status: 204 });
        } else if (path.endsWith('/conversation')) {
            await route.fulfill({ json: { turns: [], drafts: [] } });
        } else if (path.endsWith(projectId)) {
            await route.fulfill({
                json: {
                    project,
                    tasks: {
                        items: linked
                            ? [
                                  {
                                      id: task.id,
                                      title: task.title,
                                      status: task.status,
                                      nextRunAt: null,
                                  },
                              ]
                            : [],
                        nextCursor: null,
                    },
                    recentRuns: linked
                        ? [
                              {
                                  id: runId,
                                  title: task.title,
                                  taskId,
                                  status: 'succeeded',
                                  queuedAt: time,
                              },
                          ]
                        : [],
                    recentReports: linked
                        ? [{ id: reportId, title: '研究报告', taskId, runId, publishedAt: time }]
                        : [],
                },
            });
        } else {
            await route.fulfill({ json: { items: created ? [project] : [], nextCursor: null } });
        }
    });

    await page.goto('/projects');
    await expect(page.getByText('暂无项目')).toBeVisible();
    await page.getByLabel('新项目名称').fill(project.name);
    await page.getByRole('button', { name: '创建项目', exact: true }).click();
    await expect(page).toHaveURL(`/projects/${projectId}`);
    await expect(projectView(page, '对话')).toHaveAttribute('aria-pressed', 'true');
    await projectView(page, '研究任务').click();
    await expect(page.getByText('暂无关联任务')).toBeVisible();
    await page.getByLabel('选择要关联或移入的任务').selectOption(taskId);
    await page.getByRole('button', { name: '关联任务', exact: true }).click();
    await expect(
        page.getByRole('region', { name: '研究任务' }).getByRole('link', { name: task.title }),
    ).toHaveAttribute('href', `/tasks/${taskId}`);
    await projectView(page, '概览').click();
    await expect(page.getByRole('region', { name: '最近执行' }).getByRole('link')).toHaveAttribute(
        'href',
        `/runs/${runId}`,
    );
    await expect(page.getByRole('link', { name: '研究报告' })).toHaveAttribute(
        'href',
        `/reports/${reportId}`,
    );
    await projectView(page, '对话').click();
    await expect(page.getByRole('complementary', { name: '项目概览' })).toBeVisible();
    await page.screenshot({
        path: testInfo.outputPath('project-workspace-1440.png'),
        fullPage: true,
    });
    await projectView(page, '研究任务').click();
    await page.getByRole('button', { name: `解除关联 ${task.title}` }).click();
    await expect(page.getByText('暂无关联任务')).toBeVisible();
    await projectView(page, '概览').click();
    await expect(page.getByText('暂无执行记录')).toBeVisible();
    await page.getByRole('button', { name: '删除项目', exact: true }).click();
    await page.getByRole('button', { name: '确认删除项目' }).click();
    await expect(page).toHaveURL('/projects');
    await expect(page.getByText('暂无项目')).toBeVisible();
});

const draftId = '00000000-0000-4000-8000-000000000016';
const projectPath = `/projects/${projectId}`;
const config = {
    title: '开源动态草案',
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
        maxInputTokens: 40000,
        maxOutputTokens: 8000,
    },
    notificationPreference: { mode: 'summary', runIssues: true },
};
function submission(taskConfig: unknown, started: boolean) {
    return {
        detail: {
            task,
            version: {
                id: task.currentVersionId,
                taskId,
                version: 1,
                configSchemaVersion: 1,
                config: taskConfig,
                comparisonScopeHash: 'a'.repeat(64),
                createdAt: time,
            },
            baselineResetRequired: false,
        },
        runId: started ? runId : null,
    };
}

const projectDetail = {
    project,
    tasks: { items: [], nextCursor: null },
    nextRun: { taskId, title: '下一页的周期任务', at: time },
    recentRuns: [],
    recentReports: [],
};

test('项目手动表单在响应丢失后只重试原提交并打开执行详情', async ({ page }) => {
    await mockFixtureSession(page);
    await page.route('**/api/v1/tasks?*', (route) =>
        route.fulfill({ json: { items: [], nextCursor: null } }),
    );
    await page.route(`**/api/v1${projectPath}?*`, (route) =>
        route.fulfill({ json: projectDetail }),
    );
    await page.route(`**/api/v1${projectPath}/conversation`, (route) =>
        route.fulfill({ json: { turns: [], drafts: [] } }),
    );
    const attempts: { key?: string; body: { config: unknown; start: boolean } }[] = [];
    await page.route(`**/api/v1${projectPath}/tasks`, (route) => {
        const request = route.request();
        const body = request.postDataJSON();
        attempts.push({ key: request.headers()['idempotency-key'], body });
        return attempts.length === 1
            ? route.abort('connectionreset')
            : route.fulfill({ status: 201, json: submission(body.config, true) });
    });
    await page.goto(projectPath);
    await expect(page.getByRole('link', { name: '下一页的周期任务' })).toHaveAttribute(
        'href',
        `/tasks/${taskId}`,
    );
    await page.getByRole('main').getByRole('link', { name: '新建任务' }).click();
    await expect(page).toHaveURL(`${projectPath}/tasks/new`);
    await page.getByLabel('任务标题', { exact: true }).fill('项目研究');
    await page.getByLabel('查阅主题', { exact: true }).fill('开源发布');
    await page.getByLabel('查阅目标', { exact: true }).fill('查阅许可证变更');
    await page.getByRole('button', { name: '保存并立即运行' }).click();
    await expect(page.getByText(/提交结果未确认/)).toBeVisible();
    expect(attempts).toHaveLength(1);
    await page.getByRole('button', { name: '重试同一次提交' }).click();
    await expect(page).toHaveURL(`/runs/${runId}`);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({ key: expect.any(String), body: { start: true } });
    expect(attempts[1]).toEqual(attempts[0]);
});

test('项目对话草案刷新后进入共享表单，保存修订后确认运行', async ({ page }, testInfo) => {
    await mockFixtureSession(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.route('**/api/v1/tasks?*', (route) =>
        route.fulfill({ json: { items: [], nextCursor: null } }),
    );
    await page.route(`**/api/v1${projectPath}?*`, (route) =>
        route.fulfill({ json: projectDetail }),
    );
    let draft = {
        id: draftId,
        revision: 1,
        config,
        taskId: null as string | null,
        runId: null as string | null,
    };
    let turns: unknown[] = [];
    const snapshot = () => ({ turns, drafts: turns.length ? [draft] : [] });
    await page.route(`**/api/v1${projectPath}/conversation`, (route) =>
        route.fulfill({ json: snapshot() }),
    );
    await page.route(`**/api/v1${projectPath}/conversation/turns`, (route) => {
        const { turnId, message, kind } = route.request().postDataJSON();
        expect({ message, kind }).toEqual({ message: config.goal, kind: 'draft' });
        turns = [
            {
                id: turnId,
                message,
                kind,
                status: 'completed',
                answer: '草案已准备',
                reportId: null,
                draftId,
            },
        ];
        return route.fulfill({ json: snapshot() });
    });
    await page.route(`**/api/v1${projectPath}/drafts/${draftId}`, (route) => {
        const edit = route.request().postDataJSON();
        expect(edit).toMatchObject({
            revision: 1,
            config: { title: '共享表单的修订标题', goal: config.goal },
        });
        draft = { ...draft, revision: 2, config: edit.config };
        return route.fulfill({ json: draft });
    });
    await page.route(`**/api/v1${projectPath}/drafts/${draftId}/confirm`, (route) => {
        expect(route.request().postDataJSON()).toEqual({ revision: 2, start: true });
        draft = { ...draft, taskId, runId };
        return route.fulfill({ json: submission(draft.config, true) });
    });
    await page.goto(projectPath);
    const composer = page.getByLabel('消息', { exact: true });
    const overview = page.getByRole('complementary', { name: '项目概览' });
    await expect(overview).toBeHidden();
    await composer.fill(config.goal);
    await projectView(page, '概览').click();
    await expect(overview).toBeVisible();
    await expect(composer).toBeHidden();
    await projectView(page, '对话').click();
    await expect(composer).toHaveValue(config.goal);
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(page.getByRole('heading', { name: config.title })).toBeVisible();
    await page.reload();
    await expect(page.getByText('草案已准备')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        390,
    );
    const history = page.getByRole('region', { name: '对话记录' });
    const editDraft = history.getByRole('link', { name: '在表单中编辑' });
    await history.evaluate((element) => (element.scrollTop = element.scrollHeight));
    const historyBounds = (await history.boundingBox())!;
    expect((await composer.boundingBox())!.y).toBeGreaterThan(
        historyBounds.y + historyBounds.height,
    );
    await page.screenshot({ path: testInfo.outputPath('draft-recovery-390.png'), fullPage: true });
    await expect(editDraft).toBeInViewport();
    await page.getByRole('link', { name: '在表单中编辑' }).click();
    await expect(page).toHaveURL(`${projectPath}/drafts/${draftId}/edit`);
    await expect(page.getByLabel('任务标题', { exact: true })).toHaveValue(config.title);
    await page.getByLabel('任务标题', { exact: true }).fill('共享表单的修订标题');
    await page.getByRole('button', { name: '保存草案' }).click();
    await expect(page).toHaveURL(projectPath);
    await expect(page.getByRole('heading', { name: '共享表单的修订标题' })).toBeVisible();
    await page.getByRole('button', { name: '保存并立即运行' }).click();
    await expect(page.getByRole('link', { name: '查看执行' })).toHaveAttribute(
        'href',
        `/runs/${runId}`,
    );
});

const taskPath = `/tasks/${taskId}`;
const membershipPath = `/api/v1${taskPath}/project`;
const membershipUrl = (id: string) => `/api/v1/projects/${id}/tasks/${taskId}`;
const otherProject = {
    id: '00000000-0000-4000-8000-000000000017',
    name: '政策观察',
    createdAt: time,
};
const newProject = {
    id: '00000000-0000-4000-8000-000000000018',
    name: '任务发起的研究项目',
    createdAt: time,
};

async function classificationSample(
    page: Page,
    {
        initialProject = null,
        writeGate,
    }: { initialProject?: Project | null; writeGate?: Promise<void> } = {},
) {
    await mockFixtureSession(page);
    await page.route('**/api/v1/me/agent-providers', (route) =>
        route.fulfill({ json: { items: [], systemConfigured: true, storageReady: true } }),
    );
    const writes: { method: string; path: string; body: unknown }[] = [];
    const projects = [project, otherProject];
    let currentProject = initialProject;
    await page.route(/\/api\/v1\/(?:tasks|projects)(?:[/?]|$)/, async (route) => {
        const request = route.request();
        const { pathname: path } = new URL(request.url());
        const method = request.method();
        const targetProject = projects.find(({ id }) => path === membershipUrl(id));
        if (method !== 'GET') {
            const body: unknown = request.postData() ? request.postDataJSON() : undefined;
            writes.push({ method, path, body });
            expect(request.headers()['x-csrf-token']).toBe('fixture-only');
            await writeGate;
            if (method === 'PUT' && targetProject) {
                currentProject = targetProject;
                return route.fulfill({ status: 204 });
            }
            if (method === 'DELETE' && targetProject) {
                if (currentProject?.id === targetProject.id) currentProject = null;
                return route.fulfill({ status: 204 });
            }
            if (method === 'POST' && path === membershipPath && !currentProject) {
                expect(body).toEqual({ name: newProject.name });
                projects.push(newProject);
                currentProject = newProject;
                return route.fulfill({ status: 201, json: newProject });
            }
            return route.fulfill({ status: 501 });
        }
        if (path === membershipPath) return route.fulfill({ json: { project: currentProject } });
        if (path === `/api/v1${taskPath}`)
            return route.fulfill({
                headers: { etag: '"1"' },
                json: submission({ ...config, title: task.title }, false).detail,
            });
        if (path === `/api/v1${taskPath}/runs`)
            return route.fulfill({ json: { items: [], nextCursor: null } });
        if (path === '/api/v1/tasks')
            return route.fulfill({ json: { items: [task], nextCursor: null } });
        if (path === '/api/v1/projects')
            return route.fulfill({ json: { items: projects, nextCursor: null } });
        for (const item of projects) {
            const projectApiPath = `/api/v1/projects/${item.id}`;
            if (path === projectApiPath)
                return route.fulfill({
                    json: {
                        ...projectDetail,
                        project: item,
                        nextRun: null,
                        tasks: {
                            items:
                                currentProject?.id === item.id
                                    ? [
                                          {
                                              id: task.id,
                                              title: task.title,
                                              status: task.status,
                                              nextRunAt: task.nextRunAt,
                                          },
                                      ]
                                    : [],
                            nextCursor: null,
                        },
                    },
                });
            if (path === `${projectApiPath}/conversation`)
                return route.fulfill({ json: { turns: [], drafts: [] } });
        }
        return route.fallback();
    });
    return writes;
}

const taskProjectRegion = (page: Page) => page.getByRole('region', { name: '项目归类' });

test('未归类任务继续对话只打开项目选择，关闭后未写入', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const writes = await classificationSample(page);
    await page.goto(taskPath);
    const region = taskProjectRegion(page);
    await expect(region.getByText('未归类', { exact: true })).toBeVisible();
    const trigger = region.getByRole('button', { name: '继续对话研究', exact: true });
    await trigger.click();
    const heading = region.getByRole('heading', { name: '选择对话所属的项目', exact: true });
    await expect(heading).toBeFocused();
    await expect(region.getByLabel('已有项目', { exact: true })).toBeVisible();
    await expect(region.getByLabel('新项目名称', { exact: true })).toBeVisible();
    await expect(page).toHaveURL(taskPath);
    expect(writes).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        390,
    );
    await region.screenshot({
        path: testInfo.outputPath('unclassified-task-conversation-picker-390.png'),
    });
    await region.getByRole('button', { name: '关闭', exact: true }).click();
    await expect(heading).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(region.getByText('未归类', { exact: true })).toBeVisible();
    expect(writes).toEqual([]);
});

for (const createProject of [false, true]) {
    test(
        createProject ? '为任务新建并归类后进入项目对话' : '任务归入已有项目成功后进入项目对话',
        async ({ page }) => {
            const { promise: writeGate, resolve: releaseWrite } = Promise.withResolvers<void>();
            const writes = await classificationSample(page, { writeGate });
            const destination = createProject ? newProject : project;
            const expectedWrite = createProject
                ? { method: 'POST', path: membershipPath, body: { name: destination.name } }
                : { method: 'PUT', path: membershipUrl(destination.id), body: undefined };
            await page.goto(taskPath);
            const region = taskProjectRegion(page);
            await region.getByRole('button', { name: '继续对话研究', exact: true }).click();
            if (createProject)
                await region.getByLabel('新项目名称', { exact: true }).fill(destination.name);
            else await region.getByLabel('已有项目', { exact: true }).selectOption(destination.id);
            expect(writes).toEqual([]);
            const submit = region.getByRole('button', {
                name: createProject ? '新建项目并继续对话' : '归类并继续对话',
                exact: true,
            });
            try {
                await submit.click();
                await expect.poll(() => writes.slice()).toEqual([expectedWrite]);
                await expect(submit).toBeDisabled();
                await expect(page).toHaveURL(taskPath);
                await expect(region.getByText('未归类', { exact: true })).toBeVisible();
            } finally {
                releaseWrite();
            }
            await expect(page).toHaveURL(
                `/projects/${destination.id}#project-conversation-heading`,
            );
            const conversation = page.getByRole('region', { name: '项目对话', exact: true });
            await expect(
                conversation.getByRole('heading', { name: '项目对话', exact: true }),
            ).toBeFocused();
            await expect(conversation.getByLabel('消息', { exact: true })).toBeVisible();
            await projectView(page, '研究任务').click();
            await expect(
                page
                    .getByRole('region', { name: '研究任务' })
                    .getByRole('link', { name: task.title }),
            ).toHaveAttribute('href', taskPath);
            expect(writes).toEqual([expectedWrite]);
        },
    );
}

test('任务摘要移动并取消项目归类，任务配置与任务本身保留', async ({ page }) => {
    const writes = await classificationSample(page, { initialProject: project });
    await page.goto(taskPath);
    const region = taskProjectRegion(page);
    await expect(region.getByRole('link', { name: project.name })).toHaveAttribute(
        'href',
        projectPath,
    );
    const change = region.getByRole('button', { name: '更改项目归类', exact: true });
    await change.click();
    await region.getByLabel('已有项目', { exact: true }).selectOption(otherProject.id);
    await region.getByRole('button', { name: '确认归类', exact: true }).click();
    await expect(region.getByRole('link', { name: otherProject.name })).toHaveAttribute(
        'href',
        `/projects/${otherProject.id}`,
    );
    await expect(region.getByRole('heading', { name: '选择项目', exact: true })).toHaveCount(0);
    await expect(page).toHaveURL(taskPath);
    await region.getByRole('button', { name: '继续对话研究', exact: true }).click();
    await expect(page).toHaveURL(`/projects/${otherProject.id}#project-conversation-heading`);
    await expect(page.getByRole('heading', { name: '项目对话', exact: true })).toBeFocused();
    await projectView(page, '研究任务').click();
    await page.getByRole('link', { name: task.title, exact: true }).click();
    await expect(page).toHaveURL(taskPath);
    await change.click();
    await region.getByRole('button', { name: '取消归类', exact: true }).click();
    await expect(region.getByText('未归类', { exact: true })).toBeVisible();
    await page.reload();
    await expect(region.getByText('未归类', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: task.title, exact: true })).toBeVisible();
    await expect(page.getByText(config.goal, { exact: true })).toBeVisible();
    expect(writes).toEqual([
        { method: 'PUT', path: membershipUrl(otherProject.id), body: undefined },
        { method: 'DELETE', path: membershipUrl(otherProject.id), body: undefined },
    ]);
});
