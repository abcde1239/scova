import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { Report } from '../../packages/models/src/reports.ts';

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
const path = '/test-fixtures/report-comparison.html';
const kinds = [
    'baseline',
    'new',
    'changed',
    'duplicate',
    'duplicate_candidate',
    'non_material',
    'uncertain',
] as const;
const kindLabels = [
    '基线记录',
    '新增资料',
    '实质变化',
    '重复资料',
    '疑似转载',
    '非实质变化',
    '待核验',
];
const claimKinds = ['fact', 'inference', 'conflict', 'insufficient'];
const article = (page: Page) => page.locator('article.report-frame');
const table = (page: Page) => article(page).getByRole('table', { name: '逐项事实与变化对比' });
const row = (page: Page, id: string) => page.locator(`#comparison-change-${id}`);
const scroll = (page: Page) => page.locator('.comparison-scroll');
async function open(page: Page) {
    await page.goto(path);
    await expect(article(page)).toBeVisible();
    return page.evaluate(() => window.scovaComparisonFixture.getReport());
}
async function setReport(page: Page, report: Report) {
    await page.evaluate((value) => window.scovaComparisonFixture.setReport(value), report);
    await expect(article(page)).toBeVisible();
}
async function setView(page: Page, view: 'brief' | 'comparison') {
    await page.evaluate((value) => window.scovaComparisonFixture.setView(value), view);
    await expect(
        page.locator(view === 'comparison' ? '.report-comparison' : '.report-brief'),
    ).toBeVisible();
}
async function uniqueIds(page: Page) {
    expect(
        await page.evaluate(() => {
            const ids = [...document.querySelectorAll('[id]')].map((element) => element.id);
            return ids.filter((id, index) => ids.indexOf(id) !== index);
        }),
    ).toEqual([]);
}
async function claims(page: Page) {
    return article(page)
        .locator('.claim')
        .evaluateAll((elements) =>
            elements.map((element) => ({
                id: element.id.slice('claim-'.length),
                text: element.querySelector('.claim-text')!.textContent,
                confidence: element.querySelector('.confidence')!.textContent,
                evidenceIds: [...element.querySelectorAll('.citation')].map(
                    (citation) => citation.id.split('-evidence-')[1],
                ),
                quotes: [...element.querySelectorAll('blockquote')].map(
                    (quote) => quote.textContent,
                ),
            })),
        );
}
function expectedClaims(report: Report) {
    return claimKinds
        .flatMap((kind) => report.claims.filter((entry) => entry.kind === kind))
        .map((entry) => ({
            id: entry.id,
            text: entry.text,
            confidence: `证据说明：${entry.confidenceLabel}`,
            evidenceIds: entry.evidenceIds,
            quotes: entry.evidenceIds.map(
                (id) => report.evidence.find((evidence) => evidence.id === id)!.quote,
            ),
        }));
}
async function quoteWidths(page: Page) {
    const widths = await article(page)
        .locator('details[open] blockquote')
        .evaluateAll((elements) =>
            elements.map((element) => {
                const style = getComputedStyle(element);
                const effective =
                    element.clientWidth -
                    parseFloat(style.paddingLeft) -
                    parseFloat(style.paddingRight);
                return effective / parseFloat(style.fontSize);
            }),
        );
    expect(widths.length).toBeGreaterThan(0);
    expect(widths.every((width) => width >= 4)).toBe(true);
}
async function overflowSemantics(page: Page) {
    const overflow = await scroll(page).evaluate(
        (element) => element.scrollWidth > element.clientWidth,
    );
    if (overflow) {
        await expect(scroll(page)).toHaveAttribute('role', 'region');
        await expect(scroll(page)).toHaveAttribute('tabindex', '0');
        await expect(scroll(page)).toHaveAccessibleName('逐项事实与变化对比');
        await expect(page.locator('#comparison-scroll-hint')).toBeVisible();
    } else {
        await expect(scroll(page)).not.toHaveAttribute('role', 'region');
        await expect(scroll(page)).not.toHaveAttribute('tabindex', '0');
        await expect(page.locator('#comparison-scroll-hint')).toHaveCount(0);
    }
    return overflow;
}
async function settleNativeScroll(page: Page) {
    await scroll(page).evaluate(
        (element) =>
            new Promise<void>((resolve) => {
                let previous = element.scrollLeft;
                let unchangedFrames = 0;
                function measure() {
                    const current = element.scrollLeft;
                    unchangedFrames = current === previous ? unchangedFrames + 1 : 0;
                    previous = current;
                    if (unchangedFrames >= 6) resolve();
                    else requestAnimationFrame(measure);
                }
                requestAnimationFrame(measure);
            }),
    );
}
test.beforeAll(async ({ browser }) => console.log(`Browser: Chromium ${browser.version()}`));

