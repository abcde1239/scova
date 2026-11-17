import { chooseOption, chooseTimezone } from './support/select.ts';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { logoutFromAccount } from './support/account-menu.ts';

// Local HTTP samples exercise the real Web bundle, not database persistence or task creation.
async function sampleAccount(page: Page) {
    const account = {
        user: {
            id: '00000000-0000-4000-8000-000000000001',
            email: 'preferences-sample@example.test',
            preferences: {
                defaultTimezone: 'UTC',
                notificationPreference: {
                    mode: 'summary' as 'summary' | 'important_change' | 'off',
                    runIssues: true,
                },
            },
            createdAt: '2026-10-31T00:00:00Z',
        },
        csrfToken: 'preferences-browser-test-only',
    };
    const state = { patches: 0, reads: 0, status: 200, offline: false, failRead: false };
    await page.route('**/api/v1/me/avatar', (route) =>
        route.fulfill({ json: { available: false, version: null } }),
    );
    await page.route('**/api/v1/me', (route) => {
        state.reads++;
        return route.fulfill(
            state.failRead && state.reads > 1 ? { status: 503, json: failure } : { json: account },
        );
    });
    await page.route('**/api/v1/me/preferences', async (route) => {
        state.patches++;
        expect(route.request().headers()['x-csrf-token']).toBe(account.csrfToken);
        if (state.offline) return route.abort('internetdisconnected');
        if (state.status !== 200)
            return route.fulfill({
                status: state.status,
                json: {
                    ...failure,
                    ...(state.status === 422
                        ? { fieldErrors: [{ path: '/defaultTimezone', message: 'sample' }] }
                        : {}),
                },
            });
        const patch = route.request().postDataJSON() as Partial<typeof account.user.preferences>;
        account.user.preferences = { ...account.user.preferences, ...patch };
        await route.fulfill({ json: account });
    });
    return state;
}
const failure = { code: 'TEST_FAILURE', message: 'sample', requestId: 'sample' };
const save = (page: Page) => page.getByRole('button', { name: '保存默认偏好', exact: true });

for (const width of [1440, 320]) {
    test(`Naive操作通知：保存成功、失败保留表单、关闭与账号清理 ${width}`, async ({
        page,
    }, info) => {
        const state = await sampleAccount(page);
        await page.setViewportSize({ width, height: 1000 });
        await page.emulateMedia({
            colorScheme: width === 320 ? 'dark' : 'light',
            reducedMotion: 'reduce',
        });
        await page.goto('/account');
        if (width === 320)
            await page.evaluate(() => {
                document.documentElement.style.fontSize = '200%';
            });
        await chooseTimezone(page, 'Asia/Tokyo');
        await save(page).click();
        const notices = page.locator('.scova-notifications .n-notification');
        await expect(notices).toHaveCount(1);
        await expect(notices).toContainText('默认偏好已保存');
        await notices.hover();
        const bounds = await notices.boundingBox();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
            true,
        );
        await page.screenshot({
            path: info.outputPath(`notice-success-${width}.png`),
            animations: 'disabled',
        });
        await notices.locator('.n-notification__close').click();
        await expect(notices).toHaveCount(0);
        await chooseTimezone(page, 'Europe/London');
        state.offline = true;
        await save(page).click();
        await expect(notices).toContainText('默认偏好未保存');
        await expect(notices).toContainText('暂时无法连接');
        await expect(page.locator('.preferences-form').getByRole('alert')).toHaveCount(0);
        await expect(page.getByLabel('默认时区', { exact: true })).toContainText('Europe/London');
        await page.screenshot({
            path: info.outputPath(`notice-error-${width}.png`),
            animations: 'disabled',
        });
        state.offline = false;
        await page.route('**/api/v1/auth/logout', (route) => route.fulfill({ status: 204 }));
        await logoutFromAccount(page);
        await expect(page).toHaveURL(/\/login/);
        await expect(notices).toHaveCount(0);
        expect(state.patches).toBe(2);
    });
}

