import { expect, test } from '@playwright/test';

const account = {
    user: {
        id: '00000000-0000-4000-8000-000000000001',
        email: 'session-sample@example.test',
        preferences: {
            defaultTimezone: 'UTC',
            notificationPreference: { mode: 'summary', runIssues: true },
        },
        createdAt: '2026-10-31T00:00:00Z',
    },
    csrfToken: 'session-test-only',
};
const failure = { code: 'TEST_FAILURE', message: 'sample', requestId: 'sample' };

test('本地会话样本：直达刷新等待恢复，不闪受保护内容', async ({ page }) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    await page.route('**/api/v1/me', async (route) => {
        await gate;
        await route.fulfill({ json: account });
    });
    await page.goto('/library', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('status')).toContainText('正在恢复账号会话');
    await expect(page.locator('.library-view')).toHaveCount(0);
    release();
    await expect(page.getByRole('heading', { name: '资料库', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '退出登录' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: '资料库', exact: true })).toBeVisible();
    await expect(page.locator('.library-view')).toBeVisible();
});

test('本地会话样本：401登录后回站内目标，拒绝外站目标', async ({ page }) => {
    await page.route('**/api/v1/me', (route) => route.fulfill({ status: 401, json: failure }));
    await page.route('**/api/v1/auth/login', (route) => route.fulfill({ json: account }));
    await page.goto('/library?filter=all#section');
    await expect(page).toHaveURL(/\/login\?redirect=/);
    await page.getByLabel('邮箱', { exact: true }).fill(account.user.email);
    await page.getByLabel('密码', { exact: true }).fill('local-only-password');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page).toHaveURL(/\/library\?filter=all#section$/);
    await page.goto('/login?redirect=https%3A%2F%2Fevil.example');
    await page.getByLabel('邮箱', { exact: true }).fill(account.user.email);
    await page.getByLabel('密码', { exact: true }).fill('local-only-password');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page).toHaveURL(/\/tasks$/);
});

test('本地会话样本：503重试、文字放大与焦点', async ({ page }) => {
    let attempts = 0;
    await page.route('**/api/v1/me', (route) =>
        route.fulfill(++attempts === 1 ? { status: 503, json: failure } : { json: account }),
    );
    await page.setViewportSize({ width: 320, height: 844 });
    await page.goto('/library');
    await expect(page.getByRole('status')).toContainText('账号服务暂不可达');
    await expect(page.locator('.library-view')).toHaveCount(0);
    await page.evaluate(() => {
        document.documentElement.style.fontSize = '200%';
    });
    const retry = page.getByRole('button', { name: '重试', exact: true });
    await retry.focus();
    await retry.press('Enter');
    await expect(page.locator('.library-view')).toBeVisible();
    await expect(page.locator('#main-content')).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
    );
    expect(attempts).toBe(2);
});

test('本地会话样本：退出失败可重试，成功后退不可恢复旧页面', async ({ page }) => {
    let loggedOut = false;
    let attempts = 0;
    await page.route('**/api/v1/me', (route) =>
        route.fulfill(loggedOut ? { status: 401, json: failure } : { json: account }),
    );
    await page.route('**/api/v1/auth/logout', (route) => {
        if (++attempts === 1) return route.fulfill({ status: 503, json: failure });
        loggedOut = true;
        return route.fulfill({ status: 204 });
    });
    await page.goto('/library');
    await page.getByRole('link', { name: '任务', exact: true }).click();
    await page.getByRole('button', { name: '退出登录' }).click();
    await expect(page.getByRole('alert')).toHaveText('退出未成功，请检查连接后重试');
    await expect(page).toHaveURL(/\/tasks$/);
    await page.getByRole('button', { name: '退出登录' }).click();
    await expect(page).toHaveURL(/\/login\?redirect=/);
    await expect(page.getByRole('button', { name: '退出登录' })).toHaveCount(0);
    await page.goBack();
    await expect(page).toHaveURL(/\/login\?redirect=/);
    await expect(page.locator('.route-status')).toHaveCount(0);
});
