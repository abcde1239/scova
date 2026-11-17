import { expect, test } from '@playwright/test';

test('入口 JS 和应用 CSS 尚未下载时，HTML 已有可读首屏', async ({ page }) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route(/\/assets\/.*\.(js|css)$/, async (route) => {
        await gate;
        await route.continue();
    });
    try {
        await page.goto('/library?filter=all#section', { waitUntil: 'commit' });
        await expect(page.locator('#startup-screen')).toBeVisible();
        await expect(page.getByRole('status')).toHaveText('正在加载应用');
        await page.setViewportSize({ width: 320, height: 844 });
        await page.emulateMedia({ colorScheme: 'dark' });
        await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
            true,
        );
        await expect(page.locator('#startup-screen')).toHaveCSS(
            'background-color',
            'rgb(16, 20, 24)',
        );
    } finally {
        release();
    }
    await expect(page.locator('.library-view')).toBeVisible();
    await expect(page.locator('#startup-screen')).toHaveCount(0);
});

for (const [chunk, extension] of [
    ['bootstrap', 'js'],
    ['bootstrap', 'css'],
    ['LibraryView', 'js'],
]) {
    test(`${chunk}.${extension} 加载失败可重载恢复，保留原 URL`, async ({ page }) => {
        const asset = new RegExp(`/assets/${chunk}-[^/]+\\.${extension}$`);
        // Block both modulepreload and import: a failed preload alone may be requested again.
        await page.route(asset, (route) => route.abort());
        await page.goto('/library?filter=all#section');
        await expect(page.getByRole('alert')).toHaveText('应用加载失败，请检查网络后重新加载');
        await expect(page.locator('.library-view')).toHaveCount(0);
        await page.unroute(asset);
        await page.getByRole('link', { name: '重新加载', exact: true }).click();
        await expect(page.locator('.library-view')).toBeVisible();
        await expect(page).toHaveURL(/\/library\?filter=all#section$/);
        await expect(page.locator('#startup-screen')).toHaveCount(0);
    });
}

test('JavaScript 被禁用时显示启用提示', async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    try {
        const page = await context.newPage();
        await page.goto('http://127.0.0.1:4189/library');
        // Playwright text/role selectors intentionally exclude noscript descendants.
        const message = page.locator('#startup-screen noscript p');
        await expect(message).toBeVisible();
        await expect(message).toHaveText('请启用 JavaScript 后重新加载。');
        await expect(page.getByRole('status')).not.toBeVisible();
    } finally {
        await context.close();
    }
});