test('账号下拉框：浅暗主题、搜索、提醒选中和细焦点', async ({ page }, testInfo) => {
    const state = await sampleAccount(page);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/account');
    const timezone = page.getByLabel('默认时区', { exact: true });
    const notification = page.getByRole('combobox', { name: '结果提醒', exact: true });
    await expect(timezone).toContainText('UTC');
    for (const colorScheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme });
        await timezone.focus();
        const focus = await timezone.evaluate((node) => {
            const style = getComputedStyle(node);
            return { border: parseFloat(style.borderTopWidth), outline: style.outlineStyle };
        });
        expect(focus.border).toBe(1);
        expect(focus.outline).toBe('none');
        await timezone.click();
        const search = page.getByRole('combobox', { name: '搜索默认时区' });
        await search.fill('北京');
        await expect(page.getByRole('option')).toHaveCount(1);
        await expect(page.getByRole('option')).toContainText('Asia/Shanghai');
        await page.screenshot({
            path: testInfo.outputPath(`account-timezone-${colorScheme}.png`),
            animations: 'disabled',
            fullPage: true,
        });
        await search.press('Escape');
        await notification.click();
        await expect(page.getByRole('option', { selected: true })).toContainText('每次汇总');
        await page.screenshot({
            path: testInfo.outputPath(`account-notification-${colorScheme}.png`),
            animations: 'disabled',
            fullPage: true,
        });
        await page.keyboard.press('Escape');
    }
    await chooseOption(page, '结果提醒', '仅重要变化');
    await expect(notification).toContainText('仅重要变化');
    expect(state.patches).toBe(0);
});

for (const width of [1024, 1440, 1920]) {
    test(`页面主体${width}：账号、外观与新建任务的标题和内容共同居中`, async ({ page }) => {
        await sampleAccount(page);
        await page.setViewportSize({ width, height: 1000 });
        for (const [path, body] of [
            ['/account', '.settings'],
            ['/account/appearance', '.appearance-selector'],
            ['/tasks/new', '.task-config-form'],
        ] as const) {
            await page.goto(path);
            await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
            const main = await page.getByRole('main').boundingBox();
            const content = await page.locator(body!).boundingBox();
            const heading = await page.locator('.page-heading').boundingBox();
            expect(main).not.toBeNull();
            expect(content).not.toBeNull();
            expect(Math.abs(main!.x + main!.width / 2 - width / 2)).toBeLessThan(1);
            expect(Math.abs(content!.x + content!.width / 2 - width / 2)).toBeLessThan(1);
            expect(Math.abs(heading!.x - content!.x)).toBeLessThan(1);
            expect(content!.width).toBeLessThanOrEqual(704);
        }
    });
}

test('本地 HTTP 样本：保存偏好刷新保留，本机外观与阅读不提交账号偏好', async ({ page }) => {
    const state = await sampleAccount(page);
    await page.goto('/account');
    await expect(save(page)).toBeDisabled();
    await chooseTimezone(page, 'Asia/Shanghai');
    await chooseOption(page, '结果提醒', '仅重要变化');
    await page.getByLabel('提醒失败或不完整的执行').uncheck();
    await save(page).focus();
    await page.keyboard.press('Enter');
    await expect(
        page.locator('.scova-notifications .n-notification').filter({ hasText: '默认偏好已保存' }),
    ).toBeVisible();
    expect(state.patches).toBe(1);
    await page.reload();
    await expect(page.getByLabel('默认时区', { exact: true })).toContainText('Asia/Shanghai');
    await expect(page.getByLabel('结果提醒', { exact: true })).toContainText('仅重要变化');
    await expect(page.getByLabel('提醒失败或不完整的执行')).not.toBeChecked();
    await expect(page.getByText('不会改动已保存任务', { exact: false })).toBeVisible();
    await page.getByRole('link', { name: '外观与阅读设置' }).click();
    for (const group of [
        page.getByRole('group', { name: '明暗', exact: true }),
        page.getByRole('group', { name: '主题色', exact: true }),
        page.getByRole('group', { name: '正文字体', exact: true }),
        page.getByRole('group', { name: '正文字号', exact: true }),
    ]) {
        const unchecked = group.getByRole('radio').filter({ visible: true });
        await unchecked.last().check();
    }
    expect(state.patches).toBe(1);
});

