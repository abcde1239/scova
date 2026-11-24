import { logoutFromAccount, expectAccountReady } from './support/account-menu.ts';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import {
    classifyReportDelivery,
    serializeReportJson,
    type Report,
    type ReportJsonDocument,
} from '@scova/models';
import { reportFormatSample } from '../../apps/web/tests/fixtures/reports/report-format-sample.ts';

// Local HTTP samples exercise the real Web bundle; database delivery is verified separately.
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const reportPath = `/reports/${id(1)}`;
const account = (n = 100) => ({
    user: {
        id: id(n),
        email: 'reader@example.test',
        preferences: {
            defaultTimezone: 'UTC',
            notificationPreference: { mode: 'summary', runIssues: true },
        },
        createdAt: '2026-10-31T00:00:00Z',
    },
    csrfToken: 'report-test-only',
});
const failure = (code = 'TEST_FAILURE') => ({ code, message: 'sample', requestId: 'sample' });
function report() {
    return {
        id: id(1),
        taskId: id(2),
        runId: id(3),
        taskVersionId: id(4),
        baselineRunId: null,
        schemaVersion: 1,
        title: '开放研究资料：可追溯的基础简报',
        summary: '已保存来源描述了研究范围；以下分别列出来源事实、推断与尚未解决的缺口。',
        format: 'brief',
        mode: 'demo',
        outcome: 'inconclusive',
        coverage: {
            completeness: 'partial',
            searchedQueries: ['开放研究资料 最新进展'],
            gaps: ['一项来源不可达，尚未交叉核验'],
            exhausted: ['pages'],
        },
        limitations: ['仅覆盖本次保存的来源片段'],
        claims: [
            {
                id: id(10),
                kind: 'fact',
                text: '来源原文说明研究资料按批次公开。',
                confidenceLabel: '逐字引用，仅代表该来源的陈述',
                evidenceIds: [id(20)],
            },
            {
                id: id(11),
                kind: 'inference',
                text: '后续批次可能补充更多证据，仍需再次查阅。',
                confidenceLabel: 'Agent 推断，未获完整验证',
                evidenceIds: [id(20)],
            },
            {
                id: id(12),
                kind: 'conflict',
                text: '两个来源的范围描述存在差异，尚不能解释原因。',
                confidenceLabel: '冲突尚未解决',
                evidenceIds: [id(20)],
            },
            {
                id: id(13),
                kind: 'insufficient',
                text: '缺少可独立交叉核验的来源，不能认定没有重要变化。',
                confidenceLabel: '证据不足',
                evidenceIds: [],
            },
        ],
        evidence: [
            {
                id: id(20),
                sourceId: id(21),
                snapshotId: id(22),
                title: '研究资料说明',
                url: 'https://example.test/source',
                quote: '<script>window.sourceExecuted = true</script> 研究资料按批次公开。',
                location: '第 2 段，第 10–28 字符',
                observedAt: '2026-10-31T01:00:00Z',
                snapshot: {
                    originalUrl: 'https://example.test/original',
                    fetchedUrl: 'https://example.test/source',
                    canonicalUrl: 'https://example.test/source',
                    contentHash: 'a'.repeat(64),
                    extractorVersion: 'reader-v1',
                    publishedAt: null,
                    truncated: true,
                    selector: {
                        type: 'text_offset',
                        start: 10,
                        end: 28,
                        extractorVersion: 'reader-v1',
                    },
                },
            },
        ],
        changes: [],
        publishedAt: '2026-10-31T02:00:00Z',
    };
}
async function samples(page: Page) {
    await page.route('**/api/v1/me', (route) => route.fulfill({ json: account() }));
    await page.route('**/api/v1/me/agent-providers', (route) =>
        route.fulfill({ json: { items: [], systemConfigured: true, storageReady: true } }),
    );
    await page.route(`**/api/v1/reports/${id(1)}`, (route) => route.fulfill({ json: report() }));
}
for (const width of [320, 1440]) {
    test(`下载报告 Markdown 保存实际 UTF-8 文件 / ${width}`, async ({ page }) => {
        await page.setViewportSize({ width, height: 850 });
        await samples(page);
        const markdown = '# 已交付报告\n\n仅包含已保存的结论和引用。\n';
        const filename = `scova-report-${id(1)}.md`;
        const routePath = `**/api/v1${reportPath}/exports/markdown`;
        await page.route(routePath, (route) =>
            route.fulfill({
                json: {
                    id: id(60),
                    reportId: id(1),
                    filename,
                    markdown,
                    byteLength: Buffer.byteLength(markdown),
                    sha256: 'a'.repeat(64),
                    expiresAt: '2026-11-19T00:00:00Z',
                },
            }),
        );
        await page.goto(reportPath);
        await readOnMobile(page);
        await page.getByRole('button', { name: '导出成果' }).click();
        const request = page.waitForRequest((req) => req.url().endsWith('/exports/markdown'));
        const download = page.waitForEvent('download');
        await page.getByRole('button', { name: '导出 Markdown' }).click();
        expect((await request).method()).toBe('POST');
        expect((await request).headers()['x-csrf-token']).toBe(account().csrfToken);
        const saved = await download;
        expect(saved.suggestedFilename()).toBe(filename);
        expect(await saved.failure()).toBeNull();
        expect(await readFile(await saved.path(), 'utf8')).toBe(markdown);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
            width,
        );
    });
}

for (const width of [320, 1440]) {
    test(`键盘重试后下载 JSON，校验 MIME 与实际文件 / ${width}`, async ({ page }) => {
        await page.setViewportSize({ width, height: 850 });
        await samples(page);
        await page.addInitScript(() => {
            const createObjectURL = URL.createObjectURL.bind(URL);
            URL.createObjectURL = (payload) => {
                if (payload instanceof Blob)
                    document.documentElement.dataset.exportMime = payload.type;
                return createObjectURL(payload);
            };
        });
        const savedReport = report() as Report;
        const { title, summary, publishedAt, format, mode, outcome, limitations, changes } =
            savedReport;
        const reportDocument: ReportJsonDocument = {
            schemaVersion: 1,
            reportId: savedReport.id,
            title,
            summary,
            publishedAt,
            format,
            mode,
            outcome,
            coverage: {
                completeness: savedReport.coverage.completeness,
                gaps: savedReport.coverage.gaps,
            },
            limitations,
            changes,
            conclusions: savedReport.claims,
            citations: savedReport.evidence.map(
                ({ id, title, url, location, observedAt, quote }) => ({
                    id,
                    title,
                    url,
                    location,
                    observedAt,
                    quote,
                    quoteTruncated: false,
                }),
            ),
        };
        const expected = serializeReportJson(reportDocument);
        const filename = `scova-report-${savedReport.id}.json`;
        let attempts = 0;
        await page.route(`**/api/v1${reportPath}/exports/json`, (route) => {
            attempts++;
            if (attempts === 1) return route.fulfill({ status: 503, json: failure() });
            if (attempts === 2)
                return route.fulfill({ json: { document: reportDocument, filename } });
            return route.fulfill({
                json: {
                    id: id(61),
                    reportId: savedReport.id,
                    filename,
                    document: reportDocument,
                    byteLength: Buffer.byteLength(expected),
                    sha256: createHash('sha256').update(expected).digest('hex'),
                    expiresAt: '2026-11-19T00:00:00Z',
                },
            });
        });
        await page.goto(reportPath);
        await readOnMobile(page);
        await page.getByRole('button', { name: '导出成果' }).click();
        const button = page.getByRole('button', { name: '导出 JSON' });
        const markdown = page.getByRole('button', { name: '导出 Markdown' });
        await expect(markdown).toBeEnabled();
        const alert = page.getByRole('alert').filter({ hasText: '暂时无法导出报告，请重试。' });
        await button.press('Enter');
        await expect(alert).toBeVisible();
        await button.press('Enter');
        await expect.poll(() => attempts).toBe(2);
        await expect(alert).toBeVisible();
        const request = page.waitForRequest((req) => req.url().endsWith('/exports/json'));
        const download = page.waitForEvent('download');
        await button.press('Enter');
        expect((await request).method()).toBe('POST');
        expect((await request).headers()['x-csrf-token']).toBe(account().csrfToken);
        const result = await download;
        expect(attempts).toBe(3);
        expect(result.suggestedFilename()).toBe(filename);
        expect(await result.failure()).toBeNull();
        const file = await readFile(await result.path(), 'utf8');
        expect(file).toBe(expected);
        expect(JSON.parse(file)).toEqual(reportDocument);
        await expect(page.locator('html')).toHaveAttribute('data-export-mime', 'application/json');
        await expect(alert).toHaveCount(0);
        expect(
            await page.evaluate(() => window.document.documentElement.scrollWidth),
        ).toBeLessThanOrEqual(width);
    });
}

test('报告 Markdown 导出失败可感知，可再次提交', async ({ page }) => {
    await samples(page);
    let attempts = 0;
    await page.route(`**/api/v1${reportPath}/exports/markdown`, (route) => {
        attempts++;
        return route.fulfill({
            status: 422,
            json: { ...failure('REPORT_EXPORT_TOO_LARGE'), message: '报告超过 256 KiB 导出上限' },
        });
    });
    await page.goto(reportPath);
    await readOnMobile(page);
    await page.getByRole('button', { name: '导出成果' }).click();
    const button = page.getByRole('button', { name: '导出 Markdown' });
    await button.click();
    await expect(
        page.getByRole('alert').filter({ hasText: '报告超过 256 KiB 导出上限' }),
    ).toBeVisible();
    await button.click();
    await expect.poll(() => attempts).toBe(2);
});

async function readOnMobile(page: Page) {
    if ((page.viewportSize()?.width ?? 1440) < 1152)
        await page.getByRole('button', { name: '成果', exact: true }).click();
}
const article = (page: Page) =>
    page.getByRole('article', { name: '开放研究资料：可追溯的基础简报' });

