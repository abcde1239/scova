import { expect, test, type Page } from '@playwright/test';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const sourceId = uuid(21);
const snapshotId = uuid(22);
const reportId = uuid(51);
const runId = uuid(31);
const taskId = uuid(41);
const instant = '2026-10-31T01:00:00.123456Z';
const opaque = 'opaque+/=/%E6%B8%B8%E6%A0%87/2026-10-31T01:00:00.123456Z';
const cursor2 = 'second+/=游标';
const failure = (code = 'TEST_FAILURE') => ({ code, message: 'sample', requestId: 'search-e2e' });
const account = (n: number) => ({
    user: {
        id: uuid(n),
        email: `reader-${n}@example.test`,
        preferences: {
            defaultTimezone: 'UTC',
            notificationPreference: { mode: 'summary', runIssues: true },
        },
        createdAt: instant,
    },
    csrfToken: 'search-e2e',
});
function source(n = 22, title = '小样本：来源快照') {
    return {
        kind: 'source',
        id: uuid(n),
        sourceId,
        snapshotId: uuid(n),
        reportId: null,
        title,
        excerpt: '中文小样本内容，按字面检索。',
        matchedBy: 'substring',
        updatedAt: instant,
    };
}
function note(target: 'source' | 'report', n = 62) {
    return {
        kind: 'note',
        id: uuid(n),
        sourceId: target === 'source' ? sourceId : null,
        snapshotId: null,
        reportId: target === 'report' ? reportId : null,
        title: target === 'source' ? 'Robotics 来源笔记' : 'Robotics 报告笔记',
        excerpt: 'Robotics saved note context.',
        matchedBy: 'fts',
        updatedAt: instant,
    };
}
const allHits = () => [
    source(),
    source(23, '同来源第二快照'),
    note('source', 22),
    note('report', 63),
];
type Reply = { status?: number; json?: unknown; abort?: boolean };
type Read = {
    q: string | null;
    kind: string | null;
    bookmarked: string | null;
    cursor: string | null;
    limit: string | null;
    owner: number;
};
type State = {
    owner: number;
    reads: Read[];
    external: string[];
    writes: string[];
    unexpected: string[];
    failures: string[];
    release: (() => void)[];
    search: (read: Read, index: number) => Reply | Promise<Reply>;
};
const states = new WeakMap<Page, State>();
const pageData = (items: unknown[] = allHits(), nextCursor: string | null = null) => ({
    items,
    nextCursor,
});
function newState(): State {
    return {
        owner: 100,
        reads: [],
        external: [],
        writes: [],
        unexpected: [],
        failures: [],
        release: [],
        search: () => ({ json: pageData() }),
    };
}
function gate(state: State) {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => (release = resolve));
    state.release.push(release);
    return { promise, release };
}
function snapshot(n = 22) {
    return {
        id: uuid(n),
        sourceId,
        observationId: uuid(n + 100),
        runId,
        title: n === 22 ? '小样本：来源快照' : '同来源第二快照',
        canonicalUrl: 'https://outside.example.test/canonical',
        originalUrl: 'https://outside.example.test/original',
        fetchedUrl: 'https://outside.example.test/fetched',
        contentHash: 'a'.repeat(64),
        extractorVersion: 'reader-v1',
        observedAt: instant,
        publishedAt: null,
        textExpiresAt: '2026-10-30T00:00:00Z',
        bodyStatus: 'expired',
        mode: 'demo',
        truncated: false,
    };
}
function report() {
    return {
        id: reportId,
        runId,
        taskId,
        taskVersionId: uuid(42),
        title: '关联报告真实目标',
        summary: '报告摘要',
        format: 'brief',
        mode: 'demo',
        outcome: 'important_change',
        coverage: {
            completeness: 'complete',
            searchedQueries: ['小样本'],
            gaps: [],
            exhausted: [],
        },
        publishedAt: instant,
    };
}
async function installApi(page: Page, state = newState()) {
    states.set(page, state);
    page.on('request', (request) => {
        const url = new URL(request.url());
        if (
            ['http:', 'https:'].includes(url.protocol) &&
            !['127.0.0.1', 'localhost'].includes(url.hostname)
        )
            state.external.push(request.url());
    });
    page.on('requestfailed', (request) => {
        if (new URL(request.url()).pathname === '/api/v1/library/search')
            state.failures.push(request.failure()?.errorText ?? 'failed');
    });
    await page.route('**/api/v1/**', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const path = url.pathname;
        const method = request.method();
        if (method !== 'GET') {
            state.writes.push(`${method} ${path}`);
            if (path === '/api/v1/auth/logout') return route.fulfill({ status: 204 });
            if (path === '/api/v1/auth/login') {
                state.owner = 101;
                return route.fulfill({ json: account(101) });
            }
            state.unexpected.push(`${method} ${path}`);
            return route.fulfill({ status: 404, json: failure() });
        }
        if (path === '/api/v1/me') return route.fulfill({ json: account(state.owner) });
        if (new URL(page.url()).pathname === `/reports/${reportId}`) {
            if (path === `/api/v1/tasks/${taskId}/feedback`)
                return route.fulfill({ json: { items: [] } });
            if (path === '/api/v1/notes')
                return route.fulfill({ json: { items: [], nextCursor: null } });
        }
        if (path === '/api/v1/library/search') {
            const read = {
                q: url.searchParams.get('q'),
                kind: url.searchParams.get('kind'),
                bookmarked: url.searchParams.get('bookmarked'),
                cursor: url.searchParams.get('cursor'),
                limit: url.searchParams.get('limit'),
                owner: state.owner,
            };
            state.reads.push(read);
            const reply = await state.search(read, state.reads.length);
            if (reply.abort) return route.abort('failed');
            return route.fulfill({ status: reply.status ?? 200, json: reply.json ?? failure() });
        }
        if (path === '/api/v1/bookmarks') return route.fulfill({ json: pageData([]) });
        if (path === `/api/v1/library/sources/${sourceId}/snapshots`)
            return route.fulfill({ json: pageData([snapshot(), snapshot(23)]) });
        const n =
            path === `/api/v1/library/sources/${sourceId}/snapshots/${snapshotId}`
                ? 22
                : path === `/api/v1/library/sources/${sourceId}/snapshots/${uuid(23)}`
                  ? 23
                  : null;
        if (n !== null)
            return route.fulfill({
                json: {
                    snapshot: snapshot(n),
                    textBody: null,
                    quotes: [
                        {
                            id: uuid(71),
                            runId,
                            quote: '到期后仍保留的引用',
                            quoteHash: 'b'.repeat(64),
                            selector: {
                                type: 'text_offset',
                                start: 0,
                                end: '到期后仍保留的引用'.length,
                                extractorVersion: 'reader-v1',
                            },
                        },
                    ],
                    quotesTruncated: false,
                },
            });
        if (path === `/api/v1/reports/${reportId}`)
            return route.fulfill({
                json: {
                    ...report(),
                    baselineRunId: null,
                    schemaVersion: 1,
                    claims: [
                        {
                            id: uuid(81),
                            kind: 'fact',
                            text: '来源确认保存资料。',
                            confidenceLabel: '来源陈述',
                            evidenceIds: [uuid(82)],
                        },
                    ],
                    evidence: [
                        {
                            id: uuid(82),
                            sourceId,
                            snapshotId,
                            url: 'https://outside.example.test/original',
                            title: '保存来源',
                            quote: '来源确认保存资料。',
                            location: '第1段',
                            observedAt: instant,
                        },
                    ],
                    changes: [],
                    limitations: [],
                },
            });
        if (path === '/api/v1/reports') return route.fulfill({ json: pageData([report()]) });
        if (path === `/api/v1/runs/${runId}`)
            return route.fulfill({
                json: {
                    id: runId,
                    taskId,
                    taskVersionId: uuid(42),
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
                    usage: {
                        searches: 1,
                        pages: 1,
                        inputTokens: 10,
                        outputTokens: 10,
                        estimated: false,
                    },
                    coverage: report().coverage,
                    queuedAt: instant,
                    startedAt: instant,
                    finishedAt: instant,
                    failureCode: null,
                },
            });
        state.unexpected.push(`${method} ${path}`);
        return route.fulfill({ status: 404, json: failure() });
    });
    return state;
}
const input = (page: Page) => page.getByLabel('搜索已保存资料', { exact: true });
const region = (page: Page) => page.getByRole('region', { name: '检索结果', exact: true });
const results = (page: Page) => page.locator('li.search-result');
async function open(page: Page) {
    await page.goto('/library/search');
    await expect(page.getByRole('heading', { name: '搜索已存资料', exact: true })).toBeVisible();
    await expect(input(page)).toBeVisible();
}
async function search(page: Page, q = '小样本') {
    await input(page).fill(q);
    await input(page).press('Enter');
}
async function done(page: Page, count = 4) {
    await expect(results(page)).toHaveCount(count);
    await expect(region(page)).toHaveAttribute('aria-busy', 'false');
}
async function loginB(page: Page) {
    const menu = page.getByRole('button', { name: '打开导航菜单' });
    if (await menu.isVisible()) await menu.click();
    await page.getByRole('button', { name: '退出登录' }).click();
    await page.getByLabel('邮箱', { exact: true }).fill('reader-101@example.test');
    await page.getByLabel('密码', { exact: true }).fill('local-only-password');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(input(page)).toBeVisible();
}
test.beforeAll(async ({ browser }) => console.log(`Browser: Chromium ${browser.version()}`));
test.afterEach(async ({ page }) => {
    const state = states.get(page);
    if (!state) return;
    state.release.forEach((release) => release());
    expect(state.external, 'no off-origin requests').toEqual([]);
    expect(state.unexpected, 'no N+1 enrichment or unexpected endpoint').toEqual([]);
    expect(
        state.writes.filter(
            (entry) => !['POST /api/v1/auth/login', 'POST /api/v1/auth/logout'].includes(entry),
        ),
    ).toEqual([]);
});

