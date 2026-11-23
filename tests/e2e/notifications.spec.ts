import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import type { ResearchNotification } from '../../packages/models/src/notifications.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const instant = '2026-10-31T02:00:00Z';
const cursor = 'same-time:+/ cursor=第二页';
function item(n: number): ResearchNotification {
    const kind = (['summary', 'important_change', 'run_issue'] as const)[(n - 1) % 3]!;
    const partial = kind === 'run_issue' && n % 2 === 0;
    return {
        id: id(n),
        runId: id(100 + n),
        taskId: id(200),
        reportId: kind !== 'run_issue' || partial ? id(300 + n) : null,
        kind,
        runStatus: kind === 'run_issue' ? (partial ? 'partial' : 'failed') : 'succeeded',
        mode: n % 2 ? 'demo' : 'live',
        failureCode: kind === 'run_issue' ? 'NO_EVIDENCE' : null,
        createdAt: instant,
        readAt: n > 12 ? instant : null,
    };
}
function report(entry: ResearchNotification) {
    return {
        id: entry.reportId!,
        runId: entry.runId,
        taskId: entry.taskId,
        taskVersionId: id(500),
        baselineRunId: null,
        schemaVersion: 1,
        title: '可追溯的研究报告',
        summary: '依据保存来源整理结论，并保留查阅限制。',
        format: 'brief',
        mode: entry.mode,
        outcome: 'inconclusive',
        coverage: {
            completeness: entry.runStatus === 'partial' ? 'partial' : 'complete',
            searchedQueries: ['研究'],
            gaps: [],
            exhausted: [],
        },
        limitations: ['仅代表本次来源范围'],
        claims: [
            {
                id: id(601),
                kind: 'fact',
                text: '来源资料按批次公开。',
                confidenceLabel: '仅代表来源陈述',
                evidenceIds: [id(602)],
            },
        ],
        evidence: [
            {
                id: id(602),
                sourceId: id(603),
                snapshotId: id(604),
                title: '来源说明',
                url: 'https://example.test/source',
                quote: '资料按批次公开。',
                location: '第2段',
                observedAt: instant,
            },
        ],
        changes: [],
        publishedAt: instant,
    };
}
function run(entry: ResearchNotification) {
    return {
        id: entry.runId,
        taskId: entry.taskId,
        taskVersionId: id(500),
        parentRunId: null,
        baselineRunId: null,
        mode: entry.mode,
        status: 'failed',
        outcome: null,
        trigger: 'manual',
        budget: {
            maxSearches: 2,
            maxPages: 3,
            maxDurationSeconds: 60,
            maxInputTokens: 1000,
            maxOutputTokens: 500,
        },
        usage: { searches: 2, pages: 1, inputTokens: 100, outputTokens: 20, estimated: true },
        coverage: null,
        queuedAt: instant,
        startedAt: instant,
        finishedAt: instant,
        failureCode: 'NO_EVIDENCE',
    };
}
// Local HTTP samples exercise the production Web bundle, not database or delivery evidence.
async function samples(context: BrowserContext) {
    const state = {
        items: Array.from({ length: 24 }, (_, index) => item(index + 1)),
        failure: null as number | 'protocol' | 'semantic' | 'cursor' | null,
        failureScope: 'all' as 'all' | 'next',
        patchFailure: 0,
        patchWait: undefined as Promise<void> | undefined,
        getWait: undefined as Promise<void> | undefined,
        getWaitFilter: 'all:all',
        firstPageSize: 3,
    };
    const calls: {
        method: string;
        path: string;
        cursor: string | null;
        kind: string | null;
        unread: string | null;
        body?: unknown;
        csrf?: string;
    }[] = [];
    await context.route('**/api/v1/**', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const path = url.pathname;
        if (path === '/api/v1/me')
            return route.fulfill({
                json: {
                    user: {
                        id: id(900),
                        email: 'notification@example.test',
                        createdAt: instant,
                        preferences: {
                            defaultTimezone: 'UTC',
                            notificationPreference: { mode: 'summary', runIssues: true },
                        },
                    },
                    csrfToken: 'sample-csrf',
                },
            });
        const body: unknown = request.method() === 'PATCH' ? request.postDataJSON() : undefined;
        const pageCursor = url.searchParams.get('cursor');
        const kind = url.searchParams.get('kind');
        const unread = url.searchParams.get('unread');
        calls.push({
            method: request.method(),
            path,
            cursor: pageCursor,
            kind,
            unread,
            body,
            csrf: request.headers()['x-csrf-token'],
        });
        const failure = (status: number, code = 'LOCAL_FAILURE') =>
            route.fulfill({ status, json: { code, message: 'local sample', requestId: 'sample' } });
        if (/^\/api\/v1\/reports\/[^/]+$/.test(path))
            return route.fulfill({
                json: report(
                    state.items.find((entry) => entry.reportId === path.split('/').at(-1))!,
                ),
            });
        if (path.startsWith('/api/v1/runs/')) {
            if (path.endsWith('/events'))
                return route.fulfill({ contentType: 'text/event-stream', body: '' });
            return route.fulfill({
                json: run(state.items.find((entry) => entry.runId === path.split('/').at(-1))!),
            });
        }
        if (request.method() === 'PATCH') {
            if (state.patchWait) await state.patchWait;
            if (state.patchFailure) return failure(state.patchFailure);
            const entry = state.items.find((value) => value.id === path.split('/').at(-1))!;
            entry.readAt = (body as { read: boolean }).read ? '2026-10-31T05:00:00Z' : null;
            return route.fulfill({ json: entry });
        }
        const visible = state.items.filter(
            (entry) =>
                (!kind || entry.kind === kind) &&
                (unread === null ||
                    (unread === 'true' ? entry.readAt === null : entry.readAt !== null)),
        );
        const pageItems = structuredClone(
            pageCursor ? visible.slice(3) : visible.slice(0, state.firstPageSize),
        );
        // Identical timestamps and duplicate rows; distinct notices sharing a report must survive.
        if (pageCursor && visible.length > 3) pageItems.unshift(structuredClone(visible[1]!));
        const nextCursor = !pageCursor && visible.length > 3 ? cursor : null;
        const filter = `${kind ?? 'all'}:${unread === null ? 'all' : unread === 'true' ? 'unread' : 'read'}`;
        if (state.getWait && state.getWaitFilter === filter) await state.getWait;
        if (state.failure && (state.failureScope === 'all' || pageCursor !== null)) {
            if (state.failure === 'protocol')
                return route.fulfill({
                    status: 200,
                    contentType: 'application/json',
                    body: '{"broken"',
                });
            if (state.failure === 'semantic')
                return route.fulfill({
                    json: { items: [{ ...item(2), runStatus: 'partial' }], nextCursor: null },
                });
            return failure(
                state.failure === 'cursor' ? 400 : state.failure,
                state.failure === 'cursor' ? 'INVALID_CURSOR' : undefined,
            );
        }
        return route.fulfill({ json: { items: pageItems, nextCursor } });
    });
    return { state, calls };
}
const region = (page: Page) => page.getByRole('region', { name: '站内通知', exact: true });
const entries = (page: Page) => region(page).locator('article.notification-entry');
const link = (page: Page, n: number) => page.locator(`#notification-target-${id(n)}`);
const entry = (page: Page, n: number) => entries(page).filter({ has: link(page, n) });
const kindSelect = (page: Page) => page.getByRole('combobox', { name: '通知类别', exact: true });
const readSelect = (page: Page) =>
    page.getByRole('combobox', { name: '通知已读状态', exact: true });
