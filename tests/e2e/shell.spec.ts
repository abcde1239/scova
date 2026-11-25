import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

async function openPrimaryNavigation(page: Page) {
    await expect(page.getByRole('main')).toBeVisible();
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
        page.getByRole('banner').getByRole('link', { name: 'Scova，工作台首页' }),
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
    await page.setViewportSize({ width: 1440, height: 900 });
    for (const [url, title, selected] of [
        ['/tasks', '任务', '任务'],
        ['/tasks/new', '新建任务', '新建任务'],
        ['/projects', '项目', '项目'],
        ['/workflows', '工作流', '工作流'],
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
            const notificationPage = selected === '通知';
            await expect(active).toHaveCount(selected && !accountPage && !notificationPage ? 1 : 0);
            if (selected && !accountPage && !notificationPage)
                await expect(active).toHaveText(selected);
            const notification = page.getByRole('button', { name: '通知', exact: true });
            if (notificationPage) await expect(notification).toHaveClass(/selected/);
            else await expect(notification).not.toHaveClass(/selected/);
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

test('桌面侧栏的任务和新建任务独立可达，底部弹层留在视口内', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/inbox');
    const banner = page.getByRole('banner');
    const main = page.getByRole('main');
    const navigation = banner.getByRole('navigation', { name: '主导航', exact: true });
    await expect(navigation).toBeVisible();
    const tasks = navigation.getByRole('link', { name: '任务', exact: true });
    const create = navigation.getByRole('link', { name: '新建任务', exact: true });
    const brand = banner.getByRole('link', { name: 'Scova，工作台首页' });
    expect((await banner.boundingBox())!.width).toBeLessThanOrEqual((await main.boundingBox())!.x);
    const toggle = banner.getByRole('button', { name: '收起侧边栏' });
    await toggle.focus();
    await page.keyboard.press('Tab');
    await expect(brand).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(navigation.getByRole('link', { name: '选择项目以新建会话' })).toBeFocused();
    await expect(brand).toHaveAttribute('href', '/');
    await create.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/tasks\/new$/);
    await expect(main).toBeFocused();
    await expect(create).toHaveAttribute('aria-current', 'page');
    await expect(tasks).not.toHaveAttribute('aria-current');
    await tasks.click();
    await expect(page).toHaveURL(/\/tasks$/);

    const notification = banner.getByRole('button', { name: '通知', exact: true });
    await notification.focus();
    const preview = page.getByRole('dialog', { name: '通知预览', exact: true });
    await expect(preview).toBeInViewport({ ratio: 1 });
    expect((await preview.boundingBox())!.x).toBeGreaterThan((await notification.boundingBox())!.x);
    await page.keyboard.press('Escape');
    await expect(notification).toBeFocused();

    const account = banner.getByRole('button', { name: '账号菜单', exact: true });
    await account.focus();
    await page.keyboard.press('Enter');
    const accountPanel = banner.getByRole('navigation', { name: '账号操作', exact: true });
    await expect(accountPanel).toBeInViewport({ ratio: 1 });
    expect((await accountPanel.boundingBox())!.y).toBeLessThan((await account.boundingBox())!.y);
    await page.keyboard.press('Escape');
    await expect(account).toBeFocused();
});

test('桌面侧栏可键盘收起并记住偏好，窄屏仍使用抽屉', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/account');
    const banner = page.getByRole('banner');
    const main = page.getByRole('main');
    const navigation = banner.getByRole('navigation', { name: '主导航', exact: true });
    const collapse = banner.getByRole('button', { name: '收起侧边栏', exact: true });
    const expand = banner.getByRole('button', { name: '展开侧边栏', exact: true });
    await expect(collapse).toHaveAttribute('aria-expanded', 'true');
    const expandedSidebar = (await banner.boundingBox())!;
    const expandedMain = (await main.boundingBox())!;
    await page.screenshot({ path: testInfo.outputPath('sidebar-expanded.png') });

    await collapse.focus();
    await page.keyboard.press('Space');
    await expect(expand).toHaveAttribute('aria-expanded', 'false');
    await expect(expand).toBeFocused();
    expect((await banner.boundingBox())!.width).toBeLessThan(expandedSidebar.width);
    expect((await main.boundingBox())!.x).toBeLessThan(expandedMain.x);
    const create = navigation.getByRole('link', { name: '新建任务', exact: true });
    await page.keyboard.press('Tab');
    await expect(create).toBeFocused();
    const projects = navigation.getByRole('link', { name: '项目', exact: true });
    await expect(projects).toHaveAttribute('title', '项目');
    await projects.click();
    await expect(page).toHaveURL(/\/projects$/);
    await expect(expand).toBeVisible();

    await page.reload();
    await expect(expand).toHaveAttribute('aria-expanded', 'false');
    await expect(projects).toHaveAttribute('aria-current', 'page');
    await page.goto('/account');
    await expect(expand).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('sidebar-collapsed.png') });

    await page.setViewportSize({ width: 880, height: 600 });
    await expect(navigation).toBeVisible();
    const language = banner.getByRole('combobox', { name: '界面语言' });
    await language.click();
    const options = page.getByRole('listbox');
    await expect(options).toBeInViewport({ ratio: 1 });
    await page.keyboard.press('Escape');
    await expect(language).toBeFocused();
    const notifications = banner.getByRole('button', { name: '通知', exact: true });
    await notifications.focus();
    await expect(page.getByRole('dialog', { name: '通知预览' })).toBeInViewport({ ratio: 1 });
    await page.keyboard.press('Escape');
    const account = banner.getByRole('button', { name: '账号菜单', exact: true });
    await account.press('Enter');
    await expect(banner.getByRole('navigation', { name: '账号操作' })).toBeInViewport({ ratio: 1 });
    await page.keyboard.press('Escape');

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(expand).toBeHidden();
    await expect(language).toBeVisible();
    const mobileNavigation = await openPrimaryNavigation(page);
    await expect(mobileNavigation.getByRole('link', { name: '项目', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '关闭侧边栏', exact: true }).click();
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(expand).toBeVisible();
    await expand.click();
    await expect(collapse).toHaveAttribute('aria-expanded', 'true');
    await page.reload();
    await expect(collapse).toHaveAttribute('aria-expanded', 'true');
});

test('导航可用且 390 视口没有整页横溢出，跳到主内容可键盘操作', async ({ page }, testInfo) => {
    const errors = recordErrors(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/tasks');
    const navigation = await openPrimaryNavigation(page);
    const tasks = navigation.getByRole('link', { name: '任务', exact: true });
    await expect(tasks).toBeVisible();
    await expect(tasks).toHaveAttribute('aria-current', 'page');
    const create = navigation.getByRole('link', { name: '新建任务', exact: true });
    await create.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/tasks\/new$/);
    await expect(page.getByRole('main')).toBeFocused();
    await expect(
        (await openPrimaryNavigation(page)).getByRole('link', { name: '新建任务', exact: true }),
    ).toHaveAttribute('aria-current', 'page');
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
