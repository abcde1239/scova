import { expect, test, type Page } from '@playwright/test';
import { chooseOption } from './support/select.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const instant = '2026-11-07T00:00:00Z';
const config = {
    title: '执行配置与清除样本',
    topic: '来源变化',
    goal: '核验变化',
    focusPoints: [],
    exclusions: [],
    sourcePreferences: { preferredUrls: [], excludedUrls: [], officialOnly: false },
    timeRange: { kind: 'rolling', days: 7 },
    timezone: 'UTC',
    schedule: { frequency: 'manual' },
    outputFormat: 'brief',
    budget: {
        maxSearches: 10,
        maxPages: 20,
        maxDurationSeconds: 600,
        maxInputTokens: 1000000,
        maxOutputTokens: 128000,
    },
    notificationPreference: { mode: 'summary', runIssues: true },
};
const account = {
    user: {
        id: id(1),
        email: 'controls@example.test',
        createdAt: instant,
        preferences: {
            defaultTimezone: 'UTC',
            notificationPreference: config.notificationPreference,
        },
    },
    csrfToken: 'local-controls',
};
async function samples(page: Page, wait?: Promise<void>) {
    const state = { deleted: false, deletionFailure: false, savedConfig: structuredClone(config) };
    const writes: { method: string; path: string; headers: Record<string, string>; body: any }[] =
        [];
    const detail = () => ({
        task: {
            id: id(10),
            title: state.savedConfig.title,
            status: 'active',
            revision: 1,
            currentVersionId: id(11),
            nextRunAt: null,
            createdAt: instant,
            updatedAt: instant,
        },
        version: {
            id: id(11),
            taskId: id(10),
            version: 1,
            configSchemaVersion: 1,
            config: state.savedConfig,
            comparisonScopeHash: 'a'.repeat(64),
            createdAt: instant,
        },
        baselineResetRequired: false,
    });
    await page.route('**/api/v1/**', async (route) => {
        const req = route.request(),
            path = new URL(req.url()).pathname,
            method = req.method();
        const error = (status: number, code: string) =>
            route.fulfill({ status, json: { code, message: 'local sample', requestId: 'local' } });
        if (path === '/api/v1/me') {
            if (wait) await wait;
            return route.fulfill({ json: account });
        }
        if (path === '/api/v1/me/agent-providers')
            return route.fulfill({
                json: {
                    storageReady: true,
                    systemConfigured: true,
                    items: [1, 2].map((n) => ({
                        id: id(20 + n),
                        name: `研究配置${n}`,
                        model: `model-${n}`,
                        protocol: 'openai_json',
                        baseUrl: 'https://example.test/v1',
                        hasApiKey: true,
                        active: n === 1,
                        draftActive: false,
                        revision: 1,
                        updatedAt: instant,
                    })),
                },
            });
        if (method !== 'GET')
            writes.push({
                method,
                path,
                headers: req.headers(),
                body: req.postData() ? req.postDataJSON() : undefined,
            });
        if (path === `/api/v1/tasks/${id(10)}` && method === 'DELETE') {
            if (state.deletionFailure) return error(409, 'TASK_RUN_ACTIVE');
            state.deleted = true;
            return route.fulfill({ status: 204 });
        }
        if (path === '/api/v1/tasks' && method === 'POST') {
            state.savedConfig = req.postDataJSON().config;
            return route.fulfill({ status: 201, headers: { etag: '"1"' }, json: detail() });
        }
        if (path === `/api/v1/tasks/${id(10)}/runs`) {
            if (method === 'GET') return route.fulfill({ json: { items: [], nextCursor: null } });
            return route.fulfill({
                status: 202,
                json: {
                    reused: false,
                    run: {
                        id: id(30),
                        taskId: id(10),
                        taskVersionId: id(11),
                        parentRunId: null,
                        baselineRunId: null,
                        mode: 'live',
                        status: 'queued',
                        outcome: null,
                        trigger: 'manual',
                        budget: config.budget,
                        usage: {
                            searches: 0,
                            pages: 0,
                            inputTokens: 0,
                            outputTokens: 0,
                            estimated: true,
                        },
                        coverage: null,
                        queuedAt: instant,
                        startedAt: null,
                        finishedAt: null,
                        failureCode: null,
                    },
                },
            });
        }
        if (path === '/api/v1/tasks')
            return route.fulfill({
                json: { items: state.deleted ? [] : [detail().task], nextCursor: null },
            });
        if (path === `/api/v1/tasks/${id(10)}`)
            return state.deleted
                ? error(404, 'NOT_FOUND')
                : route.fulfill({ headers: { etag: '"1"' }, json: detail() });
        if (path === '/api/v1/notifications')
            return route.fulfill({ json: { items: [], nextCursor: null } });
        return error(501, 'UNEXPECTED_SAMPLE');
    });
    return { state, writes };
}