const more = (page: Page) => region(page).getByRole('button', { name: '加载更多', exact: true });
const refresh = (page: Page) => region(page).getByRole('button', { name: '刷新', exact: true });
const patches = (calls: Awaited<ReturnType<typeof samples>>['calls']) =>
    calls.filter((call) => call.method === 'PATCH');

test('顶部通知悬浮预览四条，支持键盘、快捷进入与全部通知', async ({ page }, info) => {
    const { state, calls } = await samples(page.context());
    state.firstPageSize = 8;
    await page.goto('/account/appearance');
    const trigger = page.getByRole('button', { name: '通知', exact: true });
    const preview = page.getByRole('dialog', { name: '通知预览', exact: true });
    await expect(preview).not.toBeVisible();
    expect(calls).toHaveLength(0);
    await trigger.hover();
    await expect(preview.getByRole('listitem')).toHaveCount(4);
    await expect(preview).toContainText('不能据此判断资料是否变化');
    await expect(preview.locator('a').first()).toHaveAttribute('href', `/reports/${id(301)}`);
    await preview.screenshot({ path: info.outputPath('notification-hover.png') });
    await preview.locator('a').nth(2).click();
    await expect(page).toHaveURL(new RegExp(`/runs/${id(103)}$`));
    await trigger.focus();
    await expect(preview).toBeVisible();
    await preview.getByRole('link', { name: '查看全部通知' }).focus();
    await page.keyboard.press('Escape');
    await expect(preview).not.toBeVisible();
    await expect(trigger).toBeFocused();
    await trigger.press('Enter');
    await expect(preview).toBeVisible();
    await page.locator('#main-content').focus();
    await expect(preview).not.toBeVisible();
    await trigger.press('Enter');
    await expect(preview).toBeVisible();
    await preview.getByRole('link', { name: '查看全部通知' }).click();
    await expect(page).toHaveURL(/\/notifications$/);
    expect(patches(calls)).toHaveLength(0);
});

