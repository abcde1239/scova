import { expect, test, type Page } from '@playwright/test';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const reportId = id(1);
const taskId = id(2);
const runId = id(3);
const taskVersionId = id(4);
const baselineRunId = id(5);
const sourceId = id(21);
const time = '2026-10-31T01:00:00.000Z';
function evidence(n: number, title = `保存来源 ${n}`) {
    return {
        id: id(20 + n),
        sourceId,
        snapshotId: id(40 + n),
        title,
        url: `https://example.test/source-${n}`,
        quote: `来源 ${n} 的保存引用文本。`,
        location: `第 ${n} 段，第 1–8 字符`,
        observedAt: time,
        snapshot: {
            originalUrl: `https://example.test/original-${n}`,
            fetchedUrl: `https://example.test/fetched-${n}`,
            canonicalUrl: `https://example.test/canonical-${n}`,
            contentHash: String.fromCharCode(96 + n).repeat(64),
            extractorVersion: 'reader-v1',
            publishedAt: null,
            truncated: false,
            selector: {
                type: 'text_offset' as const,
                start: 0,
                end: 10,
                extractorVersion: 'reader-v1',
            },
        },
    };
}

function researchReport(baselineOnly = false) {
    const first = evidence(1);
    const second = evidence(2);
    const orphan = evidence(3, '孤立来源：未归入结论');
    return {
        id: reportId,
        taskId,
        runId,
        taskVersionId,
        baselineRunId: baselineOnly ? baselineRunId : null,
        schemaVersion: 1,
        title: '可追溯研究报告：资料变化与证据',
        summary: '报告概述保留研究范围、证据链与仍待核验的缺口。',
        format: 'brief',
        mode: 'live',
        outcome: 'important_change',
        coverage: {
            completeness: 'partial',
            searchedQueries: ['研究资料 最新进展'],
            gaps: ['一项来源尚未完成交叉核验'],
            exhausted: ['pages'],
        },
        limitations: ['部分来源不可达，不能据此断言资料没有变化。'],
        claims: [
            {
                id: id(10),
                kind: 'fact',
                text: '来源事实：资料按批次公开。',
                confidenceLabel: '来源原文逐字支持。',
                evidenceIds: [first.id],
            },
            {
                id: id(11),
                kind: 'inference',
                text: 'Agent 推断：后续批次可能补充更多证据。',
                confidenceLabel: '推断仍需验证。',
                evidenceIds: [second.id],
            },
            {
                id: id(12),
                kind: 'conflict',
                text: '冲突证据：两个来源的范围描述不同。',
                confidenceLabel: '冲突尚未解决。',
                evidenceIds: [first.id, second.id],
            },
            {
                id: id(13),
                kind: 'insufficient',
                text: '证据不足：尚不能认定资料已完整覆盖。',
                confidenceLabel: '没有足够独立引用。',
                evidenceIds: [],
            },
        ],
        evidence: [first, second, orphan],
        changes: baselineOnly
            ? []
            : [
                  {
                      id: id(30),
                      sourceId,
                      kind: 'changed',
                      factKey: '研究范围',
                      oldValue: '旧范围',
                      newValue: '新范围',
                      oldEvidenceIds: [first.id],
                      newEvidenceIds: [second.id],
                      important: true,
                      reason: '新旧保存片段显示范围发生变化。',
                  },
              ],
        publishedAt: '2026-10-31T02:00:00.000Z',
    };
}

