import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import type { taskInput } from '../../apps/web/src/composables/useCreateTask.ts';
import { fillList } from './support/list-input.ts';

test.use({ timezoneId: 'Asia/Tokyo' });

type TaskConfig = ReturnType<typeof taskInput>['config'];
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const instant = '2026-10-31T00:00:00Z';
const taskId = id(11);
const editPath = `/tasks/${taskId}/edit`;
const original: TaskConfig = {
    title: '持续跟踪招生政策与学术研究观点的变化',
    topic: '各地高校招生政策',
    goal: '比较变化并保留可核验来源证据',
    focusPoints: ['资格\n费用', '申请步骤'],
    exclusions: [' 商业广告 ', '重复信息'],
    sourcePreferences: {
        preferredUrls: ['https://example.test/admission'],
        excludedUrls: ['https://example.test/ads'],
        officialOnly: true,
    },
    timeRange: {
        kind: 'fixed',
        start: '2026-10-01T01:02:03.123Z',
        end: '2026-10-30T09:10:11.456Z',
    },
    timezone: 'America/New_York',
    schedule: { frequency: 'weekly', weekday: 7, localTime: '09:15' },
    outputFormat: 'comparison',
    budget: {
        maxSearches: 3,
        maxPages: 4,
        maxDurationSeconds: 60,
        maxInputTokens: 1000,
        maxOutputTokens: 500,
    },
    notificationPreference: { mode: 'important_change', runIssues: false },
};

// Local HTTP contract samples; these do not represent real storage or authorization.
async function samples(context: BrowserContext) {
    const calls: { method: string; path: string; etag?: string; config?: TaskConfig }[] = [];
    const state = {
        config: structuredClone(original),
        revision: 1,
        failure: 0,
        code: 'REVISION_CONFLICT',
        getFailure: false,
        baseline: true,
        wait: undefined as Promise<void> | undefined,
    };
    function detail() {
        return {
            task: {
                id: taskId,
                title: state.config.title,
                status: 'active',
                revision: state.revision,
                currentVersionId: id(100 + state.revision),
                nextRunAt: null,
                createdAt: instant,
                updatedAt: instant,
            },
            version: {
                id: id(100 + state.revision),
                taskId,
                version: state.revision,
                configSchemaVersion: 1,
                config: state.config,
                comparisonScopeHash: 'a'.repeat(64),
                createdAt: instant,
            },
            baselineResetRequired: false,
        };
    }
    await context.route('**/api/v1/me', (route) =>
        route.fulfill({
            json: {
                user: {
                    id: id(1),
                    email: 'task-edit@example.test',
                    preferences: {
                        defaultTimezone: 'UTC',
                        notificationPreference: original.notificationPreference,
                    },
                    createdAt: instant,
                },
                csrfToken: 'sample-csrf',
            },
        }),
    );
    await context.route('**/api/v1/me/agent-providers', (route) =>
        route.fulfill({ json: { storageReady: true, systemConfigured: true, items: [] } }),
    );
    await context.route('**/api/v1/tasks**', async (route) => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        const body = request.method() === 'PATCH' ? request.postDataJSON() : undefined;
        calls.push({
            method: request.method(),
            path,
            etag: request.headers()['if-match'],
            config: body?.config as TaskConfig | undefined,
        });
        const failure = (status: number, code = state.code) =>
            route.fulfill({
                status,
                json: { code, message: 'local sample', requestId: 'sample' },
            });
        if (request.method() === 'PATCH') {
            if (state.wait) await state.wait;
            if (state.failure) return failure(state.failure);
            if (request.headers()['if-match'] !== `"${state.revision}"`) return failure(409);
            state.config = body.config as TaskConfig;
            state.revision++;
            return route.fulfill({
                headers: { etag: `"${state.revision}"`, 'access-control-expose-headers': 'ETag' },
                json: { ...detail(), baselineResetRequired: state.baseline },
            });
        }
        if (path.endsWith('/runs')) return route.fulfill({ json: { items: [], nextCursor: null } });
        if (path === '/api/v1/tasks')
            return route.fulfill({ json: { items: [detail().task], nextCursor: null } });
        if (state.getFailure) return failure(503, 'READ_FAILURE');
        return route.fulfill({
            headers: { etag: `"${state.revision}"`, 'access-control-expose-headers': 'ETag' },
            json: detail(),
        });
    });
    return { calls, state };
}
test('编辑任务的列表逐项保真：只修改一个关注点和链接', async ({ page }) => {
    const { calls, state } = await samples(page.context());
    await page.goto(editPath);
    await page.getByText('关注范围与来源偏好', { exact: true }).click();
    const focus = page.getByRole('region', { name: '重点关注（可选）', exact: true });
    await expect(focus.getByRole('textbox').first()).toHaveValue('资格\n费用');
    await focus.getByRole('textbox').nth(1).fill('申请流程，时间节点\n保留为一项');
    await fillList(page, '优先来源网址（可选）', [
        'https://example.test/admission',
        'https://example.test/new',
    ]);
    await page.getByRole('button', { name: '确认保存修改', exact: true }).click();
    await expect(page.locator('.task-config-form .save-success[role="status"]')).toContainText(
        '已保存',
    );
    expect(state.config).toEqual({
        ...original,
        focusPoints: [original.focusPoints[0], '申请流程，时间节点\n保留为一项'],
        sourcePreferences: {
            ...original.sourcePreferences,
            preferredUrls: ['https://example.test/admission', 'https://example.test/new'],
        },
    });
    expect(calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);
});

