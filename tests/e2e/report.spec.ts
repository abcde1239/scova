import { logoutFromAccount, expectAccountReady } from './support/account-menu.ts';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { classifyReportDelivery, type Report } from '@scova/models';

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
    await page.route(`**/api/v1/reports/${id(1)}`, (route) => route.fulfill({ json: report() }));
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
            await expect(page.locator('.report-delivery')).toContainText(
                {
                    answered: '核心问题已回答',
                    partial: '已生成部分答案',
                    sources_only: '已保存来源资料',
                }[status],
            );
            const evidence = page.locator(`#evidence-${saved.evidence[0].id}`);
            await evidence.locator('summary').click();
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

test('报告交付物优先，宽屏并排对话、窄屏正文在前，保留原运行日志入口', async ({ page }) => {
    await samples(page);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(reportPath);
    await expect(article(page)).toBeVisible();
    const main = await page.getByRole('main').boundingBox();
    expect(main!.width).toBeGreaterThan(1300);
    const content = await page.locator('.report-content').boundingBox();
    const companion = await page.locator('.report-companion').boundingBox();
    expect(companion!.x).toBeGreaterThanOrEqual(content!.x + content!.width);
    expect(Math.abs(companion!.y - content!.y)).toBeLessThan(1);
    expect(content!.width).toBeGreaterThan(companion!.width * 1.5);
    const baseline = await page.locator('.report-baseline').boundingBox();
    expect(baseline!.x).toBe(companion!.x);
    expect(baseline!.y).toBeGreaterThanOrEqual(companion!.y + companion!.height);
    await expect(page.locator('.report-content .report-changes')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '对话与后续研究', exact: true })).toBeVisible();
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
        const body = await page.locator('.report-content').boundingBox();
        const following = await page.locator('.report-companion').boundingBox();
        expect(following!.y).toBeGreaterThanOrEqual(body!.y + body!.height);
        const jump = tools.getByRole('link', { name: '正文', exact: true });
        await expect(jump).toHaveClass(/n-button/);
        expect((await jump.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        await jump.focus();
        await jump.press('Enter');
        await expect(page.locator('#summary-title')).toBeFocused();
        const section = page.locator('.bookmarks-tool');
        await expect(section.locator('.report-bookmarks')).toBeHidden();
        expect((await section.boundingBox())!.width).toBeLessThanOrEqual(width);
    }
});