for (const width of [320, 1440]) {
    for (const status of ['answered', 'partial', 'sources_only'] as const) {
        test(`交付分类与来源日期：${status}/${width}`, async ({ page }, info) => {
            const saved = formatReport();
            const selectedIndex = status === 'answered' ? 0 : status === 'partial' ? 1 : -1;
            saved.coverage.reportValue = {
                version: 1,
                questions: ['核心问题', '补充问题'].map((text, i) => ({
                    id: `q${i}`,
                    text,
                    priority: i === 0 ? 'core' : 'supporting',
                    status: i === selectedIndex ? 'provisional' : 'unresolved',
                    claimIndexes: i === selectedIndex ? [i] : [],
                    gap: i === selectedIndex ? '时间未完全确认' : '尚无直接回答',
                })),
                selections: saved.claims.map((_, index) => ({
                    claimIndex: index,
                    questionIds: index === selectedIndex ? [`q${index}`] : [],
                    placement: index === selectedIndex ? 'main' : 'reference',
                    reason: '仅按材料基础选择答案',
                    basis: index === selectedIndex ? 'model_assessment' : 'unassessed',
                    timeScope: 'unknown',
                    ...(index === selectedIndex
                        ? {
                              assessment: {
                                  relevance: 'direct' as const,
                                  support: 'partial' as const,
                                  role: 'answer' as const,
                                  sourceRelation: 'unknown' as const,
                                  reason: '条件内回答',
                                  conditions: '适用于本次保存版本',
                                  gap: '',
                              },
                          }
                        : {}),
                })),
            };
            saved.coverage.delivery = classifyReportDelivery(
                saved.coverage.reportValue,
                saved.claims,
            );
            expect(saved.coverage.delivery.status).toBe(status);
            saved.evidence[0].snapshot!.sourceDates = {
                published: {
                    status: 'known',
                    value: '2026-11-08',
                    instant: null,
                    precision: 'day',
                },
                modified: {
                    status: 'known',
                    value: '2026-11-09T02:30:00.000Z',
                    instant: '2026-11-09T02:30:00.000Z',
                    precision: 'instant',
                },
            };
            await page.setViewportSize({ width, height: 900 });
            const state = await formatSamples(page, saved);
            await page.goto(reportPath);
            await readOnMobile(page);
            await expect(page.locator('.report-delivery')).toContainText(
                { answered: '核心问题已回答', partial: '部分交付', sources_only: '仅保存来源' }[
                    status
                ],
            );
            await expect(page.locator('.answer-gap-overview')).toBeVisible();
            await expect(page.locator('.answer-gaps')).toBeHidden();
            const coverageLink = page.getByRole('link', { name: '查看来源覆盖说明', exact: true });
            await coverageLink.focus();
            await coverageLink.press('Enter');
            await expect(page.locator('.coverage > details > summary')).toBeFocused();
            await expect(page.locator('.answer-gaps')).toBeVisible();
            const evidence = page.locator(`#evidence-${saved.evidence[0].id}`);
            await evidence
                .locator('xpath=ancestor::details[contains(@class, "evidence-source-group")]')
                .locator(':scope > summary')
                .click();
            await evidence.locator('.citation-metadata > summary').click();
            await expect(evidence).toContainText('2026-11-08（仅日期，时区未声明）');
            await expect(evidence).toContainText('来源更新时间');
            await expect(evidence).toContainText('2026-11-09T02:30:00.000Z');
            await page.evaluate(() => {
                document.documentElement.style.fontSize = '200%';
            });
            expect(
                await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
            ).toBe(true);
            await page.screenshot({
                path: info.outputPath(`delivery-${status}-${width}.png`),
                fullPage: true,
            });
            expect(state.unexpected).toEqual([]);
        });
    }
}

test('宽屏左侧对话右侧成果、窄屏对话在前，基线在成果内且保留执行入口', async ({ page }) => {
    await samples(page);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(reportPath);
    await readOnMobile(page);
    await expect(article(page)).toBeVisible();
    const main = await page.getByRole('main').boundingBox();
    const sidebar = await page.getByRole('banner').boundingBox();
    expect(main!.x).toBeGreaterThanOrEqual(sidebar!.x + sidebar!.width);
    expect(main!.width).toBeCloseTo(1440 - sidebar!.width, 0);
    const content = await page.locator('.report-content').boundingBox();
    const companion = await page.locator('.report-companion').boundingBox();
    expect(content!.x).toBeGreaterThanOrEqual(companion!.x + companion!.width);
    expect(Math.abs(companion!.y - content!.y)).toBeLessThan(1);
    expect(content!.width).toBeGreaterThan(companion!.width);
    const baseline = await page.locator('.report-changes').boundingBox();
    const reportDocument = await page.locator('.artifact-document').boundingBox();
    expect(baseline!.x).toBeGreaterThan(content!.x);
    expect(baseline!.x + baseline!.width).toBeLessThan(content!.x + content!.width);
    expect(reportDocument!.y + reportDocument!.height).toBeLessThanOrEqual(baseline!.y);
    await expect(page.locator('.artifact-document .report-changes')).toHaveCount(0);
    await expect(page.locator('.report-content .report-changes')).toBeVisible();
    await expect(page.locator('#report-conversation')).toBeVisible();
    await page.getByRole('button', { name: '更多成果操作' }).click();
    await expect(page.getByRole('link', { name: '执行详情', exact: true })).toHaveAttribute(
        'href',
        `/runs/${id(3)}`,
    );
    for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
            true,
        );
        const tools = page.getByRole('navigation', { name: '报告内容导航' });
        await expect(page.locator('.report-content')).toBeHidden();
        await expect(page.locator('.report-companion')).toBeVisible();
        await page.getByRole('button', { name: '成果', exact: true }).click();
        await expect(page.locator('.report-content')).toBeVisible();
        await expect(page.locator('.report-companion')).toBeHidden();
        const jump = tools.getByRole('link', { name: '正文', exact: true });
        expect((await jump.boundingBox())!.height).toBeGreaterThanOrEqual(36);
        await jump.focus();
        await jump.press('Enter');
        await expect(page.locator('#report-title')).toBeFocused();
        await page.getByRole('button', { name: '返回对话', exact: true }).click();
        const section = page.locator('.bookmarks-tool');
        await expect(section.locator('.report-bookmarks')).toBeHidden();
        expect((await section.boundingBox())!.width).toBeLessThanOrEqual(width);
    }
});

test('成果关闭恢复与完整阅读保留布局、问题和笔记草稿，切换不发起研究请求', async ({ page }) => {
    const state = await formatSamples(page, multiFormatReport());
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(reportPath);
    await readOnMobile(page);
    const question = page.getByLabel('问题', { exact: true });
    await page.locator('[aria-label="提问建议"]').getByRole('button').first().click();
    await expect(question).not.toHaveValue('');
    await expect(question).toBeFocused();
    await question.fill('阅读模式切换时保留的问题');
    await page.locator('.secondary-report-tools > summary').click();
    await page.locator('.notes-tool > summary').click();
    await page.getByRole('button', { name: '新建笔记', exact: true }).click();
    const draft = page.getByLabel('本地笔记正文', { exact: true });
    await draft.fill('阅读模式切换时保留的笔记');
    for (const input of [question, draft])
        expect(await input.evaluate((element) => getComputedStyle(element).resize)).toBe('none');
    const editor = await page.locator('.note-editor').elementHandle();
    const questions = await page.locator('.questions').elementHandle();
    const panel = page.locator('#report-artifact');
    const card = page.locator('.report-artifact-card');
    const close = page.getByRole('button', { name: '关闭成果预览', exact: true });
    const selector = generatedFormat(page, 'comparison');
    await selector.click();
    const citation = page.locator('.evidence-appendix .evidence-source-group').first();
    await citation.locator(':scope > summary').click();
    await expect(citation.locator('blockquote').first()).toBeVisible();
    const reportDocument = await page.locator('.artifact-document').elementHandle();
    await close.click();
    await expect(panel).toBeHidden();
    await expect(card).toBeFocused();
    await expect(card).toHaveAttribute('aria-expanded', 'false');
    await expect(question).toHaveValue('阅读模式切换时保留的问题');
    await card.press('Enter');
    await expect(panel).toBeVisible();
    await expect(close).toBeFocused();
    await expect(card).toHaveAttribute('aria-expanded', 'true');
    await expect(selector).toHaveAttribute('aria-pressed', 'true');
    await expect(citation.locator('blockquote').first()).toBeVisible();
    expect(await reportDocument!.evaluate((element) => element.isConnected)).toBe(true);
    await close.focus();
    await close.press('Escape');
    await expect(panel).toBeHidden();
    await expect(card).toBeFocused();
    await card.click();
    const focus = page.getByRole('button', { name: '完整阅读', exact: true });
    await focus.click();
    await expect(page.locator('.report-companion')).toBeHidden();
    await expect(page.locator('.report-changes')).toBeVisible();
    await expect(panel).toBeVisible();
    await expect(page.locator('#report-title')).toBeFocused();
    await expect(citation.locator('blockquote').first()).toBeVisible();
    await page.getByRole('button', { name: '返回对话', exact: true }).click();
    await expect(question).toBeFocused();
    await expect(question).toHaveValue('阅读模式切换时保留的问题');
    await expect(draft).toHaveValue('阅读模式切换时保留的笔记');
    expect(await editor!.evaluate((element) => element.isConnected)).toBe(true);
    expect(await questions!.evaluate((element) => element.isConnected)).toBe(true);
    await page.setViewportSize({ width: 320, height: 844 });
    await expect(panel).toBeHidden();
    await card.click();
    await expect(page.locator('#report-title')).toBeFocused();
    await expect(question).toBeHidden();
    await page.getByRole('button', { name: '返回对话', exact: true }).click();
    await expect(question).toBeFocused();
    await expect(draft).toHaveValue('阅读模式切换时保留的笔记');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
    );
    expect(state.calls.filter((entry) => entry.method !== 'GET')).toEqual([]);
    expect(state.unexpected).toEqual([]);
});

test.beforeAll(async ({ browser }) => {
    console.log(`Browser: Chromium ${browser.version()}`);
});