const save = (page: Page) => page.getByRole('button', { name: '确认保存修改', exact: true });
const reload = (page: Page) => page.getByRole('button', { name: '重新读取最新版本', exact: true });
const confirmReload = (page: Page) =>
    page.getByRole('button', { name: '确认丢弃草稿并重新读取', exact: true });
const cancelReload = (page: Page) =>
    page.getByRole('button', { name: '取消重新读取', exact: true });
const patches = (calls: Awaited<ReturnType<typeof samples>>['calls']) =>
    calls.filter((call) => call.method === 'PATCH');
const reads = (calls: Awaited<ReturnType<typeof samples>>['calls']) =>
    calls.filter((call) => call.method === 'GET' && call.path === `/api/v1/tasks/${taskId}`);
async function noOverflow(page: Page) {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
    );
    for (const label of ['开始时间', '结束时间']) {
        expect(
            await page.getByLabel(label, { exact: true }).evaluate((element) => {
                const bounds = element.getBoundingClientRect();
                return bounds.left >= 0 && bounds.right <= innerWidth;
            }),
        ).toBe(true);
    }
}

for (const width of [320, 390, 768, 1024, 1440, 1920]) {
    test(`本地编辑样本${width}：完整配置、冲突重读与200%文字`, async ({ page }, info) => {
        const { calls, state } = await samples(page.context());
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        if (width % 2 === 0 && width > 1000)
            state.config.schedule = { frequency: 'daily', localTime: '08:45' };
        const expectedConfig = structuredClone(state.config);
        await page.setViewportSize({ width, height: 1000 });
        await page.goto(`/tasks/${taskId}`);
        await page.getByRole('link', { name: '编辑任务配置', exact: true }).click();
        await expect(page).toHaveURL(new RegExp(`${editPath}$`));
        const title = page.getByLabel('任务标题', { exact: true });
        await expect(title).toHaveValue(original.title);
        await expect(page.getByLabel('任务时区', { exact: true })).toContainText(
            'America/New_York',
        );
        await expect(page.getByLabel('开始时间', { exact: true })).toHaveValue(
            '2026-10-01T10:02:03.123',
        );
        await title.fill('我的本地修改草稿');
        for (const doubled of [false, true]) {
            if (doubled)
                await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
            await noOverflow(page);
            await page.evaluate(async () => {
                await document.fonts.ready;
                scrollTo(0, 0);
            });
            await info.attach(`${width}-${doubled ? 'text-200' : 'normal'}`, {
                body: await page.screenshot({
                    path: info.outputPath(`${doubled ? 'text-200' : 'normal'}.png`),
                    fullPage: true,
                }),
                contentType: 'image/png',
            });
        }
        state.failure = 409;
        await save(page).focus();
        await save(page).press('Enter');
        await expect(page.getByRole('alert')).toContainText('当前草稿已保留且可复制');
        await expect(page.getByRole('alert')).toBeFocused();
        await expect(title).toHaveValue('我的本地修改草稿');
        await expect(title).toBeEditable();
        await expect(save(page)).toBeDisabled();
        await page.getByRole('alert').scrollIntoViewIfNeeded();
        await info.attach(`${width}-conflict-alert-text-200`, {
            body: await page.screenshot({ path: info.outputPath('conflict-alert-text-200.png') }),
            contentType: 'image/png',
        });
        const before = reads(calls).length;
        await reload(page).click();
        await expect(page.getByText(/确认后会丢弃当前未保存草稿/)).toBeVisible();
        await noOverflow(page);
        for (const button of [confirmReload(page), cancelReload(page)]) {
            expect(
                await button.evaluate((element) => {
                    const bounds = element.getBoundingClientRect();
                    return bounds.left >= 0 && bounds.right <= innerWidth;
                }),
            ).toBe(true);
        }
        await page.evaluate(() => scrollTo(0, 0));
        await info.attach(`${width}-conflict-text-200`, {
            body: await page.screenshot({
                path: info.outputPath('conflict-text-200.png'),
                fullPage: true,
            }),
            contentType: 'image/png',
        });
        await cancelReload(page).focus();
        await cancelReload(page).press('Enter');
        await expect(title).toHaveValue('我的本地修改草稿');
        expect(reads(calls)).toHaveLength(before);
        state.failure = 0;
        state.config.title = '其他标签页保存的最新标题';
        state.revision = 2;
        await reload(page).click();
        await confirmReload(page).focus();
        await confirmReload(page).press('Enter');
        await expect(title).toHaveValue(state.config.title);
        await title.fill('手动合并后的标题');
        await save(page).click();
        const success = page
            .locator('.task-config-form')
            .getByRole('status')
            .filter({ hasText: '修改已保存' });
        await expect(success).toContainText('下一次完整执行将建立新基线');
        await expect(success).toBeFocused();
        await expect(page).toHaveURL(new RegExp(`${editPath}$`));
        const attempts = patches(calls);
        expect(attempts.map((call) => call.etag)).toEqual(['"1"', '"2"']);
        expect(attempts[0]!.config).toEqual({ ...expectedConfig, title: '我的本地修改草稿' });
        expect(attempts[1]!.config).toEqual({ ...expectedConfig, title: '手动合并后的标题' });
        expect(calls.filter((call) => call.method === 'POST')).toEqual([]);
        await expect(page.getByRole('link', { name: '返回任务摘要', exact: true })).toBeVisible();
        expect(errors).toEqual([]);
    });
}