type State = { baselineOnly: boolean; requests: { method: string; path: string }[] };
const fixturePath = '/test-fixtures/report-research.html';
interface ResearchFixture {
    setReport(value: ReturnType<typeof researchReport>): void;
    getReport(): ReturnType<typeof researchReport>;
    setView(value: 'brief' | 'research'): void;
    getView(): 'brief' | 'research';
}
declare global {
    interface Window {
        scovaResearchFixture: ResearchFixture;
    }
}
const article = (page: Page) => page.locator('article.research-report');
async function openReport(page: Page, state: State) {
    page.on('request', (request) => {
        if (request.url().includes('/api/') || request.url().includes('example.test'))
            state.requests.push({
                method: request.method(),
                path: new URL(request.url()).pathname,
            });
    });
    await page.goto(fixturePath);
    await page.waitForFunction(() => !!window.scovaResearchFixture);
    await page.evaluate(
        (report) => window.scovaResearchFixture.setReport(report),
        researchReport(state.baselineOnly),
    );
    await expect(article(page)).toBeVisible();
}
test.beforeAll(async ({ browser }) => console.log(`Browser: Chromium ${browser.version()}`));

for (const width of [1280, 390]) {
    test(`question answers group one source while keeping distinct views and quote links at ${width}`, async ({
        page,
    }) => {
        await page.setViewportSize({ width, height: 1000 });
        const state: State = { baselineOnly: false, requests: [] };
        await openReport(page, state);
        await page.evaluate(() => {
            const report = window.scovaResearchFixture.getReport();
            report.evidence[1]!.sourceId = '00000000-0000-4000-8000-000000000099';
            report.claims.push({
                ...report.claims[0]!,
                id: '00000000-0000-4000-8000-000000000014',
                text: '同一来源的另一观点：后续批次另行公布。',
            });
            const value = {
                ...report,
                coverage: {
                    ...report.coverage,
                    reportValue: {
                        version: 1,
                        questions: [
                            {
                                id: 'q0',
                                text: '公开批次与范围有何差异？',
                                priority: 'core',
                                status: 'disputed',
                                claimIndexes: [0, 1, 2, 4],
                                gap: '两份资料的适用范围不同。',
                            },
                        ],
                        selections: report.claims.map((_, claimIndex) => ({
                            claimIndex,
                            questionIds: claimIndex === 3 ? [] : ['q0'],
                            placement: claimIndex === 3 ? 'reference' : 'main',
                            reason: '回答公开范围',
                            basis: 'model_assessment',
                            timeScope: 'unknown',
                            assessment: {
                                relevance: 'direct',
                                support: 'partial',
                                role: 'answer',
                                sourceRelation: 'unknown',
                                reason: '对应公开批次',
                                conditions: claimIndex === 4 ? '只适用于后续批次。' : '',
                                gap: '',
                            },
                        })),
                    },
                },
            };
            window.scovaResearchFixture.setReport(value);
        });
        const answer = page.locator('#question-q0');
        await expect(answer.locator('.answer-source')).toHaveCount(3);
        const first = answer.locator('.answer-source').first();
        await expect(first.locator('.claim')).toHaveCount(2);
        await expect(first.locator('.source-evidence .evidence')).toHaveCount(1);
        await expect(first).toContainText('只适用于后续批次。');
        const link = first.locator('.claim-sources a').last();
        const target = await link.getAttribute('href');
        await link.click();
        await page.locator(`${target} summary`).click();
        await expect(page.locator(`${target} blockquote`)).toBeVisible();
        await expect(first.locator('.assessment').first()).not.toHaveAttribute('open');
        await first.locator('.assessment > summary').first().click();
        await expect(
            first.getByText('评估说明：对应公开批次', { exact: true }).first(),
        ).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
            true,
        );
        const ids = await page.locator('[id]').evaluateAll((nodes) => nodes.map((node) => node.id));
        expect(new Set(ids).size).toBe(ids.length);
        await page.screenshot({
            path: `artifacts/report-wording-2026-11-07/report-${width}.png`,
            fullPage: true,
        });
        expect(state.requests).toEqual([]);
    });
}

