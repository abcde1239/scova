import type { Page } from '@playwright/test';

export async function chooseOption(page: Page, label: string, option: string) {
    if (label === '输出形式' || label === '本次输出形式' || label === '希望得到的形式') {
        await chooseOutputFormats(page, label, [option]);
        return;
    }
    await page.getByLabel(label, { exact: true }).click();
    await page
        .getByRole('option')
        .filter({ has: page.getByText(option, { exact: true }) })
        .click();
}

/** Check the requested formats before clearing others so the required last item stays valid. */
export async function chooseOutputFormats(page: Page, label: string, options: string[]) {
    const group = page.getByRole('group', { name: label, exact: true });
    for (const option of options)
        await group.getByRole('checkbox', { name: new RegExp(`^${option}`) }).check();
    for (const checkbox of await group.getByRole('checkbox').all()) {
        const name = await checkbox.evaluate(
            (element) => element.closest('label')?.querySelector('strong')?.textContent,
        );
        if (!options.includes(name ?? '')) await checkbox.uncheck();
    }
}

export async function chooseTimezone(page: Page, zone: string, label = '默认时区') {
    await page.getByLabel(label, { exact: true }).click();
    await page.getByRole('combobox', { name: `搜索${label}`, exact: true }).fill(zone);
    await page
        .getByRole('option')
        .filter({ has: page.getByText(zone, { exact: true }) })
        .click();
}
