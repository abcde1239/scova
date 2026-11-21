import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import type { InboxItem } from '../../apps/web/src/api/inbox.ts';
import type { Report } from '../../packages/models/src/report/schema.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const instant = '2026-10-31T02:00:00Z';
const cursor = 'same-time:+/ cursor=第二页';
function item(n: number): InboxItem {
    const partial = n % 2 === 1;
    return {
        id: id(n),
        reportId: id(100 + n),
        readAt: n === 3 || n === 5 ? instant : null,
        createdAt: instant,
        report: {
            id: id(100 + n),
            runId: id(200 + n),
            taskId: id(300 + n),
            taskVersionId: id(400 + n),
            title: `持续跟踪招生政策与学术研究观点的变化：可追溯的来源比较与阶段报告 ${n}`,
            summary:
                '本次整理来源事实、观点差异与尚未核验的缺口。\n保留可查证证据，下一步继续核验适用范围。',
            format: 'brief',
            mode: partial ? 'demo' : 'live',
            outcome: 'inconclusive',
            coverage: {
                completeness: partial ? 'partial' : 'complete',
                searchedQueries: ['招生政策'],
                gaps: partial ? ['尚有来源待核验'] : [],
                exhausted: [],
            },
            publishedAt: instant,
        },
    };
}
function fullReport(entry: InboxItem): Report {
    const evidenceId = id(600);
    return {
        ...entry.report,
        baselineRunId: null,
        schemaVersion: 1,
        limitations: ['仅代表当前保存来源'],
        claims: [
            {
                id: id(601),
                kind: 'fact',
                text: '来源说明政策按批次公开。',
                confidenceLabel: '仅代表来源陈述',
                evidenceIds: [evidenceId],
            },
        ],
        evidence: [
            {
                id: evidenceId,
                sourceId: id(602),
                snapshotId: id(603),
                title: '政策来源说明',
                url: 'https://example.test/source',
                quote: '政策按批次公开。',
                location: '第2段',
                observedAt: instant,
                snapshot: {
                    originalUrl: 'https://example.test/original',
                    fetchedUrl: 'https://example.test/source',
                    canonicalUrl: 'https://example.test/source',
                    contentHash: 'a'.repeat(64),
                    extractorVersion: 'reader-v1',
                    publishedAt: null,
                    truncated: false,
                    selector: {
                        type: 'text_offset',
                        start: 0,
                        end: 10,
                        extractorVersion: 'reader-v1',
                    },
                },
            },
        ],
        changes: [],
    };
}