test('real SFC: complete claims and ordered old/new citation union survive Brief/Comparison/Brief', async ({
    page,
}) => {
    const api: string[] = [];
    page.on('request', (request) => {
        if (request.url().includes('/api/') || request.url().includes('example.test'))
            api.push(request.url());
    });
    const report = await open(page);
    const firstChanged = report.changes.find((entry) => entry.kind === 'changed')!;
    report.changes.unshift({ ...firstChanged, id: '00000000-0000-4000-8000-000000000090' });
    await setReport(page, report);
    for (const view of ['brief', 'comparison', 'brief', 'comparison'] as const) {
        await setView(page, view);
        expect(await claims(page)).toEqual(expectedClaims(report));
        await uniqueIds(page);
        await expect(page.locator('#report-title')).toHaveText(report.title);
        expect(await page.evaluate(() => window.scovaComparisonFixture.getReport())).toEqual(
            report,
        );
        expect(await page.evaluate(() => window.scovaComparisonFixture.getView())).toBe(view);
        if (view === 'comparison') {
            const sorted = kinds.flatMap((kind) =>
                report.changes.filter((entry) => entry.kind === kind),
            );
            expect(
                await table(page)
                    .locator('tbody tr')
                    .evaluateAll((elements) =>
                        elements.map((element) => element.id.replace('comparison-change-', '')),
                    ),
            ).toEqual(sorted.map((entry) => entry.id));
            for (const change of sorted) {
                const entry = row(page, change.id);
                await expect(entry.getByRole('rowheader')).toHaveText(change.factKey);
                await expect(entry.locator('.change-kind')).toHaveText(
                    kindLabels[kinds.indexOf(change.kind)]!,
                );
                await expect(entry.locator('td').first()).toContainText(
                    change.important ? '重要性标记：重要' : '重要性标记：未标记为重要',
                );
                expect(await entry.locator('td .original-text').first().textContent()).toBe(
                    change.reason,
                );
                for (const side of ['old', 'new'] as const) {
                    const ids = side === 'old' ? change.oldEvidenceIds : change.newEvidenceIds;
                    const cell = entry.locator(`.${side}-side`);
                    expect(
                        await cell
                            .locator('.table-citation')
                            .evaluateAll((elements) =>
                                elements.map((element) => element.id.split(/-(?:old|new)-/)[1]),
                            ),
                    ).toEqual(ids);
                    expect(await cell.locator('blockquote').allTextContents()).toEqual(
                        ids.map(
                            (id) => report.evidence.find((evidence) => evidence.id === id)!.quote,
                        ),
                    );
                    expect(await cell.locator('.original-text').textContent()).toBe(
                        side === 'old'
                            ? (change.oldValue ?? '未提供旧值')
                            : (change.newValue ?? '未提供新值'),
                    );
                }
            }
            const visible = new Set(
                await article(page)
                    .locator('.citation,.table-citation')
                    .evaluateAll((elements) =>
                        elements.map((element) =>
                            element.id.split(/-evidence-|-(?:old|new)-/).at(-1),
                        ),
                    ),
            );
            const expected = new Set([
                ...report.claims.flatMap((claim) => claim.evidenceIds),
                ...report.changes.flatMap((change) => [
                    ...change.oldEvidenceIds,
                    ...change.newEvidenceIds,
                ]),
            ]);
            expect(visible).toEqual(expected);
        }
    }
    expect(api).toEqual([]);
});

