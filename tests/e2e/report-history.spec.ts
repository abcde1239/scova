import { expect, test, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import type { ReportHistoryItem } from '../../apps/web/src/api/reports.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const taskA = 'abcdefab-1234-4abc-8def-abcdef123456';
const taskB = id(701);
const taskC = id(702);
const instant = '2026-10-31T02:00:00Z';
const cursor = 'same-time:+/ cursor=历史第二页';
const tasksCursor = 'task-page:+/第二页';
function item(n: number): ReportHistoryItem {
    return {
        id: id(n),
        runId: id(100 + n),
        taskId: n <= 6 ? taskA : taskB,
        taskVersionId: id(500),
        title: `持续跟踪招生政策与学术研究观点的变化：可追溯的来源比较与阶段报告 ${n}`,
        summary:
            '依据已保存来源整理事实、观点差异与尚未核验的缺口。\n保留可查证证据，并继续核验适用范围。',
        format: 'brief',
        mode: n % 2 ? 'demo' : 'live',
        outcome: 'inconclusive',
        coverage: {
            completeness: n % 2 ? 'partial' : 'complete',
            searchedQueries: ['研究政策'],
            gaps: n % 2 ? ['部分来源待核验'] : [],
            exhausted: [],
        },
        publishedAt: instant,
    };
}
function report(entry: ReportHistoryItem) {
    return {
        ...entry,
        baselineRunId: null,
        schemaVersion: 1,
        limitations: ['仅代表当前保存来源'],
        claims: [
            {
                id: id(601),
                kind: 'fact',
                text: '来源说明资料按批次公开。',
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
    };
}
function run(entry: ReportHistoryItem) {
    return {
        id: entry.runId,
        taskId: entry.taskId,
        taskVersionId: entry.taskVersionId,
        parentRunId: null,
        baselineRunId: null,
        mode: entry.mode,
        status: entry.coverage.completeness === 'partial' ? 'partial' : 'succeeded',
        outcome: 'inconclusive',
        trigger: 'manual',
        budget: {
            maxSearches: 2,
            maxPages: 3,
            maxDurationSeconds: 60,
            maxInputTokens: 1000,
            maxOutputTokens: 500,
        },
        usage: { searches: 2, pages: 1, inputTokens: 100, outputTokens: 20, estimated: true },
        coverage: entry.coverage,
        queuedAt: instant,
        startedAt: instant,
        finishedAt: instant,
        failureCode: null,
    };
}
type Fault = number | 'protocol' | 'semantic' | 'cursor' | null;
// Local HTTP samples exercise the production Web bundle; real delivery/storage is tested separately.
async function samples(context: BrowserContext) {
    const task = (taskId: string, title: string) => ({
        id: taskId,
        title,
        status: 'active',
        revision: 1,
        currentVersionId: id(800),
        nextRunAt: null,
        createdAt: instant,
        updatedAt: instant,
    });
    const state = {
        items: Array.from({ length: 12 }, (_, index) => item(index + 1)),
        tasks: [
            task(taskA, '持续跟踪招生政策与研究资料变化'),
            task(taskB, '第二个独立任务'),
            task(taskC, '尚未生成报告的任务'),
        ],
        failure: null as Fault,
        failureScope: 'all' as 'all' | 'next',
        taskFailure: null as Fault,
        taskFailureScope: 'all' as 'all' | 'next',
        getWait: undefined as Promise<void> | undefined,
        getWaitTask: null as string | null,
    };
    const calls: { method: string; path: string; cursor: string | null; taskId: string | null }[] =
        [];
    await context.route('**/api/v1/**', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const path = url.pathname;
        if (path === '/api/v1/me')
            return route.fulfill({
                json: {
                    user: {
                        id: id(900),
                        email: 'history@example.test',
                        createdAt: instant,
                        preferences: {
                            defaultTimezone: 'UTC',
                            notificationPreference: { mode: 'summary', runIssues: true },
                        },
                    },
                    csrfToken: 'sample-csrf',
                },
            });
        const pageCursor = url.searchParams.get('cursor');
        const taskId = url.searchParams.get('taskId');
        calls.push({ method: request.method(), path, cursor: pageCursor, taskId });
        const failure = (fault: Exclude<Fault, null>) =>
            fault === 'protocol'
                ? route.fulfill({ contentType: 'application/json', body: '{"broken"' })
                : route.fulfill({
                      status: typeof fault === 'number' ? fault : 400,
                      json: {
                          code: fault === 'cursor' ? 'INVALID_CURSOR' : 'LOCAL_FAILURE',
                          message: 'local sample',
                          requestId: 'sample',
                      },
                  });
        if (path === '/api/v1/tasks') {
            if (state.taskFailure && (state.taskFailureScope === 'all' || pageCursor))
                return failure(state.taskFailure);
            return route.fulfill({
                json: {
                    items: pageCursor ? state.tasks.slice(1) : state.tasks.slice(0, 1),
                    nextCursor: pageCursor ? null : tasksCursor,
                },
            });
        }
        if (path.startsWith('/api/v1/reports/'))
            return route.fulfill({
                json: report(state.items.find((value) => value.id === path.split('/').at(-1))!),
            });
        if (path.startsWith('/api/v1/runs/')) {
            if (path.endsWith('/events'))
                return route.fulfill({ contentType: 'text/event-stream', body: '' });
            return route.fulfill({
                json: run(state.items.find((value) => value.runId === path.split('/').at(-1))!),
            });
        }
        const visible = state.items.filter((value) => !taskId || value.taskId === taskId);
        const pageItems = structuredClone(pageCursor ? visible.slice(3) : visible.slice(0, 3));
        if (pageCursor && visible.length > 3) pageItems.unshift(structuredClone(visible[1]!));
        const nextCursor = !pageCursor && visible.length > 3 ? cursor : null;
        if (state.getWait && state.getWaitTask === taskId) await state.getWait;
        if (state.failure && (state.failureScope === 'all' || pageCursor)) {
            if (state.failure === 'semantic')
                return route.fulfill({
                    json: {
                        items: [{ ...item(1), coverage: { completeness: 'broken' } }],
                        nextCursor: null,
                    },
                });
            return failure(state.failure);
        }
        return route.fulfill({ json: { items: pageItems, nextCursor } });
    });
    return { state, calls };
}
const region = (page: Page) => page.getByRole('region', { name: '历史报告列表', exact: true });
const entries = (page: Page) => region(page).locator('article.report-history-entry');
const link = (page: Page, n: number) => page.locator(`#history-report-${id(n)}`);
const entry = (page: Page, n: number) => entries(page).filter({ has: link(page, n) });
const select = (page: Page) => page.getByRole('combobox', { name: '筛选任务', exact: true });
const more = (page: Page) =>
    region(page).getByRole('button', { name: '加载更多报告', exact: true });
const refresh = (page: Page) => region(page).getByRole('button', { name: '刷新报告', exact: true });
const reportCalls = (calls: Awaited<ReturnType<typeof samples>>['calls']) =>
    calls.filter((call) => call.path === '/api/v1/reports');
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
async function screenshot(page: Page, info: TestInfo, name: string, fullPage = false) {
    await page.evaluate(async () => {
        await document.fonts.ready;
    });
    await info.attach(name, {
        body: await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage }),
        contentType: 'image/png',
    });
}
for (const width of [320, 390, 768, 1024, 1440, 1920]) {
    test(`本地历史${width}：serif标题、200%文字、原游标与Back恢复`, async ({
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
        await page.goto(width === 390 ? `/tasks/reports?taskId=${taskA}` : '/tasks/reports');
        await expect(entries(page)).toHaveCount(3);
        await expect(entry(page, 1)).toContainText('演示报告');
        await expect(entry(page, 1)).toContainText('部分交付');
        await expect(entry(page, 2)).toContainText('真实查阅');
        await expect(entry(page, 2)).toContainText('计划范围内完整交付');
        expect(
            await link(page, 1).evaluate((element) => getComputedStyle(element).fontFamily),
        ).toContain('Noto Serif SC');
        expect(
            await entry(page, 1)
                .locator('time')
                .evaluate((element) => getComputedStyle(element).fontFamily),
        ).toContain('Inter');
        await expect(region(page).locator('img')).toHaveCount(0);
        for (const doubled of [false, true]) {
            if (doubled)
                await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
            await noOverflow(page);
            await page.evaluate(() => scrollTo(0, 0));
            await screenshot(page, info, doubled ? 'text-200' : 'normal', true);
            await screenshot(page, info, doubled ? 'viewport-text-200' : 'viewport-normal');
        }
        await more(page).click();
        await expect(entries(page)).toHaveCount(width === 390 ? 6 : 12);
        expect(reportCalls(calls).map((call) => call.cursor)).toEqual([null, cursor]);
        await link(page, 6).scrollIntoViewIfNeeded();
        await link(page, 6).focus();
        const before = await page.evaluate(() => scrollY);
        const routerState = await page.evaluate(() => ({
            position: history.state.position,
            current: history.state.current,
        }));
        await link(page, 6).press('Enter');
        await expect(page).toHaveURL(new RegExp(`/reports/${id(6)}$`));
        await expect(page.getByRole('article', { name: item(6).title, exact: true })).toBeVisible();
        await page.goBack();
        await expect(entries(page)).toHaveCount(width === 390 ? 6 : 12);
        await expect(select(page)).toHaveValue(width === 390 ? taskA : '');
        await expect(link(page, 6)).toBeFocused();
        await expect
            .poll(() =>
                page.evaluate(() =>
                    Math.abs(scrollY - Number(history.state.reportHistoryRestore.scroll)),
                ),
            )
            .toBeLessThanOrEqual(2);
        expect(Math.abs((await page.evaluate(() => scrollY)) - before)).toBeLessThanOrEqual(2);
        expect(
            await page.evaluate(() => ({
                position: history.state.position,
                current: history.state.current,
            })),
        ).toEqual(routerState);
        expect(reportCalls(calls)).toHaveLength(2);
        expect(calls.every((call) => call.method === 'GET')).toBe(true);
        expect(external).toEqual([]);
        expect(errors).toEqual([]);
    });
}
test('短标题报告也具有足够点击高度，窄屏与桌面均可键盘打开', async ({ page }) => {
    const { state } = await samples(page.context());
    state.items[0]!.title = '政策报告';
    for (const width of [320, 1440]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.goto('/tasks/reports');
        await expect(link(page, 1)).toBeVisible();
        expect((await link(page, 1).boundingBox())!.height).toBeGreaterThanOrEqual(44);
        await link(page, 1).focus();
        await link(page, 1).press('Enter');
        await expect(page.getByRole('article', { name: '政策报告', exact: true })).toBeVisible();
    }
});
test('任务选项初次403不阻断合法报告，保留当前筛选值', async ({ page }, info) => {
    const { state, calls } = await samples(page.context());
    state.taskFailure = 403;
    await page.setViewportSize({ width: 390, height: 1000 });
    await page.goto(`/tasks/reports?taskId=${taskA}`);
    await expect(region(page).getByRole('status')).toContainText('任务选项暂时无法读取');
    await expect(entries(page)).toHaveCount(3);
    await expect(select(page).locator('option:checked')).toHaveText('当前筛选任务');
    expect(reportCalls(calls)[0]!.taskId).toBe(taskA);
    await screenshot(page, info, 'task-initial-forbidden-viewport');
});
test('任务卡列表入口可达静态历史路由，不派发误匹配任务详情', async ({ page }) => {
    const { calls } = await samples(page.context());
    await page.goto('/tasks');
    const target = page.getByRole('link', { name: '报告历史', exact: true });
    await expect(target).toHaveCount(1);
    expect((await target.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await target.focus();
    await target.press('Enter');
    await expect(page).toHaveURL(`/tasks/reports?taskId=${taskA}`);
    await expect(entries(page)).toHaveCount(3);
    expect(calls.some((call) => call.path === '/api/v1/tasks/reports')).toBe(false);
});
test('任务选项分页与键盘筛选重置目的缓存，空态保留留白', async ({ page }, info) => {
    const { calls } = await samples(page.context());
    await page.setViewportSize({ width: 390, height: 1000 });
    await page.goto(`/tasks/reports?taskId=${taskB}`);
    await expect(select(page).locator('option:checked')).toHaveText('当前筛选任务');
    await expect(entries(page)).toHaveCount(3);
    await more(page).click();
    await expect(entries(page)).toHaveCount(6);
    await region(page).getByRole('button', { name: '加载更多任务选项', exact: true }).click();
    await expect(select(page).locator('option:checked')).toHaveText('第二个独立任务');
    expect(
        calls.filter((call) => call.path === '/api/v1/tasks').map((call) => call.cursor),
    ).toEqual([null, tasksCursor]);
    await select(page).focus();
    await select(page).press('Home');
    await select(page).press('ArrowDown');
    await select(page).press('Enter');
    await expect(select(page)).toHaveValue(taskA);
    await expect(select(page)).toBeFocused();
    await expect(entry(page, 1)).toBeVisible();
    await screenshot(page, info, 'filter-selected-viewport');
    await select(page).selectOption(taskB);
    await expect(entries(page)).toHaveCount(3);
    expect(reportCalls(calls).at(-1)!.cursor).toBeNull();
    await select(page).selectOption(taskC);
    await expect(entries(page)).toHaveCount(0);
    await expect(region(page).getByRole('status')).toContainText('尚无报告');
    await screenshot(page, info, 'empty-viewport');
    await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
    await noOverflow(page);
    await screenshot(page, info, 'empty-text-200-viewport');
});
test('合法大写UUID规范请求；非法UUID不派发历史且可重新选择', async ({ page }, info) => {
    const { calls } = await samples(page.context());
    await page.goto(`/tasks/reports?taskId=${taskA.toUpperCase()}`);
    await expect(entries(page)).toHaveCount(3);
    expect(reportCalls(calls)[0]!.taskId).toBe(taskA);
    await page.goto('/tasks/reports?taskId=bad');
    await expect(region(page).getByRole('status')).toContainText('任务筛选地址无效');
    await expect(entries(page)).toHaveCount(0);
    expect(reportCalls(calls)).toHaveLength(1);
    await screenshot(page, info, 'invalid-filter-viewport');
    await select(page).selectOption(taskA);
    await expect(entries(page)).toHaveCount(3);
});
test('迟到all读取不覆盖新任务，切换回旧筛选也从首页', async ({ page }) => {
    const { state, calls } = await samples(page.context());
    let release!: () => void;
    state.getWait = new Promise<void>((resolve) => {
        release = resolve;
    });
    await page.goto('/tasks/reports');
    await expect.poll(() => reportCalls(calls).length).toBe(1);
    await select(page).selectOption(taskA);
    await expect(entries(page)).toHaveCount(3);
    release();
    state.getWait = undefined;
    await expect(entry(page, 7)).toHaveCount(0);
    await more(page).click();
    await expect(entries(page)).toHaveCount(6);
    await select(page).selectOption('');
    await expect(entries(page)).toHaveCount(3);
    expect(reportCalls(calls).at(-1)!.cursor).toBeNull();
});
test('对应Run入口保留真实执行ID与partial模式，不隐式写已读', async ({ page }) => {
    const { calls } = await samples(page.context());
    await page.goto('/tasks/reports');
    await entry(page, 1).getByRole('link', { name: '查看对应执行', exact: true }).press('Enter');
    await expect(page).toHaveURL(new RegExp(`/runs/${id(101)}$`));
    await expect(page.getByRole('heading', { name: '部分完成', exact: true })).toBeVisible();
    expect(calls.every((call) => call.method === 'GET')).toBe(true);
});
for (const status of [403, 404, 'protocol', 503] as const) {
    test(`任务选项后页${status}：标题策略独立于合法报告读取`, async ({ page }, info) => {
        const { state, calls } = await samples(page.context());
        await page.setViewportSize({ width: 390, height: 1000 });
        await page.goto(`/tasks/reports?taskId=${taskA}`);
        await expect(entries(page)).toHaveCount(3);
        await expect(select(page).locator('option:checked')).toHaveText(state.tasks[0]!.title);
        state.taskFailure = status;
        state.taskFailureScope = 'next';
        await region(page).getByRole('button', { name: '加载更多任务选项', exact: true }).click();
        await expect(region(page).getByRole('status')).toContainText('任务选项暂时无法读取');
        await expect(select(page).locator('option:checked')).toHaveText(
            status === 503 ? state.tasks[0]!.title : '当前筛选任务',
        );
        await expect(entries(page)).toHaveCount(3);
        await screenshot(page, info, `task-options-${status}-viewport`);
        state.taskFailure = null;
        await region(page).getByRole('button', { name: '重试任务选项', exact: true }).click();
        await expect(select(page).locator('option:checked')).toHaveText(state.tasks[0]!.title);
        expect(calls.filter((call) => call.path === '/api/v1/tasks').at(-1)!.cursor).toBe(
            status === 503 ? tasksCursor : null,
        );
        expect(reportCalls(calls)).toHaveLength(1);
    });
}
for (const location of ['initial', 'next', 'refresh'] as const) {
    for (const status of [403, 404, 'protocol', 'semantic', 'cursor', 503] as const) {
        test(`${location}历史${status}：隐藏失效内容、503保留与原游标重试`, async ({
            page,
        }, info) => {
            const { state, calls } = await samples(page.context());
            if (location === 'initial') state.failure = status;
            await page.goto('/tasks/reports');
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
            if (location === 'refresh' && (status === 503 || status === 'protocol')) {
                await page.setViewportSize({ width: 320, height: 1000 });
                await screenshot(page, info, `refresh-${status}-viewport`);
                await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
                await noOverflow(page);
                await screenshot(page, info, `refresh-${status}-text-200-viewport`);
            }
            state.failure = null;
            await region(page).getByRole('button', { name: '重试', exact: true }).click();
            await expect(entries(page)).toHaveCount(location === 'next' && status === 503 ? 12 : 3);
            expect(reportCalls(calls).at(-1)!.cursor).toBe(
                location === 'next' && status === 503 ? cursor : null,
            );
        });
    }
}
