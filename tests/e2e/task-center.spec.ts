import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// Local contract-shaped samples; these are not real backend/account data.
const id = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const account = {
    user: {
        id: id(1),
        email: 'task-sample@example.test',
        preferences: {
            defaultTimezone: 'UTC',
            notificationPreference: { mode: 'summary', runIssues: true },
        },
        createdAt: '2026-10-31T00:00:00Z',
    },
    csrfToken: 'local-sample',
};
const task = (number: number, status = 'active') => ({
    id: id(number),
    title: `${number} · 长中文研究任务名称：持续查阅跨地区招生政策与学术研究观点的变化并保留来源证据`,
    status,
    revision: 1,
    currentVersionId: id(100 + number),
    nextRunAt: status === 'active' ? '2026-11-01T08:00:00Z' : null,
    createdAt: '2026-10-31T00:00:00Z',
    updatedAt: '2026-10-31T00:00:00Z',
});
const first = [task(11), task(12, 'paused'), task(13, 'archived')];
const more = task(14);
const config = {
    title: first[0]!.title,
    topic: '本地契约样例主题',
    goal: '只读摘要用于验证返回列表',
    focusPoints: [],
    exclusions: [],
    sourcePreferences: { preferredUrls: [], excludedUrls: [], officialOnly: false },
    timeRange: { kind: 'rolling', days: 7 },
    timezone: 'UTC',
    schedule: { frequency: 'manual' },
    outputFormat: 'brief',
    budget: {
        maxSearches: 1,
        maxPages: 1,
        maxDurationSeconds: 10,
        maxInputTokens: 1000,
        maxOutputTokens: 1000,
    },
    notificationPreference: { mode: 'summary', runIssues: true },
};
async function samples(page: Page) {
    const calls: string[] = [];
    await page.route('**/api/v1/me', (route) => route.fulfill({ json: account }));
    await page.route('**/api/v1/tasks**', (route) => {
        const url = new URL(route.request().url());
        calls.push(url.pathname + url.search);
        if (url.pathname.endsWith('/runs'))
            return route.fulfill({
                json: {
                    items: [
                        {
                            id: id(201),
                            taskId: more.id,
                            taskVersionId: more.currentVersionId,
                            parentRunId: null,
                            baselineRunId: null,
                            mode: 'demo',
                            status: 'failed',
                            outcome: null,
                            trigger: 'manual',
                            budget: config.budget,
                            usage: {
                                searches: 0,
                                pages: 0,
                                inputTokens: 0,
                                outputTokens: 0,
                                estimated: false,
                            },
                            coverage: null,
                            queuedAt: '2026-10-30T08:00:00Z',
                            startedAt: null,
                            finishedAt: '2026-10-30T08:01:00Z',
                            failureCode: 'SAMPLE',
                        },
                    ],
                    nextCursor: null,
                },
            });
        if (url.pathname === '/api/v1/tasks')
            return route.fulfill({
                json: url.searchParams.has('cursor')
                    ? { items: [first[0], more], nextCursor: null }
                    : { items: first, nextCursor: 'next-page' },
            });
        const selected = [...first, more].find((item) => url.pathname.endsWith(item.id));
        return route.fulfill({
            json: {
                task: selected,
                version: {
                    id: selected!.currentVersionId,
                    taskId: selected!.id,
                    version: 1,
                    configSchemaVersion: 1,
                    config: { ...config, title: selected!.title },
                    comparisonScopeHash: 'a'.repeat(64),
                    createdAt: selected!.createdAt,
                },
                baselineResetRequired: false,
            },
        });
    });
    return calls;
}