test('real SFC: semantic caption/headers and missing sides do not borrow opposite evidence', async ({
    page,
}) => {
    const report = await open(page);
    await expect(table(page).locator('caption')).toHaveText('逐项事实与变化对比');
    await expect(table(page).getByRole('columnheader')).toHaveText([
        '比较维度',
        '分类与重要性',
        '旧值 · 基线',
        '本次观测 · 新值',
    ]);
    expect(
        await table(page)
            .locator('thead th')
            .evaluateAll((elements) =>
                elements.every((element) => element.getAttribute('scope') === 'col'),
            ),
    ).toBe(true);
    expect(
        await table(page)
            .locator('tbody th')
            .evaluateAll((elements) =>
                elements.every((element) => element.getAttribute('scope') === 'row'),
            ),
    ).toBe(true);
    for (const entry of report.changes) {
        if (!entry.oldEvidenceIds.length)
            await expect(row(page, entry.id).locator('.old-side')).toContainText(
                '未提供旧侧引用。',
            );
        if (!entry.newEvidenceIds.length)
            await expect(row(page, entry.id).locator('.new-side')).toContainText(
                '未提供本次观测引用。',
            );
        if (entry.oldValue !== null && !entry.oldEvidenceIds.length)
            await expect(row(page, entry.id)).toContainText('旧值缺少可核对引用');
    }
    await expect(article(page)).toContainText(report.baselineRunId!);
    await expect(article(page).locator('.comparison-summary')).toContainText('变化结论仍不确定');
    expect(
        await page.evaluate(() => {
            const warning = document.querySelector('[aria-label="部分交付警告"]')!;
            return [
                ...document.querySelectorAll('#summary-title,.comparison-section,.claim'),
            ].every(
                (element) =>
                    !!(warning.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING),
            );
        }),
    ).toBe(true);
});

test('real SFC: empty changes retain all claims/partial and do not invent a no-change conclusion', async ({
    page,
}) => {
    const report = await open(page);
    report.changes = [];
    await setReport(page, report);
    await expect(table(page)).toHaveCount(0);
    await expect(article(page).getByText('本报告没有提供逐项变化记录。')).toBeVisible();
    expect(await claims(page)).toEqual(expectedClaims(report));
    await expect(article(page).getByRole('note', { name: '部分交付警告' })).toBeVisible();
    await expect(article(page).locator('.comparison-summary')).toContainText(
        '不能据此认定没有重要变化',
    );
    await uniqueIds(page);
});

test('real SFC: outcome follows server fields rather than empty table or absent baseline ID', async ({
    page,
}) => {
    const original = await open(page);
    const report = {
        ...original,
        changes: [],
        limitations: [],
        coverage: {
            ...original.coverage,
            completeness: 'complete' as const,
            gaps: [],
            exhausted: [],
        },
    };
    for (const [outcome, title] of [
        ['baseline', '本次建立比较基线'],
        ['no_important_change', '本次范围内未发现重要变化'],
        ['important_change', '报告记录了重要变化'],
        ['inconclusive', '变化结论仍不确定'],
    ] as const) {
        await setReport(page, { ...report, outcome, baselineRunId: null });
        await expect(article(page).locator('.comparison-summary h4')).toHaveText(title);
        await expect(article(page)).toContainText('报告未提供关联的基线执行。');
        expect(await claims(page)).toEqual(expectedClaims(report));
    }
});

