import { logoutFromAccount, expectAccountReady } from './support/account-menu.ts';
import { openReportTool } from './support/report-tools.ts';
import { expect, test } from '@playwright/test';
import type { Page, Route, TestInfo } from '@playwright/test';

// Controlled HTTP samples exercise the frozen production Web bundle, not real DB ownership.
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const reportPath = `/reports/${id(1)}`;
const sourceId = id(21);
const time = '2026-10-31T01:00:00Z';
const cursor = 'opaque+/=%游标';
const failure = (code = 'TEST_FAILURE') => ({ code, message: 'sample', requestId: 'sample' });
const account = (n = 100) => ({
    user: {
        id: id(n),
        email: 'reader@example.test',
        preferences: {
            defaultTimezone: 'UTC',
            notificationPreference: { mode: 'summary', runIssues: true },
        },
        createdAt: time,
    },
    csrfToken: 'bookmarks-test-only',
});

test('空列表只显示短提示，收藏和全部笔记不重复放置读取或创建按钮', async ({ page }, testInfo) => {
    await page.route('**/api/v1/me', (route) => route.fulfill({ json: account() }));
    for (const path of ['bookmarks', 'notes', 'notifications', 'inbox']) {
        await page.route(`**/api/v1/${path}**`, (route) =>
            route.fulfill({ json: { items: [], nextCursor: null } }),
        );
    }
    await page.goto('/library');
    const library = page.locator('#library-content');
    await expect(library.getByRole('status')).toHaveText('暂无收藏');
    await expect(library.locator('.library-toolbar button')).toHaveCount(0);
    await page
        .getByRole('navigation', { name: '资料库分区' })
        .getByRole('button', { name: '笔记', exact: true })
        .click();
    const notes = page.locator('.notes-panel');
    await expect(notes.getByRole('status')).toHaveText('暂无笔记');
    await expect(notes.getByRole('button')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('empty-notes.png'), fullPage: true });
    await page.goto('/notifications');
    const empty = page.locator('.state-panel--empty');
    await expect(empty).toHaveText('暂无通知');
    await expect(empty.getByRole('button')).toHaveCount(0);
    await page.goto('/inbox');
    await expect(empty.getByRole('status')).toHaveText('暂无报告');
    await expect(empty.getByRole('link', { name: '查看任务', exact: true })).toHaveAttribute(
        'href',
        '/tasks',
    );
    await expect(empty.getByRole('button')).toHaveCount(0);
});
function bookmark(n = 40, source = sourceId) {
    return {
        id: id(n),
        sourceId: source,
        createdAt: time,
        source: {
            id: source,
            canonicalUrl: `https://example.test/${source}`,
            title: `研究资料 ${n}：保留来源与历史证据`,
            latestSnapshotId: id(22),
            lastObservedAt: time,
        },
    };
}
function report() {
    const evidence = {
        id: id(20),
        sourceId,
        snapshotId: id(22),
        title: '研究资料说明',
        url: 'https://example.test/source',
        quote: '研究资料按批次公开。',
        location: '第 2 段，第 10–28 字符',
        observedAt: time,
        snapshot: {
            originalUrl: 'https://example.test/original',
            fetchedUrl: 'https://example.test/source',
            canonicalUrl: 'https://example.test/source',
            contentHash: 'a'.repeat(64),
            extractorVersion: 'reader-v1',
            publishedAt: null,
            truncated: true,
            selector: { type: 'text_offset', start: 10, end: 28, extractorVersion: 'reader-v1' },
        },
    };
    return {
        id: id(1),
        taskId: id(2),
        runId: id(3),
        taskVersionId: id(4),
        baselineRunId: null,
        schemaVersion: 1,
        title: '开放研究资料：可追溯的基础简报',
        summary: '资料的收藏与取消不会改变历史报告、来源引用和覆盖限制。',
        format: 'brief',
        mode: 'demo',
        outcome: 'inconclusive',
        coverage: {
            completeness: 'partial',
            searchedQueries: ['开放研究资料'],
            gaps: ['未完成交叉核验'],
            exhausted: [],
        },
        limitations: ['仅覆盖保存的来源片段'],
        claims: [
            {
                id: id(10),
                kind: 'fact',
                text: '研究资料按批次公开。',
                confidenceLabel: '来源原文',
                evidenceIds: [id(20)],
            },
        ],
        evidence: [evidence, { ...evidence, id: id(23), title: '同一来源的另一引用' }],
        changes: [],
        publishedAt: time,
    };
}
type Bookmark = ReturnType<typeof bookmark>;
type SampleState = {
    rows: Bookmark[];
    pageSize: number;
    postMode: 'success' | 'unknown' | 'reused';
    deleteStatus: number;
    listStatus: number;
    scanMode: 'normal' | 'fail' | 'loop' | 'duplicate';
    scanPages: number;
    writes: { method: string; path: string; body: string | null; csrf: string | undefined }[];
    reads: { limit: number; cursor: string | null }[];
    switched: boolean;
};
async function samples(page: Page, initial: Bookmark[] = []) {
    const state: SampleState = {
        rows: initial,
        pageSize: 1,
        postMode: 'success',
        deleteStatus: 204,
        listStatus: 200,
        scanMode: 'normal',
        scanPages: 2,
        writes: [],
        reads: [],
        switched: false,
    };
    await page.route('**/api/v1/me', (route) =>
        route.fulfill({ json: account(state.switched ? 101 : 100) }),
    );
    await page.route('**/api/v1/auth/logout', (route) => route.fulfill({ status: 204 }));
    await page.route('**/api/v1/auth/login', (route) => {
        state.switched = true;
        return route.fulfill({ json: account(101) });
    });
    await page.route(`**/api/v1/reports/${id(1)}`, (route) =>
        state.switched
            ? route.fulfill({ status: 404, json: failure() })
            : route.fulfill({ json: report() }),
    );
    await page.route('**/api/v1/bookmarks**', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const method = request.method();
        if (method !== 'GET') {
            state.writes.push({
                method,
                path: url.pathname,
                body: request.postData(),
                csrf: request.headers()['x-csrf-token'],
            });
            if (method === 'POST') {
                const target = request.postDataJSON() as { sourceId: string };
                const existing = state.rows.find((row) => row.sourceId === target.sourceId);
                const value = existing ?? bookmark(40, target.sourceId);
                if (!existing) state.rows.unshift(value);
                if (state.postMode === 'unknown')
                    return route.fulfill({ status: 503, json: failure() });
                const reused = !!existing || state.postMode === 'reused';
                return route.fulfill({
                    status: reused ? 200 : 201,
                    json: { bookmark: value, reused },
                });
            }
            if (state.deleteStatus !== 204)
                return route.fulfill({ status: state.deleteStatus, json: failure() });
            state.rows = state.rows.filter((row) => !url.pathname.endsWith(row.id));
            return route.fulfill({ status: 204 });
        }
        const limit = Number(url.searchParams.get('limit'));
        const currentCursor = url.searchParams.get('cursor');
        state.reads.push({ limit, cursor: currentCursor });
        if (state.switched) return route.fulfill({ json: { items: [], nextCursor: null } });
        if (state.listStatus !== 200)
            return route.fulfill({ status: state.listStatus, json: failure() });
        if (limit === 100) {
            const index = currentCursor === null ? 0 : Number(currentCursor.split(':').at(-1));
            if (state.scanMode === 'fail' && index > 0)
                return route.fulfill({ status: 503, json: failure() });
            if (state.scanMode === 'loop')
                return route.fulfill({
                    json: {
                        items: [bookmark(70 + index, id(70 + index))],
                        nextCursor: 'scan:1',
                    },
                });
            if (state.scanMode === 'duplicate')
                return route.fulfill({
                    json: { items: [bookmark(70, id(70))], nextCursor: index ? null : 'scan:1' },
                });
            const last = index >= state.scanPages - 1;
            return route.fulfill({
                json: {
                    items: last ? state.rows : [bookmark(70 + index, id(70 + index))],
                    nextCursor: last ? null : `scan:${index + 1}`,
                },
            });
        }
        const start = currentCursor === null ? 0 : state.pageSize;
        return route.fulfill({
            json: {
                items: state.rows.slice(start, start + state.pageSize),
                nextCursor: state.rows.length > start + state.pageSize ? cursor : null,
            },
        });
    });
    return state;
}
const action = (page: Page) => page.locator('.report-bookmarks .bookmark-action');
const create = (page: Page) => action(page).getByRole('button', { name: '收藏来源', exact: true });
const verify = (page: Page) => action(page).getByRole('button', { name: '核对收藏状态' });
const entries = (page: Page) => page.locator('.bookmark-entry');
async function openReport(page: Page) {
    await page.goto(reportPath);
    await openReportTool(page, 'bookmarks');
    const selector = page.getByRole('combobox', { name: '选择收藏来源', exact: true });
    await expect(selector.locator('option')).toHaveCount(2);
    await selector.focus();
    await selector.press('ArrowDown');
    await selector.press('Enter');
    await expect(action(page)).toBeVisible();
}
async function switchAccount(page: Page) {
    await logoutFromAccount(page);
    await page.getByLabel('邮箱', { exact: true }).fill('other@example.test');
    await page.getByLabel('密码', { exact: true }).fill('local-only-password');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expectAccountReady(page);
}
async function screenshot(page: Page, info: TestInfo, name: string) {
    await info.attach(name, {
        body: await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true }),
        contentType: 'image/png',
    });
}
test.beforeAll(async ({ browser }) => console.log(`Browser: Chromium ${browser.version()}`));