// Explicit local HTTP samples; real inbox/notification persistence is verified separately.
async function samples(context: BrowserContext) {
    const state = {
        items: Array.from({ length: 6 }, (_, index) => item(index + 1)),
        failure: null as number | 'protocol' | null,
        failureScope: 'all' as 'all' | 'next',
        patchFailure: 0,
        patchWait: undefined as Promise<void> | undefined,
        getWait: undefined as Promise<void> | undefined,
        getWaitFilter: 'all',
    };
    const calls: {
        method: string;
        path: string;
        cursor: string | null;
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
                        email: 'inbox@example.test',
                        preferences: {
                            defaultTimezone: 'UTC',
                            notificationPreference: { mode: 'summary', runIssues: true },
                        },
                        createdAt: instant,
                    },
                    csrfToken: 'sample-csrf',
                },
            });
        const body: unknown = request.method() === 'PATCH' ? request.postDataJSON() : undefined;
        const pageCursor = url.searchParams.get('cursor');
        const unread = url.searchParams.get('unread');
        calls.push({
            method: request.method(),
            path,
            cursor: pageCursor,
            unread,
            body,
            csrf: request.headers()['x-csrf-token'],
        });
        const failure = (status: number) =>
            route.fulfill({
                status,
                json: { code: 'LOCAL_FAILURE', message: 'local sample', requestId: 'sample' },
            });
        if (path.startsWith('/api/v1/reports/')) {
            if (path.endsWith('/conversation'))
                return route.fulfill({
                    json: { reportId: path.split('/').at(-2), turns: [], hasEarlier: false },
                });
            const entry = state.items.find((value) => value.reportId === path.split('/').at(-1))!;
            return route.fulfill({ json: fullReport(entry) });
        }
        if (request.method() === 'PATCH') {
            if (state.patchWait) await state.patchWait;
            if (state.patchFailure) return failure(state.patchFailure);
            const entry = state.items.find((value) => value.id === path.split('/').at(-1))!;
            entry.readAt = (body as { read: boolean }).read ? '2026-10-31T05:00:00Z' : null;
            return route.fulfill({ json: entry });
        }
        const visible = state.items.filter(
            (value) =>
                unread === null ||
                (unread === 'true' ? value.readAt === null : value.readAt !== null),
        );
        const pageItems = structuredClone(pageCursor ? visible.slice(3) : visible.slice(0, 3));
        const nextCursor = !pageCursor && visible.length > 3 ? cursor : null;
        if (pageCursor && unread === null) {
            pageItems.unshift(structuredClone(visible[1]!));
            pageItems.unshift({ ...structuredClone(visible[1]!), id: id(800) });
        }
        const filter = unread === null ? 'all' : unread === 'true' ? 'unread' : 'read';
        if (state.getWait && state.getWaitFilter === filter) await state.getWait;
        if (state.failure && (state.failureScope === 'all' || pageCursor !== null)) {
            if (state.failure === 'protocol')
                return route.fulfill({
                    status: 200,
                    contentType: 'application/json',
                    body: '{"broken"',
                });
            return failure(state.failure);
        }
        return route.fulfill({ json: { items: pageItems, nextCursor } });
    });
    return { state, calls };
}
const inbox = (page: Page) => page.getByRole('region', { name: '报告收件箱', exact: true });
const entries = (page: Page) => inbox(page).locator('article.inbox-entry');
const entry = (page: Page, n: number) =>
    entries(page).filter({ has: page.locator(`#inbox-report-${id(n)}`) });
const reportLink = (page: Page, n: number) => page.locator(`#inbox-report-${id(n)}`);
const filterLink = (page: Page, name: string) =>
    inbox(page)
        .getByRole('navigation', { name: '收件箱筛选' })
        .getByRole('link', { name, exact: true });
const more = (page: Page) => inbox(page).getByRole('button', { name: '加载更多', exact: true });
const refresh = (page: Page) => inbox(page).getByRole('button', { name: '刷新', exact: true });
const patches = (calls: Awaited<ReturnType<typeof samples>>['calls']) =>
    calls.filter((call) => call.method === 'PATCH');
async function noOverflow(page: Page) {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
    );
    for (const button of await inbox(page).getByRole('button').all()) {
        if (!(await button.isVisible())) continue;
        const box = await button.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
        expect(box!.height).toBeGreaterThanOrEqual(44);
    }
}

test('长摘要按需展开，刷新保留相同内容状态，更新内容后恢复收起且不写入', async ({ page }) => {
    const { state, calls } = await samples(page.context());
    state.items[0]!.report.summary = '完整来源说明与尚待核验的研究缺口。'.repeat(30);
    state.items[1]!.report.summary = '短摘要保持完整。';
    await page.goto('/inbox');
    const first = entry(page, 1);
    const summary = first.locator('.entry-summary');
    const toggle = first.getByRole('button', { name: '展开摘要', exact: true });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toHaveAttribute('aria-controls', (await summary.getAttribute('id'))!);
    const collapsedHeight = (await summary.boundingBox())!.height;
    await toggle.focus();
    await toggle.press('Enter');
    await expect(first.getByRole('button', { name: '收起摘要' })).toBeFocused();
    expect((await summary.boundingBox())!.height).toBeGreaterThan(collapsedHeight);
    await refresh(page).click();
    await expect(first.getByRole('button', { name: '收起摘要' })).toHaveAttribute(
        'aria-expanded',
        'true',
    );
    state.items[0]!.report.summary = '更新后的完整摘要。'.repeat(40);
    await refresh(page).click();
    await expect(summary).toHaveText(state.items[0]!.report.summary);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(entry(page, 2).getByRole('button', { name: /展开摘要|收起摘要/ })).toHaveCount(0);
    await expect(entry(page, 2).locator('.entry-summary')).toHaveText('短摘要保持完整。');
    expect(patches(calls)).toEqual([]);
});

