import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

export async function openAccountMenu(page: Page) {
    const trigger = page.getByRole('button', { name: '账号菜单', exact: true });
    if (await trigger.isVisible()) {
        if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click();
        await expect(page.getByRole('navigation', { name: '账号操作', exact: true })).toBeVisible();
    } else {
        const menu = page.getByRole('button', { name: '菜单', exact: true });
        if ((await menu.getAttribute('aria-expanded')) !== 'true') await menu.click();
        await expect(page.getByRole('dialog', { name: '工作台侧边栏' })).toBeVisible();
    }
}

export async function expectAccountReady(page: Page) {
    await expect(page.locator('.account-menu')).toBeAttached();
}

export async function logoutFromAccount(page: Page) {
    await openAccountMenu(page);
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
}