test('HTTP sample: report create201, library context, delete204 and original citations survive', async ({
    page,
}) => {
    const state = await samples(page);
    const external: string[] = [];
    page.on('request', (request) => {
        if (request.url().startsWith('https://example.test/')) external.push(request.url());
    });
    await openReport(page);
    const original = await page.locator('.report-brief').innerText();
    await expect(action(page)).not.toContainText('未收藏');
    await create(page).press('Enter');
    await expect(page.locator('.scova-notifications .n-notification').last()).toContainText(
        '已收藏来源',
    );
    expect(state.writes).toEqual([
        {
            method: 'POST',
            path: '/api/v1/bookmarks',
            body: JSON.stringify({ sourceId }),
            csrf: 'bookmarks-test-only',
        },
    ]);
    await action(page).getByRole('link', { name: '查看收藏' }).press('Enter');
    await expect(entries(page)).toHaveCount(1);
    await expect(entries(page).getByRole('link', { name: '返回刚才的报告' })).toHaveAttribute(
        'href',
        reportPath,
    );
    const externalLink = entries(page).getByRole('link', { name: '打开原始来源（新窗口）' });
    await expect(externalLink).toHaveAttribute('target', '_blank');
    await expect(externalLink).toHaveAttribute('rel', 'noopener noreferrer');
    const details = entries(page).locator('.source-details');
    await expect(details.locator('p')).toBeHidden();
    await details.locator('summary').focus();
    await details.locator('summary').press('Enter');
    await expect(details.locator('p')).toHaveText(bookmark().source.canonicalUrl);
    await expect(details.locator('time').first()).toHaveAttribute('datetime', bookmark().createdAt);
    await expect(externalLink).toBeVisible();
    await details.locator('summary').press('Space');
    await expect(details.locator('p')).toBeHidden();
    expect(state.writes).toHaveLength(1);
    await entries(page).getByRole('button', { name: '取消收藏', exact: true }).press('Space');
    await expect(entries(page)).toHaveCount(0);
    await expect(page.locator('#library-content')).toBeFocused();
    expect(state.writes.at(-1)?.method).toBe('DELETE');
    expect(state.writes.at(-1)?.path).toBe(`/api/v1/bookmarks/${id(40)}`);
    await page.goBack();
    await expect(page.locator('.report-brief')).toHaveText(original, { useInnerText: true });
    await page.locator('.evidence-source-group > summary').first().press('Enter');
    await expect(page.locator('blockquote').first()).toHaveText(report().evidence[0]!.quote);
    await expect(page.locator('.report-brief img')).toHaveCount(0);
    expect(external).toEqual([]);
    expect(state.writes.every((write) => /\/bookmarks(?:\/|$)/.test(write.path))).toBe(true);
});

