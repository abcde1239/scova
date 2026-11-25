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
    for (const width of [1024, 1440, 1920]) {
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
            expect(Math.abs(panel!.y + panel!.height / 2 - 500)).toBeLessThan(2);
            expect(column!.width).toBeLessThanOrEqual(576);
            expect(panel!.y).toBeGreaterThanOrEqual(0);
            expect(panel!.y + panel!.height).toBeLessThanOrEqual(1000);
            expect(form!.width).toBeLessThanOrEqual(448);
            expect(form!.width).toBeGreaterThan(300);
            if (width >= 1440) expect(form!.width).toBe(448);
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
    await expect(button).toHaveText('');
    const cardBounds = await tilt.boundingBox();
    const hitBounds = await button.boundingBox();
    expect(Math.abs(hitBounds!.width - cardBounds!.width)).toBeLessThan(2);
    expect(Math.abs(hitBounds!.height - cardBounds!.height)).toBeLessThan(2);
    await button.click();
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
    await button.press('Enter');
    await expect(back).toHaveAttribute('aria-expanded', 'true');
});

test('登录预览对话响应悬停，工作流节点支持键盘切换与减少动态效果', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto('/login');
    const sources = page.locator('.preview-card--watch');
    await expect(sources).toHaveCSS('rotate', '2deg');
    await sources.hover();
    await expect(sources).toHaveCSS('rotate', '3deg');

    await page.getByRole('link', { name: '向下探索产品预览' }).press('Enter');
    const conversation = page.locator('.demo-conversation');
    await conversation.hover();
    await expect(conversation.locator('.demo-prompt')).not.toHaveCSS('transform', 'none');
    await expect(conversation.locator('.demo-draft')).not.toHaveCSS('transform', 'none');

    const firstNode = page.getByRole('button', { name: /研究 1/ });
    const secondNode = page.getByRole('button', { name: /研究 2/ });
    const inspector = page.getByRole('region', { name: '节点检查器' });
    const details = inspector.locator('dl[aria-hidden="false"]');
    await expect(firstNode).toHaveAttribute('aria-pressed', 'true');
    const inspectorHeight = await inspector.evaluate((element) => element.clientHeight);
    await secondNode.click();
    await expect(secondNode).toHaveAttribute('aria-pressed', 'true');
    await expect(firstNode).toHaveAttribute('aria-pressed', 'false');
    await expect(details).toContainText('核对变更的影响范围');
    await expect(details).toHaveCSS('animation-name', /demo-inspect/);
    expect(await inspector.evaluate((element) => element.clientHeight)).toBe(inspectorHeight);

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await secondNode.press('Shift+Tab');
    await expect(firstNode).toBeFocused();
    await firstNode.press('Space');
    await expect(firstNode).toBeFocused();
    await expect(firstNode).toHaveAttribute('aria-pressed', 'true');
    await expect(details).toContainText('对比许可证版本');
    await expect(details).toHaveCSS('animation-name', 'none');
    await expect(conversation.locator('.demo-prompt')).toHaveCSS('transform', 'none');
    await expect(sources).toHaveCSS('rotate', '2deg');
});

test('认证工具保持紧凑，主题、外观及语言可独立操作', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/login');
    await expect(page.getByLabel('邮箱', { exact: true })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({
        path: testInfo.outputPath('login-desktop.png'),
        animations: 'disabled',
    });
    const tools = page.locator('.auth-tools');
    for (const control of await tools.getByRole('combobox').all()) {
        const bounds = await control.boundingBox();
        expect(bounds!.width).toBeGreaterThanOrEqual(32);
        expect(bounds!.width).toBeLessThanOrEqual(44);
        expect(bounds!.height).toBeLessThanOrEqual(44);
    }
    await expect(page.getByLabel('主题', { exact: true })).toHaveAttribute('title', /主题: /);
    await chooseOption(page, '主题', '松绿');
    await expect(page.getByLabel('主题', { exact: true })).toHaveAttribute('title', '主题: 松绿');
    await chooseOption(page, '外观', '深色');
    await expect(page.locator('.scova-theme')).toHaveClass(/scova-theme--dark/);
    await page.getByLabel('界面语言', { exact: true }).click();
    const languages = page.getByRole('listbox', { name: '界面语言', exact: true });
    await expect(languages.getByRole('option', { name: '简体中文' })).toHaveAttribute(
        'aria-selected',
        'true',
    );
    await page.screenshot({ path: testInfo.outputPath('language-menu.png') });
    await page.getByRole('combobox', { name: '界面语言', exact: true }).press('Escape');
    await expect(page.getByLabel('界面语言', { exact: true })).toBeFocused();
    await chooseOption(page, '界面语言', 'English');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sign in');
    await chooseOption(page, 'Interface language', '简体中文');
    await chooseOption(page, '主题', '蓝色');
    await chooseOption(page, '外观', '浅色');
    await page.reload();
    await expect(page.getByLabel('邮箱', { exact: true })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.mouse.move(1000, 800);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
        path: testInfo.outputPath('login-mobile.png'),
        animations: 'disabled',
    });
    const overflow = await page.locator('body *').evaluateAll((elements) =>
        elements
            .filter((element) => element.getBoundingClientRect().right > innerWidth)
            .map((element) => ({
                tag: element.tagName,
                class: element.className,
                right: element.getBoundingClientRect().right,
                width: getComputedStyle(element).width,
            })),
    );
    expect(overflow).toEqual([]);
});

