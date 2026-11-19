import { expect, test } from '@playwright/test';

test('login language switch translates validation without discarding form input', async ({
    page,
}) => {
    await page.setViewportSize({ width: 320, height: 844 });
    await page.goto('/login');
    await page.getByLabel('邮箱', { exact: true }).fill('test@example.org');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByText('请输入密码', { exact: true })).toBeVisible();
    await page.getByRole('combobox', { name: '界面语言' }).selectOption('en');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page).toHaveTitle('Sign in · Scova');
    await expect(page.getByLabel('Email', { exact: true })).toHaveValue('test@example.org');
    await expect(page.getByText('Enter your password', { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('combobox', { name: 'Interface language' })).toHaveValue('en');
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await page.getByRole('link', { name: 'Create an account' }).click();
    await expect(page.getByRole('heading', { name: 'Sign up' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        320,
    );
});

test('workbench locale updates desktop and mobile navigation but not the business page', async ({
    page,
}) => {
    await page.goto('/account/appearance');
    await page.getByRole('combobox', { name: '界面语言' }).selectOption('en');
    await expect(page).toHaveTitle('Appearance · Scova');
    await expect(
        page
            .getByRole('navigation', { name: 'Main navigation' })
            .getByRole('link', { name: 'Tasks' }),
    ).toBeVisible();
    await expect(
        page
            .getByRole('navigation', { name: 'Breadcrumbs' })
            .getByRole('link', { name: 'Account' }),
    ).toBeVisible();
    await expect(page.locator('main > [lang="zh-CN"]').filter({ hasText: '主题' })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Open account sidebar' }).click();
    await expect(
        page
            .getByRole('navigation', { name: 'Workbench menu' })
            .getByRole('link', { name: 'Agent settings' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Close sidebar' }).click();
    await page.getByRole('combobox', { name: 'Interface language' }).selectOption('zh-CN');
    await expect(page).toHaveTitle('外观 · 知巡 Scova');
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
});
