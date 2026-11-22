import { expect, test } from '@playwright/test';
import { chooseOption } from './support/select.ts';
const themeLabels: Record<string, string> = {
    blue: '蓝色',
    pine: '松绿',
    iris: '鸢尾',
    amber: '琥珀',
};

test('下拉框：主题键盘选择、Esc 和 Tab 退出并保留焦点', async ({ page }) => {
    await page.goto('/login');
    await chooseOption(page, '主题', '蓝色');
    const theme = page.getByRole('combobox', { name: '主题', exact: true });
    await theme.press('Enter');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(theme).toHaveText('松绿');
    await expect(theme).toBeFocused();
    await theme.press('Enter');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Escape');
    await expect(theme).toHaveText('松绿');
    await expect(theme).toHaveAttribute('aria-expanded', 'false');
    await expect(theme).toBeFocused();
    await theme.press('Enter');
    await page.keyboard.press('Tab');
    await expect(theme).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByRole('combobox', { name: '外观', exact: true })).toBeFocused();
});

test('时区下拉框：搜索与空态不改值，确认选择不提交表单', async ({ page }) => {
    let attempts = 0;
    await page.route('**/api/v1/auth/register', (route) => {
        attempts++;
        return route.fulfill({
            status: 503,
            json: { code: 'TEST', message: 'sample', requestId: 'select' },
        });
    });
    await page.goto('/register');
    const timezone = page.getByLabel('默认时区', { exact: true });
    const initial = await timezone.textContent();
    await timezone.click();
    const search = page.getByRole('combobox', { name: '搜索默认时区', exact: true });
    await expect(search).toBeFocused();
    await search.fill('not-a-timezone');
    await expect(page.getByRole('status')).toHaveText('没有找到匹配项，请换个关键词');
    await search.press('Escape');
    await expect(timezone).toHaveText(initial!);
    await expect(timezone).toBeFocused();
    await timezone.click();
    await search.fill('伦敦');
    await expect(
        page.getByRole('listbox', { name: '默认时区', exact: true }).getByRole('option'),
    ).toHaveCount(1);
    await search.press('Enter');
    await expect(timezone).toContainText('Europe/London');
    await expect(timezone).toBeFocused();
    expect(attempts).toBe(0);
});

test('下拉浮层：320宽与200%文字不越界，外点关闭', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 844 });
    await page.goto('/register');
    await page.evaluate(() => {
        document.documentElement.style.fontSize = '200%';
    });
    await page.getByLabel('默认时区', { exact: true }).click();
    const panel = page.getByRole('dialog', { name: '选择默认时区' });
    await expect(panel).toBeVisible();
    const bounds = await panel.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(844);
    await page.getByRole('combobox', { name: '搜索默认时区', exact: true }).fill('东京');
    await expect(
        page.getByRole('listbox', { name: '默认时区', exact: true }).getByRole('option'),
    ).toContainText('Asia/Tokyo');
    await page.getByRole('listbox', { name: '默认时区', exact: true }).getByRole('option').click();
    await expect(page.getByLabel('默认时区', { exact: true })).toContainText('Asia/Tokyo');
    await page.getByLabel('默认时区', { exact: true }).click();
    await page.mouse.click(2, 2);
    await expect(panel).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
    );
});

test.beforeEach(async ({ page }) => {
    await page.route('**/api/v1/me', (route) =>
        route.fulfill({
            status: 401,
            json: { code: 'UNAUTHORIZED', message: '请先登录', requestId: 'auth-layout' },
        }),
    );
});