test('报告默认只展开问答，辅助工具按需打开且折叠保留笔记草稿', async ({ page }) => {
    const state = await formatSamples(page);
    await page.goto(reportPath);
    await readOnMobile(page);
    await expect(page.getByLabel('问题', { exact: true })).toBeVisible();
    const tools = page.locator('.secondary-report-tools');
    await expect(tools).not.toHaveAttribute('open', '');
    await tools.locator(':scope > summary').click();
    for (const tool of ['notes', 'bookmarks', 'feedback']) {
        const section = page.locator(`.${tool}-tool`);
        await expect(section).toBeVisible();
        expect(await section.evaluate((element) => (element as HTMLDetailsElement).open)).toBe(
            false,
        );
    }
    await expect(page.locator('.report-companion select:visible')).toHaveCount(0);
    const summary = page.locator('.notes-tool > summary');
    await summary.focus();
    await summary.press('Enter');
    await page.getByRole('button', { name: '新建笔记', exact: true }).click();
    const draft = page.getByLabel('本地笔记正文', { exact: true });
    await draft.fill('折叠工具仍保留的本地稿');
    const editor = await page.locator('.note-editor').elementHandle();
    await summary.click();
    await expect(draft).toBeHidden();
    await summary.press('Space');
    await expect(draft).toHaveValue('折叠工具仍保留的本地稿');
    expect(await editor!.evaluate((element) => element.isConnected)).toBe(true);
    expect(state.calls.filter((entry) => entry.method !== 'GET')).toEqual([]);
    expect(state.unexpected).toEqual([]);
});

test('本地 HTTP 样本：正文优先且保留范围说明、四类结论、保存引用与安全原始链接', async ({
    page,
}) => {
    await samples(page);
    const sourceRequests: string[] = [];
    page.on('request', (request) => {
        if (request.url().includes('example.test')) sourceRequests.push(request.url());
    });
    await page.goto(reportPath);
    await readOnMobile(page);
    await expect(article(page)).toBeVisible();
    await expect(page.getByRole('note', { name: '查阅范围说明' })).toContainText(
        '查看来源覆盖说明',
    );
    expect(
        await page.evaluate(
            () =>
                !!(
                    document
                        .querySelector('[aria-label="查阅范围说明"]')!
                        .compareDocumentPosition(document.getElementById('summary-title')!) &
                    Node.DOCUMENT_POSITION_PRECEDING
                ),
        ),
    ).toBe(true);
    await expect(page.getByText('演示报告：来自演示数据，不代表真实查阅成果。')).toBeVisible();
    for (const name of ['来源事实', 'Agent 推断', '冲突证据', '证据不足'])
        await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
    await expect(page.getByText(id(4), { exact: true })).toBeHidden();
    await page.getByRole('link', { name: '查看来源覆盖说明' }).click();
    await expect(page.getByText(id(4), { exact: true })).toBeVisible();
    await expect(page.locator('.coverage summary')).toBeFocused();
    const citation = page.locator('.evidence-source-group').first();
    const toggle = citation.locator(':scope > summary');
    await toggle.focus();
    await toggle.press('Enter');
    await expect(citation.locator('blockquote')).toHaveText(report().evidence[0]!.quote);
    await citation.locator('.citation-metadata > summary').click();
    await expect(citation).toContainText('第 2 段，第 10–28 字符');
    await expect(citation).toContainText('2026-10-31T01:00:00Z');
    await expect(citation).toContainText('采集正文曾截断，引用仅代表已保存片段。');
    const link = citation.getByRole('link', { name: '打开网页（新窗口）' });
    await expect(link).toHaveCount(1);
    await expect(link).toHaveAttribute('href', report().evidence[0]!.snapshot.canonicalUrl);
    await toggle.focus();
    await toggle.press('Tab');
    await expect(link).toBeFocused();
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(link).toHaveAttribute('target', '_blank');
    expect(await page.evaluate(() => 'sourceExecuted' in window)).toBe(false);
    await toggle.press('Space');
    await expect(citation.locator('blockquote')).toBeHidden();
    expect(sourceRequests).toEqual([]);
    await page.reload();
    await expect(article(page)).toBeVisible();
});

for (const status of [403, 404, 409]) {
    test(`本地 HTTP 样本：HTTP ${status} 不泄漏内容与可重试状态`, async ({ page }) => {
        await samples(page);
        let failed = true;
        await page.route(`**/api/v1/reports/${id(1)}`, (route) =>
            failed
                ? route.fulfill({
                      status,
                      json: failure(status === 409 ? 'INVALID_REPORT_EVIDENCE' : 'TEST_FAILURE'),
                  })
                : route.fallback(),
        );
        await page.goto(reportPath);
        await readOnMobile(page);
        await expect(page.getByRole('status')).toContainText(
            status === 403 ? '无权' : status === 404 ? '不存在' : '证据校验未通过',
        );
        await expect(page.locator('article')).toHaveCount(0);
        const retry = page.getByRole('button', { name: '重试', exact: true });
        if (status === 409) {
            failed = false;
            await retry.focus();
            await retry.press('Enter');
            await expect(article(page)).toBeVisible();
            await expect(page.locator('#report-title')).toBeFocused();
        } else await expect(retry).toHaveCount(0);
    });
}

test('本地 HTTP 样本：无效 UUID、非法引用及非简报布局边界', async ({ page }) => {
    await samples(page);
    let reads = 0;
    await page.route('**/api/v1/reports/**', (route) => {
        reads++;
        return route.fallback();
    });
    await page.goto('/reports/not-a-uuid');
    await expect(page.getByRole('status')).toContainText('报告地址无效');
    expect(reads).toBe(0);
    const invalid = report();
    invalid.evidence[0]!.url = 'javascript:alert(1)';
    await page.route(`**/api/v1/reports/${id(1)}`, (route) => route.fulfill({ json: invalid }));
    await page.goto(reportPath);
    await readOnMobile(page);
    await expect(page.getByRole('status')).toContainText('报告结构或引用不完整');
    await expect(page.locator('article')).toHaveCount(0);
    const other = report();
    other.format = 'comparison';
    other.mode = 'live';
    other.coverage.completeness = 'complete';
    other.limitations = [];
    other.coverage.gaps = [];
    other.coverage.exhausted = [];
    await page.route(`**/api/v1/reports/${id(1)}`, (route) => route.fulfill({ json: other }));
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await expect(article(page)).toBeVisible();
    await expect(
        page.getByText('当前按基础简报展示结构化结论与引用；尚不提供原报告格式的专属布局。'),
    ).toHaveCount(0);
    await expect(page.locator('.report-comparison')).toBeVisible();
    await expect(page.getByLabel('报告形式', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: '已生成成果', exact: true })).toHaveCount(0);
    await page.locator('.coverage summary').press('Enter');
    await expect(page.getByText('已完成本次计划范围内的查阅。')).toBeVisible();
    await expect(page.getByRole('note', { name: '查阅范围说明' })).toHaveCount(0);
});

