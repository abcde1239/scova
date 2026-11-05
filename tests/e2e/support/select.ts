import type { Page } from '@playwright/test';

export async function chooseOption(page: Page, label: string, option: string) {
    await page.getByLabel(label, { exact: true }).click();
    await page
        .getByRole('option')
        .filter({ has: page.getByText(option, { exact: true }) })
        .click();
}

export async function chooseTimezone(page: Page, zone: string, label = '默认时区') {
    await page.getByLabel(label, { exact: true }).click();
    await page.getByRole('combobox', { name: `搜索${label}`, exact: true }).fill(zone);
    await page
        .getByRole('option')
        .filter({ has: page.getByText(zone, { exact: true }) })
        .click();
}