test('顶部通知预览有就地加载、错误重试与空状态', async ({ page }) => {
    const { state } = await samples(page.context());
    let release!: () => void;
    state.getWait = new Promise<void>((resolve) => {
        release = resolve;
    });
    await page.goto('/account/appearance');
    await page.getByRole('button', { name: '通知', exact: true }).hover();
    const preview = page.getByRole('dialog', { name: '通知预览', exact: true });
    await expect(preview.getByRole('status')).toContainText('正在读取通知');
    const image = preview.locator('.loading-animation');
    await expect(image).toBeVisible();
    const imageBox = await image.boundingBox();
    const textBox = await preview.getByRole('status').boundingBox();
    expect(imageBox!.x + imageBox!.width).toBeLessThanOrEqual(textBox!.x);
    state.failure = 503;
    release();
    await expect(preview.getByRole('status')).toContainText('通知暂时无法读取');
    state.failure = null;
    state.items = [];
    await preview.getByRole('button', { name: '重试', exact: true }).click();
    await expect(preview.getByRole('status')).toHaveText('暂无通知');
    await expect(preview.getByRole('link', { name: '查看全部通知' })).toBeVisible();
});
async function noOverflow(page: Page) {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
    );
    for (const control of await region(page).locator('button, select, a').all()) {
        if (!(await control.isVisible())) continue;
        const box = await control.boundingBox();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
        expect(box!.height).toBeGreaterThanOrEqual(44);
    }
}
for (const width of [320, 390, 768, 1024, 1440, 1920]) {
    test(`本地通知${width}：类别文字、图标、200%文字与键盘筛选`, async ({
        page,
        baseURL,
    }, info) => {
        const { calls } = await samples(page.context());
        const external: string[] = [];
        const errors: string[] = [];
        page.on('request', (request) => {
            if (new URL(request.url()).origin !== new URL(baseURL!).origin)
                external.push(request.url());
        });
        page.on('pageerror', (error) => errors.push(error.message));
        await page.setViewportSize({ width, height: 1000 });
        await page.goto('/notifications');
        await expect(entries(page)).toHaveCount(3);
        for (const [n, label] of [
            [1, '普通汇总'],
            [2, '重要变化'],
            [3, '运行问题'],
        ] as const)
            await expect(entry(page, n).getByRole('heading')).toHaveText(label);
        await expect(entry(page, 3)).toContainText('不能据此判断资料是否变化');
        await expect(region(page).locator('img')).toHaveCount(0);
        expect(await region(page).locator('svg').count()).toBeGreaterThan(3);
        expect(
            await entry(page, 1).evaluate((element) => getComputedStyle(element).fontFamily),
        ).toContain('Inter');
        for (const doubled of [false, true]) {
            if (doubled)
                await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
            await noOverflow(page);
            await page.evaluate(async () => {
                await document.fonts.ready;
                scrollTo(0, 0);
            });
            await info.attach(`${width}-${doubled ? 'text-200' : 'normal'}`, {
                body: await page.screenshot({
                    path: info.outputPath(`${doubled ? 'text-200' : 'normal'}.png`),
                    fullPage: true,
                }),
                contentType: 'image/png',
            });
        }
        await kindSelect(page).focus();
        await kindSelect(page).press('End');
        await kindSelect(page).press('Enter');
        await expect(kindSelect(page)).toHaveValue('run_issue');
        await expect(kindSelect(page)).toBeFocused();
        await readSelect(page).focus();
        await readSelect(page).press('End');
        await readSelect(page).press('Enter');
        await expect(readSelect(page)).toHaveValue('read');
        await expect(readSelect(page)).toBeFocused();
        await expect(entries(page)).toHaveCount(3);
        await noOverflow(page);
        expect(patches(calls)).toHaveLength(0);
        expect(external).toEqual([]);
        expect(errors).toEqual([]);
    });
}
for (const kind of ['all', 'summary', 'important_change', 'run_issue']) {
    for (const read of ['all', 'unread', 'read']) {
        test(`kind=${kind}×read=${read}分页保持原游标及服务器顺序`, async ({ page }) => {
            const { state, calls } = await samples(page.context());
            // Two distinct notifications may refer to the same report.
            state.items[3]!.reportId = state.items[0]!.reportId;
            const expected = state.items.filter(
                (value) =>
                    (kind === 'all' || value.kind === kind) &&
                    (read === 'all' || (read === 'unread' ? !value.readAt : !!value.readAt)),
            );
            await page.goto(`/notifications?kind=${kind}&read=${read}`);
            await expect(entries(page)).toHaveCount(3);
            await more(page).click();
            await expect(entries(page)).toHaveCount(expected.length);
            expect(
                await entries(page)
                    .locator('a')
                    .evaluateAll((elements) => elements.map((element) => element.id)),
            ).toEqual(expected.map((value) => `notification-target-${value.id}`));
            expect(calls.map((call) => call.cursor)).toEqual([null, cursor]);
            expect(calls.every((call) => call.kind === (kind === 'all' ? null : kind))).toBe(true);
            expect(
                calls.every(
                    (call) => call.unread === (read === 'all' ? null : String(read === 'unread')),
                ),
            ).toBe(true);
            await expect(more(page)).toHaveCount(0);
        });
    }
}
test('无报告failed进Run，有报告partial/重要变化进Report，读取不附写', async ({ page }) => {
    const { calls } = await samples(page.context());
    for (const n of [3, 6, 2]) {
        await page.goto('/notifications');
        if (n === 6) await more(page).click();
        await link(page, n).focus();
        await link(page, n).press('Enter');
        await expect(page).toHaveURL(
            new RegExp(n === 3 ? `/runs/${id(103)}$` : `/reports/${id(300 + n)}$`),
        );
        if (n === 3)
            await expect(
                page.getByRole('heading', { name: '执行失败', exact: true }),
            ).toBeVisible();
        else
            await expect(
                page.getByRole('article', { name: '可追溯的研究报告', exact: true }),
            ).toBeVisible();
    }
    expect(patches(calls)).toHaveLength(0);
    expect(calls.some((call) => call.path.includes('/inbox'))).toBe(false);
});
test('pending保留原已读、重复键盘不重写，刷新持久显示并可恢复未读', async ({ page }, info) => {
    const { state, calls } = await samples(page.context());
    let release!: () => void;
    state.patchWait = new Promise<void>((resolve) => {
        release = resolve;
    });
    await page.setViewportSize({ width: 390, height: 1000 });
    await page.goto('/notifications');
    await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
    await entry(page, 1).getByRole('button').dblclick();
    await expect(entry(page, 1).locator('strong')).toHaveText('未读');
    await expect(entry(page, 1).getByRole('button')).toHaveAttribute('aria-busy', 'true');
    await entry(page, 1).getByRole('button').press('Enter');
    await entry(page, 1).getByRole('button').press('Space');
    await expect(entry(page, 2).getByRole('button')).toBeDisabled();
    expect(patches(calls)).toHaveLength(1);
    release();
    await expect(entry(page, 1).locator('strong')).toHaveText('已读');
    await page.reload();
    await expect(entry(page, 1).locator('strong')).toHaveText('已读');
    await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
    await noOverflow(page);
    await info.attach('confirmed-read-200', {
        body: await page.screenshot({
            path: info.outputPath('confirmed-read-200.png'),
            fullPage: true,
        }),
        contentType: 'image/png',
    });
    state.patchWait = undefined;
    await entry(page, 1).getByRole('button').click();
    await expect(entry(page, 1).locator('strong')).toHaveText('未读');
    await expect(
        page
            .locator('.scova-notifications .n-notification')
            .filter({ hasText: '通知已恢复为未读。' }),
    ).toHaveCount(1);
    await expect(region(page)).not.toContainText('通知已恢复为未读。');
    await expect(entry(page, 1).getByRole('button')).toBeFocused();
    expect(patches(calls).map((call) => call.body)).toEqual([{ read: true }, { read: false }]);
    expect(patches(calls)[0]!.csrf).toBe('sample-csrf');
    expect(calls.some((call) => call.path.includes('/inbox'))).toBe(false);
});
test('写失败保原、可键盘重试，320/200%错误可读', async ({ page }, info) => {
    const { state } = await samples(page.context());
    state.patchFailure = 503;
    await page.setViewportSize({ width: 320, height: 1000 });
    await page.goto('/notifications');
    await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
    await entry(page, 1).getByRole('button').click();
    await expect(page.locator('.scova-notifications .n-notification')).toContainText(
        '保留原显示状态',
    );
    await expect(entry(page, 1).locator('strong')).toHaveText('未读');
    await noOverflow(page);
    await info.attach('write-failure-200', {
        body: await page.screenshot({
            path: info.outputPath('write-failure-200.png'),
            fullPage: true,
        }),
        contentType: 'image/png',
    });
    state.patchFailure = 0;
    await entry(page, 1).getByRole('button').press('Enter');
    await expect(entry(page, 1).locator('strong')).toHaveText('已读');
});
test('筛选移除后的键盘焦点落后继或类别select', async ({ page }) => {
    const { state } = await samples(page.context());
    state.items = [item(1), item(2)];
    await page.goto('/notifications?read=unread');
    await entry(page, 1).getByRole('button').focus();
    await entry(page, 1).getByRole('button').press('Enter');
    await expect(entry(page, 1)).toHaveCount(0);
    await expect(link(page, 2)).toBeFocused();
    await entry(page, 2).getByRole('button').click();
    await expect(entries(page)).toHaveCount(0);
    await expect(kindSelect(page)).toBeFocused();
});
test('迟到all GET不覆盖类别×未读；已接受跨filter PATCH更新所有缓存', async ({ page }) => {
    const { state, calls } = await samples(page.context());
    let releaseGet!: () => void;
    state.getWait = new Promise<void>((resolve) => {
        releaseGet = resolve;
    });
    await page.goto('/notifications');
    await expect.poll(() => calls.length).toBe(1);
    await kindSelect(page).selectOption('summary');
    await readSelect(page).selectOption('unread');
    await expect(entries(page)).toHaveCount(3);
    releaseGet();
    state.getWait = undefined;
    await expect(entry(page, 2)).toHaveCount(0);
    let releasePatch!: () => void;
    state.patchWait = new Promise<void>((resolve) => {
        releasePatch = resolve;
    });
    await entry(page, 1).getByRole('button').click();
    await expect.poll(() => patches(calls).length).toBe(1);
    await kindSelect(page).selectOption('all');
    await readSelect(page).selectOption('all');
    releasePatch();
    await expect(entry(page, 1).locator('strong')).toHaveText('已读');
    await readSelect(page).selectOption('unread');
    await expect(entry(page, 1)).toHaveCount(0);
    expect(patches(calls)).toHaveLength(1);
});
for (const location of ['initial', 'next', 'refresh'] as const) {
    for (const status of [403, 404, 'protocol', 'semantic', 'cursor', 503] as const) {
        test(`${location}读取${status}：隐藏失效内容、503原游标重试`, async ({ page }, info) => {
            const { state, calls } = await samples(page.context());
            if (location === 'initial') state.failure = status;
            await page.goto('/notifications');
            if (location !== 'initial') {
                await expect(entries(page)).toHaveCount(3);
                state.failure = status;
                if (location === 'next') {
                    state.failureScope = 'next';
                    await more(page).click();
                } else await refresh(page).click();
            }
            await expect(region(page).getByRole('status')).toContainText('加载失败');
            await expect(entries(page)).toHaveCount(
                (status === 503 || status === 'cursor') && location !== 'initial' ? 3 : 0,
            );
            if (location === 'refresh' && (status === 'protocol' || status === 503)) {
                await page.setViewportSize({ width: 320, height: 1000 });
                await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
                await noOverflow(page);
                await info.attach(`refresh-${status}-200`, {
                    body: await page.screenshot({
                        path: info.outputPath(`refresh-${status}-200.png`),
                        fullPage: true,
                    }),
                    contentType: 'image/png',
                });
            }
            state.failure = null;
            await region(page).getByRole('button', { name: '重试', exact: true }).click();
            await expect(entries(page)).toHaveCount(location === 'next' && status === 503 ? 24 : 3);
            expect(calls.at(-1)!.cursor).toBe(
                location === 'next' && status === 503 ? cursor : null,
            );
        });
    }
}
