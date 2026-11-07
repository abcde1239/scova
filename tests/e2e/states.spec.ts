import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
    await page.route('**/api/v1/me', (route) =>
        route.fulfill({
            json: {
                user: {
                    id: '00000000-0000-4000-8000-000000000001',
                    email: 'states@example.test',
                    createdAt: '2026-10-31T00:00:00Z',
                    preferences: {
                        defaultTimezone: 'UTC',
                        notificationPreference: { mode: 'summary', runIssues: true },
                    },
                },
                csrfToken: 'states-fixture',
            },
        }),
    );
});

test('失败重试保持焦点，忙碌不重复派发，成功后焦点落到说明', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/__examples/states');
    await expect(page.getByText('受控本地样例，未连接服务器。')).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: '加载失败' })).toBeVisible();
    const retry = page.getByRole('button', { name: '重试', exact: true });
    await retry.focus();
    await page.keyboard.press('Enter');
    const busy = page.getByRole('button', { name: '正在重试', exact: true });
    await expect(busy).toBeFocused();
    await expect(busy).toHaveAttribute('aria-disabled', 'true');
    expect(await busy.evaluate((element) => getComputedStyle(element).cursor)).toBe('progress');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');
    await busy.dispatchEvent('click');
    await expect(page.getByRole('status').filter({ hasText: '加载成功' })).toBeFocused();
    await expect(page.getByText('派发次数：1', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
    );
});

test('鼠标与Enter/Space只激活正常操作，禁用和忙碌实际拦截事件', async ({ page }) => {
    await page.goto('/__examples/states');
    const normal = page.getByRole('button', { name: '正常操作', exact: true });
    await normal.click();
    await normal.focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');
    await expect(page.getByText('正常次数：3', { exact: true })).toBeVisible();
    expect(await normal.evaluate((element) => getComputedStyle(element).cursor)).toBe('pointer');
    for (const name of ['禁用操作', '忙碌操作', '禁用且忙碌']) {
        const button = page.getByRole('button', { name, exact: true });
        const bounds = await button.boundingBox();
        await page.mouse.click(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
        await button.focus();
        await page.keyboard.press('Enter');
        await page.keyboard.press('Space');
        await button.dispatchEvent('click');
        await expect(page.getByText('正常次数：3', { exact: true })).toBeVisible();
        const expected = name === '忙碌操作' ? 'progress' : 'not-allowed';
        expect(await button.evaluate((element) => getComputedStyle(element).cursor)).toBe(expected);
        if (name !== '忙碌操作') await expect(button).toBeDisabled();
        else await expect(button).toHaveAttribute('aria-disabled', 'true');
        for (const child of await button.locator('span, svg').all()) {
            expect(await child.evaluate((element) => getComputedStyle(element).cursor)).toBe(
                expected,
            );
        }
    }
});

test('重试过程中移至其他输入后，完成提示不夺走焦点', async ({ page }) => {
    await page.goto('/__examples/states');
    await page.getByRole('button', { name: '重试', exact: true }).click();
    const input = page.getByLabel('文字', { exact: true });
    await input.focus();
    await expect(page.getByRole('status').filter({ hasText: '加载成功' })).toBeVisible();
    await expect(input).toBeFocused();
});

test('窄屏文字放大保持操作可达，输入和普通内容使用合适光标', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 320, height: 844 });
    await page.goto('/__examples/states');
    await page.evaluate(() => {
        document.documentElement.style.fontSize = '200%';
    });
    for (const name of ['文字', '只读文字', '日期', '时间']) {
        const input = page.getByLabel(name, { exact: true });
        expect(await input.evaluate((element) => getComputedStyle(element).cursor)).toBe(
            ['日期', '时间'].includes(name) ? 'auto' : 'text',
        );
    }
    await expect(page.getByLabel('只读文字', { exact: true })).toHaveAttribute('readonly', '');
    expect(
        await page
            .getByText('普通内容可阅读。')
            .evaluate((element) => getComputedStyle(element).cursor),
    ).toBe('default');
    await expect(page.getByRole('button', { name: '重试', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
    );
    await page.screenshot({ path: testInfo.outputPath('states-320-200.png'), fullPage: true });
});