test('HTTP sample: existing source on a later page is not absent and POST200 reuses its record', async ({
    page,
}) => {
    const state = await samples(page, [bookmark(41, id(31)), bookmark()]);
    await page.goto('/library');
    await expect(entries(page)).toHaveCount(1);
    await page.goto(reportPath);
    await openReportTool(page, 'bookmarks');
    await openReportTool(page, 'bookmarks');
    await page.getByLabel('选择收藏来源').selectOption(sourceId);
    await expect(create(page)).toBeEnabled();
    await expect(action(page)).not.toContainText('未收藏');
    await create(page).click();
    await expect(page.locator('.scova-notifications .n-notification').last()).toContainText(
        '复用现有收藏',
    );
    expect(state.rows).toHaveLength(2);
    expect(state.writes).toHaveLength(1);
});

test('HTTP sample: unknown POST scans three pages to find target, never replays the write', async ({
    page,
}) => {
    const state = await samples(page);
    state.postMode = 'unknown';
    state.scanPages = 3;
    await openReport(page);
    await create(page).click();
    await expect(action(page)).toContainText('结果尚待核对');
    await expect(create(page)).toBeDisabled();
    await verify(page).press('Enter');
    await expect(page.locator('.scova-notifications .n-notification').last()).toContainText(
        '已核对：来源已收藏',
    );
    expect(state.reads.filter((read) => read.limit === 100)).toEqual([
        { limit: 100, cursor: null },
        { limit: 100, cursor: 'scan:1' },
        { limit: 100, cursor: 'scan:2' },
    ]);
    await expect(action(page).getByRole('button', { name: '取消收藏', exact: true })).toBeEnabled();
    expect(state.writes).toHaveLength(1);
});