test('资料库入口、原文scope与中英文匹配，不联网或启动Run', async ({ page }) => {
    const state = await installApi(page);
    await page.goto('/library');
    await page.getByRole('link', { name: '搜索已存资料', exact: true }).click();
    await expect(page).toHaveURL(/\/library\/search$/);
    await expect(
        page.getByText('只检索当前账号已保存的来源快照与纯文本笔记，不进行联网搜索。'),
    ).toBeVisible();
    await search(page, '  Robotics 小样本  ');
    await done(page);
    expect(state.reads).toEqual([
        {
            q: '  Robotics 小样本  ',
            kind: null,
            bookmarked: null,
            cursor: null,
            limit: '20',
            owner: 100,
        },
    ]);
    await expect(page.getByText('字面子串匹配', { exact: true })).toHaveCount(2);
    await expect(page.getByText('全文词项匹配', { exact: true })).toHaveCount(2);
    await expect(input(page)).toBeFocused();
    expect(state.writes).toEqual([]);
});

test('中文IME组合与Enter不会提交半词，结束后只提交最终词', async ({ page }) => {
    const state = await installApi(page);
    await open(page);
    await input(page).dispatchEvent('compositionstart', { data: '' });
    await input(page).fill('小');
    await input(page).press('Enter');
    await page.waitForTimeout(400);
    expect(state.reads).toEqual([]);
    await expect(page.getByRole('button', { name: '搜索已存资料', exact: true })).toBeDisabled();
    await input(page).fill('小样本');
    await input(page).dispatchEvent('compositionend', { data: '小样本' });
    await done(page);
    expect(state.reads.map((read) => read.q)).toEqual(['小样本']);
    await expect(input(page)).toBeFocused();
});