for (const width of [320, 390, 768, 1024, 1440, 1920]) {
    test(`本地任务样本：${width}与文字放大、分页返回`, async ({ page }, testInfo) => {
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        const calls = await samples(page);
        await page.setViewportSize({ width, height: 1000 });
        await page.goto('/tasks?status=all');
        await expect(page.locator('.task-card')).toHaveCount(3);
        await page.getByRole('button', { name: '加载更多', exact: true }).click();
        await expect(page.locator('.task-card')).toHaveCount(4);
        expect(calls.filter((url) => url.includes('/runs'))).toHaveLength(0);
        const title = page.getByRole('link', { name: more.title, exact: true });
        await title.focus();
        await title.press('Enter');
        await expect(page).toHaveURL(new RegExp(`/tasks/${more.id}`));
        await expect(page.getByText('本地契约样例主题', { exact: true })).toBeVisible();
        await expect(page.locator('dd').filter({ hasText: '失败' })).toContainText('2026');
        await expect(page.getByText('UTC', { exact: true })).toBeVisible();
        expect(calls.filter((url) => url.includes('/runs')).sort()).toEqual(
            [
                `/api/v1/tasks/${more.id}/runs?limit=1`,
                `/api/v1/tasks/${more.id}/runs?limit=20`,
            ].sort(),
        );
        await page.goBack();
        await expect(page.locator('.task-card')).toHaveCount(4);
        await expect(page.getByRole('main')).toBeFocused();
        expect(
            calls.filter((url) => url.startsWith('/api/v1/tasks?') && !url.includes('cursor')),
        ).toHaveLength(1);
        for (const double of [false, true]) {
            if (double)
                await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
            await expect(page.getByRole('link', { name: more.title, exact: true })).toBeVisible();
            expect(
                await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            ).toBe(true);
            const card = page.locator('.task-card').first();
            expect(await card.evaluate((element) => getComputedStyle(element).cursor)).toBe(
                'default',
            );
            await expect(card.getByRole('link')).toHaveCount(2);
            for (const link of [
                card.getByRole('link', { name: first[0]!.title, exact: true }),
                card.getByRole('link', { name: '报告历史', exact: true }),
            ])
                expect(await link.evaluate((element) => getComputedStyle(element).cursor)).toBe(
                    'pointer',
                );
            await testInfo.attach(`${width}-${double ? 'double' : 'normal'}`, {
                body: await page.screenshot({
                    path: testInfo.outputPath(`${double ? 'double' : 'normal'}.png`),
                    fullPage: true,
                }),
                contentType: 'image/png',
            });
        }
        await page.getByRole('radio', { name: '暂停', exact: true }).check();
        await expect(page.locator('.task-card')).toHaveCount(1);
        await expect(
            page.getByRole('heading', { name: first[1]!.title, exact: true }),
        ).toBeVisible();
        expect(calls.every((url) => !url.includes('status='))).toBe(true);
        expect(calls.filter((url) => url.includes('/runs')).sort()).toEqual(
            [
                `/api/v1/tasks/${more.id}/runs?limit=1`,
                `/api/v1/tasks/${more.id}/runs?limit=20`,
            ].sort(),
        );
        expect(errors).toEqual([]);
    });
}

test('本地任务样本：加载、失败重试与空态', async ({ page }) => {
    await samples(page);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    let attempts = 0;
    await page.route('**/api/v1/tasks?**', async (route) => {
        attempts++;
        if (attempts === 1) {
            await gate;
            return route.fulfill({
                status: 503,
                json: { code: 'SAMPLE', message: '本地失败样例', requestId: 'sample' },
            });
        }
        return route.fulfill({ json: { items: [], nextCursor: null } });
    });
    await page.goto('/tasks');
    await expect(page.getByRole('status')).toContainText('正在加载');
    release();
    await expect(page.getByRole('status')).toContainText('任务读取失败');
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('没有匹配的任务');
    expect(attempts).toBe(2);
});

test('本地任务样本：摘要直接打开与刷新、历史失败重试', async ({ page }, testInfo) => {
    const calls = await samples(page);
    let summaryAttempts = 0;
    let historyAttempts = 0;
    await page.route('**/api/v1/tasks/*/runs?**', (route) => {
        const url = new URL(route.request().url());
        if (url.searchParams.get('limit') === '1') {
            summaryAttempts++;
            if (summaryAttempts === 1)
                return route.fulfill({
                    status: 503,
                    json: { code: 'SAMPLE', message: '样例失败', requestId: 'sample' },
                });
        } else if (url.searchParams.get('limit') === '20') {
            historyAttempts++;
        } else {
            return route.fulfill({ status: 501, json: { message: 'Unexpected runs query' } });
        }
        return route.fulfill({ json: { items: [], nextCursor: null } });
    });
    await page.setViewportSize({ width: 390, height: 1000 });
    await page.goto(`/tasks/${more.id}?status=paused`);
    await expect(page.getByText('本地契约样例主题', { exact: true })).toBeVisible();
    await expect(page.locator('dd').filter({ hasText: '暂不可用' })).toBeVisible();
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await expect(page.getByText('尚无执行', { exact: true })).toBeVisible();
    expect(summaryAttempts).toBe(2);
    expect(historyAttempts).toBe(1);
    expect(calls.filter((url) => url.startsWith('/api/v1/tasks?'))).toHaveLength(0);
    await page.reload();
    await expect(page.getByText('本地契约样例主题', { exact: true })).toBeVisible();
    await expect(page.getByText('尚无执行', { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('summary-390.png'), fullPage: true });
    await page
        .getByRole('navigation', { name: '面包屑导航' })
        .getByRole('link', { name: '任务', exact: true })
        .click();
    await expect(page.getByRole('radio', { name: '暂停', exact: true })).toBeChecked();
    await expect(page.locator('.task-card')).toHaveCount(1);
});