test('HTTP sample: DELETE404 stays locked until real terminal page confirms absence', async ({
    page,
}) => {
    const state = await samples(page, [bookmark()]);
    await openReport(page);
    await verify(page).click();
    const remove = action(page).getByRole('button', { name: '取消收藏', exact: true });
    await expect(remove).toBeEnabled();
    state.deleteStatus = 404;
    await remove.click();
    await expect(page.locator('.scova-notifications .n-notification').last()).toContainText(
        '请核对收藏状态',
    );
    await expect(remove).toBeDisabled();
    state.rows = [];
    state.scanPages = 3;
    state.reads = [];
    await verify(page).click();
    await expect(page.locator('.scova-notifications .n-notification').last()).toContainText(
        '已核对完整收藏列表：来源当前未收藏',
    );
    await expect(create(page)).toBeEnabled();
    expect(state.reads.filter((read) => read.limit === 100)).toHaveLength(3);
});

for (const mode of ['fail', 'loop', 'duplicate'] as const) {
    test(`HTTP sample: ${mode} scan retains unknown lock; genuine new complete GET unlocks`, async ({
        page,
    }) => {
        const state = await samples(page);
        state.postMode = 'unknown';
        state.scanMode = mode;
        await openReport(page);
        await create(page).click();
        await verify(page).click();
        await expect(action(page).getByRole('alert')).toBeVisible();
        await expect(create(page)).toBeDisabled();
        await expect(action(page)).toContainText('结果尚待核对');
        expect(state.writes).toHaveLength(1);
        state.scanMode = 'normal';
        await verify(page).click();
        await expect(page.locator('.scova-notifications .n-notification').last()).toContainText(
            '已核对：来源已收藏',
        );
        await expect(
            action(page).getByRole('button', { name: '取消收藏', exact: true }),
        ).toBeEnabled();
    });
}

