import { expect, test, type Page } from '@playwright/test';
import { logoutFromAccount } from './support/account-menu.ts';

const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNwr/gPAALIAb+GQ4DiAAAAAElFTkSuQmCC',
    'base64',
);
const first = '00000000-0000-4000-8000-000000000011';
const second = '00000000-0000-4000-8000-000000000012';
async function setup(page: Page, version: string | null = null, available = true) {
    const account = {
        user: {
            id: '00000000-0000-4000-8000-000000000001',
            email: 'avatar@example.test',
            avatarVersion: version,
            preferences: {
                defaultTimezone: 'UTC',
                notificationPreference: { mode: 'summary', runIssues: true },
            },
            createdAt: '2026-11-09T00:00:00Z',
        },
        csrfToken: 'avatar-browser-only',
    };
    const state = { writes: 0, status: 200, brokenImage: false };
    await page.route('**/api/v1/me', (route) => route.fulfill({ json: account }));
    await page.route('**/api/v1/me/avatar**', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (/\/avatar\//.test(url.pathname)) {
            return state.brokenImage
                ? route.fulfill({ status: 404 })
                : route.fulfill({ contentType: 'image/png', body: png });
        }
        if (request.method() === 'GET')
            return route.fulfill({ json: { available, version: account.user.avatarVersion } });
        state.writes++;
        expect(request.headers()['x-csrf-token']).toBe(account.csrfToken);
        expect(url.searchParams.get('expectedVersion')).toBe(account.user.avatarVersion ?? 'none');
        if (state.status !== 200)
            return route.fulfill({
                status: state.status,
                json: { code: 'AVATAR_FAILURE', message: 'sample', requestId: 'avatar-browser' },
            });
        if (request.method() === 'PUT') {
            expect(request.headers()['content-type']).toBe('image/png');
            expect(request.postDataBuffer()).toEqual(png);
            account.user.avatarVersion = account.user.avatarVersion === first ? second : first;
        } else if (request.method() === 'DELETE') account.user.avatarVersion = null;
        else throw new Error(`unexpected ${request.method()}`);
        return route.fulfill({ json: account });
    });
    return { account, state };
}
const select = (page: Page, buffer = png, mimeType = 'image/png') =>
    page.getByLabel('选择头像文件').setInputFiles({ name: 'avatar.png', mimeType, buffer });

