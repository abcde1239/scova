import { expect, test } from '@playwright/test';
import { chooseTimezone } from './support/select.ts';

const password = '12345678';
const account = {
    user: {
        id: '00000000-0000-4000-8000-000000000001',
        email: 'new@example.test',
        preferences: {
            defaultTimezone: 'Asia/Shanghai',
            notificationPreference: { mode: 'summary', runIssues: true },
        },
        createdAt: '2026-10-31T00:00:00Z',
    },
    csrfToken: 'browser-register-csrf',
};
test('本地注册样本：字段/重复邮箱/限流、原生提交和一次在途请求', async ({ page }) => {
    let attempts = 0;
    await page.route('**/api/v1/auth/register', async (route) => {
        attempts++;
        await new Promise((resolve) => setTimeout(resolve, 200));
        await route.fulfill({
            status: attempts === 1 ? 409 : attempts === 2 ? 429 : 201,
            json:
                attempts > 2
                    ? account
                    : {
                          code: attempts === 1 ? 'EMAIL_ALREADY_REGISTERED' : 'RATE_LIMITED',
                          message: 'sample',
                          requestId: 'sample',
                      },
        });
    });
    await page.goto('/login');
    await page.getByRole('link', { name: '注册账号' }).click();
    await page.getByRole('button', { name: '注册', exact: true }).click();
    await expect(page.getByLabel('邮箱', { exact: true })).toBeFocused();
    await page.getByLabel('邮箱', { exact: true }).fill(account.user.email);
    await page.getByLabel('密码', { exact: true }).fill('short');
    await page.getByRole('button', { name: '注册', exact: true }).click();
    await expect(page.getByLabel('密码', { exact: true })).toBeFocused();
    await page.getByLabel('密码', { exact: true }).fill(password);
    await expect(page.getByText('密码至少需要 8 位', { exact: true })).toBeVisible();
    expect(attempts).toBe(0);
    await chooseTimezone(page, 'Asia/Shanghai');
    await page.getByLabel('密码', { exact: true }).focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await expect(page.getByText('该邮箱已注册，请返回登录', { exact: true })).toBeVisible();
    expect(attempts).toBe(1);
    await expect(page.getByLabel('邮箱', { exact: true })).toHaveValue(account.user.email);
    await page.getByRole('button', { name: '注册', exact: true }).click();
    await expect(
        page.locator('.scova-notifications .n-notification').last().getByRole('alert'),
    ).toContainText('频繁');
    await page.getByRole('button', { name: '注册', exact: true }).click();
    await expect(page).toHaveURL(/\/tasks$/);
    expect(attempts).toBe(3);
    const storage = await page.evaluate(() =>
        JSON.stringify([Object.values(localStorage), Object.values(sessionStorage)]),
    );
    expect(storage).not.toContain(password);
    expect(storage).not.toContain(account.csrfToken);
    await page.goto('/register');
    await expect(page.getByLabel('密码', { exact: true })).toHaveValue('');
});

test('本地注册样本：关闭注册可返回登录，320宽200%文字可达', async ({ page }, testInfo) => {
    let attempts = 0;
    await page.route('**/api/v1/auth/register', (route) => {
        attempts++;
        return route.fulfill({
            status: 403,
            json: { code: 'REGISTRATION_DISABLED', message: 'sample', requestId: 'sample' },
        });
    });
    await page.setViewportSize({ width: 320, height: 844 });
    await page.goto('/register');
    await page.evaluate(() => {
        document.documentElement.style.fontSize = '200%';
    });
    await page.getByLabel('邮箱', { exact: true }).fill(account.user.email);
    await page.getByLabel('密码', { exact: true }).fill(password);
    await chooseTimezone(page, 'UTC');
    await page.getByLabel('密码', { exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(
        page.locator('.scova-notifications .n-notification').last().getByRole('alert'),
    ).toHaveText('当前部署已关闭注册，请返回登录');
    await expect(
        page.locator('.scova-notifications .n-notification').last().getByRole('alert'),
    ).not.toBeFocused();
    await expect(page.getByRole('button', { name: '注册', exact: true })).toBeDisabled();
    expect(attempts).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
    );
    expect(
        await page
            .getByLabel('邮箱', { exact: true })
            .evaluate((input) => parseFloat(getComputedStyle(input).fontSize)),
    ).toBeGreaterThanOrEqual(32);
    await page.screenshot({ path: testInfo.outputPath('register-320-double.png'), fullPage: true });
    await page.getByRole('link', { name: '返回登录' }).click();
    await expect(page).toHaveURL(/\/login$/);
});