for (const [path, title] of [
    ['/login', '登录'],
    ['/register', '注册'],
] as const) {
    for (const width of [1024, 1440]) {
        test(`${title}：${width}桌面分栏，表单在右栏居中`, async ({ page }) => {
            await page.setViewportSize({ width, height: 1000 });
            await page.goto(path);
            await expect(page.getByLabel('邮箱', { exact: true })).toBeVisible();
            await expect(page.getByRole('main')).toHaveCount(1);
            await expect(page.getByRole('heading', { level: 1 })).toHaveText(title);
            await expect(page.getByRole('navigation')).toHaveCount(0);
            await expect(page.getByRole('button', { name: '账号菜单' })).toHaveCount(0);
            await expect(page.locator('#main-content')).toBeFocused();
            const showcase = page.locator('.auth-showcase');
            await expect(showcase).toBeVisible();
            if (path === '/register') {
                await expect(showcase.locator('.auth-preview')).toHaveAttribute(
                    'aria-hidden',
                    'true',
                );
                await expect(page.locator('.product-demo')).toHaveCount(0);
            } else {
                await expect(showcase.getByRole('button', { name: '查看示例引用' })).toBeVisible();
            }
            await expect(page.locator('.auth-brand')).toBeHidden();
            const column = await page.locator('.auth-form-column').boundingBox();
            const panel = await page.locator('.auth-panel').boundingBox();
            const form = await page.locator('form').boundingBox();
            expect(column).not.toBeNull();
            expect(panel).not.toBeNull();
            expect(form).not.toBeNull();
            const center = column!.x + column!.width / 2;
            expect(column!.x).toBeGreaterThan(width * 0.4);
            expect(Math.abs(panel!.x + panel!.width / 2 - center)).toBeLessThan(2);
            expect(Math.abs(form!.x + form!.width / 2 - center)).toBeLessThan(2);
            expect(panel!.y).toBeGreaterThanOrEqual(0);
            expect(panel!.y + panel!.height).toBeLessThanOrEqual(1000);
            expect(form!.width).toBeLessThanOrEqual(448);
            expect(form!.width).toBeGreaterThan(300);
        });
    }
    for (const [width, height, scale] of [
        [320, 844, 2],
        [390, 844, 1],
        [844, 390, 1],
    ]) {
        test(`${title}：${width}×${height}/${scale * 100}%可滚动操作`, async ({ page }) => {
            await page.setViewportSize({ width, height });
            await page.goto(path);
            await expect(page.getByLabel('邮箱', { exact: true })).toBeVisible();
            if (scale === 2)
                await page.evaluate(() => {
                    document.documentElement.style.fontSize = '200%';
                });
            await expect(page.locator('.auth-showcase')).toBeHidden();
            await expect(page.getByRole('link', { name: '向下探索产品预览' })).toHaveCount(0);
            const brand = await page.locator('.auth-brand').boundingBox();
            expect(brand!.y).toBeGreaterThanOrEqual(0);
            const appearance = await page.getByLabel('外观', { exact: true }).boundingBox();
            expect(brand!.y).toBeGreaterThan(appearance!.y + appearance!.height);
            const accent = page.getByLabel('主题', { exact: true });
            await expect(accent).toBeInViewport();
            await chooseOption(page, '主题', '鸢尾');
            await expect(accent).toHaveText('鸢尾');
            await page.getByRole('button', { name: title, exact: true }).click();
            await expect(page.getByLabel('邮箱', { exact: true })).toBeFocused();
            expect(
                await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            ).toBe(true);
            const link = page.getByRole('link', {
                name: path === '/login' ? '注册账号' : '返回登录',
            });
            await link.click();
            await expect(page.getByRole('heading', { level: 1 })).toHaveText(
                path === '/login' ? '注册' : '登录',
            );
            await expect(page.getByRole('navigation')).toHaveCount(0);
        });
    }
}

test('登录与注册共享外观选择，重新加载保留主题并响应系统设置', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/login');
    await chooseOption(page, '外观', '深色');
    await expect(page.locator('.scova-theme')).toHaveClass(/scova-theme--dark/);
    await page.getByRole('link', { name: '注册账号' }).click();
    await expect(page.getByLabel('外观', { exact: true })).toHaveText('深色');
    await page.reload();
    await expect(page.locator('.scova-theme')).toHaveClass(/scova-theme--dark/);
    await chooseOption(page, '外观', '跟随系统');
    await expect(page.locator('.scova-theme')).not.toHaveClass(/scova-theme--dark/);
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('.scova-theme')).toHaveClass(/scova-theme--dark/);
});

test('登录页没有循环动效，切换减少动态效果时保持表单位置', async ({ page }) => {
    const infinite = () =>
        page.evaluate(
            () =>
                document
                    .getAnimations()
                    .filter(
                        (animation) =>
                            animation.effect?.getComputedTiming().iterations === Infinity,
                    ).length,
        );
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto('/login');
    await expect(page.getByLabel('邮箱', { exact: true })).toBeVisible();
    await expect(page.locator('.auth-backdrop')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /背景动画/ })).toHaveCount(0);
    expect(await infinite()).toBe(0);
    const panel = await page.locator('.auth-panel').boundingBox();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await infinite()).toBe(0);
    expect(await page.locator('.auth-panel').boundingBox()).toEqual(panel);
});

