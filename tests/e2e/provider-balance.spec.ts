import { test, expect, type Page } from '@playwright/test';
import { chooseOption } from './support/select.ts';
const providerId = '00000000-0000-4000-8000-000000000002';
const checkedAt = '2026-11-07T08:24:58.000Z';
async function samples(page: Page) {
    const requests: { body: unknown; csrf?: string }[] = [];
    const state = { failure: false, delay: 0 };
    await page.route('**/api/v1/**', async (route) => {
        const req = route.request(),
            path = new URL(req.url()).pathname;
        if (path === '/api/v1/me')
            return route.fulfill({
                json: {
                    user: {
                        id: '00000000-0000-4000-8000-000000000001',
                        email: 'balance@example.test',
                        createdAt: checkedAt,
                        preferences: {
                            defaultTimezone: 'UTC',
                            notificationPreference: { mode: 'summary', runIssues: true },
                        },
                    },
                    csrfToken: 'balance-csrf',
                },
            });
        if (path === '/api/v1/me/agent-providers')
            return route.fulfill({
                json: {
                    systemConfigured: true,
                    storageReady: true,
                    items: [
                        {
                            id: providerId,
                            name: '额度查询样本',
                            baseUrl: 'https://api.deepseek.com/v1',
                            model: 'deepseek-chat',
                            protocol: 'openai_json',
                            active: true,
                            draftActive: true,
                            hasApiKey: true,
                            revision: 5,
                            updatedAt: checkedAt,
                        },
                    ],
                },
            });
        if (path === `/api/v1/me/agent-providers/${providerId}/balance`) {
            requests.push({
                body: req.postDataJSON(),
                csrf: (await req.allHeaders())['x-csrf-token'],
            });
            if (state.delay) await new Promise((resolve) => setTimeout(resolve, state.delay));
            if (state.failure)
                return route.fulfill({
                    status: 422,
                    json: {
                        code: 'PROVIDER_BALANCE_UNSUPPORTED',
                        message: '该地址未提供所选额度接口',
                        requestId: 'local-balance',
                    },
                });
            const template = req.postDataJSON().template;
            return route.fulfill({
                json: {
                    adapter: template === 'auto' ? 'deepseek' : template,
                    checkedAt,
                    items:
                        template === 'new_api'
                            ? [
                                  {
                                      label: 'API Key 额度',
                                      scope: 'key',
                                      unit: '额度点',
                                      unlimited: true,
                                      used: 400000,
                                  },
                              ]
                            : [
                                  {
                                      label: '账号余额',
                                      scope: 'account',
                                      unit: 'CNY',
                                      remaining: 6.88,
                                  },
                              ],
                },
            });
        }
        if (req.method() !== 'GET') throw new Error(`Unexpected mutation ${req.method()} ${path}`);
        return route.fulfill({ json: { items: [], nextCursor: null } });
    });
    return { requests, state };
}
for (const width of [1440, 320]) {
    test(`供应商额度${width}：手动读取、快照时间、重试和Key范围`, async ({ page }, testInfo) => {
        await page.setViewportSize({ width, height: 1000 });
        const { requests, state } = await samples(page);
        await page.goto('/account/agent');
        const queryButton = page.getByRole('button', { name: '查询额度', exact: true });
        await expect(queryButton).toBeVisible();
        expect(requests).toHaveLength(0);
        state.delay = 250;
        await queryButton.click();
        await expect(page.getByRole('button', { name: '正在查询额度' })).toBeDisabled();
        await expect(page.getByText('剩余 6.88 CNY', { exact: true })).toBeVisible();
        expect(requests).toEqual([
            { body: { revision: 5, template: 'auto' }, csrf: 'balance-csrf' },
        ]);
        await expect(page.locator('.provider-balance time')).toHaveAttribute('datetime', checkedAt);
        await expect(page.locator('.provider-balance')).not.toContainText('查询结果不保证');
        await expect(page.locator('.provider-balance')).not.toContainText('Key 限额不代表');
        await page.screenshot({
            path: testInfo.outputPath('provider-official-balance.png'),
            fullPage: true,
        });
        state.failure = true;
        await page.getByRole('button', { name: '刷新额度' }).click();
        await expect(page.getByText('该地址未提供所选额度接口')).toBeVisible();
        await expect(page.getByText(/上次成功查询/)).toBeVisible();
        await expect(page.getByText('剩余 6.88 CNY', { exact: true })).toBeVisible();
        state.failure = false;
        await chooseOption(page, '额度查询方式', 'New API · Key 额度');
        await expect(page.getByText('剩余 6.88 CNY', { exact: true })).toHaveCount(0);
        await page.getByRole('button', { name: '查询额度', exact: true }).click();
        await expect(page.getByText('Key 未设限额', { exact: true })).toBeVisible();
        await expect(page.getByText('已用 400,000 额度点', { exact: true })).toBeVisible();
        expect(requests.at(-1)?.body).toEqual({ revision: 5, template: 'new_api' });
        await expect(page.locator('.provider-balance')).not.toContainText('站点换算规则可能不同');
        if (width === 320) {
            await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
            await expect(page.getByText('Key 未设限额', { exact: true })).toBeVisible();
        }
        expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
        ).toBe(true);
        await page.screenshot({
            path: testInfo.outputPath('provider-balance.png'),
            fullPage: true,
        });
    });
}
test('供应商额度读取离页取消，迟到响应不影响其他页面', async ({ page }) => {
    let cancelled = false;
    page.on('requestfailed', (request) => {
        if (new URL(request.url()).pathname.endsWith('/balance')) cancelled = true;
    });
    const { state } = await samples(page);
    state.delay = 600;
    await page.goto('/account/agent');
    await page.getByRole('button', { name: '查询额度', exact: true }).click();
    await page.getByRole('link', { name: '任务', exact: true }).first().click();
    await expect(page).toHaveURL(/\/tasks$/);
    await expect.poll(() => cancelled).toBe(true);
    await expect(page.getByText('剩余 6.88 CNY', { exact: true })).toHaveCount(0);
});