for (const width of [1440, 320]) {
    test(`头像选择预览、上传、导航同步与移除 ${width}`, async ({ page }, info) => {
        const { state } = await setup(page);
        await page.setViewportSize({ width, height: 1000 });
        await page.emulateMedia({ colorScheme: width === 320 ? 'dark' : 'light' });
        await page.goto('/account');
        if (width === 320)
            await page.evaluate(() => {
                document.documentElement.style.fontSize = '200%';
            });
        await expect(page.getByRole('button', { name: '选择图片', exact: true })).toBeEnabled();
        await select(page);
        await expect(page.locator('.profile-avatar img')).toHaveAttribute('src', /^blob:/);
        await page.getByRole('button', { name: '取消选择' }).click();
        await expect(page.locator('.profile-avatar img')).toHaveAttribute(
            'src',
            /default-avatar\.webp$/,
        );
        expect(state.writes).toBe(0);
        await select(page);
        await page.getByRole('button', { name: '上传头像', exact: true }).click();
        await expect(page.getByRole('status').filter({ hasText: '头像已更新' })).toBeVisible();
        await expect(page.locator('.profile-avatar img')).toHaveAttribute('src', new RegExp(first));
        const navigation =
            width === 320
                ? page.locator('.menu-trigger .account-avatar img')
                : page.locator('.account-trigger .account-avatar img');
        await expect(navigation).toHaveAttribute('src', new RegExp(first));
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
            true,
        );
        await page.screenshot({ path: info.outputPath(`avatar-${width}.png`), fullPage: true });
        await page.reload();
        await expect(page.locator('.profile-avatar img')).toHaveAttribute('src', new RegExp(first));
        await page.getByRole('button', { name: '移除头像', exact: true }).click();
        await expect(page.getByRole('status').filter({ hasText: '头像已移除' })).toBeVisible();
        await expect(page.locator('.profile-avatar img')).toHaveAttribute(
            'src',
            /default-avatar\.webp$/,
        );
        expect(state.writes).toBe(2);
    });
}
test('本地类型/大小校验不发上传请求', async ({ page }) => {
    const { state } = await setup(page);
    await page.goto('/account');
    await expect(page.getByRole('button', { name: '选择图片', exact: true })).toBeEnabled();
    await select(page, Buffer.from('<svg/>'), 'image/svg+xml');
    await expect(page.getByRole('alert')).toContainText('请选择JPEG');
    await select(page, Buffer.alloc(5 * 1024 * 1024 + 1));
    await expect(page.getByRole('alert')).toContainText('5 MiB');
    expect(state.writes).toBe(0);
});
test('上传失败保留旧头像与已选预览，可取消后再次操作', async ({ page }) => {
    const { state } = await setup(page, first);
    state.status = 503;
    await page.goto('/account');
    await expect(page.getByRole('button', { name: '选择图片', exact: true })).toBeEnabled();
    await select(page);
    await page.getByRole('button', { name: '上传头像', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('头像存储暂时不可用');
    await expect(page.locator('.account-trigger .account-avatar img')).toHaveAttribute(
        'src',
        new RegExp(first),
    );
    await page.getByRole('button', { name: '取消选择' }).click();
    await expect(page.locator('.profile-avatar img')).toHaveAttribute('src', new RegExp(first));
});
test('冲突不自动重发，刷新后读取服务端当前版本', async ({ page }) => {
    const { account, state } = await setup(page, first);
    state.status = 409;
    await page.goto('/account');
    await expect(page.getByRole('button', { name: '选择图片', exact: true })).toBeEnabled();
    await select(page);
    await page.getByRole('button', { name: '上传头像', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('请先刷新头像');
    expect(state.writes).toBe(1);
    account.user.avatarVersion = second;
    await page.getByRole('button', { name: '刷新头像', exact: true }).click();
    await expect(page.locator('.profile-avatar img')).toHaveAttribute('src', new RegExp(second));
});
test('未配置存储时禁用上传，损坏图片回退默认头像', async ({ page }) => {
    const { state } = await setup(page, first, false);
    state.brokenImage = true;
    await page.goto('/account');
    await expect(page.getByText('当前部署尚未启用头像上传。')).toBeVisible();
    await expect(page.getByRole('button', { name: '选择图片', exact: true })).toBeDisabled();
    await expect(page.locator('.profile-avatar img')).toHaveAttribute(
        'src',
        /default-avatar\.webp$/,
    );
});

test('默认图片也无法读取时回退首字母，替换头像后重新尝试加载', async ({ page }) => {
    const { state } = await setup(page, first);
    state.brokenImage = true;
    await page.route('**/default-avatar.webp', (route) => route.fulfill({ status: 404 }));
    await page.goto('/account');
    await expect(page.locator('.profile-avatar')).toHaveText('A');
    await expect(page.locator('.profile-avatar img')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '选择图片', exact: true })).toBeEnabled();
    await select(page);
    await expect(page.locator('.profile-avatar img')).toHaveAttribute('src', /^blob:/);
    await expect(page.locator('.profile-avatar img')).toHaveJSProperty('naturalWidth', 1);
});

test('退出账号中止上传，迟到响应不能恢复旧会话', async ({ page }) => {
    const { account } = await setup(page);
    let release!: () => void;
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => {
        release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
        started = resolve;
    });
    await page.route('**/api/v1/me/avatar?**', async (route) => {
        started();
        await waiting;
        await route
            .fulfill({ json: { ...account, user: { ...account.user, avatarVersion: first } } })
            .catch(() => {});
    });
    await page.route('**/api/v1/auth/logout', (route) => route.fulfill({ status: 204 }));
    await page.goto('/account');
    await expect(page.getByRole('button', { name: '选择图片', exact: true })).toBeEnabled();
    await select(page);
    await page.getByRole('button', { name: '上传头像', exact: true }).click();
    await entered;
    const aborted = page.waitForEvent('requestfailed', {
        predicate: (request) => request.method() === 'PUT' && request.url().includes('/me/avatar'),
    });
    await logoutFromAccount(page);
    await aborted;
    release();
    await expect(page).toHaveURL(/\/login/);
    await expect(page.locator('.account-trigger')).toHaveCount(0);
    await expect(page.getByText('头像已更新', { exact: true })).toHaveCount(0);
});