for (const width of [320, 390, 768, 1024, 1440, 1920]) {
    test(`本地收件箱样本${width}：纯文字与200%排版、原样游标去重和报告返回位置`, async ({
        page,
        baseURL,
    }, info) => {
        const { calls, state } = await samples(page.context());
        if (width === 390)
            state.items.forEach((value) => {
                value.readAt = null;
            });
        const external: string[] = [];
        const errors: string[] = [];
        page.on('request', (request) => {
            if (new URL(request.url()).origin !== new URL(baseURL!).origin)
                external.push(request.url());
        });
        page.on('pageerror', (error) => errors.push(error.message));
        await page.setViewportSize({ width, height: 1000 });
        await page.goto(width === 390 ? '/inbox?read=unread' : '/inbox');
        await expect(entries(page)).toHaveCount(3);
        await expect(entry(page, 1)).toContainText('结果已生成，未覆盖项目见报告详情。');
        await expect(entry(page, 1)).toContainText('演示报告');
        await expect(entry(page, 2)).toContainText('研究报告');
        expect(
            await entry(page, 1)
                .locator('h2')
                .evaluate((element) => getComputedStyle(element).fontFamily),
        ).toContain('Noto Serif SC');
        await expect(inbox(page).locator('img')).toHaveCount(0);
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
        await more(page).click();
        await expect(entries(page)).toHaveCount(6);
        expect(
            calls.filter((call) => call.path === '/api/v1/inbox').map((call) => call.cursor),
        ).toEqual([null, cursor]);
        await reportLink(page, 6).scrollIntoViewIfNeeded();
        await reportLink(page, 6).focus();
        const before = await page.evaluate(() => scrollY);
        await reportLink(page, 6).press('Enter');
        await expect(page).toHaveURL(new RegExp(`/reports/${id(106)}$`));
        if (width < 1152) await page.getByRole('button', { name: '成果', exact: true }).click();
        await expect(
            page.getByRole('article', { name: item(6).report.title, exact: true }),
        ).toBeVisible();
        expect(patches(calls)).toHaveLength(0);
        if ([390, 1024, 1920].includes(width)) await page.goBack();
        else if (width < 1152) {
            await page.getByRole('button', { name: '返回对话', exact: true }).click();
            await expect(page.getByRole('dialog', { name: '报告交付物', exact: true })).toHaveCount(
                0,
            );
            const back = page
                .locator('.workspace-eyebrow')
                .getByRole('link', { name: '收件箱', exact: true });
            await expect(back).toHaveAttribute('href', '/inbox');
            await back.click();
        } else await page.getByRole('link', { name: '返回收件箱', exact: true }).click();
        await expect(page).toHaveURL(width === 390 ? /\/inbox\?read=unread$/ : /\/inbox$/);
        await expect(filterLink(page, width === 390 ? '未读' : '全部')).toHaveAttribute(
            'aria-current',
            'page',
        );
        await expect(entries(page)).toHaveCount(6);
        await expect(reportLink(page, 6)).toBeFocused();
        await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(before - 2);
        expect(Math.abs((await page.evaluate(() => scrollY)) - before)).toBeLessThanOrEqual(2);
        expect(calls.filter((call) => call.path === '/api/v1/inbox')).toHaveLength(2);
        expect(external).toEqual([]);
        expect(errors).toEqual([]);
    });
}