test('本地 HTTP 样本：切换账号后迟到旧请求不能恢复旧内容', async ({ page }) => {
    await samples(page);
    let switched = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    let reads = 0;
    await page.route('**/api/v1/me', (route) =>
        route.fulfill({ json: account(switched ? 101 : 100) }),
    );
    await page.route('**/api/v1/auth/logout', (route) => route.fulfill({ status: 204 }));
    await page.route('**/api/v1/auth/login', (route) => {
        switched = true;
        return route.fulfill({ json: account(101) });
    });
    await page.route(`**/api/v1/reports/${id(1)}`, async (route) => {
        if (reads++ === 0) {
            await gate;
            await route.fulfill({ status: 401, json: failure() });
        } else await route.fulfill({ status: 404, json: failure() });
    });
    await page.goto(reportPath, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('status')).toContainText('正在读取报告');
    await logoutFromAccount(page);
    await page.getByLabel('邮箱', { exact: true }).fill('reader@example.test');
    await page.getByLabel('密码', { exact: true }).fill('local-only-password');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${reportPath}$`));
    release();
    await expect(page.getByRole('status')).toContainText('报告不存在或当前账号无法访问');
    await expectAccountReady(page);
    await expect(page.locator('article')).toHaveCount(0);
});

test('本地 HTTP 样本：断网可键盘重试，已展开报告退出换号后无残留', async ({ page }) => {
    await samples(page);
    let offline = true;
    let switched = false;
    await page.route(`**/api/v1/reports/${id(1)}`, (route) =>
        offline
            ? route.abort('internetdisconnected')
            : switched
              ? route.fulfill({ status: 404, json: failure() })
              : route.fallback(),
    );
    await page.route('**/api/v1/auth/logout', (route) => route.fulfill({ status: 204 }));
    await page.route('**/api/v1/auth/login', (route) => {
        switched = true;
        return route.fulfill({ json: account(101) });
    });
    await page.goto(reportPath);
    await readOnMobile(page);
    await expect(page.getByRole('status')).toContainText('报告暂时无法读取');
    offline = false;
    await page.getByRole('button', { name: '重试', exact: true }).press('Enter');
    await expect(article(page)).toBeVisible();
    await page.locator('.evidence-source-group > summary').first().click();
    await expect(page.locator('blockquote').first()).toBeVisible();
    await expect(page.getByLabel('报告形式', { exact: true })).toHaveCount(0);
    await expect(page.locator('.report-brief')).toBeVisible();
    await logoutFromAccount(page);
    await expect(page.locator('.report-frame, #report-artifact blockquote')).toHaveCount(0);
    await expect(page.getByLabel('报告形式', { exact: true })).toHaveCount(0);
    await page.getByLabel('邮箱', { exact: true }).fill('reader@example.test');
    await page.getByLabel('密码', { exact: true }).fill('local-only-password');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('报告不存在或当前账号无法访问');
    await expect(page.locator('.report-frame, #report-artifact blockquote')).toHaveCount(0);
    await expect(page.getByLabel('报告形式', { exact: true })).toHaveCount(0);
    await expectAccountReady(page);
});

for (const width of [320, 390, 768, 1024, 1280, 1440]) {
    test(`本地 HTTP 样本：报告 ${width} 宽度与 200% 根文字`, async ({ page }, testInfo) => {
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await samples(page);
        await page.setViewportSize({ width, height: 1000 });
        await page.goto(reportPath);
        await readOnMobile(page);
        await expect(article(page)).toBeVisible();
        await page.locator('.evidence-source-group > summary').first().click();
        await page.evaluate(() => document.fonts.ready);
        for (const enlarged of [false, true]) {
            if (enlarged)
                await page.evaluate(() => {
                    document.documentElement.style.fontSize = '200%';
                });
            expect(
                await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            ).toBe(true);
            const title = page.locator('#report-title');
            expect(
                await title.evaluate((element) => getComputedStyle(element).fontFamily),
            ).toContain('Noto Serif SC');
            await page.evaluate(() => window.scrollTo(0, 0));
            await testInfo.attach(`report-${width}${enlarged ? '-text-200' : ''}`, {
                body: await page.screenshot({
                    path: testInfo.outputPath(`report-${width}${enlarged ? '-text-200' : ''}.png`),
                    fullPage: true,
                }),
                contentType: 'image/png',
            });
        }
        expect(errors).toEqual([]);
    });
}

const formats = [
    ['brief', '.report-brief'],
    ['list', '.report-topic-list'],
    ['comparison', '.report-comparison'],
    ['research_report', '.research-report'],
] as const;
const claimKinds = ['fact', 'inference', 'conflict', 'insufficient'] as const;

function questionReport(): Report {
    const saved = formatReport();
    saved.coverage.reportValue = {
        version: 1,
        questions: [
            {
                id: 'q0',
                text: '资料有哪些主要发现？',
                priority: 'core',
                status: 'provisional',
                claimIndexes: [0, 1],
                gap: '',
            },
            {
                id: 'q1',
                text: '后续有哪些值得关注的内容？',
                priority: 'supporting',
                status: 'provisional',
                claimIndexes: [4],
                gap: '',
            },
        ],
        selections: saved.claims.map((_, index) => ({
            claimIndex: index,
            questionIds: index === 4 ? ['q1'] : index < 2 ? ['q0'] : [],
            placement: index === 2 || index === 3 ? 'reference' : 'main',
            reason: '按问题保留材料',
            basis: 'model_assessment',
            timeScope: 'unknown',
            assessment: {
                relevance: 'direct',
                support: 'partial',
                role: 'answer',
                sourceRelation: 'unknown',
                reason: '对应保存资料',
                conditions: '仅限当前保存版本',
                gap: '',
            },
        })),
    };
    return saved;
}

for (const width of [320, 390, 1024, 1440]) {
    test(`历史问题型交付物兼容 ${width}：不伪造对象结构、保留研究章节与基线`, async ({
        page,
    }, info) => {
        test.setTimeout(90_000);
        const saved = multiFormatReport(questionReport());
        const state = await formatSamples(page, saved);
        await page.setViewportSize({ width, height: 1000 });
        await page.goto(reportPath);
        await readOnMobile(page);
        for (const dark of [false, true]) {
            await page.emulateMedia({ colorScheme: dark ? 'dark' : 'light' });
            await expect(page.locator('.scova-theme--dark')).toHaveCount(dark ? 1 : 0);
            for (const enlarged of [false, true]) {
                await page.evaluate(
                    (value) => (document.documentElement.style.fontSize = value ? '200%' : ''),
                    enlarged,
                );
                for (const [format] of formats) {
                    await generatedFormat(page, format).click();
                    const answers = page.locator(`.answers--${format}`);
                    await expect(answers).toBeVisible();
                    await expect(answers.locator('.answer')).toHaveCount(2);
                    await expect(answers).toContainText('仅限当前保存版本');
                    await expect(
                        page.locator(
                            '.artifact-document .report-changes, .artifact-document .comparison-context',
                        ),
                    ).toHaveCount(0);
                    await expect(page.locator('.report-changes')).toBeVisible();
                    await expect(answers.locator('table')).toHaveCount(0);
                    if (format === 'comparison' || format === 'list')
                        await expect(answers.locator('.legacy-notice')).toContainText(
                            '未保存对象与字段结构',
                        );
                    if (format === 'list') {
                        await expect(answers.locator('.answer-number')).toHaveText(['01', '02']);
                        expect(
                            await answers
                                .locator('.answer')
                                .first()
                                .evaluate((element) => getComputedStyle(element).borderTopStyle),
                        ).toBe('solid');
                    }
                    await expect(page.locator('.report-directory')).toHaveCount(
                        format === 'research_report' ? 1 : 0,
                    );
                    await expect(answers.locator('blockquote')).toHaveCount(0);
                    const citations = page.locator('.evidence-appendix .evidence-source-group');
                    for (let i = 0; i < (await citations.count()); i++) {
                        const citation = citations.nth(i);
                        if ((await citation.getAttribute('open')) === null)
                            await citation.locator(':scope > summary').click();
                        const widths = await citation
                            .locator('blockquote')
                            .evaluateAll((elements) =>
                                elements.map((element) => {
                                    const style = getComputedStyle(element);
                                    return (
                                        (element.clientWidth -
                                            parseFloat(style.paddingLeft) -
                                            parseFloat(style.paddingRight)) /
                                        parseFloat(style.fontSize)
                                    );
                                }),
                            );
                        expect(widths.length).toBeGreaterThan(0);
                        expect(widths.every((width) => width >= 4)).toBe(true);
                    }
                    expect(
                        await page.evaluate(
                            () => document.documentElement.scrollWidth <= innerWidth,
                        ),
                    ).toBe(true);
                    const ids = await page
                        .locator('[id]')
                        .evaluateAll((elements) => elements.map((element) => element.id));
                    expect(new Set(ids).size).toBe(ids.length);
                    if (!dark && !enlarged)
                        await page.screenshot({
                            path: info.outputPath(`${format}-${width}.png`),
                            fullPage: true,
                        });
                }
            }
        }
        expect(state.calls.filter((entry) => entry.method !== 'GET')).toEqual([]);
        expect(state.unexpected).toEqual([]);
        expect(state.report).toEqual(saved);
    });
}

function formatReport(): Report {
    const value = report() as Report;
    value.baselineRunId = id(5);
    value.claims.push({ ...value.claims[1]!, id: id(14) });
    // These sources are intentionally absent from every claim; one is change-only, one isolated.
    for (const n of [30, 40])
        value.evidence.push({
            ...structuredClone(value.evidence[0]!),
            id: id(n),
            sourceId: n === 30 ? id(21) : id(n + 1),
            snapshotId: id(n + 2),
            title: `来源 ${n}`,
            quote: `完整保存原文 ${n}\n  第二段保留空格与换行。`,
        });
    value.changes = (
        [
            'baseline',
            'new',
            'duplicate',
            'duplicate_candidate',
            'changed',
            'non_material',
            'uncertain',
        ] as const
    ).map((kind, index) => ({
        id: id(50 + index),
        sourceId: id(21),
        kind,
        factKey: `事实维度 ${kind}`,
        oldValue: kind === 'new' || kind === 'baseline' ? null : `旧值 ${kind}`,
        newValue: `新值 ${kind}`,
        oldEvidenceIds: kind === 'new' || kind === 'baseline' ? [] : [id(20)],
        newEvidenceIds: [id(30)],
        important: kind === 'changed',
        reason: `原始原因 ${kind}`,
    }));
    return value;
}

const formatLabels: Record<Report['format'], string> = {
    brief: '简报',
    list: '主题清单',
    comparison: '对比表',
    research_report: '研究报告',
};
const generatedFormat = (page: Page, format: Report['format']) =>
    page
        .getByRole('navigation', { name: '已生成成果', exact: true })
        .getByRole('button', { name: formatLabels[format], exact: true });

/** Each saved artifact owns a separate set of claims, even when evidence is shared. */
function multiFormatReport(base = formatReport()): Report {
    const saved = structuredClone(base);
    const originalClaims = saved.claims;
    const originalValue = saved.coverage.reportValue;
    saved.claims = [];
    saved.coverage.artifacts = [];
    if (originalValue)
        saved.coverage.reportValue = {
            ...originalValue,
            questions: originalValue.questions.map((q) => ({ ...q, claimIndexes: [] })),
            selections: [],
        };
    formats.forEach(([format], i) => {
        const start = saved.claims.length;
        const entries = originalClaims.map((claim, n) => ({
            ...claim,
            id: id(1000 + i * 100 + n),
            text: `${formatLabels[format]}保存内容：${claim.text}`,
        }));
        saved.claims.push(...entries);
        saved.coverage.artifacts!.push({ format, claimIndexes: entries.map((_, n) => start + n) });
        if (originalValue && saved.coverage.reportValue) {
            saved.coverage.reportValue.selections.push(
                ...originalValue.selections.map((s) => ({
                    ...s,
                    claimIndex: start + s.claimIndex,
                })),
            );
            originalValue.questions.forEach((q, n) =>
                saved.coverage.reportValue!.questions[n].claimIndexes.push(
                    ...q.claimIndexes.map((index) => start + index),
                ),
            );
        }
    });
    return saved;
}

async function formatSamples(page: Page, initial = formatReport()) {
    const state = {
        report: initial,
        account: 100,
        beforeReport: undefined as (() => Promise<void>) | undefined,
        calls: [] as { method: string; path: string }[],
        unexpected: [] as string[],
    };
    await page.route('**/api/v1/**', async (route) => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        state.calls.push({ method: request.method(), path });
        if (request.method() === 'GET') {
            if (path === '/api/v1/me/agent-providers')
                return route.fulfill({
                    json: { items: [], systemConfigured: true, storageReady: true },
                });
            if (path === '/api/v1/me') return route.fulfill({ json: account(state.account) });
            if (path === `/api/v1/reports/${state.report.id}`) {
                await state.beforeReport?.();
                return route.fulfill({ json: state.report });
            }
            if (path === `/api/v1/tasks/${state.report.taskId}/feedback`)
                return route.fulfill({ json: { items: [] } });
            if (path === `/api/v1/reports/${state.report.id}/conversation`)
                return route.fulfill({
                    json: { reportId: state.report.id, turns: [], hasEarlier: false },
                });
            if (path === '/api/v1/notes')
                return route.fulfill({ json: { items: [], nextCursor: null } });
            if (/^\/api\/v1\/reports\/[^/]+\/questions\/[^/]+$/.test(path))
                return route.fulfill({ status: 404, json: failure() });
        }
        state.unexpected.push(`${request.method()} ${path}`);
        return route.fulfill({ status: 501, json: failure('UNCONFIGURED_SAMPLE_REQUEST') });
    });
    return state;
}

test('仅展示已保存的两份独立成果，阅读切换与刷新不会生成其他形式', async ({ page }, info) => {
    const saved = report() as Report;
    saved.claims = [
        { ...saved.claims[0]!, text: '简报结论：乙方案月费更低，离线场景优先甲方案。' },
        {
            ...saved.claims[1]!,
            text: '共同维度：甲方案100元/月并支持离线；乙方案80元/月且需要联网。',
        },
    ];
    saved.coverage.artifacts = [
        { format: 'brief', claimIndexes: [0] },
        { format: 'comparison', claimIndexes: [1] },
    ];
    const original = structuredClone(saved);
    const state = await formatSamples(page, saved);
    await page.goto(reportPath);
    await readOnMobile(page);
    const nav = page.getByRole('navigation', { name: '已生成成果', exact: true });
    await expect(nav.getByRole('button')).toHaveCount(2);
    await expect(nav.getByRole('button', { name: '主题清单', exact: true })).toHaveCount(0);
    await expect(nav.getByRole('button', { name: '研究报告', exact: true })).toHaveCount(0);
    await expect(page.getByLabel('报告形式', { exact: true })).toHaveCount(0);
    const claims = page.locator('.artifact-document .claim-copy');
    await expect(claims).toHaveText([saved.claims[0]!.text]);
    await generatedFormat(page, 'comparison').click();
    await expect(claims).toHaveText([saved.claims[1]!.text]);
    await expect(page.locator('.artifact-document .report-comparison')).toBeVisible();
    await expect(page.locator('.evidence-appendix .evidence-entry')).toHaveCount(1);
    await page.reload();
    await expect(generatedFormat(page, 'brief')).toHaveAttribute('aria-pressed', 'true');
    await expect(claims).toHaveText([saved.claims[0]!.text]);
    expect(state.calls.filter((call) => call.method !== 'GET')).toEqual([]);
    expect(state.unexpected).toEqual([]);
    expect(state.report).toEqual(original);
    for (const [width, scheme] of [
        [1440, 'light'],
        [390, 'light'],
        [1440, 'dark'],
    ] as const) {
        await page.setViewportSize({ width, height: 1000 });
        await page.emulateMedia({ colorScheme: scheme });
        await expect(page.locator('.scova-theme--dark')).toHaveCount(scheme === 'dark' ? 1 : 0);
        await page.screenshot({
            path: info.outputPath(`artifact-panel-${width}-${scheme}.png`),
            fullPage: true,
            animations: 'disabled',
        });
    }
});

test('同网页仅列一次，同快照去除重复原文，其他快照与全部定位锚点保留', async ({ page }) => {
    const saved = report() as Report;
    const first = saved.evidence[0]!;
    saved.evidence = [
        first,
        { ...structuredClone(first), id: id(23), quote: '第二段原文。\n  保留段落与空格。' },
        { ...structuredClone(first), id: id(24) },
        {
            ...structuredClone(first),
            id: id(25),
            snapshotId: id(26),
            quote: '另一保存版本的原文。',
        },
    ];
    saved.claims = [
        { ...saved.claims[0]!, evidenceIds: saved.evidence.map((evidence) => evidence.id) },
    ];
    const state = await formatSamples(page, saved);
    await page.goto(reportPath);
    await readOnMobile(page);
    const appendix = page.locator('.evidence-appendix');
    const groups = appendix.locator('.evidence-source-group');
    await expect(groups).toHaveCount(1);
    await expect(groups.first().locator(':scope > summary')).toContainText('3条引用');
    await expect(groups.first().locator(':scope > summary')).toContainText('2个版本');
    await groups.first().locator(':scope > summary').click();
    const versions = groups.first().locator('.source-version');
    await expect(versions).toHaveCount(2);
    await expect(versions.first().locator('blockquote')).toHaveText([
        first.quote,
        saved.evidence[1]!.quote,
    ]);
    await expect(groups.first().locator(`#evidence-${id(24)}`)).toHaveCount(1);
    await expect(versions.last().locator('blockquote')).toHaveText([saved.evidence[3]!.quote]);
    await expect(groups.first().locator('a[target="_blank"]')).toHaveCount(1);
    await expect(groups.first().locator('.source-page-link')).toHaveAttribute(
        'href',
        first.snapshot!.canonicalUrl,
    );
    await expect(groups.first().locator('.source-quote a[target="_blank"]')).toHaveCount(0);
    for (const evidence of saved.evidence)
        await expect(appendix.locator(`#evidence-${evidence.id}`)).toHaveCount(1);
    expect(
        await page.evaluate(() => {
            const ids = [...document.querySelectorAll('[id]')].map((element) => element.id);
            return ids.filter((id, index) => ids.indexOf(id) !== index);
        }),
    ).toEqual([]);
    expect(await page.evaluate(() => 'sourceExecuted' in window)).toBe(false);
    expect(state.unexpected).toEqual([]);
});

