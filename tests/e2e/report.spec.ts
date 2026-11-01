import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

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

test.beforeAll(async ({ browser }) => {
    console.log(`Browser: Chromium ${browser.version()}`);
});

test('本地 HTTP 样本：partial 在正文前、四类结论、保存引用与安全原始链接', async ({ page }) => {
    await samples(page);
    const sourceRequests: string[] = [];
    page.on('request', (request) => {
        if (request.url().includes('example.test')) sourceRequests.push(request.url());
    });
    await page.goto(reportPath);
    await expect(article(page)).toBeVisible();
    await expect(page.getByRole('note', { name: '部分交付警告' })).toContainText(
        '不能据此认定没有重要变化',
    );
    expect(
        await page.evaluate(
            () =>
                !!(
                    document
                        .querySelector('[aria-label="部分交付警告"]')!
                        .compareDocumentPosition(document.getElementById('summary-title')!) &
                    Node.DOCUMENT_POSITION_FOLLOWING
                ),
        ),
    ).toBe(true);
    await expect(page.getByText('演示报告：来自演示数据，不代表真实查阅成果。')).toBeVisible();
    for (const name of ['来源事实', 'Agent 推断', '冲突证据', '证据不足'])
        await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
    await expect(page.getByText(id(4), { exact: true })).toBeVisible();
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
    ).toBeVisible();
    await expect(page.getByText('本次计划范围内查阅完成，不代表穷尽互联网资料。')).toBeVisible();
    await expect(page.getByRole('note', { name: '部分交付警告' })).toHaveCount(0);
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
    await page.getByRole('button', { name: '退出登录' }).click();
    await page.getByLabel('邮箱', { exact: true }).fill('reader@example.test');
    await page.getByLabel('密码', { exact: true }).fill('local-only-password');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${reportPath}$`));
    release();
    await expect(page.getByRole('status')).toContainText('报告不存在或当前账号无法访问');
    await expect(page.getByRole('button', { name: '退出登录' })).toBeVisible();
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
    await page.getByRole('button', { name: '退出登录' }).click();
    await expect(page.locator('article, blockquote')).toHaveCount(0);
    await page.getByLabel('邮箱', { exact: true }).fill('reader@example.test');
    await page.getByLabel('密码', { exact: true }).fill('local-only-password');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('报告不存在或当前账号无法访问');
    await expect(page.locator('article, blockquote')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '退出登录' })).toBeVisible();
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
