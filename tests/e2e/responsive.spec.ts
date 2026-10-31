import { expect, test } from '@playwright/test';

for (const width of [1440, 1024, 768, 390, 360, 320]) {
    for (const scale of [100, 200]) {
        test(`${width} 视口、${scale}% 文字下六个入口可达且无整页横溢出`, async ({ page }) => {
            const errors: string[] = [];
            page.on('pageerror', (error) => errors.push(error.message));
            await page.setViewportSize({ width, height: 900 });
            await page.goto('/tasks');
            await page.evaluate((value) => {
                document.documentElement.style.fontSize = `${value}%`;
            }, scale);
            for (const name of ['收件箱', '资料库', '通知', '账号', '外观', '任务']) {
                const trigger = page.getByRole('button', { name: '菜单', exact: true });
                let link;
                if (await trigger.isVisible()) {
                    await trigger.focus();
                    await page.keyboard.press('Enter');
                    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
                    link = page
                        .getByRole('navigation', { name: '工作台菜单', exact: true })
                        .getByRole('link', { name, exact: true });
                } else {
                    link = page
                        .getByRole('navigation', {
                            name: ['任务', '收件箱', '资料库'].includes(name)
                                ? '主导航'
                                : '全局工具',
                            exact: true,
                        })
                        .getByRole('link', { name, exact: true });
                }
                const bounds = await link.boundingBox();
                expect(bounds?.height).toBeGreaterThanOrEqual(44);
                expect(bounds?.width).toBeGreaterThanOrEqual(44);
                await link.focus();
                await page.keyboard.press('Enter');
                await expect(page.getByRole('main')).toBeFocused();
                await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
                if (await trigger.isVisible()) {
                    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
                    await expect(page.getByRole('navigation', { name: '工作台菜单' })).toHaveCount(
                        0,
                    );
                }
                expect(
                    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
                ).toBe(true);
            }
            expect(errors).toEqual([]);
        });
    }
}

test('Esc、同页选择和宽度切换保持可见焦点并清理菜单状态', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/tasks');
    const trigger = page.getByRole('button', { name: '菜单', exact: true });
    const tasks = page
        .getByRole('navigation', { name: '工作台菜单' })
        .getByRole('link', { name: '任务', exact: true });
    await trigger.click();
    await tasks.focus();
    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await page.keyboard.press('Enter');
    await tasks.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('main')).toBeFocused();
    await trigger.click();
    await tasks.focus();
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(trigger).toBeHidden();
    await expect(page.getByRole('main')).toBeFocused();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByRole('navigation', { name: '工作台菜单' })).toHaveCount(0);
});