test('完整阅读从成果面板连续展开，保留滚动和节点，Escape收起且减少动态时直接切换', async ({
    page,
}) => {
    const state = await formatSamples(page, reportFormatSample('research_report'));
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto(reportPath);
    await readOnMobile(page);
    const panel = page.locator('#report-artifact');
    await expect(panel).toBeVisible();
    await expect(
        page.getByRole('heading', { name: '两馆自习室使用条件', exact: true }),
    ).toBeVisible();
    const original = await panel.elementHandle();
    const scroll = panel.locator(':scope > .artifact-scroll');
    await scroll.evaluate((node) => {
        node.scrollTo({ top: 180, behavior: 'instant' });
    });
    expect(await scroll.evaluate((node) => node.scrollTop)).toBe(180);
    const bounds = await page.evaluate(async () => {
        const panel = document.querySelector<HTMLElement>('#report-artifact')!;
        const before = panel.getBoundingClientRect();
        const button = [...panel.querySelectorAll('button')].find(
            (node) => node.getAttribute('aria-label') === '完整阅读',
        )!;
        button.click();
        await new Promise(requestAnimationFrame);
        const animation = panel.getAnimations()[0]!;
        animation.pause();
        animation.currentTime = 0;
        const start = panel.getBoundingClientRect();
        animation.currentTime = 90;
        const middle = panel.getBoundingClientRect();
        animation.currentTime = 180;
        const end = panel.getBoundingClientRect();
        animation.currentTime = 90;
        return {
            before: before.width,
            start: start.width,
            middle: middle.width,
            end: end.width,
            duration: animation.effect!.getTiming().duration,
        };
    });
    expect(bounds.duration).toBe(180);
    expect(bounds.start).toBeCloseTo(bounds.before, 0);
    expect(bounds.middle).toBeGreaterThan(bounds.start);
    expect(bounds.middle).toBeLessThan(bounds.end);
    expect(bounds.end).toBeGreaterThan(bounds.start * 1.5);
    await page.screenshot({ path: 'artifacts/report-reading-polish/expanding.png' });
    await panel.evaluate((node) => node.getAnimations().forEach((animation) => animation.finish()));
    await expect(page.locator('#report-title')).toBeFocused();
    expect(await scroll.evaluate((node) => node.scrollTop)).toBe(180);
    expect(
        await original!.evaluate((node) => node === document.querySelector('#report-artifact')),
    ).toBe(true);
    await scroll.evaluate((node) => {
        node.scrollTo({ top: 0, behavior: 'instant' });
    });
    await page.locator('#report-title').evaluate((node) => node.blur());
    await page.screenshot({ path: 'artifacts/report-reading-polish/research-report-reading.png' });
    await page.locator('#report-title').press('Escape');
    await expect(page.getByLabel('问题', { exact: true })).toBeFocused();
    await expect(page.locator('.report-companion')).toBeVisible();
    await page.screenshot({ path: 'artifacts/report-reading-polish/research-report-preview.png' });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.getByRole('button', { name: '完整阅读', exact: true }).click();
    await expect(page.locator('#report-title')).toBeFocused();
    expect(await panel.evaluate((node) => node.getAnimations().length)).toBe(0);
    await page.getByRole('button', { name: '返回对话', exact: true }).click();
    await expect(page.getByLabel('问题', { exact: true })).toBeFocused();
    expect(await panel.evaluate((node) => node.getAnimations().length)).toBe(0);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const interruptedFocus = await panel.evaluate(async (node) => {
        const targets: string[] = [];
        const record = (event: FocusEvent) => targets.push((event.target as HTMLElement).id);
        document.addEventListener('focusin', record);
        [...node.querySelectorAll('button')]
            .find((button) => button.getAttribute('aria-label') === '完整阅读')!
            .click();
        await new Promise(requestAnimationFrame);
        [...node.querySelectorAll('button')]
            .find((button) => button.textContent?.includes('返回对话'))!
            .click();
        await new Promise(requestAnimationFrame);
        await Promise.all(
            node.getAnimations().map((animation) => animation.finished.catch(() => {})),
        );
        await new Promise(requestAnimationFrame);
        document.removeEventListener('focusin', record);
        return targets;
    });
    expect(interruptedFocus).not.toContain('report-title');
    await expect(page.getByLabel('问题', { exact: true })).toBeFocused();
    expect(state.calls.filter((call) => call.method !== 'GET')).toEqual([]);
    expect(state.unexpected).toEqual([]);
});

test('成果面板使用220毫秒过渡并尊重减少动态效果设置', async ({ page }) => {
    await formatSamples(page);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto(reportPath);
    await readOnMobile(page);
    const panel = page.locator('.report-artifact-panel');
    await expect(panel).toBeVisible();
    const durations = await page.evaluate(async () => {
        const panel = document.querySelector('.report-artifact-panel')!;
        // Vue schedules its own two animation frames; observe the actual transition start.
        const started = new Promise<number[]>((resolve) =>
            panel.addEventListener(
                'transitionrun',
                () =>
                    resolve(
                        panel
                            .getAnimations()
                            .map((animation) => Number(animation.effect?.getTiming().duration)),
                    ),
                { once: true },
            ),
        );
        (document.querySelector('[aria-label="关闭成果预览"]') as HTMLButtonElement).click();
        return started;
    });
    expect(durations).toContain(220);
    await expect(panel).toBeHidden();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.locator('.report-artifact-card').click();
    await expect(panel).toBeVisible();
    await page.getByRole('button', { name: '关闭成果预览', exact: true }).click();
    await expect(panel).toBeHidden();
    expect(await panel.evaluate((element) => element.getAnimations().length)).toBe(0);
});