test('real SFC: raw HTML/Markdown/whitespace stay inert in values, reasons and saved quotes', async ({
    page,
}) => {
    const external: string[] = [];
    page.on('request', (request) => {
        if (request.url().includes('example.test') || request.url().includes('/api/'))
            external.push(request.url());
    });
    const report = await open(page);
    const raw =
        '  <script>window.comparisonInjected=1</script>\n<img src="https://example.test/x" onerror="bad()">\t**字面文本**  ';
    const entry = report.changes.find((change) => change.kind === 'changed')!;
    entry.oldValue = raw;
    entry.newValue = raw;
    entry.reason = raw;
    entry.factKey = raw;
    report.evidence[0]!.quote = raw;
    await setReport(page, report);
    const changed = row(page, entry.id);
    expect(await changed.getByRole('rowheader').textContent()).toBe(raw);
    expect(await changed.locator('td .original-text').allTextContents()).toEqual([raw, raw, raw]);
    const citation = changed.locator('.old-side .table-citation').first();
    await citation.locator('summary').press('Enter');
    expect(await citation.locator('blockquote').textContent()).toBe(raw);
    await expect(article(page).locator('script,img,iframe,strong')).toHaveCount(0);
    expect(await page.evaluate(() => 'comparisonInjected' in window)).toBe(false);
    expect(external).toEqual([]);
});

test('real SFC: each old/new citation opens by keyboard and Tab reaches its safe original link', async ({
    page,
}) => {
    const report = await open(page);
    for (const change of report.changes)
        for (const side of ['old', 'new'] as const) {
            for (const id of side === 'old' ? change.oldEvidenceIds : change.newEvidenceIds) {
                const citation = page.locator(`#comparison-${change.id}-${side}-${id}`);
                const summary = citation.locator('summary');
                await summary.focus();
                await summary.press('Enter');
                await expect(citation.locator('blockquote')).toBeVisible();
                const evidence = report.evidence.find((entry) => entry.id === id)!;
                expect(await citation.locator('blockquote').textContent()).toBe(evidence.quote);
                await expect(citation).toContainText(evidence.location);
                await expect(citation.locator('time')).toHaveAttribute(
                    'datetime',
                    evidence.observedAt,
                );
                const link = citation.getByRole('link', { name: '打开原始来源（新窗口）' });
                expect(
                    await summary.evaluate((element) => getComputedStyle(element).outlineStyle),
                ).not.toBe('none');
                await summary.press('Tab');
                await expect(link).toBeFocused();
                await expect(link).toHaveAttribute('href', evidence.url);
                await expect(link).toHaveAttribute('target', '_blank');
                await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
                expect(
                    await link.evaluate((element) => getComputedStyle(element).outlineStyle),
                ).not.toBe('none');
                expect(await link.evaluate((element) => getComputedStyle(element).cursor)).toBe(
                    'pointer',
                );
                expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44);
                await summary.press('Space');
                await expect(citation.locator('blockquote')).toBeHidden();
            }
        }
    await uniqueIds(page);
});

test('real SFC: actual overflow adds region/tab stop and native direction keys scroll only table', async ({
    page,
}) => {
    await page.setViewportSize({ width: 1440, height: 950 });
    await open(page);
    await expect
        .poll(() => scroll(page).evaluate((element) => element.scrollWidth <= element.clientWidth))
        .toBe(true);
    expect(await overflowSemantics(page)).toBe(false);
    await page.setViewportSize({ width: 320, height: 950 });
    await expect
        .poll(() => scroll(page).evaluate((element) => element.scrollWidth > element.clientWidth))
        .toBe(true);
    expect(await overflowSemantics(page)).toBe(true);
    await scroll(page).focus();
    await expect(scroll(page)).toBeFocused();
    expect(
        await scroll(page).evaluate((element) => getComputedStyle(element).outlineStyle),
    ).not.toBe('none');
    await scroll(page).press('ArrowRight');
    await expect
        .poll(() => scroll(page).evaluate((element) => element.scrollLeft))
        .toBeGreaterThan(0);
    await settleNativeScroll(page);
    const first = await scroll(page).evaluate((element) => element.scrollLeft);
    await scroll(page).press('ArrowRight');
    await expect
        .poll(() => scroll(page).evaluate((element) => element.scrollLeft))
        .toBeGreaterThan(first);
    await settleNativeScroll(page);
    const before = await scroll(page).evaluate((element) => element.scrollLeft);
    await scroll(page).press('ArrowLeft');
    await expect
        .poll(() => scroll(page).evaluate((element) => element.scrollLeft))
        .toBeLessThan(before);
    expect(await page.evaluate(() => scrollX)).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
    );
    await page.setViewportSize({ width: 1920, height: 950 });
    await expect(scroll(page)).not.toHaveAttribute('tabindex', '0');
    expect(await overflowSemantics(page)).toBe(false);
});

