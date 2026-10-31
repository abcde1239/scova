import { expect, test, type Page } from '@playwright/test';
import type { useTaskRunHistory } from '../../apps/web/src/composables/useTaskRunHistory.ts';
type Run = ReturnType<typeof useTaskRunHistory>['items']['value'][number];
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const instant = '2026-10-31T00:00:00Z';
const config = {
    title: '历史版本与模式追溯',
    topic: '公开资料',
    goal: '保留历史配置与证据',
    focusPoints: [],
    exclusions: [],
    sourcePreferences: { preferredUrls: [], excludedUrls: [], officialOnly: false },
    timeRange: { kind: 'rolling', days: 7 },
    timezone: 'UTC',
    schedule: { frequency: 'manual' },
    outputFormat: 'brief',
    budget: {
        maxSearches: 2,
        maxPages: 3,
        maxDurationSeconds: 60,
        maxInputTokens: 1000,
        maxOutputTokens: 500,
    },
    notificationPreference: { mode: 'summary', runIssues: true },
};
function run(n: number, taskId = id(1)): Run {
    return {
        id: id(n),
        taskId,
        taskVersionId: id(n + 200),
        parentRunId: null,
        baselineRunId: null,
        mode: n % 2 ? 'demo' : 'live',
        status: 'failed',
        outcome: null,
        trigger: 'manual',
        budget: config.budget,
        usage: { searches: 0, pages: 0, inputTokens: 0, outputTokens: 0, estimated: false },
        coverage: null,
        queuedAt: instant,
        startedAt: instant,
        finishedAt: instant,
        failureCode: 'NO_EVIDENCE',
    };
}
function detail(taskId: string) {
    return {
        task: {
            id: taskId,
            title: config.title,
            status: 'active',
            revision: 8,
            currentVersionId: id(50),
            nextRunAt: null,
            createdAt: instant,
            updatedAt: instant,
        },
        version: {
            id: id(50),
            taskId,
            version: 8,
            configSchemaVersion: 1,
            config,
            comparisonScopeHash: 'a'.repeat(64),
            createdAt: instant,
        },
        baselineResetRequired: false,
    };
}
async function samples(page: Page) {
    const calls: string[] = [];
    const state = { fail: 0, emptyTask: id(2) };
    await page.route('**/api/v1/me', (route) =>
        route.fulfill({
            json: {
                user: {
                    id: id(100),
                    email: 'history@example.test',
                    preferences: config.notificationPreference && {
                        defaultTimezone: 'UTC',
                        notificationPreference: config.notificationPreference,
                    },
                    createdAt: instant,
                },
                csrfToken: 'sample-only',
            },
        }),
    );
    await page.route('**/api/v1/tasks**', (route) => {
        const url = new URL(route.request().url());
        const target = url.pathname.split('/')[4] ?? id(1);
        if (url.pathname.endsWith('/runs')) {
            if (url.searchParams.get('limit') === '20') calls.push(url.href);
            if (state.fail && url.searchParams.get('limit') === '20')
                return route.fulfill({
                    status: state.fail,
                    json: { code: 'TEST_FAILURE', message: 'sample', requestId: 'sample' },
                });
            return route.fulfill({
                json:
                    target === state.emptyTask
                        ? { items: [], nextCursor: null }
                        : url.searchParams.get('limit') === '1'
                          ? { items: [run(12)], nextCursor: null }
                          : url.searchParams.has('cursor')
                            ? { items: [run(11), run(10)], nextCursor: null }
                            : { items: [run(12), run(11)], nextCursor: 'opaque/+=' },
            });
        }
        if (url.pathname === '/api/v1/tasks')
            return route.fulfill({
                json: { items: [detail(id(1)).task, detail(id(2)).task], nextCursor: null },
            });
        return route.fulfill({ json: detail(target) });
    });
    await page.route('**/api/v1/runs/**', (route) => {
        const url = new URL(route.request().url());
        if (url.pathname.endsWith('/events'))
            return route.fulfill({ contentType: 'text/event-stream', body: '' });
        const target = url.pathname.split('/')[4];
        return route.fulfill({ json: run(Number(target?.slice(-12))) });
    });
    return { calls, state };
}
for (const width of [320, 390, 768, 1024, 1440, 1920]) {
    test(`本地历史样本：${width}宽度、200%文字与旧Run导航`, async ({ page }, info) => {
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        const { calls } = await samples(page);
        await page.setViewportSize({ width, height: 1000 });
        await page.goto(`/tasks/${id(1)}`);
        const history = page.locator('.run-history');
        await expect(history.locator('.history-entry')).toHaveCount(2);
        await history.getByRole('button', { name: '加载更早的执行', exact: true }).click();
        await expect(history.locator('.history-entry')).toHaveCount(3);
        expect(new URL(calls[1]!).searchParams.get('cursor')).toBe('opaque/+=');
        for (const doubled of [false, true]) {
            if (doubled)
                await page.evaluate(() => {
                    document.documentElement.style.fontSize = '200%';
                });
            await expect(history.getByText('演示模式 · Demo', { exact: true })).toBeVisible();
            await expect(
                history.getByText(`固定配置版本：${id(211)}`, { exact: true }),
            ).toBeVisible();
            expect(
                await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            ).toBe(true);
            await page.evaluate(() => scrollTo(0, 0));
            await info.attach(`${width}-${doubled ? 'text-200' : 'normal'}`, {
                body: await page.screenshot({
                    path: info.outputPath(`${doubled ? 'text-200' : 'normal'}.png`),
                    fullPage: true,
                }),
                contentType: 'image/png',
            });
        }
        await history.locator(`a[href="/runs/${id(11)}"]`).click();
        await expect(page.locator('.execution-detail')).toBeVisible();
        await expect(
            page.locator('.execution-detail').getByText(id(211), { exact: true }),
        ).toBeVisible();
        await expect(
            page.locator('.execution-detail').getByText('演示模式 · Demo', { exact: true }),
        ).toBeVisible();
        await page.goBack();
        await expect(history.locator('.history-entry')).toHaveCount(3);
        expect(errors).toEqual([]);
    });
}
test('本地历史样本：错误可键盘重试，成功后标题恢复焦点', async ({ page }) => {
    const { state } = await samples(page);
    state.fail = 503;
    await page.goto(`/tasks/${id(1)}`);
    const history = page.locator('.run-history');
    await expect(history.getByRole('status')).toContainText('执行历史暂不可用');
    state.fail = 0;
    const retry = history.getByRole('button', { name: '重试', exact: true });
    await retry.focus();
    await retry.press('Enter');
    await expect(history.locator('.history-entry')).toHaveCount(2);
    await expect(history.getByRole('heading', { name: '执行历史', exact: true })).toBeFocused();
});
test('本地历史样本：后续页失败保留记录，键盘重试同一游标并恢复焦点', async ({ page }) => {
    const { state, calls } = await samples(page);
    await page.setViewportSize({ width: 390, height: 1000 });
    await page.goto(`/tasks/${id(1)}`);
    const history = page.locator('.run-history');
    await expect(history.locator('.history-entry')).toHaveCount(2);
    await page.evaluate(() => {
        document.documentElement.style.fontSize = '200%';
    });
    state.fail = 503;
    const more = history.getByRole('button', { name: '加载更早的执行', exact: true });
    await more.focus();
    await more.press('Enter');
    await expect(history.getByRole('status')).toContainText('后续执行记录读取失败');
    await expect(history.locator('.history-entry')).toHaveCount(2);
    await expect(more).toBeFocused();
    state.fail = 0;
    const retry = history.getByRole('button', { name: '重试', exact: true });
    await retry.focus();
    await retry.press('Enter');
    await expect(history.locator('.history-entry')).toHaveCount(3);
    await expect(history.getByRole('heading', { name: '执行历史', exact: true })).toBeFocused();
    await expect(history.getByRole('status')).toHaveCount(0);
    expect(calls.map((url) => new URL(url).searchParams.get('cursor'))).toEqual([
        null,
        'opaque/+=',
        'opaque/+=',
    ]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
    );
});
test('本地历史样本：换任务清除旧列表，空历史保留当前任务', async ({ page }) => {
    await samples(page);
    await page.goto(`/tasks/${id(1)}`);
    await expect(page.locator('.history-entry')).toHaveCount(2);
    await page.goto(`/tasks/${id(2)}`);
    await expect(page.locator('.run-history').getByRole('status')).toContainText(
        '此任务尚无执行记录',
    );
    await expect(page.locator('.history-entry')).toHaveCount(0);
});
