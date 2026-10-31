import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

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

test('本地 HTTP 样本：保存偏好刷新保留，本机外观与阅读不提交账号偏好', async ({ page }) => {
    const state = await sampleAccount(page);
    await page.goto('/account');
    await expect(save(page)).toBeDisabled();
    await page.getByLabel('默认时区', { exact: true }).fill('Asia/Shanghai');
    await page.getByLabel('结果提醒', { exact: true }).selectOption('important_change');
    await page.getByLabel('提醒失败或不完整的执行').uncheck();
    await save(page).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('status').filter({ hasText: '默认偏好已保存' })).toBeVisible();
    expect(state.patches).toBe(1);
    await page.reload();
    await expect(page.getByLabel('默认时区', { exact: true })).toHaveValue('Asia/Shanghai');
    await expect(page.getByLabel('结果提醒', { exact: true })).toHaveValue('important_change');
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
    await timezone.fill('Moon/Base');
    await save(page).click();
    await expect(timezone).toBeFocused();
    await expect(timezone).toHaveAttribute('aria-invalid', 'true');
    expect(state.patches).toBe(0);
    await timezone.fill('Europe/London');
    for (const [status, text] of [
        [422, '请检查标出的偏好设置'],
        [429, '保存过于频繁，请稍后重试'],
        [403, '暂时无法保存，请刷新页面后重试'],
    ] as const) {
        state.status = status;
        await save(page).click();
        await expect(page.getByRole('alert')).toHaveText(text);
        await expect(timezone).toHaveValue('Europe/London');
        if (status === 422) await expect(timezone).toBeFocused();
        else await expect(page.getByRole('alert')).toBeFocused();
    }
    state.offline = true;
    await save(page).click();
    await expect(page.getByRole('alert')).toHaveText('暂时无法连接，请检查网络后重试');
    await expect(timezone).toHaveValue('Europe/London');
    expect(state.patches).toBe(4);
    state.offline = false;
    state.status = 200;
    await save(page).press('Enter');
    await expect(page.getByRole('status').filter({ hasText: '默认偏好已保存' })).toBeVisible();
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
    await expect(timezone).toHaveValue('UTC');
    await timezone.fill('Asia/Tokyo');
    releaseRead();
    await expect(save(page)).toBeEnabled();
    await expect(timezone).toHaveValue('Asia/Tokyo');
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
    await expect(timezone).toHaveAttribute('readonly', '');
    await page.locator('form.preferences-form').dispatchEvent('submit');
    releaseSave();
    await expect(page.getByRole('status').filter({ hasText: '默认偏好已保存' })).toBeVisible();
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
        await expect(page.getByLabel('默认时区', { exact: true })).toHaveValue('UTC');
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
