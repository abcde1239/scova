import { expect, test, type Page } from '@playwright/test';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const instant = '2026-11-09T00:00:00Z';
const config = {
    title: '批量任务',
    topic: '资料',
    goal: '收集',
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
    notificationPreference: { mode: 'off', runIssues: false },
};
function detail(n: number, revision = 1) {
    const title = `批量任务${n}`;
    return {
        task: {
            id: id(n),
            title,
            status: n === 13 ? 'paused' : 'active',
            revision,
            currentVersionId: id(n + 100),
            nextRunAt: null,
            createdAt: instant,
            updatedAt: instant,
        },
        version: {
            id: id(n + 100),
            taskId: id(n),
            version: 1,
            configSchemaVersion: 1,
            config: { ...config, title },
            comparisonScopeHash: 'a'.repeat(64),
            createdAt: instant,
        },
        baselineResetRequired: false,
    };
}
async function samples(
    page: Page,
    mode: 'success' | 'mixed' | 'unknown' | 'changed' = 'success',
    hold?: Promise<void>,
) {
    const deleted = new Set<number>();
    const writes: { n: number; headers: Record<string, string> }[] = [];
    const reads: number[] = [];
    const unexpected: string[] = [];
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.route('**/api/v1/**', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const path = url.pathname;
        const error = (status: number, code: string) =>
            route.fulfill({ status, json: { code, message: 'local sample', requestId: 'local' } });
        if (path === '/api/v1/me')
            return route.fulfill({
                json: {
                    user: {
                        id: id(1),
                        email: 'bulk-browser@example.test',
                        createdAt: instant,
                        preferences: {
                            defaultTimezone: 'UTC',
                            notificationPreference: config.notificationPreference,
                        },
                    },
                    csrfToken: 'bulk-browser-csrf',
                },
            });
        if (path === '/api/v1/notifications')
            return route.fulfill({ json: { items: [], nextCursor: null } });
        if (path === '/api/v1/tasks' && request.method() === 'GET') {
            const cursor = url.searchParams.get('cursor');
            return route.fulfill({
                json: {
                    items: (cursor ? [12, 13] : [10, 11])
                        .filter((n) => !deleted.has(n))
                        .map((n) => detail(n).task),
                    nextCursor: cursor ? null : 'bulk-page-2',
                },
            });
        }
        const matched = /^\/api\/v1\/tasks\/(00000000-0000-4000-8000-\d{12})$/.exec(path);
        if (matched) {
            const n = Number(matched[1].slice(-12));
            if (request.method() === 'DELETE') {
                writes.push({ n, headers: request.headers() });
                if (hold) await hold;
                if (mode === 'mixed' && n === 10) return error(409, 'TASK_RUN_ACTIVE');
                if (mode === 'unknown' && n === 11) {
                    deleted.add(n);
                    return error(503, 'SAMPLE');
                }
                deleted.add(n);
                return route.fulfill({ status: 204 });
            }
            if (request.method() === 'GET') {
                reads.push(n);
                if (deleted.has(n)) return error(404, 'NOT_FOUND');
                const revision = mode === 'changed' && n === 11 ? 2 : 1;
                return route.fulfill({
                    headers: { etag: `"${revision}"` },
                    json: detail(n, revision),
                });
            }
        }
        unexpected.push(`${request.method()} ${path}`);
        return error(501, 'UNEXPECTED_SAMPLE');
    });
    return { writes, reads, deleted, unexpected, pageErrors };
}
const dialog = (page: Page, count: number) =>
    page.getByRole('dialog', { name: `永久清除 ${count} 个任务？` });