test('主题切换只改变强调色，保留表单、布局和跨页偏好', async ({ page }) => {
    await page.goto('/login');
    const email = page.getByLabel('邮箱', { exact: true });
    await email.fill('theme-preview@example.test');
    await page.evaluate(() => document.fonts.ready);
    const panelBefore = await page.locator('.auth-panel').boundingBox();
    const accents = new Set<string>();
    for (const accent of ['blue', 'pine', 'iris', 'amber']) {
        await chooseOption(page, '主题', themeLabels[accent]!);
        await expect(email).toHaveValue('theme-preview@example.test');
        accents.add(
            await page.locator('.auth-headline em').evaluate((el) => getComputedStyle(el).color),
        );
        expect(await page.locator('.auth-panel').boundingBox()).toEqual(panelBefore);
    }
    expect(accents.size).toBe(4);
    await chooseOption(page, '外观', '深色');
    await page.getByRole('link', { name: '注册账号' }).click();
    await expect(page.getByLabel('主题', { exact: true })).toHaveText('琥珀');
    await page.reload();
    await expect(page.getByLabel('主题', { exact: true })).toHaveText('琥珀');
    await expect(page.getByLabel('外观', { exact: true })).toHaveText('深色');
});

test('桌面报告卡响应悬停与键盘翻面，减少动态效果时保留静态切换', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto('/login');
    const tilt = page.locator('.preview-report');
    const progress = page.locator('.preview-card--run');
    const flip = page.locator('.preview-flip');
    const button = page.getByRole('button', { name: '查看示例引用' });
    await tilt.hover();
    await expect(tilt).toHaveCSS('rotate', '-3deg');
    await expect(progress).toHaveCSS('rotate', '2.75deg');
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    await button.press('Enter');
    const back = page.getByRole('button', { name: '返回报告摘要' });
    await expect(back).toBeFocused();
    await expect(back).toHaveAttribute('aria-expanded', 'true');
    await expect(flip).not.toHaveCSS('transform', 'none');
    await expect(page.locator('#auth-report-sources')).toHaveAttribute('aria-hidden', 'false');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(flip).toHaveCSS('transition-duration', '0s');
    await expect(flip).toHaveCSS('transform', 'none');
    await expect(tilt).toHaveCSS('rotate', '-1deg');
    await expect(page.getByText('仓库许可证文件')).toBeVisible();
    await back.press('Space');
    await expect(button).toBeFocused();
    await expect(page.getByText('仓库许可证文件')).toBeHidden();
    await expect(page.getByText('两项实质许可证变更，一项存疑')).toBeVisible();
});

for (const width of [1440, 1024]) {
    test(`登录页 ${width}：仅左栏滚动，右栏位置和表单输入保持`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        const reduced = width === 1024;
        await page.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference' });
        await page.goto('/login');
        const email = page.getByLabel('邮箱', { exact: true });
        const showcase = page.locator('.auth-showcase');
        const form = page.locator('.auth-form-column');
        await email.fill('preview@example.test');
        await page.evaluate(() => document.fonts.ready);
        const before = await form.boundingBox();
        const explore = showcase.getByRole('link', { name: '向下探索产品预览' });
        const demo = showcase.getByRole('heading', { name: '一项研究如何从问题变成报告' });
        await expect(demo).not.toBeInViewport();
        expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(900);
        await page.mouse.move(width * 0.25, 440);
        await page.mouse.wheel(0, 520);
        await expect
            .poll(() => showcase.evaluate((element) => element.scrollTop))
            .toBeGreaterThan(0);
        expect(await form.boundingBox()).toEqual(before);
        expect(await page.evaluate(() => scrollY)).toBe(0);
        await explore.press('Enter');
        await expect(demo).toBeFocused();
        await expect(demo).toBeInViewport();
        const chat = showcase.getByRole('article', { name: '在项目对话中起草研究' });
        await expect(chat.getByText('待确认', { exact: true })).toBeInViewport();
        const workflow = showcase.getByRole('article', { name: '可编辑的研究工作流' });
        await workflow.scrollIntoViewIfNeeded();
        await expect(workflow.getByRole('heading', { name: '节点检查器' })).toBeInViewport();
        if (reduced)
            await expect(workflow.locator('.demo-window')).toHaveCSS('animation-name', 'none');
        expect(
            await showcase.evaluate((element) => element.scrollWidth <= element.clientWidth),
        ).toBe(true);
        expect(await form.boundingBox()).toEqual(before);
        expect(await page.evaluate(() => scrollY)).toBe(0);
        await showcase.getByRole('link', { name: '返回报告预览' }).click();
        await expect(explore).toBeFocused();
        await expect.poll(() => showcase.evaluate((element) => element.scrollTop)).toBe(0);
        await expect(email).toHaveValue('preview@example.test');
    });
}