test('已读在途保原状态、重复激活不重写；成功后刷新仍已读且不改通知', async ({ page }, info) => {
    const { state, calls } = await samples(page.context());
    let release!: () => void;
    state.patchWait = new Promise<void>((resolve) => {
        release = resolve;
    });
    await page.setViewportSize({ width: 390, height: 1000 });
    await page.goto('/inbox');
    await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
    await entry(page, 1).getByRole('button', { name: '标记已读', exact: true }).dblclick();
    await expect(entry(page, 1).locator('strong')).toHaveText('未读');
    await expect(
        entry(page, 1).getByRole('button', { name: '正在更新', exact: true }),
    ).toHaveAttribute('aria-busy', 'true');
    await entry(page, 1).getByRole('button', { name: '正在更新', exact: true }).press('Enter');
    await entry(page, 1).getByRole('button', { name: '正在更新', exact: true }).press('Space');
    await expect(
        entry(page, 2).getByRole('button', { name: '标记已读', exact: true }),
    ).toBeDisabled();
    expect(patches(calls)).toHaveLength(1);
    release();
    await expect(entry(page, 1).locator('strong')).toHaveText('已读');
    await expect(
        page.locator('.scova-notifications .n-notification').filter({ hasText: '已标记为已读。' }),
    ).toHaveCount(1);
    await expect(inbox(page)).not.toContainText('已标记为已读。');
    await expect(
        entry(page, 1).getByRole('button', { name: '恢复未读', exact: true }),
    ).toBeEnabled();
    await page.reload();
    await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
    await expect(entry(page, 1).locator('strong')).toHaveText('已读');
    await expect(page.locator('.scova-notifications .n-notification')).toHaveCount(0);
    await noOverflow(page);
    await entry(page, 1).scrollIntoViewIfNeeded();
    await info.attach('390-confirmed-read-text-200', {
        body: await page.screenshot({ path: info.outputPath('confirmed-read-text-200.png') }),
        contentType: 'image/png',
    });
    expect(patches(calls)[0]!.body).toEqual({ read: true });
    expect(patches(calls)[0]!.csrf).toBe('sample-csrf');
    expect(calls.some((call) => call.path.includes('/notifications'))).toBe(false);
    state.patchWait = undefined;
    await entry(page, 1).getByRole('button', { name: '恢复未读', exact: true }).click();
    await expect(entry(page, 1).locator('strong')).toHaveText('未读');
    await expect(
        page.locator('.scova-notifications .n-notification').filter({ hasText: '已恢复为未读。' }),
    ).toHaveCount(1);
    await expect(inbox(page)).not.toContainText('已恢复为未读。');
    await expect(
        entry(page, 1).getByRole('button', { name: '标记已读', exact: true }),
    ).toBeFocused();
    expect(patches(calls).map((call) => call.body)).toEqual([{ read: true }, { read: false }]);
});

test('写失败保留未读和可重试按钮，320/200%错误可读', async ({ page }, info) => {
    const { state, calls } = await samples(page.context());
    state.patchFailure = 503;
    await page.setViewportSize({ width: 320, height: 1000 });
    await page.goto('/inbox');
    await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
    await entry(page, 1).getByRole('button', { name: '标记已读', exact: true }).click();
    await expect(page.locator('.scova-notifications .n-notification')).toContainText(
        '原状态已保留',
    );
    await expect(entry(page, 1).locator('strong')).toHaveText('未读');
    await expect(
        entry(page, 1).getByRole('button', { name: '标记已读', exact: true }),
    ).toBeEnabled();
    await noOverflow(page);
    await page.locator('.scova-notifications .n-notification').last().scrollIntoViewIfNeeded();
    await info.attach('320-write-failure-text-200', {
        body: await page.screenshot({ path: info.outputPath('write-failure-text-200.png') }),
        contentType: 'image/png',
    });
    expect(patches(calls)).toHaveLength(1);
    state.patchFailure = 0;
    await entry(page, 1).getByRole('button', { name: '标记已读', exact: true }).click();
    await expect(entry(page, 1).locator('strong')).toHaveText('已读');
});

test('未读写成功移除条目并聚焦后继，最后条目移除返回当前筛选', async ({ page }, info) => {
    const { state } = await samples(page.context());
    state.items = [item(1), item(2)];
    await page.goto('/inbox?read=unread');
    await expect(entries(page)).toHaveCount(2);
    await entry(page, 1).getByRole('button', { name: '标记已读', exact: true }).focus();
    await entry(page, 1).getByRole('button', { name: '标记已读', exact: true }).press('Enter');
    await expect(entry(page, 1)).toHaveCount(0);
    await expect(reportLink(page, 2)).toBeFocused();
    await entry(page, 2).getByRole('button', { name: '标记已读', exact: true }).click();
    await expect(entries(page)).toHaveCount(0);
    await expect(filterLink(page, '未读')).toBeFocused();
    await expect(inbox(page).getByRole('status').filter({ hasText: '暂无未读报告' })).toBeVisible();
    await info.attach('unread-empty-focus', {
        body: await page.screenshot({ path: info.outputPath('unread-empty-focus.png') }),
        contentType: 'image/png',
    });
});

