import { logoutFromAccount, expectAccountReady } from './support/account-menu.ts';
import { expect, test } from '@playwright/test';

const account = {
    user: {
        id: '00000000-0000-4000-8000-000000000001',
        email: 'session-sample@example.test',
        preferences: {
            defaultTimezone: 'UTC',
            notificationPreference: { mode: 'summary', runIssues: true },
        },
        createdAt: '2026-10-31T00:00:00Z',
    },
    csrfToken: 'session-test-only',
};
const failure = { code: 'TEST_FAILURE', message: 'sample', requestId: 'sample' };

test('本地会话样本：直达刷新等待恢复，不闪受保护内容', async ({ page }) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    await page.route('**/api/v1/me', async (route) => {
        await gate;
        await route.fulfill({ json: account });
    });
    await page.goto('/library', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('status')).toContainText('正在恢复账号会话');
    await expect(page.locator('.library-view')).toHaveCount(0);
    await expect(page.locator('.workbench')).toHaveCount(0);
    release();
    await expect(page.getByRole('heading', { name: '资料库', exact: true })).toBeVisible();
    await expectAccountReady(page);
    await page.reload();
    await expect(page.getByRole('heading', { name: '资料库', exact: true })).toBeVisible();
    await expect(page.locator('.library-view')).toBeVisible();
});

test('本地会话样本：401登录后回站内目标，拒绝外站目标', async ({ page }) => {
    await page.route('**/api/v1/me', (route) => route.fulfill({ status: 401, json: failure }));
    await page.route('**/api/v1/auth/login', (route) => route.fulfill({ json: account }));
    await page.goto('/library?filter=all#section');
    await expect(page).toHaveURL(/\/login\?redirect=/);
    await page.getByLabel('邮箱', { exact: true }).fill(account.user.email);
    await page.getByLabel('密码', { exact: true }).fill('local-only-password');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page).toHaveURL(/\/library\?filter=all#section$/);
    await page.goto('/login?redirect=https%3A%2F%2Fevil.example');
    await page.getByLabel('邮箱', { exact: true }).fill(account.user.email);
    await page.getByLabel('密码', { exact: true }).fill('local-only-password');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page).toHaveURL(/\/tasks$/);
});

test('本地会话样本：503重试、文字放大与焦点', async ({ page }) => {
    let attempts = 0;
    await page.route('**/api/v1/me', (route) =>
        route.fulfill(++attempts === 1 ? { status: 503, json: failure } : { json: account }),
    );
    await page.setViewportSize({ width: 320, height: 844 });
    await page.goto('/library');
    await expect(page).toHaveURL(/\/service-unavailable\?redirect=/);
    await expect(page.getByRole('heading', { name: '暂时无法连接服务' })).toBeVisible();
    await expect(page.getByRole('status')).toContainText('账号服务暂不可达');
    await expect(page.locator('.library-view')).toHaveCount(0);
    await page.evaluate(() => {
        document.documentElement.style.fontSize = '200%';
    });
    const retry = page.getByRole('button', { name: '重试', exact: true });
    await retry.focus();
    await retry.press('Enter');
    await expect(page.locator('.library-view')).toBeVisible();
    await expect(page.locator('#main-content')).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
    );
    expect(attempts).toBe(2);
});

test('本地会话样本：退出失败可重试，成功后退不可恢复旧页面', async ({ page }) => {
    let loggedOut = false;
    let attempts = 0;
    await page.route('**/api/v1/me', (route) =>
        route.fulfill(loggedOut ? { status: 401, json: failure } : { json: account }),
    );
    await page.route('**/api/v1/auth/logout', (route) => {
        if (++attempts === 1) return route.fulfill({ status: 503, json: failure });
        loggedOut = true;
        return route.fulfill({ status: 204 });
    });
    await page.goto('/library');
    await page.getByRole('link', { name: '任务', exact: true }).click();
    await logoutFromAccount(page);
    await expect(page.getByRole('alert')).toHaveText('退出未成功，请检查连接后重试');
    await expect(page).toHaveURL(/\/tasks$/);
    await logoutFromAccount(page);
    await expect(page).toHaveURL(/\/login\?redirect=/);
    await expect(page.getByRole('button', { name: '退出登录' })).toHaveCount(0);
    await page.goBack();
    await expect(page).toHaveURL(/\/login\?redirect=/);
    await expect(page.locator('.route-status')).toHaveCount(0);
});

test('本地会话样本：断网后恢复为401，先显示独立加载再进入登录', async ({ page }) => {
    let attempts = 0;
    await page.route('**/api/v1/me', (route) =>
        ++attempts === 1
            ? route.abort('connectionrefused')
            : route.fulfill({ status: 401, json: failure }),
    );
    await page.goto('/account?tab=profile#details');
    await expect(page).toHaveURL(/\/service-unavailable\?redirect=/);
    await expect(page.locator('.workbench')).toHaveCount(0);
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await expect(page).toHaveURL(/\/login\?redirect=/);
    expect(new URL(page.url()).searchParams.get('redirect')).toBe('/account?tab=profile#details');
    await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible();
    await expect(page.locator('.workbench')).toHaveCount(0);
});

