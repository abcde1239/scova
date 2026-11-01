import { expect, test, type Page } from '@playwright/test';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const sourceId = id(21);
const snapshotId = id(22);
const runId = id(31);
const secondRunId = id(32);
const taskId = id(41);
const taskVersionId = id(42);
const reportId = id(51);
const time = '2026-10-31T01:00:00.000Z';
const cursor = 'opaque+/=%E6%B8%B8%E6%A0%87';
const failure = (code = 'TEST_FAILURE') => ({
    code,
    message: 'sample',
    requestId: 'source-history-e2e',
});
const account = (n = 100) => ({
    user: {
        id: id(n),
        email: `reader-${n}@example.test`,
        preferences: {
            defaultTimezone: 'UTC',
            notificationPreference: { mode: 'summary', runIssues: true },
        },
        createdAt: time,
    },
    csrfToken: 'source-history-e2e',
});

function snapshot(n: number, observedAt = time) {
    const value = id(n);
    return {
        id: value,
        sourceId,
        observationId: id(n + 100),
        runId: n === 22 ? runId : secondRunId,
        title: n === 22 ? '来源快照：研究资料' : '来源快照：第二页资料',
        canonicalUrl: 'https://example.test/canonical',
        originalUrl: 'https://example.test/original',
        fetchedUrl: 'https://example.test/fetched',
        contentHash: 'a'.repeat(64),
        extractorVersion: 'reader-v1',
        observedAt,
        publishedAt: '2026-10-30T23:00:00.000Z',
        textExpiresAt: null,
        bodyStatus: 'available' as const,
        mode: 'demo' as const,
        truncated: false,
    };
}

const body = '前缀：保存片段：中文😀后缀。正文仍是纯文本。';
const quote = '保存片段：中文😀';
const quoteStart = body.indexOf(quote);
const quoteEnd = quoteStart + quote.length;
function detail(overrides: Record<string, unknown> = {}) {
    return {
        snapshot: snapshot(22),
        textBody: body,
        quotes: [
            {
                id: id(61),
                runId,
                quote,
                quoteHash: 'b'.repeat(64),
                selector: {
                    type: 'text_offset' as const,
                    start: quoteStart,
                    end: quoteEnd,
                    extractorVersion: 'reader-v1',
                },
            },
        ],
        quotesTruncated: false,
        ...overrides,
    };
}
function run() {
    return {
        id: runId,
        taskId,
        taskVersionId,
        parentRunId: null,
        baselineRunId: null,
        mode: 'demo',
        status: 'succeeded',
        outcome: 'important_change',
        trigger: 'manual',
        budget: {
            maxSearches: 5,
            maxPages: 5,
            maxDurationSeconds: 60,
            maxInputTokens: 1000,
            maxOutputTokens: 500,
        },
        usage: { searches: 1, pages: 1, inputTokens: 10, outputTokens: 10, estimated: false },
        coverage: {
            completeness: 'complete',
            searchedQueries: ['研究资料'],
            gaps: [],
            exhausted: [],
        },
        queuedAt: time,
        startedAt: time,
        finishedAt: '2026-10-31T01:01:00.000Z',
        failureCode: null,
    };
}
function reportSummary() {
    return {
        id: reportId,
        runId,
        taskId,
        taskVersionId,
        title: '真实报告：研究资料',
        summary: '报告摘要',
        format: 'brief',
        mode: 'demo',
        outcome: 'important_change',
        coverage: {
            completeness: 'complete',
            searchedQueries: ['研究资料'],
            gaps: [],
            exhausted: [],
        },
        publishedAt: '2026-10-31T01:02:00.000Z',
    };
}
type State = {
    switched: boolean;
    listReads: { cursor: string | null }[];
    duplicatePage: boolean;
    detailStatus: number;
    listStatus: number;
    detailDelay: Promise<void> | null;
    releaseDetail: (() => void) | null;
    writes: string[];
};