test('300ms防抖仅提交最终英文，取消定时器保留输入且清空归焦', async ({ page }) => {
    const state = await installApi(page);
    await open(page);
    await input(page).fill('Rob');
    await input(page).fill('Robotics');
    await done(page);
    expect(state.reads.map((read) => read.q)).toEqual(['Robotics']);
    await input(page).fill('canceled timer');
    await expect(results(page)).toHaveCount(0);
    await page.getByRole('button', { name: '取消检索', exact: true }).click();
    await page.waitForTimeout(400);
    expect(state.reads).toHaveLength(1);
    await expect(input(page)).toHaveValue('canceled timer');
    await expect(page.getByRole('status').filter({ hasText: '已取消本次检索' })).toBeVisible();
    await page.getByRole('button', { name: '清空输入', exact: true }).click();
    await expect(input(page)).toHaveValue('');
    await expect(input(page)).toBeFocused();
});

for (const action of ['取消检索', '清空输入', '离开页面']) {
    test(`在途${action}取消请求，迟到成功不恢复结果`, async ({ page }) => {
        const state = await installApi(page);
        const pending = gate(state);
        state.search = async () => {
            await pending.promise;
            return { json: pageData([source(22, '旧请求独有内容')]) };
        };
        await open(page);
        await search(page, 'pending');
        await expect.poll(() => state.reads.length).toBe(1);
        await expect(region(page)).toHaveAttribute('aria-busy', 'true');
        if (action === '离开页面')
            await page.getByRole('link', { name: '收藏', exact: true }).click();
        else await page.getByRole('button', { name: action, exact: true }).click();
        await expect.poll(() => state.failures.length).toBeGreaterThan(0);
        pending.release();
        await page.waitForTimeout(100);
        await expect(page.getByText('旧请求独有内容', { exact: true })).toHaveCount(0);
        if (action === '取消检索') await expect(input(page)).toHaveValue('pending');
        if (action === '清空输入') await expect(input(page)).toHaveValue('');
        expect(state.reads).toHaveLength(1);
    });
}

