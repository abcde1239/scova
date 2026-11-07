import { expect, test } from '@playwright/test';
import type { Page, TestInfo } from '@playwright/test';

// This test-only seam mounts actual compiled SFCs; HTTP/storage delivery is tested separately.
interface ReportSample {
    id: string;
    title: string;
    summary: string;
    format: string;
    mode: string;
    outcome: string;
    taskVersionId: string;
    publishedAt: string;
    coverage: {
        completeness: string;
        searchedQueries: string[];
        gaps: string[];
        exhausted: string[];
    };
    limitations: string[];
    claims: {
        id: string;
        kind: string;
        text: string;
        confidenceLabel: string;
        evidenceIds: string[];
    }[];
    evidence: { id: string; quote: string; title: string; url: string }[];
    changes: { newEvidenceIds: string[] }[];
}
declare global {
    interface Window {
        scovaReportFixture: {
            setReport(value: unknown): void;
            setView(value: 'brief' | 'topic-list'): void;
            getReport(): ReportSample;
            getView(): string;
        };
    }
}
const path = '/test-fixtures/report-topic-list.html';
const kinds = ['fact', 'inference', 'conflict', 'insufficient'];
const labels = ['来源事实', 'Agent 推断', '冲突证据', '证据不足'];
const article = (page: Page) => page.locator('article.report-frame');
const warning = (page: Page) => page.getByRole('note', { name: '查阅范围说明' });
const claim = (page: Page, id: string) => page.locator(`#claim-${id}`);
async function open(page: Page) {
    await page.goto(path);
    await expect(article(page)).toBeVisible();
    return page.evaluate(() => window.scovaReportFixture.getReport());
}
async function setView(page: Page, value: 'brief' | 'topic-list') {
    await page.evaluate((view) => window.scovaReportFixture.setView(view), value);
    await expect(
        page.locator(value === 'brief' ? '.report-brief' : '.report-topic-list'),
    ).toBeVisible();
}
async function setReport(page: Page, value: ReportSample) {
    await page.evaluate((report) => window.scovaReportFixture.setReport(report), value);
    await expect(article(page)).toBeVisible();
}
async function assertUniqueIds(page: Page) {
    expect(
        await page.evaluate(() => {
            const ids = [...document.querySelectorAll('[id]')].map((element) => element.id);
            return ids.filter((id, index) => ids.indexOf(id) !== index);
        }),
    ).toEqual([]);
}
async function domMapping(page: Page) {
    return article(page)
        .locator('.claim')
        .evaluateAll((elements) =>
            elements.map((element) => ({
                id: element.id.slice('claim-'.length),
                text: element.querySelector('.claim-text')!.textContent,
                confidence: element.querySelector('.confidence')!.textContent,
                evidence: [...element.querySelectorAll('.citation')].map(
                    (citation) => citation.id.split('-evidence-')[1],
                ),
                quotes: [...element.querySelectorAll('blockquote')].map(
                    (quote) => quote.textContent,
                ),
            })),
        );
}
async function capture(page: Page, info: TestInfo, name: string) {
    await info.attach(name, {
        body: await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true }),
        contentType: 'image/png',
    });
}
async function assertReadableQuote(page: Page) {
    const quote = article(page).locator('.citation blockquote').first();
    await expect(quote).toBeVisible();
    const charactersPerLine = await quote.evaluate((element) => {
        const style = getComputedStyle(element);
        const available =
            element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
        return available / parseFloat(style.fontSize);
    });
    expect(charactersPerLine).toBeGreaterThanOrEqual(4);
}
test.beforeAll(async ({ browser }) => console.log(`Browser: Chromium ${browser.version()}`));