async function installApi(page: Page, state: State) {
    await page.route('**/api/v1/**', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const path = url.pathname;
        if (request.method() !== 'GET') {
            state.writes.push(`${request.method()} ${path}`);
            if (path.endsWith('/auth/logout')) return route.fulfill({ status: 204 });
            if (path.endsWith('/auth/login')) {
                state.switched = true;
                return route.fulfill({ json: account(101) });
            }
            return route.fulfill({ status: 404, json: failure() });
        }
        if (path.endsWith('/me'))
            return route.fulfill({ json: account(state.switched ? 101 : 100) });
        if (path === `/api/v1/library/sources/${sourceId}/snapshots`) {
            if (state.listStatus !== 200)
                return route.fulfill({ status: state.listStatus, json: failure() });
            const value = url.searchParams.get('cursor');
            state.listReads.push({ cursor: value });
            if (!value)
                return route.fulfill({ json: { items: [snapshot(22)], nextCursor: cursor } });
            if (state.duplicatePage)
                return route.fulfill({ json: { items: [snapshot(22)], nextCursor: cursor } });
            if (value === cursor)
                return route.fulfill({
                    json: { items: [snapshot(23, '2026-10-30T01:00:00.000Z')], nextCursor: null },
                });
            return route.fulfill({ status: 400, json: failure('INVALID_CURSOR') });
        }
        if (path === `/api/v1/library/sources/${sourceId}/snapshots/${snapshotId}`) {
            if (state.detailDelay) await state.detailDelay;
            if (state.switched) return route.fulfill({ status: 401, json: failure() });
            if (state.detailStatus !== 200)
                return route.fulfill({ status: state.detailStatus, json: failure() });
            return route.fulfill({ headers: { date: new Date().toUTCString() }, json: detail() });
        }
        if (path === `/api/v1/runs/${runId}`) return route.fulfill({ json: run() });
        if (path === '/api/v1/reports')
            return route.fulfill({ json: { items: [reportSummary()], nextCursor: null } });
        if (path === `/api/v1/reports/${reportId}`)
            return route.fulfill({
                json: {
                    ...reportSummary(),
                    claims: [],
                    evidence: [],
                    changes: [],
                    limitations: [],
                },
            });
        return route.fulfill({ status: 404, json: failure() });
    });
}

function newState(): State {
    return {
        switched: false,
        listReads: [],
        duplicatePage: false,
        detailStatus: 200,
        listStatus: 200,
        detailDelay: null,
        releaseDetail: null,
        writes: [],
    };
}
async function openHistory(page: Page, snapshot = true) {
    await page.goto(`/library/sources/${sourceId}/snapshots${snapshot ? `/${snapshotId}` : ''}`);
    await expect(page.getByRole('heading', { name: '来源历史' })).toBeVisible();
}

test.beforeAll(async ({ browser }) => console.log(`Browser: Chromium ${browser.version()}`));

test('来源历史列表、opaque 分页、详情 quote 与真实 run→report 入口', async ({ page }) => {
    const state = newState();
    await installApi(page, state);
    const external: string[] = [];
    page.on('request', (request) => {
        if (request.url().includes('example.test')) external.push(request.url());
    });
    await openHistory(page);
    await expect(page.getByRole('link', { name: '来源快照：研究资料' })).toHaveAttribute(
        'aria-current',
        'page',
    );
    await expect(page.getByText('可用')).toBeVisible();
    await expect(page.getByRole('heading', { name: '来源快照：研究资料' })).toBeVisible();
    const citation = page.locator('details.saved-quote').first();
    await citation.locator('summary').press('Enter');
    await expect(citation.locator('blockquote')).toHaveText(quote);
    await expect(citation).toContainText(`${quoteStart}–${quoteEnd}`);
    await expect(citation).toContainText('reader-v1');
    await expect(citation).toContainText(id(61));
    await expect(page.getByRole('link', { name: '打开原始来源（新窗口）' })).toHaveAttribute(
        'rel',
        'noopener noreferrer',
    );
    expect(external).toEqual([]);
    await page.getByRole('button', { name: '下一页' }).click();
    await expect(page.getByRole('link', { name: '来源快照：第二页资料' })).toBeVisible();
    expect(state.listReads.map((read) => read.cursor)).toEqual([null, cursor]);
    await page.getByRole('button', { name: '上一页' }).click();
    await expect(page.getByRole('link', { name: '来源快照：研究资料' })).toBeVisible();
    await page.getByRole('button', { name: '从第一页重新读取' }).click();
    await expect.poll(() => state.listReads.length).toBeGreaterThanOrEqual(3);
    expect(state.listReads.at(-1)?.cursor).toBe(null);
    await page.getByRole('link', { name: '查看该次执行' }).first().click();
    await expect(page).toHaveURL(new RegExp(`/runs/${runId}$`));
    await expect(page.getByRole('link', { name: '查看已发布报告' })).toHaveAttribute(
        'href',
        `/reports/${reportId}`,
    );
});