test('soft evidence keeps uncertain content visible without creating citations and shows candidate notes separately', async ({
    page,
}) => {
    const state: State = { baselineOnly: false, requests: [] };
    await openReport(page, state);
    await page.evaluate(() => {
        const report = window.scovaResearchFixture.getReport();
        const claim = report.claims.find((c) => c.kind === 'insufficient')!;
        claim.text = '保留待核实的模型判断 <script>doNotRun()</script>';
        const value = {
            ...report,
            coverage: { ...report.coverage, notes: ['候选按上限筛选，不代表引擎故障。'] },
        };
        window.scovaResearchFixture.setReport(value);
    });
    const claim = page.locator('.claim').filter({ hasText: '保留待核实的模型判断' });
    await expect(claim.getByText('需要补充材料', { exact: true })).toBeVisible();
    await expect(claim.locator('.claim-text')).toHaveText(
        '保留待核实的模型判断 <script>doNotRun()</script>',
    );
    await expect(claim.locator('.citation')).toHaveCount(0);
    await expect(claim.locator('script')).toHaveCount(0);
    await page.getByText('查看查询摘要与覆盖缺口', { exact: true }).click();
    await expect(page.getByText('候选按上限筛选，不代表引擎故障。', { exact: true })).toBeVisible();
    expect(state.requests).toEqual([]);
});

test('ResearchReport 目录、四类结论、changes 与孤立 evidence 按真实 DTO 完整呈现', async ({
    page,
}) => {
    const state: State = { baselineOnly: false, requests: [] };
    await openReport(page, state);
    await expect(page.getByRole('navigation', { name: '报告目录' })).toBeVisible();
    for (const name of [
        '报告概述',
        '查阅范围与限制',
        '变化与基线',
        '来源事实',
        'Agent 推断',
        '冲突证据',
        '证据不足',
        '来源与保存引用',
    ])
        await expect(page.getByRole('link', { name, exact: true })).toBeVisible();
    await expect(page.getByRole('note', { name: '查阅范围说明' })).toContainText(
        '未覆盖项目和来源详情见下方',
    );
    await expect(page.getByText('研究范围', { exact: true })).toBeVisible();
    await expect(
        page.getByText('孤立来源：未归入结论 · 查看原文引用', { exact: true }),
    ).toBeVisible();
    await expect(
        page.getByText('以下按报告保存顺序列出可访问证据；孤立来源不会被猜测归入某条结论。'),
    ).toBeVisible();
    expect(state.requests).toEqual([]);
});

test('目录原生锚点点击实际聚焦目标、设置 tabindex -1 与 6rem 避让', async ({ page }) => {
    const state: State = { baselineOnly: false, requests: [] };
    await openReport(page, state);
    const links = page.locator('.report-directory a');
    for (let i = 0; i < (await links.count()); i++) {
        const link = links.nth(i);
        const targetId = (await link.getAttribute('href'))!.slice(1);
        await link.focus();
        await link.press('Enter');
        const target = page.locator(`#${targetId}`);
        await expect(target).toBeFocused();
        await expect(target).toHaveAttribute('tabindex', '-1');
        const position = await target.evaluate((node) => ({
            margin: (node as HTMLElement).style.scrollMarginBlockStart,
            y: node.getBoundingClientRect().top,
            rootSize: parseFloat(getComputedStyle(document.documentElement).fontSize),
        }));
        expect(position.margin).toBe('6rem');
        expect(position.y).toBeGreaterThanOrEqual(position.rootSize * 6 - 1);
    }
    await expect(page).toHaveURL(fixturePath);
});

test('空 changes 但存在 baselineRunId 时目录仍显示变化与基线且不虚构变化', async ({ page }) => {
    const state: State = { baselineOnly: true, requests: [] };
    await openReport(page, state);
    await expect(page.getByRole('link', { name: '变化与基线', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '变化与基线', exact: true })).toBeVisible();
    await expect(page.getByText(baselineRunId, { exact: true })).toBeVisible();
    await expect(page.getByText('本报告没有提供逐项变化记录。')).toBeVisible();
});