test('本地 HTTP 样本：非法时区、字段错误、限流、拒绝与断网保留编辑并聚焦错误', async ({ page }) => {
    const state = await sampleAccount(page);
    await page.goto('/account');
    const timezone = page.getByLabel('默认时区', { exact: true });
    await timezone.click();
    const search = page.getByRole('combobox', { name: '搜索默认时区' });
    await search.fill('Moon/Base');
    await expect(page.getByText('没有找到匹配项，请换个关键词')).toBeVisible();
    await search.press('Escape');
    await expect(save(page)).toBeDisabled();
    expect(state.patches).toBe(0);
    await chooseTimezone(page, 'Europe/London');
    for (const [status, text] of [
        [422, '请检查标出的偏好设置'],
        [429, '保存过于频繁，请稍后重试'],
        [403, '暂时无法保存，请刷新页面后重试'],
    ] as const) {
        state.status = status;
        await save(page).click();
        if (status === 422)
            await expect(page.locator('.preferences-form').getByRole('alert')).toHaveText(text);
        else
            await expect(page.locator('.scova-notifications .n-notification').last()).toContainText(
                text,
            );
        await expect(timezone).toContainText('Europe/London');
        if (status === 422) await expect(timezone).toBeFocused();
        else
            await expect(
                page.locator('.scova-notifications .n-notification').last(),
            ).not.toBeFocused();
    }
    state.offline = true;
    await save(page).click();
    await expect(page.locator('.scova-notifications .n-notification').last()).toContainText(
        '暂时无法连接，请检查网络后重试',
    );
    await expect(timezone).toContainText('Europe/London');
    expect(state.patches).toBe(4);
    state.offline = false;
    state.status = 200;
    await save(page).press('Enter');
    await expect(
        page.locator('.scova-notifications .n-notification').filter({ hasText: '默认偏好已保存' }),
    ).toBeVisible();
    expect(state.patches).toBe(5);
});

test('本地 HTTP 样本：延迟读取不覆盖编辑、保存期间锁定、读取失败可重试', async ({ page }) => {
    const state = await sampleAccount(page);
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => {
        releaseRead = resolve;
    });
    await page.route('**/api/v1/me', async (route) => {
        if (state.reads++ === 0) return route.fallback();
        await readGate;
        await route.fallback();
    });
    await page.goto('/account');
    const timezone = page.getByLabel('默认时区', { exact: true });
    await expect(timezone).toContainText('UTC');
    await chooseTimezone(page, 'Asia/Tokyo');
    releaseRead();
    await expect(save(page)).toBeEnabled();
    await expect(timezone).toContainText('Asia/Tokyo');
    let releaseSave!: () => void;
    const saveGate = new Promise<void>((resolve) => {
        releaseSave = resolve;
    });
    await page.route('**/api/v1/me/preferences', async (route) => {
        await saveGate;
        await route.fallback();
    });
    await save(page).click();
    await expect(page.getByRole('button', { name: '正在保存' })).toBeDisabled();
    await expect(timezone).toBeDisabled();
    await page.locator('form.preferences-form').dispatchEvent('submit');
    releaseSave();
    await expect(
        page.locator('.scova-notifications .n-notification').filter({ hasText: '默认偏好已保存' }),
    ).toBeVisible();
    expect(state.patches).toBe(1);
    await page.unroute('**/api/v1/me');
    let reads = 0;
    await page.route('**/api/v1/me', (route) =>
        route.fulfill(
            ++reads === 2
                ? { status: 503, json: failure }
                : {
                      json: {
                          user: {
                              id: '00000000-0000-4000-8000-000000000001',
                              email: 'preferences-sample@example.test',
                              preferences: {
                                  defaultTimezone: 'UTC',
                                  notificationPreference: { mode: 'summary', runIssues: true },
                              },
                              createdAt: '2026-10-31T00:00:00Z',
                          },
                          csrfToken: 'preferences-browser-test-only',
                      },
                  },
        ),
    );
    await page.reload();
    await expect(page.getByRole('alert')).toContainText('默认偏好暂时无法读取');
    await expect(save(page)).toBeDisabled();
    await page.getByRole('button', { name: '重新读取' }).click();
    await expect(page.getByRole('alert')).toHaveCount(0);
});

for (const width of [320, 390, 768, 1024, 1280, 1440]) {
    test(`本地 HTTP 样本：账号偏好 ${width} 宽度及 200% 文字放大`, async ({ page }, testInfo) => {
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await sampleAccount(page);
        await page.setViewportSize({ width, height: 1000 });
        await page.goto('/account');
        await expect(page.getByLabel('默认时区', { exact: true })).toContainText('UTC');
        for (const enlarged of [false, true]) {
            if (enlarged)
                await page.evaluate(() => {
                    document.documentElement.style.fontSize = '200%';
                });
            expect(
                await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            ).toBe(true);
            await expect(page.getByLabel('结果提醒', { exact: true })).toBeVisible();
            await testInfo.attach(`preferences-${width}${enlarged ? '-text-200' : ''}`, {
                body: await page.screenshot({
                    path: testInfo.outputPath(
                        `preferences-${width}${enlarged ? '-text-200' : ''}.png`,
                    ),
                    fullPage: true,
                }),
                contentType: 'image/png',
            });
        }
        expect(errors).toEqual([]);
    });
}
