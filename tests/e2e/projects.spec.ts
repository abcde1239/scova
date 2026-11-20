import { expect, test } from '@playwright/test';
import { mockFixtureSession } from './support/session-sample.ts';

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

test('项目用户旅程使用项目契约关联和解除任务，查看近期成果，并删除项目', async ({ page }) => {
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
    await expect(page.getByText('暂无关联任务')).toBeVisible();
    await page.getByLabel('选择要关联或移入的任务').selectOption(taskId);
    await page.getByRole('button', { name: '关联任务', exact: true }).click();
    await expect(
        page.getByRole('region', { name: '关联任务' }).getByRole('link', { name: task.title }),
    ).toHaveAttribute('href', `/tasks/${taskId}`);
    await expect(page.getByRole('region', { name: '最近执行' }).getByRole('link')).toHaveAttribute(
        'href',
        `/runs/${runId}`,
    );
    await expect(page.getByRole('link', { name: '研究报告' })).toHaveAttribute(
        'href',
        `/reports/${reportId}`,
    );
    await page.getByRole('button', { name: `解除关联 ${task.title}` }).click();
    await expect(page.getByText('暂无关联任务')).toBeVisible();
    await expect(page.getByText('暂无执行记录')).toBeVisible();
    await page.getByRole('button', { name: '删除项目', exact: true }).click();
    await page.getByRole('button', { name: '确认删除项目' }).click();
    await expect(page).toHaveURL('/projects');
    await expect(page.getByText('暂无项目')).toBeVisible();
});