test('Brief 与 Research 切换共享同一 DTO、claim 文本与保存引用，路由保持独立 fixture', async ({
    page,
}) => {
    const state: State = { baselineOnly: false, requests: [] };
    await openReport(page, state);
    const report = researchReport();
    const claims = async () =>
        page.locator('.claim').evaluateAll((nodes) =>
            nodes.map((node) => ({
                id: node.id,
                text: node.querySelector('.claim-text')?.textContent,
                confidence: node.querySelector('.confidence')?.textContent,
                citations: Array.from(node.querySelectorAll('blockquote')).map(
                    (quote) => quote.textContent,
                ),
            })),
        );
    const research = await claims();
    await page.evaluate(() => window.scovaResearchFixture.setView('brief'));
    await expect(article(page)).toHaveCount(0);
    expect(await claims()).toEqual(research);
    expect(await page.evaluate(() => window.scovaResearchFixture.getReport())).toEqual(report);
    await page.evaluate(() => window.scovaResearchFixture.setView('research'));
    await expect(article(page)).toBeVisible();
    expect(await claims()).toEqual(research);
    await expect(page).toHaveURL(fixturePath);
    expect(state.requests).toEqual([]);
});

test('无 changes 且无 baseline 仍可达变化结论；保存引用全文字面展示', async ({ page }) => {
    const state: State = { baselineOnly: false, requests: [] };
    await openReport(page, state);
    const report = researchReport();
    report.changes = [];
    const longQuote =
        '<script>window.researchExecuted = true</script>\n' + '来源原文完整保留😀。'.repeat(80);
    report.evidence[2]!.quote = longQuote;
    await page.evaluate((value) => window.scovaResearchFixture.setReport(value), report);
    await expect(page.getByRole('link', { name: '变化与基线', exact: true })).toBeVisible();
    const orphan = page.locator(`#evidence-${report.evidence[2]!.id} details`);
    await orphan.locator('summary').press('Enter');
    await expect(orphan.locator('blockquote')).toHaveText(longQuote);
    expect(await page.evaluate(() => 'researchExecuted' in window)).toBe(false);
    expect(state.requests).toEqual([]);
});

for (const [outcome, title] of [
    ['no_important_change', '本次范围内未发现重要变化'],
    ['baseline', '本次建立比较基线'],
    ['inconclusive', '变化结论仍不确定'],
] as const) {
    test(`空 changes/null baseline 的 ${outcome} 与 Brief 呈现完全一致`, async ({ page }) => {
        const state: State = { baselineOnly: false, requests: [] };
        await openReport(page, state);
        const report = researchReport();
        report.changes = [];
        report.outcome = outcome;
        report.coverage.completeness = 'complete';
        report.coverage.gaps = [];
        report.coverage.exhausted = [];
        report.limitations = [];
        await page.evaluate((value) => window.scovaResearchFixture.setReport(value), report);
        const link = page.getByRole('link', { name: '变化与基线', exact: true });
        await expect(link).toBeVisible();
        await link.press('Enter');
        await expect(page.locator('#report-changes-title')).toBeFocused();
        await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
        const research = await page.locator('.comparison-summary').innerText();
        await page.evaluate(() => window.scovaResearchFixture.setView('brief'));
        await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
        expect(await page.locator('.comparison-summary').innerText()).toBe(research);
        expect(await page.evaluate(() => window.scovaResearchFixture.getReport())).toEqual(report);
        expect(state.requests).toEqual([]);
    });
}

test('阅读正文使用 serif/sans 偏好，目录与工具保持 interface sans', async ({ page }) => {
    const state: State = { baselineOnly: false, requests: [] };
    await openReport(page, state);
    const serif = await page.evaluate(() => ({
        reading: getComputedStyle(document.querySelector('.claim-text')!).fontFamily,
        directory: getComputedStyle(document.querySelector('.report-directory')!).fontFamily,
    }));
    expect(serif.reading).not.toBe(serif.directory);
    await page.locator('#sample-family').selectOption('sans');
    await expect(article(page)).toBeVisible();
    const sans = await page
        .locator('.claim-text')
        .first()
        .evaluate((node) => getComputedStyle(node).fontFamily);
    expect(sans).toBe(serif.directory);
});