test('专注阅读与对话定位保留问题和笔记草稿，切换不发起研究请求', async ({ page }) => {
    const state = await formatSamples(page);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(reportPath);
    const question = page.getByLabel('问题', { exact: true });
    await page.getByRole('button', { name: '总结主要发现', exact: true }).click();
    await expect(question).toHaveValue('请总结这份报告的主要发现。');
    await expect(question).toBeFocused();
    await question.fill('阅读模式切换时保留的问题');
    await page.locator('.notes-tool > summary').click();
    await page.getByRole('button', { name: '新建笔记', exact: true }).click();
    const draft = page.getByLabel('本地笔记正文', { exact: true });
    await draft.fill('阅读模式切换时保留的笔记');
    const editor = await page.locator('.note-editor').elementHandle();
    const questions = await page.locator('.questions').elementHandle();
    const focus = page.getByRole('button', { name: '专注阅读', exact: true });
    await focus.click();
    await expect(page.locator('.report-companion')).toBeHidden();
    await expect(page.locator('.report-baseline')).toBeHidden();
    await expect(page.getByRole('region', { name: '报告交付物' })).toBeVisible();
    await expect(page.getByRole('button', { name: '显示对话', exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
    );
    await page.getByRole('button', { name: '围绕报告提问', exact: true }).click();
    await expect(question).toBeFocused();
    await expect(question).toHaveValue('阅读模式切换时保留的问题');
    await expect(draft).toHaveValue('阅读模式切换时保留的笔记');
    expect(await editor!.evaluate((element) => element.isConnected)).toBe(true);
    expect(await questions!.evaluate((element) => element.isConnected)).toBe(true);
    await page.setViewportSize({ width: 320, height: 844 });
    await page.getByRole('button', { name: '专注阅读', exact: true }).click();
    await expect(question).toBeHidden();
    await page.getByRole('button', { name: '围绕报告提问', exact: true }).click();
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
    await expect(page.getByLabel('问题', { exact: true })).toBeVisible();
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
    await expect(article(page)).toBeVisible();
    await expect(page.getByRole('note', { name: '查阅范围说明' })).toContainText(
        '未覆盖项目和来源详情见下方',
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
    await page.getByRole('link', { name: '查看完整限制与缺口' }).click();
    await expect(page.getByText(id(4), { exact: true })).toBeVisible();
    await expect(page.locator('.coverage summary')).toBeFocused();
    const citation = page.locator('details.evidence').first();
    const toggle = citation.locator('summary');
    await toggle.focus();
    await toggle.press('Enter');
    await expect(citation.locator('blockquote')).toHaveText(report().evidence[0]!.quote);
    await expect(citation).toContainText('第 2 段，第 10–28 字符');
    await expect(citation).toContainText('2026-10-31T01:00:00Z');
    await expect(citation).toContainText('完整采集正文过期后引用仍保留');
    const link = citation.getByRole('link', { name: '打开原始来源（新窗口）' });
    await expect(link).toHaveAttribute('href', 'https://example.test/original');
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
    await expect(page.getByLabel('报告形式', { exact: true })).toHaveValue('comparison');
    await page.locator('.coverage summary').press('Enter');
    await expect(page.getByText('本次计划范围内查阅完成，不代表穷尽互联网资料。')).toBeVisible();
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
    await expect(page.getByRole('status')).toContainText('报告暂时无法读取');
    offline = false;
    await page.getByRole('button', { name: '重试', exact: true }).press('Enter');
    await expect(article(page)).toBeVisible();
    await page.locator('details.evidence summary').first().click();
    await expect(page.locator('blockquote').first()).toBeVisible();
    await page.getByLabel('报告形式', { exact: true }).selectOption('list');
    await expect(page.locator('.report-topic-list')).toBeVisible();
    await logoutFromAccount(page);
    await expect(page.locator('article, blockquote')).toHaveCount(0);
    await expect(page.getByLabel('报告形式', { exact: true })).toHaveCount(0);
    await page.getByLabel('邮箱', { exact: true }).fill('reader@example.test');
    await page.getByLabel('密码', { exact: true }).fill('local-only-password');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('报告不存在或当前账号无法访问');
    await expect(page.locator('article, blockquote')).toHaveCount(0);
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
        await expect(article(page)).toBeVisible();
        await page.locator('details.evidence summary').first().click();
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
    test(`问题型交付物视觉区分 ${width}：清单卡片、信息表格、研究章节与右侧基线`, async ({
        page,
    }, info) => {
        test.setTimeout(90_000);
        const saved = questionReport();
        const state = await formatSamples(page, saved);
        await page.setViewportSize({ width, height: 1000 });
        await page.goto(reportPath);
        const selector = page.getByLabel('报告形式', { exact: true });
        for (const dark of [false, true]) {
            await page.emulateMedia({ colorScheme: dark ? 'dark' : 'light' });
            await expect(page.locator('.scova-theme--dark')).toHaveCount(dark ? 1 : 0);
            for (const enlarged of [false, true]) {
                await page.evaluate(
                    (value) => (document.documentElement.style.fontSize = value ? '200%' : ''),
                    enlarged,
                );
                for (const [format] of formats) {
                    await selector.selectOption(format);
                    const answers = page.locator(`.answers--${format}`);
                    await expect(answers).toBeVisible();
                    await expect(answers.locator('.answer')).toHaveCount(2);
                    await expect(answers).toContainText('仅限当前保存版本');
                    await expect(
                        page.locator(
                            '.report-content .report-changes, .report-content .comparison-context',
                        ),
                    ).toHaveCount(0);
                    await expect(page.locator('.report-baseline')).toBeVisible();
                    await expect(answers.locator('table')).toHaveCount(
                        format === 'comparison' ? 1 : 0,
                    );
                    if (format === 'comparison') {
                        await expect(answers.getByRole('columnheader')).toHaveText([
                            '研究问题',
                            '已收集信息与来源',
                        ]);
                        if (width < 1024 || enlarged)
                            expect(
                                await answers
                                    .locator('.answer-scroll')
                                    .evaluate(
                                        (element) => element.scrollWidth > element.clientWidth,
                                    ),
                            ).toBe(true);
                    }
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
                    const citations = answers.locator('.source-evidence details.evidence');
                    for (let i = 0; i < (await citations.count()); i++) {
                        const citation = citations.nth(i);
                        await citation.locator('summary').click();
                        expect(
                            await citation.locator('blockquote').evaluate((element) => {
                                const style = getComputedStyle(element);
                                return (
                                    (element.clientWidth -
                                        parseFloat(style.paddingLeft) -
                                        parseFloat(style.paddingRight)) /
                                    parseFloat(style.fontSize)
                                );
                            }),
                        ).toBeGreaterThanOrEqual(4);
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
            if (path === '/api/v1/me') return route.fulfill({ json: account(state.account) });
            if (path === `/api/v1/reports/${state.report.id}`) {
                await state.beforeReport?.();
                return route.fulfill({ json: state.report });
            }
            if (path === `/api/v1/tasks/${state.report.taskId}/feedback`)
                return route.fulfill({ json: { items: [] } });
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

async function assertFormatContent(page: Page, expected: Report) {
    const frame = page.locator('.report-frame');
    await expect(frame).toHaveCount(1);
    await expect(frame.locator('#report-title')).toHaveText(expected.title);
    await expect(frame.locator('.metadata')).toContainText(expected.taskVersionId);
    await expect(frame.locator('.metadata time')).toHaveAttribute('datetime', expected.publishedAt);
    const orderedClaims = claimKinds.flatMap((kind) =>
        expected.claims.filter((entry) => entry.kind === kind),
    );
    expect(
        await frame.locator('.claim').evaluateAll((elements) =>
            elements.map((element) => ({
                id: element.id.slice('claim-'.length),
                text: element.querySelector('.claim-text')!.textContent,
                confidence: element.querySelector('.confidence')!.textContent,
                evidenceIds: [...element.querySelectorAll('.citation')].map(
                    (entry) => entry.id.split('-evidence-')[1],
                ),
            })),
        ),
    ).toEqual(
        orderedClaims.map((entry) => ({
            id: entry.id,
            text: entry.text,
            confidence: `证据说明：${entry.confidenceLabel}`,
            evidenceIds: entry.evidenceIds,
        })),
    );
    expect(
        await frame.locator('.evidence-entry').evaluateAll((elements) =>
            elements.map((element) => ({
                id: element.id.slice('evidence-'.length),
                quote: element.querySelector('blockquote')!.textContent,
            })),
        ),
    ).toEqual(expected.evidence.map((entry) => ({ id: entry.id, quote: entry.quote })));
    for (const entry of expected.changes) {
        const row = page.locator(
            `.report-baseline .change-record[aria-labelledby="change-${entry.id}"]`,
        );
        await expect(row).toHaveCount(1);
        await expect(row).toContainText(entry.factKey);
        await expect(row).toContainText(entry.reason);
        for (const side of ['old', 'new'] as const) {
            const section = row.locator(`.${side}-side`);
            await expect(section).toContainText(
                entry[`${side}Value`] ?? `未提供${side === 'old' ? '旧' : '新'}值`,
            );
            expect(await section.locator('blockquote').allTextContents()).toEqual(
                entry[`${side}EvidenceIds`].map(
                    (evidenceId) =>
                        expected.evidence.find((evidence) => evidence.id === evidenceId)!.quote,
                ),
            );
        }
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
    test(`生产四视图：保存 ${savedFormat} 默认布局、全量集合、URL 与刷新恢复`, async ({ page }) => {
        const saved = formatReport();
        saved.format = savedFormat;
        const state = await formatSamples(page, saved);
        const url = `${reportPath}?questionId=${id(90)}&unknown=a&unknown=b&view=list&view=invalid#preserved`;
        await page.goto(url);
        await expect(page.locator(renderer)).toBeVisible();
        const selector = page.getByLabel('报告形式', { exact: true });
        await expect(selector).toHaveValue(savedFormat);
        const originalUrl = page.url();
        const reportReads = () =>
            state.calls.filter((entry) => entry.path === `/api/v1/reports/${saved.id}`).length;
        const reads = reportReads();
        for (const [format, active] of [...formats, ...formats].reverse()) {
            await selector.focus();
            await selector.selectOption(format);
            await expect(selector).toBeFocused();
            await expect(page.locator(active)).toBeVisible();
            await assertFormatContent(page, saved);
            const navigation = page.getByRole('navigation', { name: '报告内容导航', exact: true });
            for (const [label, target] of [
                ['正文', 'summary-title'],
                ['变化', 'report-changes-title'],
                ['来源', 'saved-evidence-title'],
            ]) {
                await navigation.getByRole('link', { name: label!, exact: true }).focus();
                await navigation.getByRole('link', { name: label!, exact: true }).press('Enter');
                await expect(page.locator(`#${target}`)).toBeFocused();
                expect(page.url()).toBe(originalUrl);
            }
            expect(page.url()).toBe(originalUrl);
            expect(reportReads()).toBe(reads);
        }
        expect(state.calls.filter((entry) => entry.method !== 'GET')).toEqual([]);
        expect(state.unexpected).toEqual([]);
        await page.reload();
        await expect(selector).toHaveValue(savedFormat);
        await expect(page.locator(renderer)).toBeVisible();
        expect(page.url()).toBe(originalUrl);
        expect(reportReads()).toBe(reads + 1);
        expect(state.report).toEqual(saved);
    });
}

test('生产四视图：格式切换保留未提交问题和同页笔记编辑器，换报告重置', async ({ page }) => {
    const state = await formatSamples(page);
    await page.goto(reportPath);
    const selector = page.getByLabel('报告形式', { exact: true });
    await expect(selector).toBeVisible();
    await page.getByLabel('问题', { exact: true }).fill('保留的未提交问题');
    const questions = await page.locator('.questions').elementHandle();
    const notes = await page.locator('.notes-panel').elementHandle();
    expect(notes).not.toBeNull();
    for (const [format] of formats) {
        await selector.selectOption(format);
        await expect(page.getByLabel('问题', { exact: true })).toHaveValue('保留的未提交问题');
        expect(await questions!.evaluate((element) => element.isConnected)).toBe(true);
        expect(await notes!.evaluate((element) => element.isConnected)).toBe(true);
    }
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
    await expect(selector).toHaveValue('research_report');
    expect(await notes!.evaluate((element) => element.isConnected)).toBe(true);
    state.report = { ...state.report, id: id(70), format: 'list', title: '另一份保存报告' };
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
        await expect(selector).toHaveValue('list');
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
        const state = await formatSamples(page);
        await page.setViewportSize({ width, height: 1000 });
        await page.goto(reportPath);
        const selector = page.getByLabel('报告形式', { exact: true });
        for (const enlarged of [false, true]) {
            await page.evaluate(
                (value) => (document.documentElement.style.fontSize = value ? '200%' : ''),
                enlarged,
            );
            for (const [format, renderer] of formats) {
                await selector.focus();
                await selector.selectOption(format);
                await expect(selector).toBeFocused();
                await expect(page.locator(renderer)).toBeVisible();
                await expect(page.locator('#report-title')).toBeVisible();
                await expect(page.getByRole('note', { name: '查阅范围说明' })).toBeVisible();
                const source = page.locator('.evidence-entry').first();
                await source.locator('summary').focus();
                await source.locator('summary').press('Enter');
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