test('A→B→A的新意图拒绝被取消A1和B迟到响应', async ({ page }) => {
    const state = await installApi(page);
    const first = gate(state);
    const second = gate(state);
    state.search = async (_, index) => {
        if (index === 1) {
            await first.promise;
            return { json: pageData([source(22, '旧A1')]) };
        }
        if (index === 2) {
            await second.promise;
            return { status: 503 };
        }
        return { json: pageData([source(23, '新A2')]) };
    };
    await open(page);
    await search(page, 'A');
    await expect.poll(() => state.reads.length).toBe(1);
    await search(page, 'B');
    await expect.poll(() => state.reads.length).toBe(2);
    await search(page, 'A');
    await done(page, 1);
    await expect(page.getByRole('link', { name: '新A2', exact: true })).toBeVisible();
    second.release();
    first.release();
    await page.waitForTimeout(100);
    await expect(results(page)).toContainText('新A2');
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(state.reads.map((read) => read.q)).toEqual(['A', 'B', 'A']);
    await expect(input(page)).toBeFocused();
});

test('空白/201码元/9词零请求，200码元及8词可真实提交', async ({ page }) => {
    const state = await installApi(page);
    await open(page);
    for (const q of ['   ', '中'.repeat(201), '😀'.repeat(101), 'a b c d e f g h i']) {
        await search(page, q);
        await expect(page.getByRole('alert')).toBeVisible();
        await page.waitForTimeout(350);
        expect(state.reads).toEqual([]);
    }
    await search(page, '😀'.repeat(100));
    await done(page);
    await search(page, 'a b c d e f g h');
    await done(page);
    expect(state.reads.map((read) => read.q)).toEqual(['😀'.repeat(100), 'a b c d e f g h']);
});

test('kind/bookmarked原样过滤、false不等于全部、任一切换丢弃旧cursor', async ({ page }) => {
    const state = await installApi(page);
    state.search = (read) => ({
        json: pageData(
            read.kind === 'note' ? [note('source')] : [source()],
            read.cursor ? null : opaque,
        ),
    });
    await open(page);
    await search(page);
    await done(page, 1);
    await page.getByRole('button', { name: '下一页', exact: true }).click();
    await expect.poll(() => state.reads.length).toBe(2);
    await page.getByRole('combobox', { name: '资料类型', exact: true }).selectOption('note');
    await done(page, 1);
    expect(state.reads.at(-1)).toMatchObject({ kind: 'note', cursor: null });
    await page.getByRole('combobox', { name: '来源收藏状态', exact: true }).selectOption('true');
    await done(page, 1);
    expect(state.reads.at(-1)).toMatchObject({ bookmarked: 'true', cursor: null });
    await page.getByRole('combobox', { name: '来源收藏状态', exact: true }).selectOption('false');
    await done(page, 1);
    expect(state.reads.at(-1)).toMatchObject({ bookmarked: 'false', cursor: null });
    await page.getByRole('combobox', { name: '来源收藏状态', exact: true }).selectOption('all');
    await page.getByRole('combobox', { name: '资料类型', exact: true }).selectOption('all');
    await done(page, 1);
    expect(state.reads.at(-1)).toMatchObject({ kind: null, bookmarked: null, cursor: null });
});

for (const target of ['snapshot', 'source-note', 'report-note'] as const) {
    test(`typed ${target}实际站内定位，不混用source/snapshot/note/report ID`, async ({ page }) => {
        await installApi(page);
        await open(page);
        await search(page);
        await done(page);
        const index = target === 'snapshot' ? 1 : target === 'source-note' ? 2 : 3;
        const link = results(page).nth(index).getByRole('link').last();
        const path =
            target === 'snapshot'
                ? `/library/sources/${sourceId}/snapshots/${uuid(23)}`
                : target === 'source-note'
                  ? `/library/sources/${sourceId}/snapshots`
                  : `/reports/${reportId}`;
        await expect(link).toHaveAttribute('href', path);
        await link.press('Enter');
        await expect.poll(() => new URL(page.url()).pathname).toBe(path);
        await expect(
            page.getByRole('heading', {
                name: target === 'report-note' ? '关联报告真实目标' : '来源历史',
                exact: true,
            }),
        ).toBeVisible();
    });
}