test('正文到期后隐藏正文但保留 quotes，服务端 expired 也不回退旧正文', async ({ page }) => {
    const state = newState();
    await installApi(page, state);
    await page.route(`**/api/v1/library/sources/${sourceId}/snapshots/${snapshotId}`, (route) =>
        route.fulfill({
            headers: { date: new Date().toUTCString() },
            json: detail({
                snapshot: {
                    ...snapshot(22),
                    bodyStatus: 'expired',
                    textExpiresAt: '2026-10-30T00:00:00.000Z',
                },
                textBody: null,
            }),
        }),
    );
    await openHistory(page);
    await expect(page.getByRole('status')).toContainText('保存正文已过期');
    await expect(page.getByText(body, { exact: true })).toHaveCount(0);
    const citation = page.locator('details.saved-quote').first();
    await citation.locator('summary').press('Space');
    await expect(citation.locator('blockquote')).toHaveText(quote);
});

for (const status of [403, 404, 409, 503]) {
    test(`详情 HTTP ${status} 不显示 stale full body`, async ({ page }) => {
        const state = newState();
        state.detailStatus = status;
        await installApi(page, state);
        await openHistory(page);
        await expect(page.getByRole('alert')).toContainText(
            status === 409 ? '校验失败' : status === 503 ? '暂时无法读取' : '不存在',
        );
        await expect(page.getByText(body, { exact: true })).toHaveCount(0);
        await expect(page.locator('details.saved-quote')).toHaveCount(0);
    });
}

test('分页重复 cursor 或重复 item 会阻止继续读取并提供从第一页恢复', async ({ page }) => {
    const state = newState();
    state.duplicatePage = true;
    await installApi(page, state);
    await openHistory(page, false);
    await page.getByRole('button', { name: '下一页' }).click();
    await expect(page.getByRole('alert')).toContainText('校验失败');
    await expect(page.getByRole('button', { name: '从第一页重新读取' })).toBeEnabled();
});

test('切换账号后迟到的旧账号响应不能恢复旧快照', async ({ page }) => {
    const state = newState();
    let release!: () => void;
    state.detailDelay = new Promise<void>((resolve) => (release = resolve));
    await installApi(page, state);
    const detailRequested = page.waitForRequest(
        (request) =>
            request.method() === 'GET' &&
            new URL(request.url()).pathname ===
                `/api/v1/library/sources/${sourceId}/snapshots/${snapshotId}`,
    );
    await page.goto(`/library/sources/${sourceId}/snapshots/${snapshotId}`, {
        waitUntil: 'domcontentloaded',
    });
    await detailRequested;
    await expect(page.getByRole('status').filter({ hasText: '正在读取保存快照' })).toBeVisible();
    await page.getByRole('button', { name: '退出登录' }).click();
    await page.getByLabel('邮箱', { exact: true }).fill('reader-101@example.test');
    await page.getByLabel('密码', { exact: true }).fill('local-only-password');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('button', { name: '退出登录' })).toBeVisible();
    release();
    await expect(page.getByText(body, { exact: true })).toHaveCount(0);
    await expect(page.locator('article.snapshot-detail')).toHaveCount(0);
    expect(state.writes).toContain('POST /api/v1/auth/logout');
});

test('无效 owner/source/snapshot 地址不会发读取请求且页面无横向溢出', async ({ page }) => {
    const state = newState();
    await installApi(page, state);
    await page.goto('/library/sources/not-a-uuid/snapshots/not-a-uuid');
    await expect(page.getByRole('alert')).toContainText('地址无效');
    expect(state.listReads).toEqual([]);
    await page.setViewportSize({ width: 320, height: 800 });
    await expect(page.locator('body')).toHaveJSProperty('scrollWidth', 320);
});

for (const colorScheme of ['light', 'dark'] as const) {
    for (const width of [320, 390, 768, 1024, 1440, 1920]) {
        test(`响应式 ${colorScheme} ${width}px、200% 根字号保持可读且无横向溢出`, async ({
            page,
        }) => {
            const state = newState();
            await installApi(page, state);
            await page.emulateMedia({ colorScheme });
            await page.setViewportSize({ width, height: 900 });
            await openHistory(page);
            await page.evaluate(() => {
                document.documentElement.style.fontSize = '200%';
            });
            await expect(page.locator('body')).toHaveJSProperty('scrollWidth', width);
            await expect(page.getByRole('heading', { name: '来源快照：研究资料' })).toBeVisible();
            await expect(page.getByRole('button', { name: '从第一页重新读取' })).toHaveCSS(
                'cursor',
                'pointer',
            );
            await page.getByRole('link', { name: '查看该次执行' }).first().focus();
            await expect(page.getByRole('link', { name: '查看该次执行' }).first()).toBeFocused();
        });
    }
}