test('HTTP sample: canceled verification and ordinary list seed cannot unlock after remount', async ({
    page,
}) => {
    const state = await samples(page);
    state.postMode = 'unknown';
    await openReport(page);
    await create(page).click();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    let started = false;
    const held = async (route: Route) => {
        if (new URL(route.request().url()).searchParams.get('limit') === '100') {
            started = true;
            await gate;
        }
        await route.fallback();
    };
    await page.route('**/api/v1/bookmarks**', held);
    await verify(page).click();
    await expect.poll(() => started).toBe(true);
    await action(page).getByRole('link', { name: '查看收藏' }).click();
    await expect(entries(page)).toHaveCount(1);
    await expect(
        entries(page).getByRole('button', { name: '取消收藏', exact: true }),
    ).toBeDisabled();
    release();
    await page.unroute('**/api/v1/bookmarks**', held);
    await entries(page).getByRole('link', { name: '返回刚才的报告' }).click();
    await openReportTool(page, 'bookmarks');
    await page.getByLabel('选择收藏来源').selectOption(sourceId);
    await expect(action(page)).toContainText('结果尚待核对');
    await expect(
        action(page).getByRole('button', { name: '取消收藏', exact: true }),
    ).toBeDisabled();
    await verify(page).click();
    await expect(page.locator('.scova-notifications .n-notification').last()).toContainText(
        '已核对：来源已收藏',
    );
    expect(state.writes).toHaveLength(1);
});

test('HTTP sample: pending command blocks duplicate mouse/key and all source actions', async ({
    page,
}) => {
    const state = await samples(page);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    let posted = 0;
    await page.route('**/api/v1/bookmarks', async (route) => {
        if (route.request().method() === 'POST') {
            posted++;
            await gate;
        }
        await route.fallback();
    });
    await openReport(page);
    const button = create(page);
    await button.focus();
    await button.press('Enter');
    await expect.poll(() => posted).toBe(1);
    await button.press('Enter');
    await button.press('Space');
    await expect(button).toBeDisabled();
    await expect(page.getByLabel('选择收藏来源')).toBeDisabled();
    await expect(verify(page)).toBeDisabled();
    expect(posted).toBe(1);
    release();
    await expect(page.locator('.scova-notifications .n-notification').last()).toContainText(
        '已收藏来源',
    );
    expect(state.writes).toHaveLength(1);
});

test('HTTP sample: unknown pending write survives unmount; late result does not falsely confirm', async ({
    page,
}) => {
    const state = await samples(page);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    let posted = false;
    const held = async (route: Route) => {
        if (route.request().method() === 'POST') {
            posted = true;
            await gate;
        }
        await route.fallback();
    };
    await page.route('**/api/v1/bookmarks', held);
    await openReport(page);
    await create(page).click();
    await expect.poll(() => posted).toBe(true);
    await action(page).getByRole('link', { name: '查看收藏' }).click();
    await expect(page.locator('#library-content')).toBeVisible();
    release();
    await expect.poll(() => state.writes.length).toBe(1);
    await page.goBack();
    await openReportTool(page, 'bookmarks');
    await page.getByLabel('选择收藏来源').selectOption(sourceId);
    await expect(action(page)).toContainText('结果尚待核对');
    await expect(create(page)).toBeDisabled();
    await verify(page).click();
    await expect(page.locator('.scova-notifications .n-notification').last()).toContainText(
        '已核对：来源已收藏',
    );
});

test('HTTP sample: opaque pagination retry/back and deleting later page resets home/focus', async ({
    page,
}) => {
    const state = await samples(page, [bookmark(41, id(31)), bookmark()]);
    await page.goto('/library');
    await expect(entries(page)).toContainText('研究资料 41');
    state.listStatus = 503;
    await page.getByRole('button', { name: '下一页', exact: true }).press('Enter');
    await expect(page.getByRole('alert')).toContainText('暂时无法读取');
    state.listStatus = 200;
    await page.getByRole('button', { name: '重新读取本页', exact: true }).press('Enter');
    await expect(entries(page)).toContainText('研究资料 40');
    expect(state.reads.at(-1)).toEqual({ limit: 25, cursor });
    await entries(page).getByRole('button', { name: '取消收藏', exact: true }).press('Enter');
    await expect(entries(page)).toContainText('研究资料 41');
    await expect(page.locator('#library-content')).toBeFocused();
    await expect(page.getByRole('button', { name: '上一页', exact: true })).toHaveCount(0);
    expect(state.reads.at(-1)).toEqual({ limit: 25, cursor: null });
    await entries(page).getByRole('button', { name: '取消收藏', exact: true }).press('Enter');
    await expect(entries(page)).toHaveCount(0);
    await expect(page.locator('#library-content')).toBeFocused();
});