test('两个标签页同读一版本：B冲突不覆盖A且可复制草稿', async ({ page, context }) => {
    const { state, calls } = await samples(context);
    const other = await context.newPage();
    await page.goto(editPath);
    await other.goto(editPath);
    await page.getByLabel('任务标题', { exact: true }).fill('标签页A已保存');
    await other.getByLabel('任务标题', { exact: true }).fill('标签页B未保存');
    await save(page).click();
    await expect(page.locator('.task-config-form .save-success[role="status"]')).toContainText(
        '修改已保存',
    );
    await save(other).click();
    await expect(other.getByRole('alert')).toContainText('其他页面修改');
    await expect(other.getByLabel('任务标题', { exact: true })).toHaveValue('标签页B未保存');
    await other.getByLabel('任务标题', { exact: true }).selectText();
    expect(state.config.title).toBe('标签页A已保存');
    expect(patches(calls).map((call) => call.etag)).toEqual(['"1"', '"1"']);
    await expect(save(other)).toBeDisabled();
});

test('摘要缓存不能替代编辑初读，进入编辑取得最新配置和ETag', async ({ page }) => {
    const { state, calls } = await samples(page.context());
    await page.goto(`/tasks/${taskId}`);
    await expect(page.getByRole('link', { name: '编辑任务配置', exact: true })).toBeVisible();
    state.config.title = '进入编辑前服务端已更新';
    state.revision = 3;
    const before = reads(calls).length;
    await page.getByRole('link', { name: '编辑任务配置', exact: true }).click();
    const title = page.getByLabel('任务标题', { exact: true });
    await expect(title).toHaveValue('进入编辑前服务端已更新');
    expect(reads(calls).length).toBeGreaterThan(before);
    await title.fill('基于最新版本的修改');
    await save(page).click();
    await expect(page.locator('.task-config-form .save-success[role="status"]')).toContainText(
        '修改已保存',
    );
    expect(patches(calls).map((call) => call.etag)).toEqual(['"3"']);
});

