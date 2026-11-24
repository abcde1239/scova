import { expect, test } from '@playwright/test';

const samplePath = '/tests/fixtures/reports/report-research.html?sample=formats';
const formats = ['brief', 'list', 'comparison', 'research_report'] as const;

for (const format of formats) {
    for (const narrow of [false, true]) {
        test(`${format} saved document ${narrow ? '320px 200% text' : 'desktop'} preserves reading and citations`, async ({
            page,
        }) => {
            const errors: string[] = [];
            const outbound: string[] = [];
            page.on('pageerror', (error) => errors.push(error.message));
            page.on('request', (request) => {
                if (request.url().includes('example.test')) outbound.push(request.url());
            });
            await page.setViewportSize({ width: narrow ? 320 : 1280, height: 1000 });
            await page.goto(samplePath);
            await expect(
                page.getByRole('heading', { name: '四类报告交付预览', exact: true }),
            ).toBeVisible();
            await page
                .getByRole('combobox', { name: '产出形式', exact: true })
                .selectOption(format);
            if (narrow)
                await page.evaluate(() => {
                    document.documentElement.style.fontSize = '200%';
                });
            await expect(
                page.getByRole('heading', { name: '两馆自习室使用条件', exact: true }),
            ).toBeVisible();
            await expect(page.locator('.showcase-report')).toContainText('免费');
            await expect(page.getByLabel('研究覆盖统计')).toBeVisible();
            await expect(page.getByLabel('研究覆盖统计').locator('dt')).toHaveText([
                '回答完成',
                '外部证据支持',
                '仍未解决',
            ]);
            await expect(page.getByLabel('研究覆盖统计').locator('dd')).toHaveText([
                '3/3',
                '3/3',
                '0',
            ]);
            await expect(page.locator('.report-delivery a')).toHaveText('核心问题已回答');
            await expect(page.locator('.pending, .structured-warning, .question-gap')).toHaveCount(
                0,
            );
            await expect(
                page.locator('.report-document .citations, .structured-links'),
            ).toHaveCount(0);
            expect(
                await page.evaluate(() => {
                    const { scrollWidth } = document.documentElement;
                    return scrollWidth <= innerWidth
                        ? []
                        : [
                              scrollWidth,
                              ...[...document.querySelectorAll('body *')]
                                  .filter(
                                      (element) =>
                                          element.getBoundingClientRect().right > innerWidth + 1,
                                  )
                                  .slice(0, 20)
                                  .map((element) => [
                                      element.tagName,
                                      element.className,
                                      element.getBoundingClientRect().right,
                                  ]),
                          ];
                }),
            ).toEqual([]);
            const documentOutput = format === 'brief' || format === 'research_report';
            if (documentOutput) {
                await expect(
                    page.locator('#summary-title, .answer-gap-overview, .report-warning'),
                ).toHaveCount(0);
                await page.locator('.report-delivery a').click();
                await expect(page.locator('.coverage details')).toHaveAttribute('open');
                await expect(page.locator('.coverage details > summary')).toBeFocused();
                await expect(page.locator('.coverage-body')).toContainText(
                    '已完成本次计划范围内的查阅',
                );
                await page.locator('.coverage details > summary').click();
                await expect(page.locator('.report-document')).toBeVisible();
                await expect(page.locator('.report-document')).toContainText('每次预约最多两小时');
                await expect(page.locator('.answer-support')).not.toHaveAttribute('open');
                await expect(page.locator('.answer-support .claim')).toHaveCount(0);
                if (format === 'brief')
                    await expect(page.locator('ol.finding-list > li')).toHaveCount(2);
                else {
                    await expect(page.locator('.document-paragraphs:is(ul)')).toHaveCount(0);
                    const chapter = page.getByRole('link', {
                        name: '摘要',
                        exact: true,
                    });
                    await chapter.focus();
                    await chapter.press('Enter');
                    await expect(page.locator('#document-overview')).toBeFocused();
                    await expect(page.locator('#document-overview')).toHaveAttribute(
                        'tabindex',
                        '-1',
                    );
                }
            } else {
                await expect(page.locator('.structured-content')).toBeVisible();
                await expect(page.locator('.structured-content')).toContainText('免费');
                if (format === 'list') {
                    await expect(page.locator('.object-card')).toHaveCount(2);
                    await expect(page.locator('.object-card dt')).toHaveCount(8);
                } else {
                    await expect(page.locator('.object-matrix thead th')).toHaveText([
                        '维度',
                        '甲馆',
                        '乙馆',
                    ]);
                    await expect(page.locator('.object-matrix tbody tr')).toHaveCount(4);
                    if (narrow)
                        expect(
                            await page
                                .locator('.matrix-scroll')
                                .evaluate((node) => node.scrollWidth > node.clientWidth),
                        ).toBe(true);
                }
            }
            const appendix = page.locator('.evidence-appendix');
            await expect(appendix.locator('.evidence-source-group')).toHaveCount(2);
            await expect(
                page.locator(
                    '.report-document a[href^="#evidence-"], .structured-content a[href^="#evidence-"]',
                ),
            ).toHaveCount(0);
            if (format === 'comparison' || (format === 'list' && !narrow)) {
                const note = page.locator('.structured-content .value-note a').first();
                await expect(note).toBeVisible();
                const targetId = (await note.getAttribute('href'))!.slice(1);
                const target = page.locator(`[id="${targetId}"]`);
                await note.focus();
                await note.press('Enter');
                await expect(target).toBeVisible();
                await expect(target).toBeFocused();
                await expect(target).toContainText('每次预约最多两小时');
            }
            const source = appendix.locator('.evidence-source-group').first();
            await source.locator(':scope > summary').focus();
            await source.locator(':scope > summary').press('Enter');
            await expect(source.locator('blockquote')).toBeVisible();
            await expect(source.locator('a[target="_blank"]')).toHaveCount(1);
            const outboundLink = source.locator('a[target="_blank"]');
            await expect(outboundLink.locator('.app-icon')).toHaveCount(1);
            await outboundLink.hover();
            expect(
                await outboundLink.evaluate((link) => ({
                    background: getComputedStyle(link).backgroundColor,
                    border: getComputedStyle(link).borderTopWidth,
                })),
            ).toEqual({ background: 'rgba(0, 0, 0, 0)', border: '0px' });
            if (!narrow && format === 'brief') {
                await page.getByRole('combobox', { name: '产出形式', exact: true }).focus();
                await page.mouse.move(0, 0);
                await source.screenshot({
                    path: 'artifacts/link-navigation-refinement/external-source.png',
                });
            }
            await expect(source.locator('a[target="_blank"]')).toHaveAttribute(
                'rel',
                'noopener noreferrer',
            );
            await source.locator(':scope > summary').press('Enter');
            const provenance = appendix.locator('.claim-provenance');
            await provenance.locator(':scope > summary').click();
            const reference = provenance.locator('a[href^="#evidence-"]').first();
            const evidenceTarget = await reference.getAttribute('href');
            await reference.focus();
            await reference.press('Enter');
            await expect(page.locator(`${evidenceTarget} blockquote`)).toBeVisible();
            await expect(page.locator(evidenceTarget!)).toBeFocused();
            const ids = await page
                .locator('[id]')
                .evaluateAll((nodes) => nodes.map((node) => node.id));
            expect(new Set(ids).size).toBe(ids.length);
            if (narrow) {
                const source = page.locator('.evidence-source-group > summary').first();
                const label = source.locator('.source-label');
                const count = source.locator('.source-count');
                const labelBox = await label.boundingBox();
                const countBox = await count.boundingBox();
                expect(labelBox!.width).toBeGreaterThan(140);
                expect(countBox!.y).toBeGreaterThanOrEqual(labelBox!.y + labelBox!.height);
                expect((await source.boundingBox())!.height).toBeGreaterThanOrEqual(44);
            }
            await page
                .getByRole('combobox', { name: '显示主题', exact: true })
                .selectOption('dark');
            expect(
                await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            ).toBe(true);
            await page
                .getByRole('combobox', { name: '显示主题', exact: true })
                .selectOption('light');
            await page.evaluate(() => {
                for (const details of document.querySelectorAll('details')) details.open = false;
                window.scrollTo(0, 0);
            });
            await page.screenshot({
                path: `artifacts/report-formats-redesign/frontend/${format}-${narrow ? '320-200pct' : 'desktop'}.png`,
                fullPage: true,
            });
            expect(outbound).toEqual([]);
            expect(errors).toEqual([]);
        });
    }
}
