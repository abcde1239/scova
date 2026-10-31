import { expect, test } from '@playwright/test';

const account = {
    user: {
        id: '00000000-0000-4000-8000-000000000001',
        email: 'a@example.org',
        preferences: {
            defaultTimezone: 'Asia/Shanghai',
            notificationPreference: { mode: 'summary', runIssues: true },
        },
        createdAt: '2026-10-31T00:00:00Z',
    },
    csrfToken: 'local-test-csrf',
};

test('本地HTTP样本：字段、401/429、键盘提交、忙碌拦截及成功交接', async ({ page }) => {
    const password = 'local-browser-password-38d7d48f';
    let attempts = 0;
    await page.route('**/api/v1/auth/login', async (route) => {
        attempts++;
        await new Promise((resolve) => setTimeout(resolve, 250));
        await route.fulfill({
            status: attempts === 1 ? 401 : attempts === 2 ? 429 : 200,
            contentType: 'application/json',
            body: JSON.stringify(
                attempts > 2
                    ? account
                    : { code: 'AUTH_FAILURE', message: 'test-only', requestId: 'sample' },
            ),
        });
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/login');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByLabel('邮箱', { exact: true })).toBeFocused();
    expect(attempts).toBe(0);
    await page.getByLabel('邮箱', { exact: true }).fill('a@example.org');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByLabel('密码', { exact: true })).toBeFocused();
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: '正在登录' })).toHaveAttribute(
        'aria-disabled',
        'true',
    );
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');
    await expect(page.getByRole('alert')).toHaveText('邮箱或密码不正确');
    await expect(page.getByRole('alert')).toBeFocused();
    expect(attempts).toBe(1);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveText('登录尝试过于频繁，请稍后重试');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page).toHaveURL(/\/tasks$/);
    expect(attempts).toBe(3);
    const stored = await page.evaluate(() => ({
        local: Object.fromEntries(
            Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)]),
        ),
        session: Object.fromEntries(
            Object.keys(sessionStorage).map((key) => [key, sessionStorage.getItem(key)]),
        ),
    }));
    expect(JSON.stringify(stored)).not.toContain('password');
    expect(JSON.stringify(stored)).not.toContain(password);
    expect(JSON.stringify(stored)).not.toContain('local-test-csrf');
});

for (const width of [320, 390]) {
    test(`${width}本地表单：200%文字仍可操作并保持相对字号`, async ({ page }, testInfo) => {
        await page.setViewportSize({ width, height: 844 });
        await page.goto('/login');
        await page.evaluate(() => {
            document.documentElement.style.fontSize = '200%';
        });
        expect(
            await page
                .getByLabel('邮箱', { exact: true })
                .evaluate((input) => parseFloat(getComputedStyle(input).fontSize)),
        ).toBeGreaterThanOrEqual(32);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
            true,
        );
        await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible();
        await page.screenshot({
            path: testInfo.outputPath(`login-${width}-200.png`),
            fullPage: true,
        });
    });
}