for (const width of [1440, 1024]) {
    test(`登录页 ${width}：仅左栏滚动，右栏位置和表单输入保持`, async ({ page }, testInfo) => {
        await page.setViewportSize({ width, height: 900 });
        const reduced = width === 1024;
        await page.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference' });
        await page.goto('/login');
        const email = page.getByLabel('邮箱', { exact: true });
        const showcase = page.locator('.auth-showcase');
        await expect(showcase).toHaveCSS('scrollbar-width', 'none');
        await expect(page.locator('.product-demo')).toHaveCSS(
            'background-color',
            'rgba(0, 0, 0, 0)',
        );
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
        if (reduced) await expect(page.locator('.auth-pitch')).toHaveCSS('transform', 'none');
        expect(await form.boundingBox()).toEqual(before);
        expect(await page.evaluate(() => scrollY)).toBe(0);
        await explore.press('Enter');
        await expect(demo).toBeFocused();
        await expect(demo).toBeInViewport();
        await page.screenshot({ path: testInfo.outputPath('login-product-demo.png') });
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

test('登录页左栏滚动时网格、来源标签、进度轨与进度条随之移动，滚到底示例完整显示', async ({
    page,
}) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto('/login');
    await expect(page.getByLabel('邮箱', { exact: true })).toBeVisible();
    const showcase = page.locator('.auth-showcase');
    const ambient = showcase.locator('.auth-ambient');
    await expect(ambient).toHaveAttribute('aria-hidden', 'true');
    await expect(ambient).toHaveCSS('pointer-events', 'none');
    const sample = () =>
        page.evaluate(() => {
            const pick = (selector: string) => document.querySelector<HTMLElement>(selector)!;
            return {
                grid: getComputedStyle(pick('.auth-grid')).transform,
                chip: getComputedStyle(pick('.auth-chip')).transform,
                rail: getComputedStyle(pick('.auth-rail i')).transform,
                progress: pick('.preview-progress i').getBoundingClientRect().width,
                progressLayoutWidth: pick('.preview-progress i').offsetWidth,
            };
        });
    const before = await sample();
    await showcase.evaluate((element) => element.scrollTo(0, element.scrollHeight));
    await expect.poll(async () => (await sample()).grid).not.toBe(before.grid);
    const after = await sample();
    expect(after.chip).not.toBe(before.chip);
    expect(after.rail).not.toBe(before.rail);
    expect(after.progress).toBeGreaterThan(before.progress);
    expect(after.progressLayoutWidth).toBe(before.progressLayoutWidth);
    await expect
        .poll(() =>
            page.evaluate(() =>
                [
                    ...document.querySelectorAll<HTMLElement>(
                        '.demo-copy, .demo-node, .demo-boundary, .demo-inspector dd, .demo-composer',
                    ),
                ].every((element) => getComputedStyle(element).opacity === '1'),
            ),
        )
        .toBe(true);
    expect(await showcase.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
    );
    expect(await page.evaluate(() => scrollY)).toBe(0);
});

test('减少动态效果时左栏氛围层静态保留，进度轨隐藏且不随滚动移动', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/login');
    await expect(page.getByLabel('邮箱', { exact: true })).toBeVisible();
    const showcase = page.locator('.auth-showcase');
    await expect(showcase.locator('.auth-glow').first()).toBeVisible();
    await expect(showcase.locator('.auth-chip').first()).toBeVisible();
    await expect(showcase.locator('.auth-chip').first()).toHaveCSS('animation-name', 'none');
    await expect(showcase.locator('.auth-rail')).toBeHidden();
    const chip = await showcase.locator('.auth-chip').first().boundingBox();
    await showcase.evaluate((element) => element.scrollTo(0, 600));
    await expect.poll(() => showcase.evaluate((element) => element.scrollTop)).toBe(600);
    expect(await showcase.locator('.auth-chip').first().boundingBox()).toEqual(chip);
    await expect(page.locator('.demo-window').first()).toHaveCSS('animation-name', 'none');
});

test('注册页与窄屏不渲染左栏氛围层', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/register');
    await expect(page.getByLabel('邮箱', { exact: true })).toBeVisible();
    await expect(page.locator('.auth-ambient')).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/login');
    await expect(page.getByLabel('邮箱', { exact: true })).toBeVisible();
    await expect(page.locator('.auth-ambient')).toBeHidden();
});