test('编辑初读失败不展示摘要缓存表单，可显式重试', async ({ page }) => {
    const { state, calls } = await samples(page.context());
    await page.goto(`/tasks/${taskId}`);
    await expect(page.getByRole('link', { name: '编辑任务配置', exact: true })).toBeVisible();
    state.getFailure = true;
    await page.getByRole('link', { name: '编辑任务配置', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${editPath}$`));
    await expect(
        page.getByRole('main').getByRole('status').filter({ hasText: '任务无法编辑' }),
    ).toHaveText('加载失败：任务无法编辑，请检查权限、版本或稍后重试');
    await expect(page.locator('.task-config-form')).toHaveCount(0);
    expect(patches(calls)).toHaveLength(0);
    state.getFailure = false;
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await expect(page.getByLabel('任务标题', { exact: true })).toHaveValue(original.title);
});

test('412保留草稿，重读失败与取消不丢内容或修订依据', async ({ page }) => {
    const { state, calls } = await samples(page.context());
    state.failure = 412;
    await page.goto(editPath);
    const title = page.getByLabel('任务标题', { exact: true });
    await title.fill('412待合并草稿');
    await save(page).click();
    await expect(page.getByRole('alert')).toContainText('草稿已保留');
    state.getFailure = true;
    await reload(page).click();
    await confirmReload(page).click();
    await expect(page.getByRole('alert')).toContainText('原草稿和修订依据仍保留');
    await expect(title).toHaveValue('412待合并草稿');
    await cancelReload(page).click();
    await expect(save(page)).toBeDisabled();
    expect(patches(calls)).toHaveLength(1);
    state.getFailure = false;
    state.failure = 0;
    await reload(page).click();
    await confirmReload(page).click();
    await expect(title).toHaveValue(original.title);
    await title.fill('重读后的修改');
    await save(page).click();
    await expect(page.locator('.task-config-form .save-success[role="status"]')).toContainText(
        '修改已保存',
    );
    expect(patches(calls).map((call) => call.etag)).toEqual(['"1"', '"1"']);
});

test('键盘重读确认和取消后焦点保持在有效操作', async ({ page }) => {
    await samples(page.context());
    await page.goto(editPath);
    await reload(page).focus();
    await reload(page).press('Enter');
    await expect(confirmReload(page)).toBeFocused();
    await cancelReload(page).focus();
    await cancelReload(page).press('Enter');
    await expect(reload(page)).toBeFocused();
    await reload(page).press('Enter');
    await confirmReload(page).press('Enter');
    await expect(page.getByLabel('任务标题', { exact: true })).toBeFocused();
});

test('在途双击仅一次，503不确定结果阻止直接重发且保留草稿', async ({ page }) => {
    const { state, calls } = await samples(page.context());
    let release!: () => void;
    state.wait = new Promise<void>((resolve) => {
        release = resolve;
    });
    state.failure = 503;
    await page.goto(editPath);
    const title = page.getByLabel('任务标题', { exact: true });
    await title.fill('保存结果尚未确认');
    await save(page).dblclick();
    await expect(page.getByRole('button', { name: '正在保存', exact: true })).toHaveAttribute(
        'aria-busy',
        'true',
    );
    expect(patches(calls)).toHaveLength(1);
    release();
    await expect(page.getByRole('alert')).toContainText('保存结果未确认');
    await expect(page.getByRole('alert')).toBeFocused();
    await expect(title).toHaveValue('保存结果尚未确认');
    await expect(save(page)).toBeDisabled();
    expect(patches(calls)).toHaveLength(1);
});

test('未保存离开可取消，确认后才放弃；字段失败聚焦且保留内容', async ({ page }) => {
    const { calls } = await samples(page.context());
    await page.goto(editPath);
    const title = page.getByLabel('任务标题', { exact: true });
    await title.fill('离开前的草稿');
    page.once('dialog', (dialog) => dialog.dismiss());
    await page.getByRole('link', { name: '返回任务摘要', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${editPath}$`));
    await expect(title).toHaveValue('离开前的草稿');
    await title.fill('');
    await save(page).click();
    await expect(title).toBeFocused();
    expect(patches(calls)).toHaveLength(0);
    await title.fill('离开前的草稿');
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('link', { name: '返回任务摘要', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/tasks/${taskId}$`));
    await page.getByRole('link', { name: '编辑任务配置', exact: true }).click();
    await expect(title).toHaveValue(original.title);
});
