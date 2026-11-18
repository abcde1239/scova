import { expect, test } from '@playwright/test';
import { openAccountMenu } from './support/account-menu.ts';

for (const { width, scale } of [
    { width: 390, scale: 100 },
    { width: 320, scale: 200 },
]) {
    test(`头像进入个人栏再进入账号页 ${width}/${scale}%：头像与摘要均可点击并保留返回路径`, async ({
        page,
    }, testInfo) => {
        await page.setViewportSize({ width, height: 844 });
        let writes = 0;
        page.on('request', (request) => {
            if (request.method() !== 'GET') writes++;
        });
        await page.goto('/inbox?from=avatar');
        await page.evaluate((value) => {
            document.documentElement.style.fontSize = `${value}%`;
        }, scale);
        const trigger = page.getByRole('button', { name: '打开个人侧栏', exact: true });
        const brand = page.getByRole('banner').getByRole('link', { name: 'Scova，任务首页' });
        await expect(trigger).toBeVisible();
        await expect(brand).toBeVisible();
        const triggerBox = (await trigger.boundingBox())!;
        const brandBox = (await brand.boundingBox())!;
        expect(
            triggerBox.y + triggerBox.height <= brandBox.y + 1 ||
                triggerBox.x + triggerBox.width <= brandBox.x + 1,
        ).toBe(true);
        expect(
            await trigger.evaluate(
                (element) =>
                    !!(
                        element.compareDocumentPosition(document.querySelector('.brand')!) &
                        Node.DOCUMENT_POSITION_FOLLOWING
                    ),
            ),
        ).toBe(true);
        await expect(page.getByRole('button', { name: '菜单', exact: true })).toHaveCount(0);
        const drawer = page.getByRole('dialog', { name: '工作台侧边栏' });
        for (const target of ['avatar', 'identity']) {
            await trigger.locator('.trigger-avatar').click();
            await expect(drawer).toBeVisible();
            await expect(drawer).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');
            await expect(drawer.getByRole('navigation').getByRole('link')).toHaveText([
                '任务',
                '收件箱',
                '资料库',
                '通知',
                'Agent 配置',
                '外观',
            ]);
            await expect(page).toHaveURL(/\/inbox\?from=avatar$/);
            const account = drawer.getByRole('link', { name: '打开账号页面', exact: true });
            await expect(account).toHaveAttribute('href', '/account');
            await expect(account).toContainText('browser-sample@example.test');
            await expect(
                drawer.getByRole('navigation').getByRole('link', { name: '账号', exact: true }),
            ).toHaveCount(0);
            if (target === 'identity') {
                await drawer.screenshot({
                    path: testInfo.outputPath('mobile-personal-drawer.png'),
                });
            }
            await account.locator(target === 'avatar' ? '.avatar' : '.drawer-identity').click();
            await expect(page).toHaveURL(/\/account$/);
            await expect(drawer).toBeHidden();
            await expect(page.getByRole('main')).toBeFocused();
            await expect(page.getByRole('heading', { name: '账号', exact: true })).toBeVisible();
            await expect(
                page.getByRole('region', { name: '当前登录账号', exact: true }),
            ).toContainText('browser-sample@example.test');
            if (target === 'identity') {
                await page.screenshot({ path: testInfo.outputPath('mobile-account-page.png') });
            }
            expect(
                await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            ).toBe(true);
            await page.goBack();
            await expect(page).toHaveURL(/\/inbox\?from=avatar$/);
            await expect(drawer).toBeHidden();
            await expect(page.getByRole('main')).toBeFocused();
        }
        expect(writes).toBe(0);
    });
}

for (const width of [1440]) {
    test(`账号入口 ${width}：退出不占正文，键盘展开、关闭与导航`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.goto('/tasks');
        const banner = page.getByRole('banner');
        const trigger = banner.getByRole('button', { name: '账号菜单', exact: true });
        await expect(trigger).toBeVisible();
        await expect(page.getByRole('main').getByRole('button', { name: '退出登录' })).toHaveCount(
            0,
        );
        await expect(page.getByRole('button', { name: '退出登录' })).toBeHidden();
        await trigger.focus();
        await trigger.press('Enter');
        const menu = page.getByRole('navigation', { name: '账号操作', exact: true });
        await expect(menu).toBeVisible();
        await expect(menu.getByText('browser-sample@example.test', { exact: true })).toBeVisible();
        await expect(menu.getByRole('button', { name: '退出登录', exact: true })).toBeVisible();
        await trigger.press('Tab');
        await expect(menu.getByRole('link', { name: '账号', exact: true })).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(menu).toBeHidden();
        await expect(trigger).toBeFocused();
        await openAccountMenu(page);
        await page.getByRole('heading', { name: '任务', exact: true }).click();
        await expect(menu).toBeHidden();
        await trigger.focus();
        await trigger.press('ArrowDown');
        await expect(menu.getByRole('link', { name: '账号', exact: true })).toBeFocused();
        await page.keyboard.press('Enter');
        await expect(page).toHaveURL(/\/account$/);
        await expect(menu).toBeHidden();
        await expect(page.getByRole('main')).toBeFocused();
        await openAccountMenu(page);
        await menu.getByRole('link', { name: '外观', exact: true }).click();
        await expect(page).toHaveURL(/\/account\/appearance$/);
        await expect(menu).toBeHidden();
        await openAccountMenu(page);
        await menu.getByRole('link', { name: '外观', exact: true }).click();
        await expect(page.getByRole('main')).toBeFocused();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
            true,
        );
    });
}

