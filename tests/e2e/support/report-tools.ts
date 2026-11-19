import type { ReportQuestion } from '@scova/models';
import { expect, type Page } from '@playwright/test';

/** Exercise the same native disclosure used by readers; never mutate its open attribute. */
export async function openReportTool(page: Page, tool: 'notes' | 'bookmarks' | 'feedback') {
    const section = page.locator(`.${tool}-tool`);
    await expect(section).toBeAttached();
    if (!(await section.evaluate((element) => (element as HTMLDetailsElement).open)))
        await section.locator(':scope > summary').click();
}

/** The appendix groups observations by page and version, independently of DTO order. */
export async function expectReportEvidence(page: Page, evidence: readonly { id: string }[]) {
    const anchors = page.locator('.evidence-appendix .evidence-entry');
    const expected = evidence.map(({ id }) => `evidence-${id}`).sort();
    await expect
        .poll(() => anchors.evaluateAll((elements) => elements.map((element) => element.id).sort()))
        .toEqual(expected);
}

export async function askReportQuestion(page: Page, reportId: string, question: string) {
    await page.getByLabel('问题', { exact: true }).fill(question);
    const ask = page.getByRole('button', { name: '提问', exact: true });
    await expect(ask).toBeEnabled();
    const posted = page.waitForResponse(
        (response) =>
            response.request().method() === 'POST' &&
            new URL(response.url()).pathname === `/api/v1/reports/${reportId}/questions`,
    );
    await ask.press('Enter');
    const response = await posted;
    expect(response.status()).toBe(201);
    const saved = (await response.json()) as ReportQuestion;
    await expect(page).toHaveURL((url) => url.searchParams.get('questionId') === saved.id);
    return saved.id;
}