test('HTTP sample: keyboard paging endpoint disappearance restores focus', async ({ page }) => {
    await samples(page, [bookmark(41, id(31)), bookmark()]);
    await page.goto('/library');
    await page.getByRole('button', { name: '下一页', exact: true }).press('Space');
    await expect(entries(page)).toContainText('研究资料 40');
    await expect(page.locator('#library-content')).toBeFocused();
    await page.getByRole('button', { name: '上一页', exact: true }).press('Enter');
    await expect(entries(page)).toContainText('研究资料 41');
    await expect(page.locator('#library-content')).toBeFocused();
});

test('HTTP sample: delete completion does not steal focus moved by the user', async ({ page }) => {
    await samples(page, [bookmark()]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    let deleting = false;
    await page.route('**/api/v1/bookmarks/*', async (route) => {
        deleting = true;
        await gate;
        await route.fallback();
    });
    await page.goto('/library');
    await entries(page).getByRole('button', { name: '取消收藏', exact: true }).press('Enter');
    await expect.poll(() => deleting).toBe(true);
    const notification = page
        .getByRole('navigation', { name: '全局工具' })
        .getByRole('button', { name: '通知', exact: true });
    await notification.focus();
    release();
    await expect(entries(page)).toHaveCount(0);
    await expect(notification).toBeFocused();
});

for (const old of ['null', 'old-id'] as const) {
    test(`HTTP sample: validated list supersedes ${old} source cache and deletes current id`, async ({
        page,
    }) => {
        const state = await samples(page, old === 'old-id' ? [bookmark(45)] : []);
        await openReport(page);
        await verify(page).click();
        await expect(page.locator('.scova-notifications .n-notification').last()).toContainText(
            old === 'old-id' ? '来源已收藏' : '来源当前未收藏',
        );
        state.rows = [bookmark(46)];
        await action(page).getByRole('link', { name: '查看收藏' }).click();
        await expect(entries(page)).toContainText('研究资料 46');
        await entries(page).getByRole('button', { name: '取消收藏', exact: true }).click();
        await expect(entries(page)).toHaveCount(0);
        expect(state.writes.at(-1)?.path).toBe(`/api/v1/bookmarks/${id(46)}`);
    });
}

test('HTTP sample: origin context only matches chosen source; reload/direct entry drops nonce', async ({
    page,
}) => {
    await samples(page, [bookmark(), bookmark(41, id(31))]);
    await openReport(page);
    await action(page).getByRole('link', { name: '查看收藏' }).click();
    await expect(page.getByRole('link', { name: '返回刚才的报告' })).toHaveCount(1);
    await page.getByRole('button', { name: '下一页', exact: true }).click();
    await expect(entries(page)).toContainText('研究资料 41');
    await expect(page.getByRole('link', { name: '返回刚才的报告' })).toHaveCount(0);
    await page.getByRole('button', { name: '上一页', exact: true }).click();
    await expect(page.getByRole('link', { name: '返回刚才的报告' })).toHaveCount(1);
    await page.reload();
    await expect(entries(page)).toHaveCount(1);
    await expect(page.getByRole('link', { name: '返回刚才的报告' })).toHaveCount(0);
    await page.goto('/library');
    await expect(entries(page)).toHaveCount(1);
    await expect(page.getByRole('link', { name: '返回刚才的报告' })).toHaveCount(0);
});

for (const status of [403, 404, 503, 'protocol'] as const) {
    test(`HTTP sample: cached list handles ${status} without false current state`, async ({
        page,
    }) => {
        const state = await samples(page, [bookmark()]);
        await page.goto('/library');
        await expect(entries(page)).toHaveCount(1);
        if (status === 'protocol')
            await page.route('**/api/v1/bookmarks**', (route) =>
                route.fulfill({ body: '{broken', contentType: 'application/json' }),
            );
        else state.listStatus = status;
        await page.getByRole('button', { name: '重新读取本页', exact: true }).click();
        await expect(page.getByRole('alert')).toBeVisible();
        await expect(entries(page)).toHaveCount(status === 503 ? 1 : 0);
        if (status === 503)
            await expect(
                page.getByText('以下保留上次读取值，请重新读取以确认当前状态。'),
            ).toBeVisible();
    });
}

for (const late of [201, 401]) {
    test(`HTTP sample: old-account delayed POST${late} cannot populate new account`, async ({
        page,
    }) => {
        const state = await samples(page, [bookmark(41, id(31))]);
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let posted = false;
        await page.route('**/api/v1/bookmarks', async (route) => {
            if (route.request().method() !== 'POST') return route.fallback();
            posted = true;
            await gate;
            return route.fulfill({
                status: late,
                json: late === 201 ? { bookmark: bookmark(), reused: false } : failure(),
            });
        });
        await openReport(page);
        await create(page).click();
        await expect.poll(() => posted).toBe(true);
        await switchAccount(page);
        await expect(page.getByRole('status')).toContainText('报告不存在或当前账号无法访问');
        release();
        await page
            .getByRole('navigation', { name: '主导航' })
            .getByRole('link', { name: '资料库' })
            .click();
        await expect(page.getByText('暂无收藏')).toBeVisible();
        await expect(entries(page)).toHaveCount(0);
        await expect(page.getByRole('link', { name: '返回刚才的报告' })).toHaveCount(0);
        expect(state.switched).toBe(true);
        await expectAccountReady(page);
    });
}

for (const width of [320, 390, 768, 1024, 1440, 1920]) {
    test(`HTTP sample: ${width} light/dark, long text and 200% root text`, async ({
        page,
    }, info) => {
        const long = bookmark();
        long.source.title = '长期研究资料与来源条件对照：'.repeat(8);
        long.source.canonicalUrl = `https://example.test/${'verylongsource'.repeat(12)}`;
        const untitled = bookmark(41, id(31));
        const values: (
            | Bookmark
            | (Omit<Bookmark, 'source'> & {
                  source: Omit<Bookmark['source'], 'title' | 'lastObservedAt'> & {
                      title: null;
                      lastObservedAt: null;
                  };
              })
        )[] = [
            long,
            { ...untitled, source: { ...untitled.source, title: null, lastObservedAt: null } },
        ];
        const state = await samples(page, values as Bookmark[]);
        state.pageSize = 25;
        const errors: string[] = [];
        const external: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        page.on('request', (request) => {
            if (request.url().startsWith('https://example.test/')) external.push(request.url());
        });
        await page.setViewportSize({ width, height: 1000 });
        await page.goto('/library');
        await expect(entries(page)).toHaveCount(2);
        await page.evaluate(() => document.fonts.ready);
        await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
        await expect(page.getByRole('heading', { level: 1 })).toHaveText('资料库');
        await expect(entries(page).nth(1).getByRole('heading', { level: 2 })).toHaveText(
            untitled.source.canonicalUrl,
        );
        await expect(
            entries(page).nth(1).getByText(untitled.source.canonicalUrl, { exact: true }),
        ).toHaveCount(1);
        for (const dark of [false, true]) {
            await page.emulateMedia({ colorScheme: dark ? 'dark' : 'light' });
            await expect(page.locator('.scova-theme--dark')).toHaveCount(dark ? 1 : 0);
            for (const enlarged of [false, true]) {
                await page.evaluate((value) => {
                    document.documentElement.style.fontSize = value ? '200%' : '';
                }, enlarged);
                expect(
                    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
                ).toBe(true);
                for (const button of await entries(page).getByRole('button').all()) {
                    const box = await button.boundingBox();
                    expect(box!.height).toBeGreaterThanOrEqual(enlarged ? 88 : 44);
                    expect(
                        await button.evaluate((element) => getComputedStyle(element).cursor),
                    ).toBe('pointer');
                }
                expect(
                    await entries(page)
                        .first()
                        .getByRole('heading', { level: 2 })
                        .evaluate((element) => getComputedStyle(element).fontFamily),
                ).toContain('Noto Serif SC');
                await screenshot(
                    page,
                    info,
                    `library-${width}-${dark ? 'dark' : 'light'}${enlarged ? '-text-200' : ''}`,
                );
            }
        }
        await expect(entries(page).locator('img')).toHaveCount(0);
        expect(external).toEqual([]);
        expect(errors).toEqual([]);
    });
}