for (const width of [320, 1440]) {
    test(`会话恢复动画居中 ${width}`, async ({ page }, info) => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        await samples(page, gate);
        await page.setViewportSize({ width, height: 1000 });
        try {
            await page.goto('/tasks', { waitUntil: 'domcontentloaded' });
            await expect(page.getByRole('status')).toContainText('正在恢复账号会话');
            const image = page.locator('.loading-animation');
            await expect(image).toBeVisible();
            const box = await image.boundingBox();
            expect(Math.abs(box!.x + box!.width / 2 - width / 2)).toBeLessThan(1);
            await page.screenshot({ path: info.outputPath('session-recovery.png') });
        } finally {
            release();
        }
        await expect(page.locator('.loading-animation')).toHaveCount(0);
    });

    test(`清除弹窗安全焦点、取消和确认 ${width}`, async ({ page }, info) => {
        const { writes } = await samples(page);
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.setViewportSize({ width, height: 1000 });
        await page.goto(`/tasks/${id(10)}`);
        const trigger = page.getByRole('button', { name: '清除任务', exact: true });
        await expect(trigger).toBeEnabled();
        if (width === 320)
            await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
        await trigger.click();
        const dialog = page.getByRole('dialog', { name: '永久清除任务？' });
        await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeFocused();
        await expect(dialog).toContainText('报告笔记和问答');
        await dialog.press('Escape');
        await expect(trigger).toBeFocused();
        expect(writes).toHaveLength(0);
        await trigger.click();
        await dialog.getByRole('button', { name: '取消', exact: true }).click();
        expect(writes).toHaveLength(0);
        await trigger.click();
        const confirm = dialog.getByRole('button', { name: '确认永久清除', exact: true });
        const bounds = await confirm.boundingBox();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
        expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(1000);
        await page.screenshot({ path: info.outputPath('delete-confirmation.png') });
        await confirm.click();
        await expect(page).toHaveURL(/\/tasks$/);
        expect(writes.filter((call) => call.method === 'DELETE')).toMatchObject([
            { headers: { 'if-match': '"1"', 'x-csrf-token': 'local-controls' } },
        ]);
        expect(errors).toEqual([]);
    });
}

test('活动执行拒绝清除可刷新重新确认', async ({ page }) => {
    const { state, writes } = await samples(page);
    state.deletionFailure = true;
    await page.goto(`/tasks/${id(10)}`);
    const trigger = page.getByRole('button', { name: '清除任务', exact: true });
    await trigger.click();
    await page.getByRole('button', { name: '确认永久清除' }).click();
    await expect(page.getByRole('status').filter({ hasText: '等待执行结束' })).toBeVisible();
    await expect(trigger).toBeDisabled();
    await page.getByRole('button', { name: '刷新任务状态' }).click();
    await expect(trigger).toBeEnabled();
    expect(writes).toHaveLength(1);
});

test('单次执行选择Agent发送指定配置，不修改账号默认', async ({ page }) => {
    const { writes } = await samples(page);
    await page.goto(`/tasks/${id(10)}`);
    await chooseOption(page, '执行 Agent 配置', '研究配置2');
    await page.getByRole('button', { name: '立即执行', exact: true }).click();
    await expect(page.getByRole('link', { name: '查看执行' })).toBeVisible();
    expect(writes).toHaveLength(1);
    expect(writes[0]!.body).toEqual({ mode: 'live', agentProviderId: id(22) });
    await expect(page.getByRole('combobox', { name: '执行 Agent 配置' })).toBeDisabled();
});

test('创建任务保存执行Agent选择', async ({ page }) => {
    const { writes } = await samples(page);
    await page.goto('/tasks/new');
    await page.getByLabel('任务标题', { exact: true }).fill('我的研究任务');
    await page.getByLabel('查阅主题', { exact: true }).fill('来源变化');
    await page.getByLabel('查阅目标', { exact: true }).fill('核验变化');
    await chooseOption(page, '执行 Agent 配置', '研究配置2');
    await page.getByRole('button', { name: '确认保存任务', exact: true }).click();
    await expect(page).toHaveURL(new RegExp('/tasks/' + id(10) + '$'));
    expect(
        writes.filter((call) => call.path === '/api/v1/tasks')[0]!.body.config.agentProviderId,
    ).toBe(id(22));
});