test('real SFCs: same DTO has identical claims, raw confidence and ordered shared citations', async ({
    page,
}) => {
    const api: string[] = [];
    page.on('request', (request) => {
        if (request.url().includes('/api/') || request.url().includes('example.test'))
            api.push(request.url());
    });
    const report = await open(page);
    const sorted = kinds.flatMap((kind) => report.claims.filter((entry) => entry.kind === kind));
    const expected = sorted.map((entry) => ({
        id: entry.id,
        text: entry.text,
        confidence: `证据说明：${entry.confidenceLabel}`,
        evidence: entry.evidenceIds,
        quotes: entry.evidenceIds.map(
            (id) => report.evidence.find((entry) => entry.id === id)!.quote,
        ),
    }));
    let first: Awaited<ReturnType<typeof domMapping>> | undefined;
    for (const view of ['topic-list', 'brief', 'topic-list'] as const) {
        await setView(page, view);
        const actual = await domMapping(page);
        expect(actual).toEqual(expected);
        if (first) expect(actual).toEqual(first);
        first = actual;
        await assertUniqueIds(page);
        expect(await page.evaluate(() => window.scovaReportFixture.getReport())).toEqual(report);
        expect(await page.evaluate(() => window.scovaReportFixture.getView())).toBe(view);
        await expect(article(page).locator('.claim')).toHaveCount(report.claims.length);
        await expect(page.locator('#report-title')).toHaveText(report.title);
        await expect(article(page).locator('time').first()).toHaveAttribute(
            'datetime',
            report.publishedAt,
        );
        await expect(article(page)).toContainText(report.taskVersionId);
    }
    const direct = new Set(report.claims.flatMap((entry) => entry.evidenceIds));
    const changesOnly = report.evidence.filter((entry) => !direct.has(entry.id));
    expect(changesOnly).toHaveLength(1);
    expect(report.changes[0]!.newEvidenceIds).toContain(changesOnly[0]!.id);
    await expect(article(page).locator(`[id$="-evidence-${changesOnly[0]!.id}"]`)).toHaveCount(0);
    const equalText = report.claims.filter((entry) => entry.kind === 'inference');
    expect(equalText.map((entry) => entry.text)).toEqual([equalText[0]!.text, equalText[0]!.text]);
    expect(new Set(equalText.map((entry) => entry.id)).size).toBe(2);
    expect(api).toEqual([]);
});

test('real SFCs: partial precedes summary and every claim; raw coverage and modes survive both layouts', async ({
    page,
}) => {
    const report = await open(page);
    for (const view of ['brief', 'topic-list'] as const) {
        await setView(page, view);
        await expect(warning(page)).toContainText('未覆盖项目和来源详情见下方');
        expect(
            await page.evaluate(() => {
                const alert = document.querySelector('[aria-label="查阅范围说明"]')!;
                return [...document.querySelectorAll('#summary-title, .claim')].every(
                    (element) =>
                        !!(
                            alert.compareDocumentPosition(element) &
                            Node.DOCUMENT_POSITION_FOLLOWING
                        ),
                );
            }),
        ).toBe(true);
        for (const label of labels)
            await expect(
                article(page).getByRole('heading', { name: label, exact: true }),
            ).toBeVisible();
        const coverage = article(page).locator('.coverage details');
        await coverage.locator('summary').press('Enter');
        for (const text of [...report.coverage.searchedQueries, ...report.limitations])
            await expect(coverage).toContainText(text);
        await expect(coverage).toContainText('已耗尽预算：页面数');
        await expect(article(page).locator('.mode')).toHaveText(
            '演示报告：来自演示数据，不代表真实查阅成果。',
        );
        const noEvidence = report.claims.find((entry) => entry.evidenceIds.length === 0)!;
        await expect(claim(page, noEvidence.id)).toContainText(
            '这条内容暂时没有可展开的直接引用，保留为线索。',
        );
        if (view === 'topic-list') {
            await expect(article(page).locator('.topic-section')).toHaveCount(4);
            await expect(article(page).locator('.topic-items > li')).toHaveCount(5);
        }
    }
});

test('real SFCs: complete/live sample and saved format remain distinct from view selection', async ({
    page,
}) => {
    const initial = await open(page);
    await page.getByLabel('样本完整性').selectOption('complete');
    await page.getByLabel('样本模式').selectOption('live');
    const report = await page.evaluate(() => window.scovaReportFixture.getReport());
    expect(report.claims).toEqual(initial.claims);
    expect(report.evidence).toEqual(initial.evidence);
    report.format = 'comparison';
    await setReport(page, report);
    for (const view of ['brief', 'topic-list'] as const) {
        await setView(page, view);
        await expect(warning(page)).toHaveCount(0);
        await expect(article(page).locator('.mode')).toHaveText('真实查阅报告');
        await expect(article(page)).toContainText('本次计划范围内查阅完成，不代表穷尽互联网资料。');
        await expect(page.locator('#summary-title')).toHaveText(
            view === 'brief' ? '简报概述' : '报告概述',
        );
        const notice = page.getByText(
            '当前按基础简报展示结构化结论与引用；尚不提供原报告格式的专属布局。',
        );
        await expect(notice).toHaveCount(0);
        expect(await page.evaluate(() => window.scovaReportFixture.getReport())).toEqual(report);
    }
});

