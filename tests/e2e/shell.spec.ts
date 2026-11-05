import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

async function openPrimaryNavigation(page: Page) {
    let navigation = page.getByRole('navigation', { name: '主导航', exact: true });
    if (!(await navigation.isVisible())) {
        await page.getByRole('button', { name: /^打开(个人侧栏|导航菜单)$/ }).click();
        navigation = page.getByRole('navigation', { name: '工作台菜单', exact: true });
    }
    await expect(navigation).toBeVisible();
    return navigation;
}

function recordErrors(page: Page) {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    return errors;
}

test.beforeAll(async ({ browser }) => {
    console.log(`Browser: Chromium ${browser.version()}`);
});

test('Scova 品牌与面包屑保留真实层级，快捷入口可键盘导航', async ({ page }) => {
    await page.goto('/account/appearance');
    await expect(
        page.getByRole('banner').getByRole('link', { name: 'Scova，任务首页' }),
    ).toHaveText('Scova');
    const breadcrumbs = page.getByRole('navigation', { name: '面包屑导航' });
    await expect(breadcrumbs.locator('[aria-current="page"]')).toHaveText('外观');
    const parent = breadcrumbs.getByRole('link', { name: '账号', exact: true });
    await parent.focus();
    await parent.press('Enter');
    await expect(page).toHaveURL(/\/account$/);
    await expect(breadcrumbs).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '账号', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '账号信息', exact: true })).toHaveCount(0);
    const shortcut = page.getByRole('link', { name: '外观与阅读设置' });
    await expect(shortcut).toHaveClass(/n-button/);
    await shortcut.focus();
    await shortcut.press('Enter');
    await expect(page).toHaveURL(/\/account\/appearance$/);
    await expect(page.locator('a button, button a')).toHaveCount(0);
});

test('有效路径与未知路径均可刷新直达，标题、导航和焦点正确', async ({ page }, testInfo) => {
    const errors = recordErrors(page);
    for (const [url, title, selected] of [
        ['/tasks', '任务', '任务'],
        ['/inbox', '收件箱', '收件箱'],
        ['/library', '资料库', '资料库'],
        ['/notifications', '通知', '通知'],
        ['/account', '账号', '账号'],
        ['/account/appearance', '外观', '外观'],
        ['/unknown/deep?from=shell', '页面未找到', null],
    ] as const) {
        await page.goto(url);
        for (const refresh of [false, true]) {
            if (refresh) await page.reload();
            await expect(page).toHaveTitle(`${title} · 知巡 Scova`);
            await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
            await expect(page.getByRole('main')).toBeFocused();
            expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe(url);
            const active = page.getByRole('banner').locator('nav [aria-current="page"]:visible');
            const accountPage = selected === '账号' || selected === '外观';
            await expect(active).toHaveCount(selected && !accountPage ? 1 : 0);
            if (selected && !accountPage) await expect(active).toHaveText(selected);
            if (accountPage)
                await expect(page.getByRole('button', { name: '账号菜单' })).toHaveAttribute(
                    'aria-current',
                    'true',
                );
        }
    }
    await expect(page.getByText('此页面不存在。', { exact: true })).toBeVisible();
    await expect(page.getByRole('banner').locator('nav [aria-current="page"]')).toHaveCount(0);
    await page.getByRole('link', { name: '返回任务', exact: true }).click();
    await expect(page).toHaveURL(/\/tasks$/);
    await expect(page.getByRole('main')).toBeFocused();
    await testInfo.attach('desktop-shell', {
        body: await page.screenshot({
            path: testInfo.outputPath('desktop-shell.png'),
            fullPage: true,
        }),
        contentType: 'image/png',
    });
    expect(errors).toEqual([]);
});

test('导航可用且 390 视口没有整页横溢出，跳到主内容可键盘操作', async ({ page }, testInfo) => {
    const errors = recordErrors(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/tasks');
    const navigation = await openPrimaryNavigation(page);
    const inbox = navigation.getByRole('link', { name: '收件箱', exact: true });
    await inbox.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/inbox$/);
    await expect(page.getByRole('main')).toBeFocused();
    await expect(page.getByRole('heading', { name: '收件箱', exact: true })).toBeVisible();
    await expect(
        (await openPrimaryNavigation(page)).getByRole('link', { name: '收件箱', exact: true }),
    ).toHaveAttribute('aria-current', 'page');
    const closeNavigation = page.getByRole('button', { name: '关闭侧边栏', exact: true });
    if (await closeNavigation.isVisible()) await closeNavigation.click();
    expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    const skip = page.getByRole('link', { name: '跳到主内容', exact: true });
    await skip.focus();
    await expect(skip).toBeInViewport();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('main')).toBeFocused();
    await testInfo.attach('shell-390', {
        body: await page.screenshot({ path: testInfo.outputPath('shell-390.png'), fullPage: true }),
        contentType: 'image/png',
    });
    expect(errors).toEqual([]);
});