async function start(page: Page) {
    await page.goto('/tasks');
    await page.getByRole('button', { name: '批量管理', exact: true }).click();
}
async function selectAll(page: Page) {
    await page.getByRole('button', { name: '选择已加载任务' }).click();
}
async function open(page: Page, count: number) {
    await page.getByRole('button', { name: '清除所选任务' }).click();
    await expect(dialog(page, count)).toBeVisible();
}
async function confirm(page: Page, count: number) {
    await dialog(page, count).getByRole('textbox').fill(`清除 ${count} 个任务`);
    await dialog(page, count).getByRole('button', { name: '确认永久清除' }).click();
}
for (const width of [320, 1440]) {
    test(`批量清除：明确数量、文字防误删、取消与成功 ${width}`, async ({ page }, info) => {
        const state = await samples(page);
        await page.setViewportSize({ width, height: 1000 });
        await start(page);
        await expect(page.getByRole('button', { name: '清除所选任务' })).toBeDisabled();
        await page.getByRole('checkbox', { name: '选择任务：批量任务10', exact: true }).check();
        await open(page, 1);
        await expect(
            dialog(page, 1).getByRole('button', { name: '取消', exact: true }),
        ).toBeFocused();
        await expect(dialog(page, 1)).toContainText('报告笔记和问答');
        await expect(dialog(page, 1).getByRole('button', { name: '确认永久清除' })).toBeDisabled();
        await dialog(page, 1).getByRole('textbox').fill('清除 2 个任务');
        await expect(dialog(page, 1).getByRole('button', { name: '确认永久清除' })).toBeDisabled();
        await dialog(page, 1).press('Escape');
        await expect(page.getByRole('button', { name: '清除所选任务' })).toBeFocused();
        expect(state.writes).toEqual([]);
        await selectAll(page);
        await open(page, 2);
        await dialog(page, 2).getByRole('button', { name: '取消', exact: true }).click();
        expect(state.writes).toEqual([]);
        await open(page, 2);
        if (width === 320)
            await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
        const confirmButton = dialog(page, 2).getByRole('button', { name: '确认永久清除' });
        const rect = await confirmButton.boundingBox();
        expect(rect!.x).toBeGreaterThanOrEqual(0);
        expect(rect!.x + rect!.width).toBeLessThanOrEqual(width);
        expect(rect!.y + rect!.height).toBeLessThanOrEqual(1000);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
            true,
        );
        await page.screenshot({ path: info.outputPath(`bulk-confirm-${width}.png`) });
        await confirm(page, 2);
        await expect(page.locator('.bulk-feedback')).toContainText('已清除 2 个');
        await expect(page.locator('.task-card')).toHaveCount(0);
        await expect(page.getByRole('button', { name: '清除所选任务' })).toBeDisabled();
        expect(state.writes.map((item) => item.n)).toEqual([10, 11]);
        expect(
            state.writes.every(
                (item) =>
                    item.headers['if-match'] === '"1"' &&
                    item.headers['x-csrf-token'] === 'bulk-browser-csrf',
            ),
        ).toBe(true);
        expect(state.reads).toEqual([10, 10, 11, 10, 11]);
        expect(state.unexpected).toEqual([]);
        expect(state.pageErrors).toEqual([]);
    });
}
test('加载更多不自动选中，切换筛选清空选择，隐藏任务不进入批次', async ({ page }) => {
    const state = await samples(page);
    await start(page);
    await selectAll(page);
    await page.getByRole('button', { name: '加载更多', exact: true }).click();
    await expect(
        page.getByRole('checkbox', { name: '选择任务：批量任务12', exact: true }),
    ).not.toBeChecked();
    await expect(page.getByRole('checkbox')).toHaveCount(3);
    await page.getByRole('radio', { name: '暂停', exact: true }).check();
    await expect(page.getByRole('checkbox')).toHaveCount(0);
    await page.getByRole('button', { name: '加载更多', exact: true }).click();
    await page.getByRole('button', { name: '批量管理', exact: true }).click();
    await expect(page.getByRole('button', { name: '清除所选任务' })).toBeDisabled();
    await expect(
        page.getByRole('checkbox', { name: '选择任务：批量任务13', exact: true }),
    ).toBeVisible();
    await selectAll(page);
    await open(page, 1);
    await confirm(page, 1);
    await expect(page.locator('.bulk-feedback')).toContainText('已清除 1 个');
    expect(state.writes.map((item) => item.n)).toEqual([13]);
    expect(state.unexpected).toEqual([]);
});
test('有活动执行的任务保留，其他任务成功并逐项反馈', async ({ page }) => {
    const state = await samples(page, 'mixed');
    await start(page);
    await selectAll(page);
    await open(page, 2);
    await confirm(page, 2);
    await expect(page.locator('.bulk-feedback')).toContainText('已清除 1 个，其他 1 个');
    await expect(page.locator('.bulk-feedback')).toContainText('批量任务10：仍有活动执行');
    await expect(page.locator('.bulk-feedback')).toContainText('批量任务11：已清除');
    await expect(page.getByRole('article', { name: '批量任务10', exact: true })).toBeVisible();
    await expect(page.getByRole('article', { name: '批量任务11', exact: true })).toHaveCount(0);
    expect(state.writes.map((item) => item.n)).toEqual([10, 11]);
    expect(state.unexpected).toEqual([]);
});
test('响应丢失/503不自动重发，保留已完成结果并停止后续任务', async ({ page }) => {
    const state = await samples(page, 'unknown');
    await start(page);
    await page.getByRole('button', { name: '加载更多', exact: true }).click();
    await expect(page.getByRole('checkbox')).toHaveCount(3);
    await selectAll(page);
    await open(page, 3);
    await confirm(page, 3);
    await expect(page.locator('.bulk-feedback')).toContainText('批量任务10：已清除');
    await expect(page.locator('.bulk-feedback')).toContainText('批量任务11：结果待核对');
    await expect(page.locator('.bulk-feedback')).toContainText('批量任务12：未发送清除请求');
    expect(state.writes.map((item) => item.n)).toEqual([10, 11]);
    expect(state.unexpected).toEqual([]);
});
test('预检发现修订变化时整批不发送清除', async ({ page }) => {
    const state = await samples(page, 'changed');
    await start(page);
    await selectAll(page);
    await page.getByRole('button', { name: '清除所选任务' }).click();
    await expect(page.locator('.bulk-feedback')).toContainText('所选任务已变化，未执行清除');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(state.writes).toEqual([]);
});
test('执行中显示进度并阻止双击与Escape关闭', async ({ page }) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const state = await samples(page, 'success', gate);
    try {
        await start(page);
        await selectAll(page);
        await open(page, 2);
        await confirm(page, 2);
        await expect.poll(() => state.writes.length).toBe(1);
        await expect(dialog(page, 2)).toContainText('正在清除，已处理 0/2');
        await expect(
            dialog(page, 2).getByRole('button', { name: '取消', exact: true }),
        ).toBeDisabled();
        await dialog(page, 2).press('Escape');
        await expect(dialog(page, 2)).toBeVisible();
        const busyConfirm = dialog(page, 2).getByRole('button', { name: '确认永久清除' });
        await expect(busyConfirm).toBeDisabled();
        await busyConfirm.dispatchEvent('click');
        expect(state.writes).toHaveLength(1);
    } finally {
        release();
    }
    await expect(page.locator('.bulk-feedback')).toContainText('已清除 2 个');
    expect(state.writes).toHaveLength(2);
    expect(state.pageErrors).toEqual([]);
});