test('同一页面的多句话共用文末来源，结论依据可展开并定位原文', async ({ page }) => {
    const saved = questionReport();
    const state = await formatSamples(page, saved);
    await page.goto(reportPath);
    await readOnMobile(page);
    const answer = page.locator('.answers #question-q0');
    await expect(answer.locator('.claim')).toHaveCount(2);
    const group = page.locator('.evidence-appendix .evidence-source-group').first();
    await expect(group).toHaveCount(1);
    await expect(group.locator('blockquote')).toHaveText(
        saved.evidence.map((entry) => entry.quote),
    );
    const quote = group.locator(`#evidence-${saved.evidence[0]!.id}`);
    await expect(quote).toBeHidden();
    await expect(answer.locator('a[href^="#evidence-"],.citation')).toHaveCount(0);
    const provenance = page.locator('.evidence-appendix .claim-provenance');
    await provenance.locator(':scope > summary').press('Enter');
    const links = provenance.locator(
        ['#claim-support-' + saved.claims[0]!.id, '#claim-support-' + saved.claims[1]!.id]
            .map((selector) => `${selector} a[href^="#evidence-"]`)
            .join(','),
    );
    await expect(links).toHaveCount(2);
    await links.last().click();
    await expect(quote.locator('blockquote')).toBeVisible();
    await expect(quote).toBeFocused();
    await expect(quote.locator('blockquote')).toHaveText(saved.evidence[0]!.quote);
    expect(state.calls.filter((call) => call.method !== 'GET')).toEqual([]);
    expect(state.unexpected).toEqual([]);
});

const sourcePreviewCases = [
    { width: 320, scheme: 'light', scale: 100 },
    { width: 320, scheme: 'dark', scale: 100 },
    { width: 320, scheme: 'dark', scale: 200 },
    { width: 1440, scheme: 'light', scale: 100 },
    { width: 1440, scheme: 'dark', scale: 100 },
] as const;
for (const { width, scheme, scale } of sourcePreviewCases) {
    test(`小字来源可预览且定位保存引用 / ${width} ${scheme} ${scale}%`, async ({ page }, info) => {
        await page.setViewportSize({ width, height: 820 });
        await page.emulateMedia({ colorScheme: scheme });
        const saved = questionReport();
        const first = saved.evidence[0]!;
        saved.evidence = [
            { ...first, url: 'https://zh.wikipedia.org/wiki/研究', snapshot: undefined },
            {
                ...first,
                id: id(25),
                url: 'https://zh.wikipedia.org/wiki/研究#section',
                snapshot: undefined,
            },
            {
                ...first,
                id: id(26),
                sourceId: id(28),
                snapshotId: id(29),
                title: '独立来源',
                url: 'https://example.org/reference',
                snapshot: undefined,
            },
            ...saved.evidence.slice(1),
        ];
        saved.claims[0]!.evidenceIds = saved.evidence.slice(0, 3).map((entry) => entry.id);
        const state = await formatSamples(page, saved);
        await page.goto(reportPath);
        await readOnMobile(page);
        if (scale === 200) await page.addStyleTag({ content: 'html { font-size: 200%; }' });
        const chip = page
            .getByRole('button', { name: '查看引用来源：维基百科，共 2 个网页', exact: true })
            .first();
        const panel = page.getByRole('region', { name: '引用来源', exact: true });
        await expect(page.locator('.scova-theme--dark')).toHaveCount(scheme === 'dark' ? 1 : 0);
        await expect(chip).toHaveText(/^W\s*维基百科\s*\+1$/);
        await expect(chip.locator('.source-mark')).toHaveAttribute('aria-hidden', 'true');
        await expect(panel).toBeHidden();
        await chip.scrollIntoViewIfNeeded();
        await chip.press('Enter');
        await expect(chip).toHaveAttribute('aria-expanded', 'true');
        await expect(panel.locator('.source-preview-entry')).toHaveCount(2);
        await expect(panel.locator('.source-excerpt').first()).toHaveText(first.quote);
        await expect(panel.getByRole('link', { name: /独立来源/ })).toHaveAttribute(
            'target',
            '_blank',
        );
        const bounds = (await panel.boundingBox())!;
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
        expect(bounds.y).toBeGreaterThanOrEqual(0);
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(820);
        if (width === 320 && scale === 100) {
            const chipBounds = (await chip.boundingBox())!;
            expect(bounds.y).toBeGreaterThanOrEqual(chipBounds.y + chipBounds.height);
        }
        await page.screenshot({
            path: info.outputPath(`source-preview-${width}-${scheme}-${scale}.png`),
        });
        await chip.press('Tab');
        const close = panel.getByRole('button', { name: '关闭引用来源', exact: true });
        await expect(close).toBeFocused();
        await close.press('Escape');
        await expect(chip).toBeFocused();
        await expect(chip).toHaveAttribute('aria-expanded', 'false');
        await expect(page.locator('#report-artifact')).toBeVisible();
        await chip.click();
        await panel.getByRole('link', { name: '查看保存引用' }).first().click();
        await expect(panel).toBeHidden();
        await expect(page.locator(`#evidence-${first.id}`)).toBeFocused();
        expect(await page.evaluate(() => Reflect.get(window, 'sourceExecuted'))).toBeUndefined();
        expect(state.calls.filter((call) => call.method !== 'GET')).toEqual([]);
        expect(state.unexpected).toEqual([]);
    });
}

for (const width of [320, 1440]) {
    test(`结构化对象交付 ${width}：真实矩阵、缺字段首屏和集中引用`, async ({ page }, info) => {
        const saved = multiFormatReport(questionReport());
        for (const selection of saved.coverage.reportValue!.selections) {
            selection.assessment!.conditions =
                'getter 默认浅层；直接对 reactive 对象调用 watch 会隐式创建 deep watcher';
            selection.assessment!.gap = '其它调用方式仍需单独核实';
        }
        for (const artifact of saved.coverage.artifacts!) {
            const index = artifact.claimIndexes[0]!;
            const text = saved.claims[index]!.text;
            artifact.summary = text;
            artifact.coverage = {
                version: 1,
                requirements: [
                    {
                        id: 'object-a-entry',
                        questionIds: ['q0'],
                        object: '对象甲',
                        field: '用途',
                        required: true,
                        status: 'supported',
                        claimIndexes: [index],
                        gap: '',
                    },
                    {
                        id: 'object-b-entry',
                        questionIds: ['q0'],
                        object: '对象乙',
                        field: '用途',
                        required: true,
                        status: 'unknown',
                        claimIndexes: [],
                        gap: '尚未取得对象乙用途',
                    },
                ],
            };
            const known = { text, claimIndexes: [index], status: 'supported' as const, gap: '' };
            const unknown = {
                text: '',
                claimIndexes: [],
                status: 'unknown' as const,
                gap: '尚未取得对象乙用途',
            };
            if (artifact.format === 'list')
                artifact.content = {
                    version: 1,
                    list: {
                        entries: [
                            {
                                id: 'object-a',
                                name: '对象甲',
                                fields: [{ id: 'purpose', label: '用途', ...known }],
                            },
                            {
                                id: 'object-b',
                                name: '对象乙',
                                fields: [{ id: 'purpose', label: '用途', ...unknown }],
                            },
                        ],
                    },
                };
            if (artifact.format === 'comparison')
                artifact.content = {
                    version: 1,
                    comparison: {
                        objects: [
                            { id: 'object-a', name: '对象甲' },
                            { id: 'object-b', name: '对象乙' },
                        ],
                        dimensions: [{ id: 'purpose', label: '用途' }],
                        cells: [
                            { objectId: 'object-a', dimensionId: 'purpose', ...known },
                            { objectId: 'object-b', dimensionId: 'purpose', ...unknown },
                        ],
                    },
                };
        }
        const original = structuredClone(saved);
        const state = await formatSamples(page, saved);
        await page.setViewportSize({ width, height: 1000 });
        await page.goto(reportPath);
        await readOnMobile(page);
        for (const format of ['list', 'comparison'] as const) {
            await generatedFormat(page, format).click();
            await expect(page.locator('.report-delivery')).toContainText('部分交付');
            await page.locator('.report-delivery a').click();
            await expect(page.locator('.answer-gaps')).toContainText('对象乙 · 用途');
            await expect(page.locator('.structured-content')).toContainText('尚未取得对象乙用途');
            const tableMode =
                format === 'comparison' || (await page.locator('.list-table').isVisible());
            const details = page.locator(tableMode ? '.structured-notes' : '.list-cards');
            await expect(details).toBeVisible();
            await expect(details).toContainText('尚未取得对象乙用途');
            await expect(details).toContainText(
                '直接对 reactive 对象调用 watch 会隐式创建 deep watcher',
            );
            await expect(details).toContainText('补充说明：其它调用方式仍需单独核实');
            await expect(page.locator('.answer-support')).not.toHaveAttribute('open');
            if (format === 'list')
                await expect(page.locator('.object-card h4')).toHaveText(['对象甲', '对象乙']);
            else
                await expect(page.locator('.object-matrix thead th')).toHaveText([
                    '维度',
                    '对象甲',
                    '对象乙',
                ]);
            await expect(
                page.locator(
                    '.structured-content a:not([href^="#structured-note-"]), .structured-links',
                ),
            ).toHaveCount(0);
            const artifact = saved.coverage.artifacts!.find((entry) => entry.format === format)!;
            const currentClaim = saved.claims[artifact.claimIndexes[0]!]!;
            const provenance = page.locator(`.claim-provenance #claim-support-${currentClaim.id}`);
            if ((await page.locator('.claim-provenance').getAttribute('open')) === null)
                await page.locator('.claim-provenance > summary').press('Enter');
            const claimLink = provenance.locator(`a[href="#claim-${currentClaim.id}"]`);
            await claimLink.click();
            await expect(page.locator(`#claim-${currentClaim.id}`)).toBeFocused();
            await expect(page.locator(`#claim-${currentClaim.id} .claim-copy`)).toHaveText(
                currentClaim.text,
            );
            const sourceLink = provenance.locator('a[href^="#evidence-"]').first();
            await expect(sourceLink).toHaveAttribute(
                'href',
                `#evidence-${currentClaim.evidenceIds[0]}`,
            );
            await sourceLink.click();
            const sourceId = (await sourceLink.getAttribute('href'))!;
            await expect(page.locator(sourceId)).toBeFocused();
            await expect(page.locator(`${sourceId} blockquote`)).toBeVisible();
            await expect(page.locator('.answers blockquote')).toHaveCount(0);
            for (const enlarged of [false, true]) {
                await page.evaluate((value) => {
                    document.documentElement.style.fontSize = value ? '200%' : '';
                }, enlarged);
                expect(
                    await page.evaluate(
                        () => document.documentElement.scrollWidth <= innerWidth + 1,
                    ),
                ).toBe(true);
                await info.attach(`${format}-${width}-${enlarged ? 'text200' : 'normal'}`, {
                    body: await page.screenshot({ fullPage: true }),
                    contentType: 'image/png',
                });
            }
            await page.evaluate(() => {
                document.documentElement.style.fontSize = '';
            });
        }
        expect(state.calls.filter((call) => call.method !== 'GET')).toEqual([]);
        expect(state.unexpected).toEqual([]);
        expect(saved).toEqual(original);
    });
}