test('过期正文限制只作范围说明，当前状态由来源详情权威展示并保quote', async ({ page }) => {
    await installApi(page);
    await open(page);
    await search(page);
    await done(page);
    await expect(page.getByText(/过期正文不参与检索/)).toBeVisible();
    await expect(page.locator('.search-results')).not.toContainText('已过期');
    await results(page).first().getByRole('link', { name: '查看命中来源快照' }).click();
    await expect(page.getByText(/已过期|已清理/).first()).toBeVisible();
    const quote = page.locator('details.saved-quote').first();
    await quote.locator('summary').press('Enter');
    await expect(quote.locator('blockquote')).toHaveText('到期后仍保留的引用');
    await expect(page.locator('.snapshot-body')).toHaveCount(0);
});

test('opaque游标往返、终页及按钮消失焦点，400恢复必须新增首GET', async ({ page }) => {
    const state = await installApi(page);
    let status = 200;
    let firstReads = 0;
    state.search = (read) => {
        if (!read.cursor) {
            firstReads++;
            return { json: pageData([source(22, `第一页${firstReads}`)], opaque) };
        }
        return status === 200 ? { json: pageData([source(23, '第二页终页')]) } : { status };
    };
    await open(page);
    await search(page, '  exact scope  ');
    await done(page, 1);
    await page.getByRole('button', { name: '下一页', exact: true }).press('Enter');
    await done(page, 1);
    await expect(results(page)).toContainText('第二页终页');
    expect(state.reads.at(-1)?.cursor).toBe(opaque);
    await expect(page.getByRole('button', { name: '下一页', exact: true })).toHaveCount(0);
    await expect(region(page)).toBeFocused();
    await page.getByRole('button', { name: '上一页', exact: true }).press('Enter');
    await expect(page.getByRole('button', { name: '下一页', exact: true })).toBeVisible();
    status = 400;
    await page.getByRole('button', { name: '下一页', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('分页位置已失效');
    const before = firstReads;
    await page.getByRole('button', { name: '从第一页重新读取', exact: true }).click();
    await done(page, 1);
    expect(firstReads).toBeGreaterThan(before);
    expect(state.reads.at(-1)).toMatchObject({ q: '  exact scope  ', cursor: null });
    await expect(results(page)).toContainText(`第一页${firstReads}`);
});

for (const broken of [
    '同页重复',
    '跨页重复',
    '自返游标',
    '三页循环',
    '空页带游标',
    '超额页',
] as const) {
    test(`分页${broken}拒绝展示坏页且真实从头恢复`, async ({ page }) => {
        const state = await installApi(page);
        let repaired = false;
        state.search = (read) => {
            if (repaired) return { json: pageData([source(24, '恢复后新结果')]) };
            if (!read.cursor) {
                if (broken === '同页重复') return { json: pageData([source(), source()]) };
                if (broken === '空页带游标') return { json: pageData([], opaque) };
                if (broken === '超额页')
                    return {
                        json: pageData(Array.from({ length: 21 }, (_, n) => source(n + 100))),
                    };
                return { json: pageData([source()], opaque) };
            }
            if (broken === '跨页重复') return { json: pageData([source()]) };
            if (broken === '自返游标') return { json: pageData([source(23)], opaque) };
            if (read.cursor === opaque) return { json: pageData([source(23)], cursor2) };
            return { json: pageData([source(24)], opaque) };
        };
        await open(page);
        await search(page);
        if (['跨页重复', '自返游标', '三页循环'].includes(broken)) {
            await page.getByRole('button', { name: '下一页', exact: true }).click();
            if (broken === '三页循环') {
                await expect(results(page)).toContainText('小样本');
                await page.getByRole('button', { name: '下一页', exact: true }).click();
            }
        }
        await expect(page.getByRole('alert')).toContainText('校验失败');
        await expect(results(page)).toHaveCount(0);
        await expect(page.getByRole('button', { name: '下一页', exact: true })).toHaveCount(0);
        const before = state.reads.length;
        repaired = true;
        await page.getByRole('button', { name: '从第一页重新读取', exact: true }).click();
        await done(page, 1);
        expect(state.reads.length).toBeGreaterThan(before);
        expect(state.reads.at(-1)?.cursor).toBe(null);
        await expect(results(page)).toContainText('恢复后新结果');
    });
}

for (const invalid of [
    'source错snapshot',
    'source带report',
    'note双目标',
    'note零目标',
    'note带snapshot',
    'kind错筛选',
    '收藏带报告笔记',
] as const) {
    test(`拒绝typed/scope非法响应：${invalid}`, async ({ page }) => {
        const state = await installApi(page);
        state.search = () => ({
            json: pageData([
                invalid === 'source错snapshot'
                    ? { ...source(), id: uuid(99) }
                    : invalid === 'source带report'
                      ? { ...source(), reportId }
                      : invalid === 'note双目标'
                        ? { ...note('source'), reportId }
                        : invalid === 'note零目标'
                          ? { ...note('report'), reportId: null }
                          : invalid === 'note带snapshot'
                            ? { ...note('report'), snapshotId }
                            : invalid === 'kind错筛选'
                              ? note('source')
                              : note('report'),
            ]),
        });
        await open(page);
        if (invalid === 'kind错筛选')
            await page
                .getByRole('combobox', { name: '资料类型', exact: true })
                .selectOption('source');
        if (invalid === '收藏带报告笔记')
            await page
                .getByRole('combobox', { name: '来源收藏状态', exact: true })
                .selectOption('true');
        await search(page);
        await expect(page.getByRole('alert')).toContainText('校验失败');
        await expect(results(page)).toHaveCount(0);
    });
}

for (const status of [422, 503, 403, 404, 409, 'network', 'schema'] as const) {
    test(`检索${status}隐藏旧命中且错误不冒充empty，重读实际GET`, async ({ page }) => {
        const state = await installApi(page);
        await open(page);
        await search(page);
        await done(page);
        state.search = () =>
            status === 'network'
                ? { abort: true }
                : status === 'schema'
                  ? { json: { items: [{ title: 'bad' }], nextCursor: null } }
                  : { status };
        await search(page, '新条件');
        await expect(page.getByRole('alert')).toContainText(
            status === 422
                ? '未通过校验'
                : status === 503
                  ? '暂时不可用'
                  : status === 403 || status === 404
                    ? '无法读取'
                    : status === 'schema'
                      ? '校验失败'
                      : '失败',
        );
        await expect(results(page)).toHaveCount(0);
        await expect(page.getByText('当前关键词和筛选条件下，没有已存资料命中。')).toHaveCount(0);
        const before = state.reads.length;
        state.search = () => ({ json: pageData([]) });
        await page.getByRole('button', { name: '从第一页重新读取', exact: true }).click();
        await expect(
            page.getByRole('status').filter({ hasText: '没有已存资料命中' }),
        ).toBeVisible();
        expect(state.reads.length).toBeGreaterThan(before);
        await expect(input(page)).toHaveValue('新条件');
    });
}

test('当前owner401正确清会话并进入登录', async ({ page }) => {
    const state = await installApi(page);
    state.search = () => ({ status: 401 });
    await open(page);
    await search(page);
    await expect(page.getByLabel('邮箱', { exact: true })).toBeVisible();
    await expect(results(page)).toHaveCount(0);
});

for (const lateStatus of [200, 401]) {
    test(`换号清理输入和分页，旧owner迟到${lateStatus}不恢复或登出新owner`, async ({ page }) => {
        const state = await installApi(page);
        const pending = gate(state);
        state.search = async (read) => {
            if (read.owner === 100) {
                await pending.promise;
                return lateStatus === 200
                    ? { json: pageData([source(22, '旧owner秘密')]) }
                    : { status: 401 };
            }
            return { json: pageData([source(23, '新owner资料')]) };
        };
        await open(page);
        await search(page, '旧账号词');
        await expect.poll(() => state.reads.length).toBe(1);
        await loginB(page);
        await expect(input(page)).toHaveValue('');
        await expect(results(page)).toHaveCount(0);
        await search(page, '新账号词');
        await done(page, 1);
        pending.release();
        await page.waitForTimeout(100);
        await expect(results(page)).toContainText('新owner资料');
        await expect(page.getByText('旧owner秘密', { exact: true })).toHaveCount(0);
        await expect(page.getByLabel('邮箱', { exact: true })).toHaveCount(0);
        expect(state.reads.at(-1)).toMatchObject({ owner: 101, q: '新账号词', cursor: null });
    });
}

test('500码元摘录和恶意title完整字面、安全且无外网', async ({ page }) => {
    const state = await installApi(page);
    const malicious =
        '<script>globalThis.scovaInjected=1</script><img src="https://outside.example.test/x" onerror="globalThis.scovaInjected=2">';
    const excerpt = (
        malicious +
        '\n中文😀https://outside.example.test/' +
        '很长的内容'.repeat(100)
    ).slice(0, 500);
    state.search = () => ({ json: pageData([{ ...source(), title: malicious, excerpt }]) });
    await open(page);
    await search(page);
    await done(page, 1);
    expect(await page.locator('.search-excerpt').textContent()).toBe(excerpt);
    expect(await results(page).locator('h3').textContent()).toBe(malicious);
    await expect(results(page).locator('script,img')).toHaveCount(0);
    expect(await page.evaluate(() => Reflect.get(globalThis, 'scovaInjected'))).toBeUndefined();
    await expect(page.locator('.search-excerpt')).toHaveCSS('white-space', 'pre-wrap');
});

for (const colorScheme of ['light', 'dark'] as const) {
    for (const width of [320, 360, 390, 768, 1024, 1440]) {
        test(`六宽${width} ${colorScheme} 正常与200%根字号、字体/cursor/键盘`, async ({
            page,
        }, info) => {
            const state = await installApi(page);
            const longTitle =
                '长中文来源标题与连续URLhttps://outside.example.test/' + 'research'.repeat(16);
            state.search = () => ({
                json: pageData(
                    [
                        {
                            ...source(),
                            title: longTitle,
                            excerpt: (
                                '中文研究资料\nhttps://outside.example.test/' + 'long'.repeat(150)
                            ).slice(0, 500),
                        },
                    ],
                    opaque,
                ),
            });
            await page.emulateMedia({ colorScheme });
            await page.setViewportSize({ width, height: 900 });
            await open(page);
            await search(page);
            await done(page, 1);
            for (const zoom of [100, 200]) {
                await page.evaluate((value) => {
                    document.documentElement.style.fontSize = `${value}%`;
                }, zoom);
                await expect
                    .poll(() =>
                        page.evaluate(() =>
                            Math.max(
                                document.body.scrollWidth,
                                document.documentElement.scrollWidth,
                            ),
                        ),
                    )
                    .toBe(width);
                await expect(input(page)).toHaveCSS('cursor', 'text');
                await expect(page.locator('.search-excerpt')).toHaveCSS('cursor', 'default');
                await expect(results(page)).toHaveCSS('cursor', 'default');
                await expect(results(page).locator('dl')).toHaveCSS('cursor', 'default');
                await expect(results(page).locator('time')).toHaveCSS('cursor', 'default');
                await expect(results(page).locator('h3 a')).toHaveCSS('cursor', 'pointer');
                const link = results(page).first().getByRole('link').last();
                await expect(link).toHaveCSS('cursor', 'pointer');
                await link.focus();
                await expect(link).toBeFocused();
                const geometry = await link.evaluate((element) => {
                    const rect = element.getBoundingClientRect();
                    const style = getComputedStyle(element);
                    return {
                        width: rect.width,
                        height: rect.height,
                        left: rect.left,
                        right: rect.right,
                        outline: style.outlineStyle,
                        root: parseFloat(getComputedStyle(document.documentElement).fontSize),
                    };
                });
                expect(geometry.height).toBeGreaterThanOrEqual(geometry.root * 2.75 - 1);
                expect(geometry.left).toBeGreaterThanOrEqual(0);
                expect(geometry.right).toBeLessThanOrEqual(width + 1);
                expect(geometry.outline).not.toBe('none');
                expect(
                    await input(page).evaluate((element) => getComputedStyle(element).fontFamily),
                ).toMatch(/sans|Inter/i);
                expect(
                    await results(page)
                        .locator('h3')
                        .evaluate((element) => getComputedStyle(element).fontFamily),
                ).toMatch(/serif/i);
                if (zoom === 200 && (width === 320 || width === 1440))
                    await page.screenshot({
                        path: info.outputPath(`${colorScheme}-${width}-${zoom}.png`),
                        fullPage: true,
                    });
            }
        });
    }
}
