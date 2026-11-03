import { expect, type Page } from '@playwright/test';

/** Exercise the same native disclosure used by readers; never mutate its open attribute. */
export async function openReportTool(page: Page, tool: 'notes' | 'bookmarks' | 'feedback') {
    const section = page.locator(`.${tool}-tool`);
    await expect(section).toBeAttached();
    if (!(await section.evaluate((element) => (element as HTMLDetailsElement).open)))
        await section.locator(':scope > summary').click();
}