async function assertFormatContent(page: Page, expected: Report) {
    const frame = page.locator('.report-frame');
    await expect(frame).toHaveCount(1);
    await expect(page.locator('.artifact-document .evidence-appendix')).toHaveCount(0);
    await expect(page.locator('.evidence-appendix')).toHaveCount(1);
    await expect(frame.locator('.claim a,.claim details')).toHaveCount(0);
    await expect(page.locator('.report-changes .evidence-link')).toHaveCount(0);
    expect(
        await page
            .locator('a[href^="#evidence-"]')
            .evaluateAll((links) =>
                links.every((link) => !!link.closest('.evidence-appendix, .report-changes')),
            ),
    ).toBe(true);
    expect(
        await page
            .locator('.evidence-appendix')
            .evaluate(
                (appendix) =>
                    !!(
                        document
                            .querySelector('.report-changes')!
                            .compareDocumentPosition(appendix) & Node.DOCUMENT_POSITION_FOLLOWING
                    ),
            ),
    ).toBe(true);
    await expect(frame.locator('#report-title')).toHaveText(expected.title);
    await expect(frame.locator('.metadata')).toContainText(expected.taskVersionId);
    await expect(frame.locator('.metadata time')).toHaveAttribute('datetime', expected.publishedAt);
    const orderedClaims = claimKinds.flatMap((kind) =>
        expected.claims.filter((entry) => entry.kind === kind),
    );
    expect(
        await frame.locator('.claim').evaluateAll((elements) =>
            elements.map((element) => {
                const attribution = document
                    .querySelector(`.claim-provenance a[href="#${element.id}"]`)!
                    .closest('li')!;
                return {
                    id: element.id.slice('claim-'.length),
                    text: element.querySelector('.claim-copy')!.textContent,
                    confidence: attribution.querySelector('p')!.textContent,
                    evidenceIds: [...attribution.querySelectorAll('a[href^="#evidence-"]')].map(
                        (entry) => entry.id.split('-evidence-')[1],
                    ),
                };
            }),
        ),
    ).toEqual(
        orderedClaims.map((entry) => ({
            id: entry.id,
            text: entry.text,
            confidence: `${{ fact: '来源事实', inference: 'Agent 推断', conflict: '冲突证据', insufficient: '证据不足', model_answer: '模型自回答' }[entry.kind]} · ${entry.confidenceLabel}`,
            evidenceIds: entry.evidenceIds,
        })),
    );
    expect(
        await page.locator('.evidence-appendix .evidence-entry').evaluateAll((elements) =>
            elements.map((element) => ({
                id: element.id.slice('evidence-'.length),
                quote: element.querySelector('blockquote')!.textContent,
            })),
        ),
    ).toEqual(expected.evidence.map((entry) => ({ id: entry.id, quote: entry.quote })));
    for (const entry of expected.changes.filter((entry) => entry.kind !== 'baseline')) {
        const row = page.locator(
            `.report-changes .change-record[aria-labelledby="change-${entry.id}"]`,
        );
        await expect(row).toHaveCount(1);
        await expect(row).toContainText(entry.factKey);
        await expect(row).toContainText(entry.reason);
        if (entry.oldValue !== null)
            await expect(row.locator('.old-value')).toHaveText(entry.oldValue);
        await expect(row.locator('.new-value')).toHaveText(entry.newValue ?? '未提供新值');
        for (const side of ['old', 'new'] as const)
            expect(
                await row
                    .locator(`a[id*="-${side}-"]`)
                    .evaluateAll((links) => links.map((link) => link.getAttribute('href'))),
            ).toEqual(entry[`${side}EvidenceIds`].map((id) => `#evidence-${id}`));
    }
    expect(
        await page.evaluate(() => {
            const ids = [...document.querySelectorAll('[id]')].map((element) => element.id);
            return ids.filter((value, index) => ids.indexOf(value) !== index);
        }),
    ).toEqual([]);
    await expect(page.getByRole('note', { name: '查阅范围说明' })).toHaveCount(
        expected.coverage.completeness === 'partial' ? 1 : 0,
    );
    expect(await page.evaluate(() => 'sourceExecuted' in window)).toBe(false);
}

for (const [savedFormat, renderer] of formats) {
    test(`历史单成果：保存 ${savedFormat} 后阅读形式固定，URL 与刷新不改变内容`, async ({
        page,
    }) => {
        const saved = formatReport();
        saved.format = savedFormat;
        const state = await formatSamples(page, saved);
        const url = `${reportPath}?questionId=${id(90)}&unknown=a&unknown=b&view=list&view=invalid#preserved`;
        await page.goto(url);
        await expect(page.locator(renderer)).toBeVisible();
        await expect(page.getByLabel('报告形式', { exact: true })).toHaveCount(0);
        await expect(page.getByRole('navigation', { name: '已生成成果', exact: true })).toHaveCount(
            0,
        );
        const originalUrl = page.url();
        const reportReads = () =>
            state.calls.filter((entry) => entry.path === `/api/v1/reports/${saved.id}`).length;
        const reads = reportReads();
        await assertFormatContent(page, saved);
        const navigation = page.getByRole('navigation', { name: '报告内容导航', exact: true });
        for (const [label, target] of [
            ['正文', 'report-title'],
            ['变化', 'report-changes-title'],
            ['来源', 'saved-evidence-title'],
        ]) {
            await navigation.getByRole('link', { name: label!, exact: true }).press('Enter');
            await expect(page.locator(`#${target}`)).toBeFocused();
            expect(page.url()).toBe(originalUrl);
        }
        expect(reportReads()).toBe(reads);
        expect(state.calls.filter((entry) => entry.method !== 'GET')).toEqual([]);
        expect(state.unexpected).toEqual([]);
        await page.reload();
        await expect(page.locator(renderer)).toBeVisible();
        expect(page.url()).toBe(originalUrl);
        expect(reportReads()).toBe(reads + 1);
        expect(state.report).toEqual(saved);
    });
}

test('生产四视图：格式切换保留未提交问题和同页笔记编辑器，换报告重置', async ({ page }) => {
    const state = await formatSamples(page, multiFormatReport());
    await page.goto(reportPath);
    await readOnMobile(page);
    const selector = page.getByRole('navigation', { name: '已生成成果', exact: true });
    await expect(selector).toBeVisible();
    await page.getByLabel('问题', { exact: true }).fill('保留的未提交问题');
    const questions = await page.locator('.questions').elementHandle();
    const notes = await page.locator('.notes-panel').elementHandle();
    expect(notes).not.toBeNull();
    for (const [format] of formats) {
        await generatedFormat(page, format).click();
        await expect(page.getByLabel('问题', { exact: true })).toHaveValue('保留的未提交问题');
        expect(await questions!.evaluate((element) => element.isConnected)).toBe(true);
        expect(await notes!.evaluate((element) => element.isConnected)).toBe(true);
    }
    await page.getByRole('button', { name: '添加功能' }).click();
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: '清空问题', exact: true }).click();
    await expect(page.getByLabel('问题', { exact: true })).toHaveValue('');
    const navigateWithinApp = async (target: string) =>
        page.evaluate((target) => {
            // Browser history events exercise the real router without adding a test API to the app.
            window.history.pushState({ ...window.history.state, current: target }, '', target);
            window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }));
        }, target);
    await navigateWithinApp(`${reportPath}?sameReport=1`);
    await expect(generatedFormat(page, 'research_report')).toHaveAttribute('aria-pressed', 'true');
    expect(await notes!.evaluate((element) => element.isConnected)).toBe(true);
    state.report = { ...formatReport(), id: id(70), format: 'list', title: '另一份保存报告' };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let waiting = false;
    state.beforeReport = async () => {
        waiting = true;
        await gate;
    };
    try {
        await navigateWithinApp(`/reports/${id(70)}`);
        await expect.poll(() => waiting).toBe(true);
        await expect(page.locator('.report-frame')).toHaveCount(0);
        await expect(selector).toHaveCount(0);
        release();
        await expect(page.locator('.report-topic-list')).toBeVisible();
        await expect(selector).toHaveCount(0);
        await expect(page.locator('#report-title')).toHaveText('另一份保存报告');
    } finally {
        release();
    }
    await expect(page.getByLabel('问题', { exact: true })).toHaveValue('');
    expect(state.calls.filter((entry) => entry.method !== 'GET')).toEqual([]);
    expect(state.unexpected).toEqual([]);
});

for (const width of [320, 360, 390, 768, 1024, 1440]) {
    test(`生产四视图：${width} 六宽与200%根文字、引用及局部表格滚动`, async ({ page }, info) => {
        const state = await formatSamples(page, multiFormatReport());
        await page.setViewportSize({ width, height: 1000 });
        await page.goto(reportPath);
        await readOnMobile(page);
        for (const enlarged of [false, true]) {
            await page.evaluate(
                (value) => (document.documentElement.style.fontSize = value ? '200%' : ''),
                enlarged,
            );
            for (const [format, renderer] of formats) {
                const selection = generatedFormat(page, format);
                await selection.click();
                await expect(selection).toHaveAttribute('aria-pressed', 'true');
                await expect(page.locator(renderer)).toBeVisible();
                await expect(page.locator('#report-title')).toBeVisible();
                await expect(page.getByRole('note', { name: '查阅范围说明' })).toBeVisible();
                const group = page.locator('.evidence-appendix .evidence-source-group').first();
                const source = group.locator('.source-quote').first();
                await group.locator(':scope > summary').focus();
                if ((await group.getAttribute('open')) === null)
                    await group.locator(':scope > summary').press('Enter');
                await expect(source.locator('blockquote')).toBeVisible();
                expect(
                    await source.locator('blockquote').evaluate((element) => {
                        const css = getComputedStyle(element);
                        return (
                            (element.clientWidth -
                                parseFloat(css.paddingLeft) -
                                parseFloat(css.paddingRight)) /
                            parseFloat(css.fontSize)
                        );
                    }),
                ).toBeGreaterThanOrEqual(4);
                expect(
                    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
                ).toBe(true);
                if (format === 'comparison') {
                    const scroll = page.locator('.findings-scroll');
                    expect(
                        await scroll.evaluate((element) => getComputedStyle(element).overflowX),
                    ).toBe('auto');
                    if (width <= 390 || enlarged)
                        expect(
                            await scroll.evaluate(
                                (element) => element.scrollWidth > element.clientWidth,
                            ),
                        ).toBe(true);
                }
                await info.attach(`${format}-${width}${enlarged ? '-text200' : ''}`, {
                    body: await page.screenshot({ fullPage: true }),
                    contentType: 'image/png',
                });
            }
        }
        expect(state.calls.filter((entry) => entry.method !== 'GET')).toEqual([]);
        expect(state.unexpected).toEqual([]);
    });
}