test('本地会话样本：登录入口服务不可达，重试失败不循环且保留目标', async ({ page }) => {
    let attempts = 0;
    await page.route('**/api/v1/me', (route) =>
        route.fulfill(
            ++attempts < 3 ? { status: 503, json: failure } : { status: 401, json: failure },
        ),
    );
    await page.goto('/login?redirect=/library');
    await expect(page).toHaveURL(/\/service-unavailable\?redirect=/);
    await expect(page.locator('.auth-layout')).toHaveCount(0);
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await expect(page.getByRole('button', { name: '重试', exact: true })).toBeEnabled();
    await expect(page).toHaveURL(/\/service-unavailable\?redirect=/);
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await expect(page).toHaveURL(/\/login\?redirect=\/library$/);
    expect(attempts).toBe(3);
});

test('本地HTTP样本：构建环境地址直接请求独立API端口', async ({ page }) => {
    const request = page.waitForRequest('http://127.0.0.1:4190/api/v1/me');
    const response = page.waitForResponse('http://127.0.0.1:4190/api/v1/me');
    await page.goto('/account');
    expect((await (await request).allHeaders()).origin).toBe('http://127.0.0.1:4189');
    expect((await response).headers()['access-control-allow-origin']).toBe('http://127.0.0.1:4189');
    await expectAccountReady(page);
    const result = await page.evaluate(async () => {
        const base = 'http://127.0.0.1:4190/api/v1/__sample';
        const write = await fetch(`${base}/session`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'content-type': 'application/json', 'x-csrf-token': 'sample' },
            body: '{}',
        });
        const stream = await fetch(`${base}/events`, {
            credentials: 'include',
            headers: { accept: 'text/event-stream', 'last-event-id': 'sample' },
        });
        return {
            writeStatus: write.status,
            streamStatus: stream.status,
            text: await stream.text(),
            etag: stream.headers.get('etag'),
            cookie: document.cookie,
        };
    });
    expect(result).toMatchObject({
        writeStatus: 204,
        streamStatus: 200,
        text: 'data: cookie-accepted\n\n',
        etag: '"sample"',
    });
    expect(result.cookie).not.toContain('scova_connection_sample');
});

test('本地会话样本：已登录后断网，在切换业务页前进入错误页', async ({ page }) => {
    let offline = false;
    await page.route('**/api/v1/me', (route) =>
        offline ? route.abort('connectionrefused') : route.fulfill({ json: account }),
    );
    await page.goto('/library');
    await expect(page.locator('.library-view')).toBeVisible();
    offline = true;
    await page.getByRole('link', { name: '任务', exact: true }).click();
    await expect(page).toHaveURL(/\/service-unavailable\?redirect=/);
    expect(new URL(page.url()).searchParams.get('redirect')).toBe('/tasks');
    await expect(page.locator('.task-center')).toHaveCount(0);
    await expect(page.locator('.workbench')).toHaveCount(0);
    offline = false;
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await expect(page).toHaveURL(/\/tasks$/);
});

for (const width of [1440, 320]) {
    test(`community 加载动画、浅暗模式及减少动态偏好 ${width}`, async ({ page }, info) => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        await page.route('**/api/v1/me', async (route) => {
            await gate;
            await route.fulfill({ json: account });
        });
        await page.setViewportSize({ width, height: 1000 });
        await page.goto('/library', { waitUntil: 'domcontentloaded' });
        const animation = page.locator('img.loading-animation');
        await expect(animation).toBeVisible();
        await expect
            .poll(() => animation.evaluate((el) => (el as HTMLImageElement).naturalWidth))
            .toBeGreaterThan(0);
        await expect(page.getByRole('status')).toHaveText('正在恢复账号会话');
        await expect(page.locator('.workbench')).toHaveCount(0);
        for (const colorScheme of ['light', 'dark'] as const) {
            await page.emulateMedia({ colorScheme });
            if (width === 320)
                await page.evaluate(() => {
                    document.documentElement.style.fontSize = '200%';
                });
            await page.screenshot({
                path: info.outputPath(`loading-${colorScheme}.png`),
                fullPage: true,
            });
            expect(
                await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            ).toBe(true);
        }
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await expect(animation).not.toBeVisible();
        await expect(page.getByRole('status')).toHaveText('正在恢复账号会话');
        release();
        await expect(page.getByRole('heading', { name: '资料库', exact: true })).toBeVisible();
        await expect(animation).toHaveCount(0);
    });
}
