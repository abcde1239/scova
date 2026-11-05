import type { Page } from '@playwright/test';

/** Exercise the same row actions as a user; preserve a multiline value as one item. */
export async function fillList(page: Page, label: string, values: string[]) {
    const group = page.getByRole('region', { name: label, exact: true });
    while ((await group.getByRole('textbox').count()) > values.length)
        await group
            .getByRole('button', { name: /^删除/ })
            .last()
            .click();
    while ((await group.getByRole('textbox').count()) < values.length)
        await group.getByRole('button', { name: /^添加/ }).click();
    for (const [index, value] of values.entries())
        await group.getByRole('textbox').nth(index).fill(value);
}
