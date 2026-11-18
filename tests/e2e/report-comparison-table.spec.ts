import { expect, test, type Page } from '@playwright/test';
import type { Report } from '../../packages/models/src/report/schema.ts';
declare global {
    interface Window {
        scovaComparisonFixture: {
            setReport(value: unknown): void;
            setView(value: 'brief' | 'comparison'): void;
            getReport(): Report;
            getView(): string;
        };
    }
}
const path = '/tests/fixtures/reports/report-comparison.html';
const article = (page: Page) => page.locator('article.report-frame');
async function open(page: Page) {
    await page.goto(path);
    await expect(article(page)).toBeVisible();
    return page.evaluate(() => window.scovaComparisonFixture.getReport());
}
async function uniqueIds(page: Page) {
    expect(
        await page.evaluate(() => {
            const ids = [...document.querySelectorAll('[id]')].map((el) => el.id);
            return ids.filter((id, index) => ids.indexOf(id) !== index);
        }),
    ).toEqual([]);
}
for (const width of [320, 768, 1440]) {
    test(`comparison reuses a single change view at ${width}`, async ({ page }, info) => {
        await page.setViewportSize({ width, height: 1000 });
        await page.emulateMedia({ reducedMotion: 'reduce' });
        const report = await open(page);
        const before = structuredClone(report);
        await expect(page.locator('.report-changes')).toHaveCount(1);
        await expect(page.locator('.comparison-table,.change-provenance')).toHaveCount(0);
        const other = page.locator('.report-changes details > summary');
        if (await other.count()) await other.press('Enter');
        for (const change of report.changes.filter((change) => change.kind !== 'baseline')) {
            const record = page.locator(`[data-change-id="${change.id}"]`);
            await expect(record).toContainText(change.factKey);
            await expect(record).toContainText(change.reason);
            if (change.oldValue !== null)
                await expect(record.locator('.old-value')).toHaveText(change.oldValue);
            await expect(record.locator('.new-value')).toHaveText(change.newValue ?? '未提供新值');
            for (const link of await record.locator('a[href^="#evidence-"]').all()) {
                await link.focus();
                await link.press('Enter');
                await expect(page.locator((await link.getAttribute('href'))!)).toBeFocused();
            }
        }
        await uniqueIds(page);
        for (const size of ['100%', '200%']) {
            await page.evaluate((size) => (document.documentElement.style.fontSize = size), size);
            expect(
                await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            ).toBe(true);
        }
        await info.attach('comparison-200', {
            body: await page.screenshot({ fullPage: true }),
            contentType: 'image/png',
        });
        await page.evaluate(() => window.scovaComparisonFixture.setView('brief'));
        await expect(page.locator('.report-changes')).toHaveCount(1);
        await uniqueIds(page);
        expect(await page.evaluate(() => window.scovaComparisonFixture.getReport())).toEqual(
            before,
        );
    });
}
test('missing baseline ID stays human readable and first-run records stay in saved data', async ({
    page,
}) => {
    const report = await open(page);
    report.baselineRunId = null;
    report.outcome = 'baseline';
    report.coverage.completeness = 'complete';
    report.coverage.gaps = [];
    report.changes = report.changes.filter((change) => change.kind === 'baseline');
    await page.evaluate((report) => window.scovaComparisonFixture.setReport(report), report);
    await expect(page.getByRole('heading', { name: '已设为比较起点', exact: true })).toBeVisible();
    await expect(page.locator('.change-record')).toHaveCount(0);
    await expect(page.locator('.report-changes')).not.toContainText('基线执行标识');
    expect((await page.evaluate(() => window.scovaComparisonFixture.getReport())).changes).toEqual(
        report.changes,
    );
});

test('navigation links retain focus and pressed feedback across themes and accents', async ({
    page,
}, info) => {
    await open(page);
    await page.setViewportSize({ width: 320, height: 1000 });
    for (const scheme of ['light', 'dark'])
        for (const accent of ['blue', 'pine', 'iris', 'amber']) {
            await page.locator('#sample-scheme').selectOption(scheme);
            await page.locator('#sample-accent').selectOption(accent);
            const link = page.locator('.report-changes .navigation-link').first();
            await link.focus();
            expect(await link.evaluate((el) => getComputedStyle(el).outlineStyle)).not.toBe('none');
            await page.emulateMedia({ reducedMotion: 'reduce' });
            await link.hover();
            expect(
                await link.locator('.app-icon').evaluate((el) => getComputedStyle(el).transform),
            ).toBe('none');
            await page.mouse.down();
            expect(await link.evaluate((el) => getComputedStyle(el).textDecorationLine)).toContain(
                'underline',
            );
            await page.mouse.move(0, 0);
            await page.mouse.up();
            await info.attach(`${scheme}-${accent}`, {
                body: await page.screenshot({ fullPage: true }),
                contentType: 'image/png',
            });
        }
});