test('报告图表显示来源数据并下载 SVG，私有 CSV 可上传、定位和删除', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await samples(page);
    const reportId = id(1);
    const chartId = id(90);
    const attachmentId = id(91);
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><title>来源图表</title></svg>';
    const chartUrl = `/api/v1/reports/${reportId}/charts/${chartId}/download`;
    const attachmentUrl = `/api/v1/reports/${reportId}/attachments/${attachmentId}/download`;
    const csv = '名称,值\r\n"跨行\n样例",9\r\n';
    const filename = '参考.csv';
    const attachment = {
        id: attachmentId,
        reportId,
        filename,
        byteLength: Buffer.byteLength(csv),
        createdAt: report().publishedAt,
        downloadUrl: attachmentUrl,
        status: 'ready',
        rowCount: 2,
        failureCode: null,
    };
    let saved = false;
    let chartRequests = 0;
    await page.route(`**/api/v1/reports/${reportId}/charts/source-hosts`, async (route) => {
        chartRequests++;
        expect(route.request().headers()['x-csrf-token']).toBe('report-test-only');
        await route.fulfill({
            json: {
                id: chartId,
                reportId,
                reportVersion: new Date(report().publishedAt).toISOString(),
                rendererVersion: 1,
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
                downloadUrl: chartUrl,
                rows: [
                    {
                        hostname: 'example.test',
                        count: 1,
                        sources: [{ sourceId: id(21), evidenceIds: [id(20)] }],
                    },
                ],
            },
        });
    });
    await page.route(`**${chartUrl}`, (route) =>
        route.fulfill({
            body: svg,
            headers: {
                'content-type': 'image/svg+xml',
                'content-disposition': 'attachment; filename="sources.svg"',
            },
        }),
    );
    await page.route(`**/api/v1/reports/${reportId}/attachments**`, async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (request.method() === 'POST') {
            expect(request.headers()['x-csrf-token']).toBe('report-test-only');
            expect(request.headers()['content-type']).toBe('text/csv');
            expect(url.searchParams.get('filename')).toBe(filename);
            expect(request.postDataBuffer()?.toString('utf8')).toBe(csv);
            saved = true;
            await route.fulfill({ json: attachment });
        } else if (request.method() === 'DELETE') {
            expect(request.headers()['x-csrf-token']).toBe('report-test-only');
            saved = false;
            await route.fulfill({ json: { id: attachmentId } });
        } else if (url.pathname.endsWith('/rows')) {
            expect(url.searchParams.get('start')).toBe('1');
            expect(url.searchParams.get('end')).toBe('2');
            await route.fulfill({
                json: {
                    attachmentId,
                    rowCount: 2,
                    rows: [
                        { rowNumber: 1, startLine: 1, endLine: 1, cells: ['名称', '值'] },
                        { rowNumber: 2, startLine: 2, endLine: 3, cells: ['跨行\n样例', '9'] },
                    ],
                },
            });
        } else {
            await route.fulfill({ json: { items: saved ? [attachment] : [] } });
        }
    });
    await page.goto(reportPath);
    await page.getByText('引用来源图表', { exact: true }).click();
    const generate = page.getByRole('button', { name: '生成来源图表', exact: true });
    await generate.focus();
    await generate.press('Enter');
    await page.getByText('查看图表数据及引用').click();
    const table = page.getByRole('table', { name: '各主机名的去重引用来源数' });
    await expect(table.getByRole('rowheader', { name: 'example.test' })).toBeVisible();
    await expect(table.getByRole('link', { name: '研究资料说明' })).toHaveAttribute(
        'href',
        `#evidence-${id(20)}`,
    );
    const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.getByRole('button', { name: '下载 SVG 图表' }).click(),
    ]);
    expect(download.suggestedFilename()).toBe(`scova-source-hosts-${reportId}.svg`);
    expect(await readFile((await download.path())!, 'utf8')).toBe(svg);
    expect(chartRequests).toBe(1);

    await page.getByText('私有参考附件', { exact: true }).click();
    await expect(page.getByText('暂无参考附件')).toBeVisible();
    await page
        .getByLabel('选择附件')
        .setInputFiles({ name: filename, mimeType: 'text/csv', buffer: Buffer.from(csv) });
    await page.getByRole('button', { name: '上传附件', exact: true }).click();
    await expect(page.getByText(filename, { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '查看内容', exact: true }).click();
    await expect(page.getByText('记录 2 · 原文件第 2–3 行')).toBeVisible();
    await page.getByRole('button', { name: '删除附件', exact: true }).click();
    await page.getByRole('button', { name: '确认删除', exact: true }).click();
    await expect(page.getByText('暂无参考附件')).toBeVisible();
});

for (const width of [1440, 390]) {
    test(`报告打印只保留当前成果、变化和来源 / ${width}px`, async ({ page }, info) => {
        await page.setViewportSize({ width, height: 900 });
        await samples(page);
        await page.addInitScript(() => {
            window.print = () => window.dispatchEvent(new Event('beforeprint'));
        });
        await page.goto(reportPath);
        if (width < 600) await page.getByRole('button', { name: '成果', exact: true }).click();
        const panel = page.locator('#report-artifact');
        const source = panel.locator('.evidence-source-group').first();
        await expect(source).toBeVisible();
        await expect(source).not.toHaveAttribute('open', '');
        await panel.getByRole('button', { name: '导出成果' }).click();
        await panel.getByRole('button', { name: '打印 / 另存为 PDF' }).press('Enter');
        await expect(source).toHaveAttribute('open', '');
        await page.emulateMedia({ media: 'print' });
        await expect(panel.locator('#report-title')).toHaveText(report().title);
        await expect(panel.locator('.source-quotes').first()).toBeVisible();
        await expect(page.locator('.workbench-header')).toBeHidden();
        await expect(page.locator('#report-conversation')).toBeHidden();
        await expect(panel.getByText('私有参考附件')).toBeHidden();
        await expect(panel.locator('.artifact-scroll')).toHaveCSS('overflow', 'visible');
        const pdf = await page.pdf({ path: info.outputPath('report-print.pdf'), format: 'A4' });
        expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
        await page.emulateMedia({ media: 'screen' });
        await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
        await expect(source).not.toHaveAttribute('open', '');
        await panel.getByRole('button', { name: '导出成果' }).click();
        await expect(panel.getByRole('button', { name: '打印 / 另存为 PDF' })).toBeVisible();
    });
}

test('报告附件 TXT 显示原文行，PDF 只提供原件下载', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await samples(page);
    const reportId = id(1);
    const root = `/api/v1/reports/${reportId}/attachments`;
    const fixtures = {
        '资料.txt': { id: id(92), content: '<b>文本原样保留</b>\n', mediaType: 'text/plain' },
        '资料.pdf': { id: id(93), content: '%PDF-1.7\nfixture', mediaType: 'application/pdf' },
    };
    const saved = new Set<keyof typeof fixtures>();
    const resource = (filename: keyof typeof fixtures) => ({
        id: fixtures[filename].id,
        reportId,
        filename,
        byteLength: Buffer.byteLength(fixtures[filename].content),
        createdAt: report().publishedAt,
        downloadUrl: `${root}/${fixtures[filename].id}/download`,
        failureCode: null,
        ...(filename.endsWith('.pdf')
            ? { format: 'pdf', status: 'download_only', rowCount: null }
            : { format: 'txt', status: 'ready', rowCount: 1 }),
    });
    await page.route(`**${root}**`, async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (request.method() === 'POST') {
            const filename = url.searchParams.get('filename') as keyof typeof fixtures;
            expect(request.headers()['x-csrf-token']).toBe('report-test-only');
            expect(request.headers()['content-type']).toBe(fixtures[filename].mediaType);
            expect(request.postDataBuffer()?.toString()).toBe(fixtures[filename].content);
            saved.add(filename);
            return route.fulfill({ json: resource(filename) });
        }
        if (url.pathname.endsWith(`/${fixtures['资料.txt'].id}/rows`))
            return route.fulfill({
                json: {
                    attachmentId: fixtures['资料.txt'].id,
                    rowCount: 1,
                    rows: [
                        {
                            rowNumber: 1,
                            startLine: 1,
                            endLine: 1,
                            cells: [fixtures['资料.txt'].content.trimEnd()],
                        },
                    ],
                },
            });
        if (url.pathname.endsWith(`/${fixtures['资料.pdf'].id}/download`))
            return route.fulfill({
                contentType: 'application/octet-stream',
                body: fixtures['资料.pdf'].content,
            });
        return route.fulfill({ json: { items: [...saved].map(resource) } });
    });
    await page.goto(reportPath);
    await page.getByText('私有参考附件', { exact: true }).click();
    for (const [filename, fixture] of Object.entries(fixtures)) {
        await page.getByLabel('选择附件').setInputFiles({
            name: filename,
            mimeType: 'application/octet-stream',
            buffer: Buffer.from(fixture.content),
        });
        await page.getByRole('button', { name: '上传附件', exact: true }).press('Enter');
        await expect(page.getByText(filename, { exact: true })).toBeVisible();
    }
    await page.getByRole('button', { name: '查看内容', exact: true }).click();
    await expect(page.getByText('<b>文本原样保留</b>', { exact: true })).toBeVisible();
    const pdf = page.locator('li').filter({
        has: page.getByText('PDF · 可下载原文件', { exact: true }),
    });
    await expect(pdf.getByRole('button', { name: '查看内容', exact: true })).toHaveCount(0);
    const [download] = await Promise.all([
        page.waitForEvent('download'),
        pdf.getByRole('button', { name: '下载原文件' }).click(),
    ]);
    expect(download.suggestedFilename()).toBe('资料.pdf');
    expect(await readFile((await download.path())!, 'utf8')).toBe(fixtures['资料.pdf'].content);
});