test('筛选切换后迟到all读取不覆盖未读结果，请求布尔值原样', async ({ page }) => {
    const { state, calls } = await samples(page.context());
    let release!: () => void;
    state.getWait = new Promise<void>((resolve) => {
        release = resolve;
    });
    await page.goto('/inbox');
    await expect.poll(() => calls.length).toBeGreaterThan(0);
    await filterLink(page, '未读').click();
    await expect(entries(page)).toHaveCount(3);
    release();
    await expect(filterLink(page, '未读')).toHaveAttribute('aria-current', 'page');
    await expect(entry(page, 3)).toHaveCount(0);
    expect(calls.some((call) => call.unread === 'true')).toBe(true);
    state.getWait = undefined;
    await filterLink(page, '已读').click();
    await expect(entries(page)).toHaveCount(2);
    await expect(entry(page, 3)).toBeVisible();
    expect(calls.some((call) => call.unread === 'false')).toBe(true);
});

test('all写入在途切未读再返回，已接受成功仍更新全部缓存', async ({ page }) => {
    const { state, calls } = await samples(page.context());
    let release!: () => void;
    state.patchWait = new Promise<void>((resolve) => {
        release = resolve;
    });
    await page.goto('/inbox');
    await entry(page, 1).getByRole('button', { name: '标记已读', exact: true }).click();
    await expect.poll(() => patches(calls).length).toBe(1);
    await filterLink(page, '未读').click();
    await expect(entries(page)).toHaveCount(3);
    await filterLink(page, '全部').click();
    release();
    await expect(entry(page, 1).locator('strong')).toHaveText('已读');
    await filterLink(page, '未读').click();
    await expect(entry(page, 1)).toHaveCount(0);
    expect(patches(calls)).toHaveLength(1);
});

for (const location of ['initial', 'next', 'refresh'] as const) {
    for (const status of [403, 404, 'protocol', 503] as const) {
        test(`${location}读取${status}：授权或协议失败隐藏旧页，503保留并原位重试`, async ({
            page,
        }, info) => {
            const { state, calls } = await samples(page.context());
            if (location === 'initial') state.failure = status;
            await page.goto('/inbox');
            if (location !== 'initial') {
                await expect(entries(page)).toHaveCount(3);
                state.failure = status;
                if (location === 'next') {
                    state.failureScope = 'next';
                    await more(page).click();
                } else await refresh(page).click();
            }
            await expect(inbox(page).getByRole('status')).toContainText('加载失败');
            await expect(entries(page)).toHaveCount(
                status === 503 && location !== 'initial' ? 3 : 0,
            );
            if (location === 'refresh' && (status === 503 || status === 'protocol')) {
                await page.setViewportSize({ width: 320, height: 1000 });
                await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
                await noOverflow(page);
                await inbox(page).getByRole('status').scrollIntoViewIfNeeded();
                await info.attach(`320-${status}-refresh-text-200`, {
                    body: await page.screenshot({
                        path: info.outputPath('refresh-error-text-200.png'),
                    }),
                    contentType: 'image/png',
                });
            }
            state.failure = null;
            if (location === 'next' && status === 503)
                await inbox(page)
                    .getByRole('button', { name: '重试加载更多', exact: true })
                    .click();
            else await inbox(page).getByRole('button', { name: '重试', exact: true }).click();
            await expect(entries(page)).toHaveCount(location === 'next' ? 6 : 3);
            if (location === 'next')
                expect(calls.filter((call) => call.cursor).map((call) => call.cursor)).toEqual([
                    cursor,
                    cursor,
                ]);
        });
    }
}

test('从收件箱离开后迟到读取不在报告页显示列表或已读提示', async ({ page }) => {
    const { state, calls } = await samples(page.context());
    let release!: () => void;
    await page.goto('/inbox');
    await expect(entries(page)).toHaveCount(3);
    state.getWait = new Promise<void>((resolve) => {
        release = resolve;
    });
    await refresh(page).click();
    await expect.poll(() => calls.filter((call) => call.path === '/api/v1/inbox').length).toBe(2);
    await reportLink(page, 1).click();
    await expect(
        page.getByRole('article', { name: item(1).report.title, exact: true }),
    ).toBeVisible();
    release();
    await expect(inbox(page)).toHaveCount(0);
    expect(patches(calls)).toHaveLength(0);
});