test('real SFCs: only real nonempty categories; no synthesized themes or merged same-text claims', async ({
    page,
}) => {
    const report = await open(page);
    report.claims = report.claims.filter((entry) => entry.kind === 'inference');
    await setReport(page, report);
    for (const view of ['topic-list', 'brief'] as const) {
        await setView(page, view);
        await expect(article(page).locator('.claim')).toHaveCount(2);
        await expect(page.locator('#claims-inference')).toHaveText('Agent 推断');
        await expect(
            page.locator('#claims-fact, #claims-conflict, #claims-insufficient'),
        ).toHaveCount(0);
        expect(
            await article(page)
                .locator('.claim')
                .evaluateAll((elements) => elements.map((element) => element.id)),
        ).toEqual(report.claims.map((entry) => `claim-${entry.id}`));
        await expect(article(page)).not.toContainText('智能主题已生成');
        expect(await page.evaluate(() => window.scovaReportFixture.getReport())).toEqual(report);
    }
});

test('real SFCs: full multiline content and script-like summary/quote stay inert plain text', async ({
    page,
}) => {
    const report = await open(page);
    const payload =
        '<img src="https://example.test/injected.png" onerror="window.quoteExecuted=true"><script>window.quoteExecuted=true</script>';
    report.summary = `保留摘要 ${payload}`;
    report.claims[0]!.text = `${'长结论：申请条件与截止日期必须逐项保留。'.repeat(60)}\n第二段\n${payload}`;
    report.claims[0]!.confidenceLabel = '完整证据说明：待核对的范围与原文条件';
    report.evidence[0]!.quote = `${'长引用上下文与原文条件。'.repeat(100)}\n${payload}`;
    const external: string[] = [];
    page.on('request', (request) => {
        if (request.url().includes('example.test')) external.push(request.url());
    });
    await setReport(page, report);
    for (const view of ['brief', 'topic-list'] as const) {
        await setView(page, view);
        await expect(article(page).locator('[aria-labelledby="summary-title"] > p')).toHaveText(
            report.summary,
        );
        const text = claim(page, report.claims[0]!.id).locator('.claim-text');
        expect(await text.textContent()).toBe(report.claims[0]!.text);
        expect(await text.evaluate((element) => getComputedStyle(element).whiteSpace)).toBe(
            'pre-wrap',
        );
        await expect(claim(page, report.claims[0]!.id).locator('.confidence')).toHaveText(
            `证据说明：${report.claims[0]!.confidenceLabel}`,
        );
        const quoted = page.locator(
            `#claim-${report.claims[0]!.id}-evidence-${report.evidence[0]!.id}`,
        );
        await quoted.locator('summary').press('Enter');
        expect(await quoted.locator('blockquote').textContent()).toBe(report.evidence[0]!.quote);
        await expect(article(page).locator('script, img, iframe')).toHaveCount(0);
        expect(await page.evaluate(() => 'quoteExecuted' in window)).toBe(false);
    }
    expect(external).toEqual([]);
});

test('real SFCs: keyboard opens and closes each quote and reaches safe original link', async ({
    page,
}) => {
    const report = await open(page);
    for (const view of ['brief', 'topic-list'] as const) {
        await setView(page, view);
        for (const entry of report.claims)
            for (const evidenceId of entry.evidenceIds) {
                const wrapper = page.locator(`#claim-${entry.id}-evidence-${evidenceId}`);
                const summary = wrapper.locator('summary');
                await summary.focus();
                await summary.press('Enter');
                await expect(wrapper.locator('blockquote')).toBeVisible();
                expect(
                    await summary.evaluate((element) => getComputedStyle(element).outlineStyle),
                ).not.toBe('none');
                const link = wrapper.getByRole('link', { name: '打开原始来源（新窗口）' });
                await summary.press('Tab');
                await expect(link).toBeFocused();
                await expect(link).toHaveAttribute(
                    'href',
                    report.evidence.find((entry) => entry.id === evidenceId)!.url,
                );
                await expect(link).toHaveAttribute('target', '_blank');
                await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
                expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44);
                expect(await summary.evaluate((element) => getComputedStyle(element).cursor)).toBe(
                    'pointer',
                );
                await summary.press('Space');
                await expect(wrapper.locator('blockquote')).toBeHidden();
            }
        await assertUniqueIds(page);
    }
});

test('fixture boundary: invalid DTO cannot replace the current authorized sample', async ({
    page,
}) => {
    const report = await open(page);
    const result = await page.evaluate(() => {
        const seam = window.scovaReportFixture;
        const invalid = seam.getReport();
        invalid.evidence = [];
        try {
            seam.setReport(invalid);
            return 'accepted';
        } catch {
            return 'rejected';
        }
    });
    expect(result).toBe('rejected');
    expect(await page.evaluate(() => window.scovaReportFixture.getReport())).toEqual(report);
    await expect(page.locator('#report-title')).toHaveText(report.title);
    await expect(article(page).locator('.claim')).toHaveCount(report.claims.length);
});