test('fixture boundary: invalid side references cannot replace the prior validated Report', async ({
    page,
}) => {
    const report = await open(page);
    const result = await page.evaluate(() => {
        const seam = window.scovaComparisonFixture;
        const invalid = seam.getReport();
        invalid.changes[2]!.newEvidenceIds = ['00000000-0000-4000-8000-000000000999'];
        try {
            seam.setReport(invalid);
            return 'accepted';
        } catch {
            return 'rejected';
        }
    });
    expect(result).toBe('rejected');
    expect(await page.evaluate(() => window.scovaComparisonFixture.getReport())).toEqual(report);
    await expect(table(page).locator('tbody tr')).toHaveCount(report.changes.length);
});

for (const width of [320, 390, 768, 1024, 1440, 1920]) {
    test(`real SFC: comparison ${width} light/dark, serif/sans and 200% text keep local scroll and readable quotes`, async ({
        page,
    }, info) => {
        const errors: string[] = [];
        const requests: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        page.on('request', (request) => {
            if (request.url().includes('/api/') || request.url().includes('example.test'))
                requests.push(request.url());
        });
        await page.setViewportSize({ width, height: 1000 });
        const report = await open(page);
        const changed = report.changes.find((change) => change.kind === 'changed')!;
        const changedRow = row(page, changed.id);
        for (const side of ['old', 'new'])
            await changedRow.locator(`.${side}-side summary`).first().press('Enter');
        await article(page).locator('.claim summary').first().press('Enter');
        await page.evaluate(() => document.fonts.ready);
        for (const scheme of ['light', 'dark']) {
            await page.locator('#sample-scheme').selectOption(scheme);
            await expect(page.locator('.scova-theme--dark')).toHaveCount(scheme === 'dark' ? 1 : 0);
            for (const family of ['serif', 'sans']) {
                await page.locator('#sample-family').selectOption(family);
                await expect
                    .poll(() =>
                        article(page)
                            .locator('.claim-text')
                            .first()
                            .evaluate((element) => getComputedStyle(element).fontFamily),
                    )
                    .toContain(family === 'serif' ? 'Noto Serif SC' : 'Inter');
                for (const enlarged of [false, true]) {
                    await page.evaluate((value) => {
                        document.documentElement.style.fontSize = value ? '200%' : '';
                    }, enlarged);
                    await expect
                        .poll(() =>
                            page.evaluate(
                                () => document.documentElement.scrollWidth <= innerWidth + 1,
                            ),
                        )
                        .toBe(true);
                    await overflowSemantics(page);
                    await quoteWidths(page);
                    const fonts = await table(page)
                        .locator('th,td,.table-citation summary,.table-citation blockquote')
                        .evaluateAll((elements) =>
                            elements.map((element) => getComputedStyle(element).fontFamily),
                        );
                    expect(fonts.every((font) => font.includes('Inter'))).toBe(true);
                    const controls = await changedRow
                        .locator('details[open] summary,details[open] a')
                        .evaluateAll((elements) =>
                            elements.map((element) => element.getBoundingClientRect().height),
                        );
                    expect(controls.every((height) => height >= (enlarged ? 88 : 44) - 1)).toBe(
                        true,
                    );
                    await changedRow.locator('.old-side summary').first().scrollIntoViewIfNeeded();
                    await page.screenshot({
                        path: info.outputPath(
                            `comparison-${width}-${scheme}-${family}${enlarged ? '-text200' : ''}.png`,
                        ),
                        fullPage: false,
                    });
                }
            }
        }
        expect(await claims(page)).toEqual(expectedClaims(report));
        expect(await page.evaluate(() => window.scovaComparisonFixture.getReport())).toEqual(
            report,
        );
        await uniqueIds(page);
        expect(errors).toEqual([]);
        expect(requests).toEqual([]);
    });
}