for (const width of [390, 320, 768]) {
    for (const scale of [100, 200]) {
        test(`手机侧栏 ${width}/${scale}%：账号合并、焦点约束、关闭与导航`, async ({ page }) => {
            await page.setViewportSize({ width, height: 844 });
            await page.goto('/tasks');
            await page.evaluate((value) => {
                document.documentElement.style.fontSize = `${value}%`;
            }, scale);
            const trigger = page.getByRole('button', {
                name: /^打开(个人侧栏|导航菜单)$/,
                exact: true,
            });
            await expect(page.getByRole('button', { name: '账号菜单' })).toBeHidden();
            await expect(
                page.getByRole('main').getByRole('button', { name: '退出登录' }),
            ).toHaveCount(0);
            await trigger.focus();
            await trigger.press('Enter');
            const drawer = page.getByRole('dialog', { name: '工作台侧边栏' });
            const close = drawer.getByRole('button', { name: '关闭侧边栏' });
            await expect(drawer).toBeVisible();
            await expect(drawer).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');
            expect((await drawer.boundingBox())!.x).toBe(0);
            await expect(drawer.getByText('Scova', { exact: true })).toHaveCount(0);
            const appearanceBounds = await drawer
                .getByRole('link', { name: '外观', exact: true })
                .boundingBox();
            const logoutBounds = await drawer
                .getByRole('button', { name: '退出登录', exact: true })
                .boundingBox();
            expect(
                logoutBounds!.y - appearanceBounds!.y - appearanceBounds!.height,
            ).toBeLessThanOrEqual(64);
            expect(
                await drawer.evaluate((element) => element.scrollWidth <= element.clientWidth),
            ).toBe(true);
            await expect(close).toBeFocused();
            await expect(
                drawer.getByText('browser-sample@example.test', { exact: true }),
            ).toBeVisible();
            expect(await drawer.evaluate((element) => element.matches(':modal'))).toBe(true);
            await close.press('Shift+Tab');
            const account = drawer.getByRole('link', { name: '打开账号页面', exact: true });
            await expect(account).toBeFocused();
            await account.press('Shift+Tab');
            await expect(
                drawer.getByRole('button', { name: '退出登录', exact: true }),
            ).toBeFocused();
            await page.keyboard.press('Escape');
            await expect(drawer).toBeHidden();
            await expect(trigger).toBeFocused();
            await trigger.click();
            await account.click();
            await expect(page).toHaveURL(/\/account$/);
            await expect(drawer).toBeHidden();
            await expect(page.getByRole('main')).toBeFocused();
            await trigger.click();
            await account.click();
            await expect(page.getByRole('main')).toBeFocused();
            await trigger.click();
            await page.mouse.click(width - 1, 200);
            await expect(drawer).toBeHidden();
            await expect(trigger).toBeFocused();
            expect(
                await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            ).toBe(true);
        });
    }
}

test('电脑头像悬停可查看账号，移开关闭且不触发退出', async ({ page }) => {
    let writes = 0;
    page.on('request', (request) => {
        if (request.method() !== 'GET') writes++;
    });
    await page.goto('/tasks');
    const trigger = page.getByRole('button', { name: '账号菜单', exact: true });
    await trigger.hover();
    const menu = page.getByRole('navigation', { name: '账号操作', exact: true });
    await expect(menu).toBeVisible();
    await menu.getByRole('link', { name: '账号', exact: true }).hover();
    await expect(menu).toBeVisible();
    await page.getByRole('heading', { name: '任务', exact: true }).hover();
    await expect(menu).toBeHidden();
    expect(writes).toBe(0);
});

test('手机侧栏退出失败保留账号，可重试且在途双击只发送一次', async ({ page }) => {
    let attempts = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    await page.route('**/api/v1/auth/logout', async (route) => {
        expect(route.request().method()).toBe('POST');
        expect(route.request().headers()['x-csrf-token']).toBe('browser-sample-only');
        if (++attempts === 1) {
            await gate;
            return route.fulfill({
                status: 503,
                json: { code: 'TEST_FAILURE', message: 'sample', requestId: 'sample' },
            });
        }
        return route.fulfill({ status: 204 });
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/tasks');
    await openAccountMenu(page);
    const drawer = page.getByRole('dialog', { name: '工作台侧边栏' });
    const logout = drawer.getByRole('button', { name: '退出登录', exact: true });
    await logout.click();
    await expect(logout).toHaveAttribute('aria-busy', 'true');
    await logout.press('Enter');
    await expect.poll(() => attempts).toBe(1);
    release();
    await expect(drawer.locator('.logout-error')).toHaveText('退出未成功，请检查连接后重试');
    await expect(drawer.locator('.drawer-account')).toContainText('browser-sample@example.test');
    await logout.click();
    await expect(page).toHaveURL(/\/login\?redirect=/);
    await expect(drawer).toBeHidden();
    expect(attempts).toBe(2);
    await expect(page.getByRole('button', { name: /^打开(个人侧栏|导航菜单)$/ })).toHaveCount(0);
    await expect(drawer).toHaveCount(0);
    await expect(page.getByRole('button', { name: '退出登录' })).toHaveCount(0);
    await expect(page.getByLabel('邮箱', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible();
});