test('页面不自动请求外站，证据链接安全且不产生写请求', async ({ page }) => {
    const state: State = { baselineOnly: false, requests: [] };
    const external: string[] = [];
    page.on('request', (request) => {
        if (request.url().includes('example.test')) external.push(request.url());
    });
    await openReport(page, state);
    const details = page.locator('details.evidence').first();
    await details.locator('summary').click();
    const link = details.getByRole('link', { name: '打开原始来源（新窗口）' });
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(external).toEqual([]);
    expect(state.requests).toEqual([]);
});

test('来源附录在 320px 与 200% 文字下保留完整引用和连续中文行宽', async ({ page }) => {
    const state: State = { baselineOnly: false, requests: [] };
    await openReport(page, state);
    const report = researchReport();
    const raw = `研究资料保存引用应保持连续中文可读。${'原始片段与定位仍需完整保留。'.repeat(20)}\n<script>字面引用</script>\nhttps://example.test/${'saved-source-'.repeat(20)}`;
    report.evidence[0]!.quote = raw;
    await page.evaluate((value) => window.scovaResearchFixture.setReport(value), report);
    const citation = page.locator('.evidence-appendix .evidence-entry').first();
    await citation.locator('summary').click();
    const quote = citation.locator('blockquote');
    for (const width of [320, 360, 390, 768, 1024, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        for (const enlarged of [false, true]) {
            await page.evaluate((value) => {
                document.documentElement.style.fontSize = value ? '200%' : '';
            }, enlarged);
            await expect(quote).toHaveText(raw);
            expect(await quote.textContent()).toBe(raw);
            const geometry = await quote.evaluate((element) => {
                const style = getComputedStyle(element);
                const range = document.createRange();
                range.setStart(element.firstChild!, 0);
                range.setEnd(element.firstChild!, 4);
                const lines = [...range.getClientRects()].map((rect) => rect.top);
                return {
                    contentWidth:
                        (element.clientWidth -
                            parseFloat(style.paddingLeft) -
                            parseFloat(style.paddingRight)) /
                        parseFloat(style.fontSize),
                    firstFourCharactersShareLine: new Set(lines).size === 1,
                };
            });
            expect(geometry.contentWidth).toBeGreaterThanOrEqual(4);
            expect(geometry.firstFourCharactersShareLine).toBe(true);
            await expect(page.locator('body')).toHaveJSProperty('scrollWidth', width);
        }
    }
    await expect(citation.locator('script,img,iframe')).toHaveCount(0);
    expect(await page.evaluate(() => window.scovaResearchFixture.getReport())).toEqual(report);
    expect(state.requests).toEqual([]);
});

for (const scheme of ['light', 'dark'] as const) {
    for (const width of [320, 360, 390, 768, 1024, 1440]) {
        test(`ResearchReport ${scheme} ${width}px 200% 根字号无页面横溢且 sticky 工具可达`, async ({
            page,
        }) => {
            const state: State = { baselineOnly: false, requests: [] };
            await page.setViewportSize({ width, height: 900 });
            await openReport(page, state);
            await page.locator('#sample-scheme').selectOption(scheme);
            await page.evaluate(() => {
                document.documentElement.style.fontSize = '200%';
            });
            await expect(page.locator('body')).toHaveJSProperty('scrollWidth', width);
            await expect(page.getByRole('link', { name: '报告概述', exact: true })).toHaveCSS(
                'cursor',
                'pointer',
            );
            await page.getByRole('link', { name: '来源与保存引用', exact: true }).focus();
            await expect(
                page.getByRole('link', { name: '来源与保存引用', exact: true }),
            ).toBeFocused();
            await expect(
                page.getByRole('heading', { name: '来源与保存引用', exact: true }),
            ).toBeVisible();
        });
    }
}