test('real SFCs: narrow enlarged citations retain readable width in both layouts', async ({
    page,
}, info) => {
    await page.setViewportSize({ width: 320, height: 1000 });
    const report = await open(page);
    await page.evaluate(() => {
        document.documentElement.style.fontSize = '200%';
    });
    for (const view of ['brief', 'topic-list'] as const) {
        await setView(page, view);
        const toggle = article(page).locator('.citation summary').first();
        await toggle.focus();
        await toggle.press('Enter');
        await assertReadableQuote(page);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
            true,
        );
        await expect(article(page).locator('.claim')).toHaveCount(report.claims.length);
        expect(await article(page).locator('.citation blockquote').first().textContent()).toBe(
            report.evidence.find(
                (entry) =>
                    entry.id ===
                    report.claims.find((entry) => entry.kind === 'fact')!.evidenceIds[0],
            )!.quote,
        );
        await capture(page, info, `${view}-320-text-200-readable-quote`);
    }
});

test('shared typography: stored reading size and live family preference reach both actual layouts', async ({
    page,
}) => {
    await page.addInitScript(() =>
        localStorage.setItem(
            'scova.reading.v1',
            JSON.stringify({ version: 1, family: 'serif', size: 1.1875 }),
        ),
    );
    await open(page);
    for (const view of ['brief', 'topic-list'] as const) {
        await setView(page, view);
        for (const family of ['serif', 'sans']) {
            await page.getByLabel('阅读字体').selectOption(family);
            await expect
                .poll(() =>
                    article(page)
                        .locator('.claim-text')
                        .first()
                        .evaluate((element) => getComputedStyle(element).fontFamily),
                )
                .toContain(family === 'serif' ? 'Noto Serif SC' : 'Inter');
            expect(
                await article(page)
                    .locator('.claim-text')
                    .first()
                    .evaluate((element) => getComputedStyle(element).fontSize),
            ).toBe('19px');
            expect(
                await article(page)
                    .locator('.confidence')
                    .first()
                    .evaluate((element) => getComputedStyle(element).fontFamily),
            ).toContain('Inter');
            expect(
                await page
                    .locator('#report-title')
                    .evaluate((element) => getComputedStyle(element).fontFamily),
            ).toContain('Noto Serif SC');
        }
    }
});

for (const width of [320, 390, 768, 1024, 1440, 1920]) {
    test(`real TopicList SFC: ${width} light/dark, reading fonts and 200% root text`, async ({
        page,
    }, info) => {
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.setViewportSize({ width, height: 1000 });
        const report = await open(page);
        await page.evaluate(() => document.fonts.ready);
        for (const dark of [false, true]) {
            await page.getByLabel('测试明暗').selectOption(dark ? 'dark' : 'light');
            await page.getByLabel('阅读字体').selectOption(dark ? 'sans' : 'serif');
            await page.getByLabel('测试主色').selectOption(dark ? 'pine' : 'iris');
            await expect(page.locator('.scova-theme--dark')).toHaveCount(dark ? 1 : 0);
            const toggle = article(page).locator('.citation summary').first();
            if (
                (await article(page).locator('.citation details').first().getAttribute('open')) ===
                null
            ) {
                await toggle.focus();
                await toggle.press('Enter');
            }
            for (const enlarged of [false, true]) {
                await page.evaluate((value) => {
                    document.documentElement.style.fontSize = value ? '200%' : '';
                }, enlarged);
                expect(
                    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
                ).toBe(true);
                await expect(warning(page)).toBeVisible();
                await expect(article(page).locator('.claim')).toHaveCount(report.claims.length);
                for (const summary of [article(page).locator('.coverage summary'), toggle])
                    expect((await summary.boundingBox())!.height).toBeGreaterThanOrEqual(
                        enlarged ? 88 : 44,
                    );
                expect(
                    await article(page)
                        .locator('.claim-text')
                        .first()
                        .evaluate((element) => getComputedStyle(element).fontFamily),
                ).toContain(dark ? 'Inter' : 'Noto Serif SC');
                await assertUniqueIds(page);
                await assertReadableQuote(page);
                await capture(
                    page,
                    info,
                    `topic-list-${width}-${dark ? 'dark-sans-pine' : 'light-serif-iris'}${enlarged ? '-text-200' : ''}`,
                );
            }
        }
        expect(errors).toEqual([]);
    });
}
