import { logoutFromAccount, expectAccountReady } from './support/account-menu.ts';
import { openReportTool } from './support/report-tools.ts';
import { expect, test } from '@playwright/test';
import type { BrowserContext, Page, Route } from '@playwright/test';

// Controlled HTTP samples exercise production SFCs/transport, not actual DB persistence.
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const stamp = '2026-10-31T01:00:00Z';
const reportPath = `/reports/${id(1)}`;
const sourceA = id(21);
const sourceB = id(31);
const target = { kind: 'report' as const, id: id(1) };
const failure = (code = 'TEST_FAILURE') => ({ code, message: 'sample', requestId: 'sample' });
const account = (switched = false) => ({
    user: {
        id: id(switched ? 101 : 100),
        email: 'reader@example.test',
        preferences: {
            defaultTimezone: 'UTC',
            notificationPreference: { mode: 'summary', runIssues: true },
        },
        createdAt: stamp,
    },
    csrfToken: 'notes-test-only',
});
function note(n = 40, body = '服务端原笔记', revision = 1, kind: 'report' | 'source' = 'report') {
    return {
        id: id(n),
        target: { kind, id: kind === 'report' ? id(1) : sourceA },
        body,
        revision,
        createdAt: stamp,
        updatedAt: stamp,
    };
}
function bookmark(n: number, source: string) {
    return {
        id: id(n),
        sourceId: source,
        createdAt: stamp,
        source: {
            id: source,
            canonicalUrl: `https://example.test/${source}`,
            title: source === sourceA ? '资料 A' : '资料 B',
            latestSnapshotId: id(22),
            lastObservedAt: stamp,
        },
    };
}
function report() {
    const evidence = {
        id: id(20),
        sourceId: sourceA,
        snapshotId: id(22),
        title: '资料 A',
        url: 'https://example.test/source',
        quote: '研究资料按批次公开。',
        location: '第 2 段',
        observedAt: stamp,
        snapshot: {
            originalUrl: 'https://example.test/original',
            fetchedUrl: 'https://example.test/source',
            canonicalUrl: 'https://example.test/source',
            contentHash: 'a'.repeat(64),
            extractorVersion: 'reader-v1',
            publishedAt: null,
            truncated: true,
            selector: { type: 'text_offset', start: 0, end: 12, extractorVersion: 'reader-v1' },
        },
    };
    return {
        id: id(1),
        taskId: id(2),
        runId: id(3),
        taskVersionId: id(4),
        baselineRunId: null,
        schemaVersion: 1,
        title: '可追溯的基础简报',
        summary: '笔记与收藏不会改变历史报告。',
        format: 'brief',
        mode: 'demo',
        outcome: 'inconclusive',
        coverage: {
            completeness: 'partial',
            searchedQueries: ['资料'],
            gaps: ['未交叉核验'],
            exhausted: [],
        },
        limitations: ['仅保存片段'],
        claims: [
            {
                id: id(10),
                kind: 'fact',
                text: evidence.quote,
                confidenceLabel: '来源原文',
                evidenceIds: [id(20)],
            },
        ],
        evidence: [evidence],
        changes: [],
        publishedAt: stamp,
    };
}
type Note = ReturnType<typeof note>;
type RequestRecord = {
    method: string;
    path: string;
    query: string;
    body: string | null;
    key?: string;
    tag?: string;
    csrf?: string;
};
type State = {
    rows: Note[];
    bookmarks: ReturnType<typeof bookmark>[];
    requests: RequestRecord[];
    unexpected: string[];
    switched: boolean;
    post: 'ok' | 'lost' | 'rate' | 'pending' | 'deleted';
    patch: 'ok' | 'lost' | 'same' | 'skip' | 'rate';
    remove: 'ok' | 'lost';
    detail: 'ok' | 'no-etag' | 'wrong-id' | 'wrong-target' | 'error';
    listStatus: number;
    pageSize: number;
    reportHold: boolean;
    reportWaiting: boolean;
    releaseReport?: (status: number) => void;
};
async function samples(context: BrowserContext, initial: Note[] = []) {
    const state: State = {
        rows: initial,
        bookmarks: [bookmark(60, sourceA), bookmark(61, sourceB)],
        requests: [],
        unexpected: [],
        switched: false,
        post: 'ok',
        patch: 'ok',
        remove: 'ok',
        detail: 'ok',
        listStatus: 200,
        pageSize: 20,
        reportHold: false,
        reportWaiting: false,
    };
    const keys = new Map<string, string>();
    const respond = (route: Route, value: Note) =>
        route.fulfill({ json: value, headers: { etag: `"${value.revision}"` } });
    await context.route('**/api/v1/**', async (route) => {
        const req = route.request();
        const url = new URL(req.url());
        const path = url.pathname.replace('/api/v1', '');
        const method = req.method();
        const headers = req.headers();
        state.requests.push({
            method,
            path,
            query: url.search,
            body: req.postData(),
            key: headers['idempotency-key'],
            tag: headers['if-match'],
            csrf: headers['x-csrf-token'],
        });
        if (path === '/me') return route.fulfill({ json: account(state.switched) });
        if (path === `/tasks/${id(2)}/feedback` && method === 'GET')
            return route.fulfill({ json: { items: [] } });
        if (path === '/auth/logout') return route.fulfill({ status: 204 });
        if (path === '/auth/login') {
            state.switched = true;
            return route.fulfill({ json: account(true) });
        }
        if (path === `/reports/${id(1)}/conversation`)
            return route.fulfill({ json: { reportId: id(1), turns: [], hasEarlier: false } });
        if (path === `/reports/${id(1)}`) {
            if (state.switched) return route.fulfill({ status: 404, json: failure() });
            if (state.reportHold) {
                state.reportWaiting = true;
                const status = await new Promise<number>((resolve) => {
                    state.releaseReport = resolve;
                });
                return status === 200
                    ? route.fulfill({ json: report() })
                    : route.fulfill({ status, json: failure() });
            }
            return route.fulfill({ json: report() });
        }
        if (path === '/bookmarks' && method === 'GET')
            return route.fulfill({
                json: { items: state.switched ? [] : state.bookmarks, nextCursor: null },
            });
        if (path.startsWith('/bookmarks/') && method === 'DELETE') {
            state.bookmarks = state.bookmarks.filter((item) => !path.endsWith(item.id));
            return route.fulfill({ status: 204 });
        }
        if (path === '/notes' && method === 'GET') {
            if (state.listStatus !== 200)
                return route.fulfill({ status: state.listStatus, json: failure() });
            const sourceId = url.searchParams.get('sourceId');
            const reportId = url.searchParams.get('reportId');
            const rows = state.switched
                ? []
                : state.rows.filter(
                      (item) =>
                          (!sourceId && !reportId) ||
                          (item.target.id === (sourceId ?? reportId) &&
                              item.target.kind === (sourceId ? 'source' : 'report')),
                  );
            const offset = Number(url.searchParams.get('cursor') ?? 0);
            return route.fulfill({
                json: {
                    items: rows.slice(offset, offset + state.pageSize),
                    nextCursor:
                        offset + state.pageSize < rows.length
                            ? String(offset + state.pageSize)
                            : null,
                },
            });
        }
        if (path === '/notes' && method === 'POST') {
            const input = req.postDataJSON() as { body: string; target: Note['target'] };
            if (state.post === 'rate')
                return route.fulfill({
                    status: 429,
                    headers: { 'retry-after': '2' },
                    json: failure('RATE_LIMITED'),
                });
            if (state.post === 'pending')
                return route.fulfill({ status: 409, json: failure('IDEMPOTENCY_PENDING') });
            if (state.post === 'deleted')
                return route.fulfill({
                    status: 409,
                    json: failure('IDEMPOTENCY_RESOURCE_DELETED'),
                });
            const key = headers['idempotency-key']!;
            const old = state.rows.find((item) => item.id === keys.get(key));
            const value = old ?? {
                ...note(80 + state.rows.length, input.body),
                target: input.target,
            };
            if (!old) {
                state.rows.unshift(value);
                keys.set(key, value.id);
            }
            if (state.post === 'lost') return route.fulfill({ status: 503, json: failure() });
            return route.fulfill({
                status: old ? 200 : 201,
                headers: { etag: `"${value.revision}"` },
                json: { note: value, reused: !!old },
            });
        }
        if (path.startsWith('/notes/')) {
            const value = state.rows.find((item) => path === `/notes/${item.id}`);
            if (!value || state.switched) return route.fulfill({ status: 404, json: failure() });
            if (method === 'GET') {
                if (state.detail === 'error')
                    return route.fulfill({ status: 503, json: failure() });
                const result =
                    state.detail === 'wrong-id'
                        ? { ...value, id: id(999) }
                        : state.detail === 'wrong-target'
                          ? { ...value, target: { kind: 'source', id: value.target.id } }
                          : value;
                return route.fulfill({
                    json: result,
                    headers: state.detail === 'no-etag' ? {} : { etag: `"${value.revision}"` },
                });
            }
            if (headers['if-match'] !== `"${value.revision}"`)
                return route.fulfill({ status: 409, json: failure('REVISION_CONFLICT') });
            if (method === 'PATCH') {
                if (state.patch === 'rate')
                    return route.fulfill({
                        status: 429,
                        headers: { 'retry-after': '2' },
                        json: failure('RATE_LIMITED'),
                    });
                const input = req.postDataJSON() as { body: string };
                value.body = input.body;
                value.revision += state.patch === 'same' ? 0 : state.patch === 'skip' ? 2 : 1;
                if (state.patch === 'lost') return route.fulfill({ status: 503, json: failure() });
                return respond(route, value);
            }
            if (method === 'DELETE') {
                state.rows = state.rows.filter((item) => item.id !== value.id);
                return state.remove === 'lost'
                    ? route.fulfill({ status: 503, json: failure() })
                    : route.fulfill({ status: 204 });
            }
        }
        state.unexpected.push(`${method} ${path}`);
        return route.fulfill({ status: 501, json: failure() });
    });
    return state;
}
const panel = (page: Page) => page.locator('.notes-panel:visible');
const editor = (page: Page) => page.locator('.note-editor:visible');
const draft = (page: Page) => editor(page).getByRole('textbox', { name: '本地笔记正文' });
const action = (page: Page, name: string) =>
    editor(page).getByRole('button', { name, exact: true });
const writes = (state: State, method?: string) =>
    state.requests.filter(
        (req) =>
            req.path.startsWith('/notes') &&
            req.method !== 'GET' &&
            (!method || req.method === method),
    );
async function openReport(page: Page) {
    await page.goto(reportPath);
    await expect(page.locator('.report-brief')).toBeVisible();
    await openReportTool(page, 'notes');
    await expect(panel(page)).toBeVisible();
}
async function openNote(page: Page) {
    if (await page.locator('.notes-tool').count()) await openReportTool(page, 'notes');
    await panel(page).getByRole('button', { name: '编辑笔记', exact: true }).first().click();
    await expect(draft(page)).toBeEditable();
}
async function newNote(page: Page, body = '原始本地稿') {
    if (await page.locator('.notes-tool').count()) await openReportTool(page, 'notes');
    await panel(page).getByRole('button', { name: '新建笔记', exact: true }).click();
    await expect(draft(page)).toBeFocused();
    await draft(page).fill(body);
}
async function library(page: Page) {
    await page
        .getByRole('navigation', { name: '主导航' })
        .getByRole('link', { name: '资料库', exact: true })
        .click();
}
async function confirmClick(page: Page, name: string, accept: boolean) {
    page.once('dialog', (dialog) => (accept ? dialog.accept() : dialog.dismiss()));
    await action(page, name).click();
}
async function switchAccount(page: Page) {
    await logoutFromAccount(page);
    await page.getByRole('textbox', { name: '邮箱', exact: true }).fill('next@example.test');
    await page.getByLabel('密码', { exact: true }).fill('another-password-123');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expectAccountReady(page);
}

test('HTTP sample: create, edit, explicit delete use actual detail quoted ETags and no other resource writes', async ({
    page,
    context,
}) => {
    const state = await samples(context);
    await openReport(page);
    const brief = await page.locator('.report-brief').textContent();
    const body =
        '  原始\t笔记\n<script>window.noteInjected=1</script>\n**Markdown** <img src="https://evil.test/image">  ';
    await newNote(page, body);
    await action(page, '创建笔记').click();
    await expect(
        page.locator('.scova-notifications .n-notification').filter({ hasText: '笔记已创建' }),
    ).toBeVisible();
    expect(writes(state, 'POST')).toHaveLength(1);
    expect(JSON.parse(writes(state, 'POST')[0]!.body!)).toEqual({ body, target });
    expect(writes(state)[0]!.key).toMatch(/^[\w-]{16,128}$/);
    expect(writes(state)[0]!.csrf).toBe('notes-test-only');
    expect(
        state.requests.filter(
            (req) => req.path === `/notes/${state.rows[0]!.id}` && req.method === 'GET',
        ),
    ).toHaveLength(1);
    await expect(panel(page).locator('.notes-list .note-body')).toHaveText(body);
    expect(await panel(page).locator('.notes-list .note-body').textContent()).toBe(body);
    await expect(panel(page).locator('script,img,iframe')).toHaveCount(0);
    await draft(page).fill('修改后的正文');
    await action(page, '保存笔记').click();
    await expect(
        page.locator('.scova-notifications .n-notification').filter({ hasText: '笔记已保存' }),
    ).toBeVisible();
    expect(writes(state, 'PATCH')[0]!.tag).toBe('"1"');
    expect(JSON.parse(writes(state, 'PATCH')[0]!.body!)).toEqual({ body: '修改后的正文' });
    await confirmClick(page, '删除笔记', false);
    expect(writes(state, 'DELETE')).toHaveLength(0);
    await confirmClick(page, '删除笔记', true);
    await expect(
        page.locator('.scova-notifications .n-notification').filter({ hasText: '笔记已删除' }),
    ).toBeVisible();
    expect(writes(state, 'DELETE')[0]!.tag).toBe('"2"');
    expect(await page.locator('.report-brief').textContent()).toBe(brief);
    expect(state.unexpected).toEqual([]);
});

test('HTTP sample: two pages conflict preserve the losing draft until explicit rebase/adopt', async ({
    page,
    context,
}) => {
    const state = await samples(context, [note()]);
    const other = await context.newPage();
    await openReport(page);
    await openReport(other);
    await openNote(page);
    await openNote(other);
    await draft(page).fill('标签页A的新版本');
    await draft(other).fill('标签页B不应丢失的稿');
    await action(page, '保存笔记').click();
    await expect(action(page, '保存笔记')).toBeEnabled();
    await action(other, '保存笔记').click();
    await expect(
        other.locator('.scova-notifications .n-notification').filter({ hasText: '修订冲突' }),
    ).toBeVisible();
    await expect(draft(other)).toHaveValue('标签页B不应丢失的稿');
    await action(other, '重新读取服务端副本').click();
    await expect(editor(other).locator('.server-copy .note-body')).toHaveText('标签页A的新版本');
    await expect(action(other, '保存笔记')).toBeDisabled();
    await action(other, '保留本地稿，按此版本整理').click();
    await expect(draft(other)).toHaveValue('标签页B不应丢失的稿');
    await action(other, '保存笔记').click();
    await expect(
        other.locator('.scova-notifications .n-notification').filter({ hasText: '笔记已保存' }),
    ).toBeVisible();
    expect(writes(state, 'PATCH').map((req) => req.tag)).toEqual(['"1"', '"1"', '"2"']);
    await draft(page).fill('A仍有本地稿');
    await action(page, '重新读取服务端副本').click();
    await confirmClick(page, '采用服务端正文', false);
    await expect(draft(page)).toHaveValue('A仍有本地稿');
    await confirmClick(page, '采用服务端正文', true);
    await expect(draft(page)).toHaveValue('标签页B不应丢失的稿');
    await other.close();
});

test('HTTP sample: unknown create keeps immutable attempt; replay current content requires explicit review', async ({
    page,
    context,
}) => {
    const state = await samples(context);
    state.post = 'lost';
    await openReport(page);
    await newNote(page, '  原稿\n保持  ');
    await action(page, '创建笔记').click();
    await expect(action(page, '同键核对并重放创建')).toBeEnabled();
    await expect(draft(page)).not.toBeEditable();
    await panel(page).getByRole('combobox', { name: '笔记目标' }).selectOption(`source:${sourceA}`);
    await expect(panel(page).getByRole('combobox', { name: '笔记目标' })).toHaveValue(
        `report:${id(1)}`,
    );
    await library(page);
    await expect(page).toHaveURL(new RegExp(reportPath));
    const created = state.rows[0]!;
    created.body = '重放时服务端已变的正文';
    created.revision = 4;
    state.post = 'ok';
    await action(page, '同键核对并重放创建').click();
    await expect(editor(page).locator('.server-copy .note-body')).toHaveText(created.body);
    await expect(draft(page)).toHaveValue('  原稿\n保持  ');
    await expect(action(page, '保存笔记')).toBeDisabled();
    expect(writes(state, 'POST')[1]).toEqual(writes(state, 'POST')[0]);
    await action(page, '保留本地稿，按此版本整理').click();
    await action(page, '保存笔记').click();
    await expect(
        page.locator('.scova-notifications .n-notification').filter({ hasText: '笔记已保存' }),
    ).toBeVisible();
    expect(writes(state, 'PATCH')[0]!.tag).toBe('"4"');
});

test('HTTP sample: pending/deleted key cannot silently become a new create', async ({
    page,
    context,
}) => {
    const state = await samples(context);
    state.post = 'pending';
    await openReport(page);
    await newNote(page);
    await action(page, '创建笔记').click();
    await expect(action(page, '同键核对并重放创建')).toBeEnabled();
    state.post = 'deleted';
    await action(page, '同键核对并重放创建').click();
    await expect(
        page.locator('.scova-notifications .n-notification').filter({ hasText: '旧键不能复建' }),
    ).toBeVisible();
    await expect(action(page, '同键核对并重放创建')).toBeDisabled();
    await confirmClick(page, '结束本次创建尝试', false);
    await expect(draft(page)).not.toBeEditable();
    await confirmClick(page, '结束本次创建尝试', true);
    await expect(draft(page)).toHaveValue('原始本地稿');
    state.post = 'ok';
    await action(page, '创建笔记').click();
    await expect(
        page.locator('.scova-notifications .n-notification').filter({ hasText: '笔记已创建' }),
    ).toBeVisible();
    const posts = writes(state, 'POST');
    expect(posts[0]!.key).toBe(posts[1]!.key);
    expect(posts[2]!.key).not.toBe(posts[0]!.key);
});

for (const actionName of ['PATCH', 'DELETE'] as const) {
    test(`HTTP sample: unknown ${actionName} cannot resend before actual GET and explicit resolution`, async ({
        page,
        context,
    }) => {
        const state = await samples(context, [note()]);
        await openReport(page);
        await openNote(page);
        await draft(page).fill('未知操作后的可复制稿');
        if (actionName === 'PATCH') {
            state.patch = 'lost';
            await action(page, '保存笔记').click();
        } else {
            state.remove = 'lost';
            await confirmClick(page, '删除笔记', true);
        }
        await expect(
            page
                .locator('.scova-notifications .n-notification')
                .filter({ hasText: '操作结果尚未确认' }),
        ).toBeVisible();
        await expect(action(page, '保存笔记')).toBeDisabled();
        await library(page);
        await expect(page).toHaveURL(new RegExp(reportPath));
        if (actionName === 'PATCH') {
            state.detail = 'error';
            await action(page, '重新读取服务端副本').click();
            await expect(
                page
                    .locator('.scova-notifications .n-notification')
                    .filter({ hasText: '暂时无法读取' }),
            ).toBeVisible();
            await expect(action(page, '保存笔记')).toBeDisabled();
            state.detail = 'ok';
            await action(page, '重新读取服务端副本').click();
            await expect(editor(page).locator('.server-copy')).toBeVisible();
            await expect(action(page, '保存笔记')).toBeDisabled();
            await action(page, '保留本地稿，按此版本整理').click();
        } else {
            await action(page, '重新读取服务端副本').click();
            await expect(
                page
                    .locator('.scova-notifications .n-notification')
                    .filter({ hasText: '不存在或当前账号无法访问' }),
            ).toBeVisible();
            await expect(action(page, '关闭笔记')).toBeVisible();
        }
        await expect(draft(page)).toHaveValue('未知操作后的可复制稿');
        expect(writes(state, actionName)).toHaveLength(1);
    });
}

for (const revision of ['same', 'skip'] as const) {
    test(`HTTP sample: PATCH ${revision} revision is unknown, never saved`, async ({
        page,
        context,
    }) => {
        const state = await samples(context, [note()]);
        state.patch = revision;
        await openReport(page);
        await openNote(page);
        await draft(page).fill('修订必须只增一');
        await action(page, '保存笔记').click();
        await expect(
            page
                .locator('.scova-notifications .n-notification')
                .filter({ hasText: '操作结果尚未确认' }),
        ).toBeVisible();
        await expect(action(page, '保存笔记')).toBeDisabled();
        await expect(draft(page)).toHaveValue('修订必须只增一');
        expect(writes(state, 'PATCH')).toHaveLength(1);
    });
}

test('HTTP sample: 429 Retry-After retains raw create attempt without automatic writes', async ({
    page,
    context,
}) => {
    await page.clock.install();
    const state = await samples(context);
    state.post = 'rate';
    await openReport(page);
    await newNote(page, '限流原稿');
    await action(page, '创建笔记').click();
    await expect(action(page, '同键核对并重放创建')).toBeDisabled();
    await expect(editor(page).getByRole('status').filter({ hasText: '可重试时间' })).toBeVisible();
    await page.clock.runFor(2100);
    await expect(action(page, '同键核对并重放创建')).toBeEnabled();
    expect(writes(state, 'POST')).toHaveLength(1);
    await expect(draft(page)).toHaveValue('限流原稿');
    state.post = 'ok';
    await action(page, '同键核对并重放创建').click();
    await expect(
        page.locator('.scova-notifications .n-notification').filter({ hasText: '笔记已创建' }),
    ).toBeVisible();
    expect(writes(state, 'POST')[1]).toEqual(writes(state, 'POST')[0]);
});

for (const bad of ['no-etag', 'wrong-id', 'wrong-target'] as const) {
    test(`HTTP sample: list revision cannot authorize editing with ${bad} detail`, async ({
        page,
        context,
    }) => {
        const state = await samples(context, [note()]);
        state.detail = bad;
        await openReport(page);
        await panel(page).getByRole('button', { name: '编辑笔记', exact: true }).click();
        await expect(
            page
                .locator('.scova-notifications .n-notification')
                .filter({ hasText: '数据校验失败' }),
        ).toBeVisible();
        await expect(action(page, '保存笔记')).toBeDisabled();
        await expect(action(page, '删除笔记')).toBeDisabled();
        expect(writes(state)).toHaveLength(0);
    });
}

test('HTTP sample: source A entry, manual B, bookmarks, A entry again creates only for A', async ({
    page,
    context,
}) => {
    const state = await samples(context);
    await page.goto('/library');
    const entry = page
        .locator('.bookmark-entry')
        .filter({ has: page.getByRole('heading', { name: '资料 A', exact: true }) });
    await entry.getByRole('button', { name: '为此来源记笔记' }).click();
    await expect(panel(page).getByRole('combobox')).toHaveValue(`source:${sourceA}`);
    await panel(page).getByRole('combobox').selectOption(`source:${sourceB}`);
    await page
        .getByRole('navigation', { name: '资料库分区' })
        .getByRole('button', { name: '收藏', exact: true })
        .click();
    await entry.getByRole('button', { name: '为此来源记笔记' }).click();
    await expect(panel(page).getByRole('combobox')).toHaveValue(`source:${sourceA}`);
    await newNote(page, '返回A入口的笔记');
    await action(page, '创建笔记').click();
    await expect(
        page.locator('.scova-notifications .n-notification').filter({ hasText: '笔记已创建' }),
    ).toBeVisible();
    expect(JSON.parse(writes(state, 'POST')[0]!.body!).target).toEqual({
        kind: 'source',
        id: sourceA,
    });
    expect(
        state.requests
            .filter((req) => req.path === '/notes' && req.method === 'GET')
            .every((req) => !new URLSearchParams(req.query).has('reportId')),
    ).toBe(true);
});

test('HTTP sample: dirty draft guards page, target, section and route; unbookmark keeps notes/report', async ({
    page,
    context,
}) => {
    const sourceNote = note(40, '取消收藏后仍保留', 1, 'source');
    const state = await samples(context, [sourceNote, note(41, '下一页', 1, 'source')]);
    state.pageSize = 1;
    await page.goto('/library');
    await page
        .locator('.bookmark-entry')
        .first()
        .getByRole('button', { name: '为此来源记笔记' })
        .click();
    await openNote(page);
    await draft(page).fill('跨区护稿');
    let dialogs = 0;
    const dismiss = async (dialog: import('@playwright/test').Dialog) => {
        dialogs++;
        await dialog.dismiss();
    };
    page.on('dialog', dismiss);
    const reads = state.requests.length;
    await panel(page).getByRole('button', { name: '下一页笔记' }).click();
    await panel(page).getByRole('combobox').selectOption(`source:${sourceB}`);
    await page
        .getByRole('navigation', { name: '资料库分区' })
        .getByRole('button', { name: '收藏', exact: true })
        .click();
    await page
        .getByRole('navigation', { name: '主导航' })
        .getByRole('link', { name: '任务', exact: true })
        .click();
    await expect(draft(page)).toHaveValue('跨区护稿');
    expect(dialogs).toBe(4);
    expect(state.requests).toHaveLength(reads);
    page.off('dialog', dismiss);
    await confirmClick(page, '取消编辑', true);
    await page
        .getByRole('navigation', { name: '资料库分区' })
        .getByRole('button', { name: '收藏', exact: true })
        .click();
    const first = page.locator('.bookmark-entry').first();
    page.once('dialog', (dialog) => dialog.accept());
    await first.getByRole('button', { name: '取消收藏', exact: true }).click();
    await expect(page.locator('.bookmark-entry')).toHaveCount(1);
    await page
        .getByRole('navigation', { name: '资料库分区' })
        .getByRole('button', { name: '笔记', exact: true })
        .click();
    await panel(page).getByRole('combobox').selectOption('');
    await expect(panel(page).locator('.note-body')).toHaveText(sourceNote.body);
    await expect(panel(page).getByRole('link', { name: '打开关联报告' })).toHaveCount(0);
    expect(writes(state)).toHaveLength(0);
    expect(state.requests.filter((req) => req.method === 'DELETE').map((req) => req.path)).toEqual([
        `/bookmarks/${id(60)}`,
    ]);
    expect(state.unexpected).toEqual([]);
});

for (const status of [503, 403, 404]) {
    test(`HTTP sample: stale Report slow ${status} keeps same-owner local draft but hides all server content`, async ({
        page,
        context,
    }) => {
        const state = await samples(context, [note()]);
        await page.clock.install();
        await openReport(page);
        const now = await page.evaluate(() => Date.now());
        await page.getByRole('link', { name: '阅读外观', exact: true }).click();
        await expect(page).toHaveURL(/\/account\/appearance$/);
        await page.clock.setFixedTime(now + 31_000);
        state.reportHold = true;
        await page.goBack();
        await expect.poll(() => state.reportWaiting).toBe(true);
        await expect(page.locator('.report-brief')).toBeVisible();
        await newNote(page, `报告失败仍保留-${status}`);
        state.releaseReport!(status);
        await expect(page.locator('.report-brief')).toHaveCount(0);
        await expect(
            panel(page).getByRole('status').filter({ hasText: '报告暂时不可用' }),
        ).toBeVisible();
        await expect(draft(page)).toHaveValue(`报告失败仍保留-${status}`);
        await expect(draft(page)).toBeEditable();
        await expect(panel(page).locator('.notes-list,.server-copy,.notes-tools')).toHaveCount(0);
        await expect(action(page, '创建笔记')).toBeDisabled();
        const before = state.requests.length;
        page.once('dialog', (dialog) => dialog.dismiss());
        await library(page);
        await expect(page).toHaveURL(new RegExp(reportPath));
        await expect(draft(page)).toHaveValue(`报告失败仍保留-${status}`);
        expect(state.requests).toHaveLength(before);
        expect(writes(state)).toHaveLength(0);
    });
}

for (const late of [201, 401]) {
    test(`HTTP sample: old-owner delayed POST${late} cannot restore draft or expire replacement`, async ({
        page,
        context,
    }) => {
        const state = await samples(context);
        let release!: () => void;
        let posted = false;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        await page.route('**/api/v1/notes', async (route) => {
            if (route.request().method() !== 'POST') return route.fallback();
            posted = true;
            await gate;
            return route.fulfill({
                status: late,
                headers: { etag: '"1"' },
                json: late === 201 ? { note: note(90, '旧账号秘密稿'), reused: false } : failure(),
            });
        });
        await openReport(page);
        await newNote(page, '旧账号秘密稿');
        await action(page, '创建笔记').click();
        await expect.poll(() => posted).toBe(true);
        await switchAccount(page);
        await expect(page.locator('.report-brief,.note-editor')).toHaveCount(0);
        release();
        await library(page);
        await page
            .getByRole('navigation', { name: '资料库分区' })
            .getByRole('button', { name: '笔记', exact: true })
            .click();
        await expect(panel(page).locator('.note-body')).toHaveCount(0);
        await expect(page.getByText('旧账号秘密稿', { exact: true })).toHaveCount(0);
        await expectAccountReady(page);
        expect(state.switched).toBe(true);
    });
}

for (const mode of ['review', 'unknown-create'] as const) {
    test(`HTTP sample: unavailable Report locks ${mode} while retaining only local copy`, async ({
        page,
        context,
    }) => {
        const state = await samples(context, [note()]);
        await page.clock.install();
        await openReport(page);
        const now = await page.evaluate(() => Date.now());
        await page.getByRole('link', { name: '阅读外观', exact: true }).click();
        await expect(page).toHaveURL(/\/account\/appearance$/);
        await page.clock.setFixedTime(now + 31_000);
        state.reportHold = true;
        await page.goBack();
        await expect.poll(() => state.reportWaiting).toBe(true);
        if (mode === 'review') {
            await openNote(page);
            await draft(page).fill('本地保留，不泄露服务端副本');
            await action(page, '重新读取服务端副本').click();
            await expect(editor(page).locator('.server-copy')).toBeVisible();
        } else {
            state.post = 'lost';
            await newNote(page, '未知创建原稿');
            await action(page, '创建笔记').click();
            await expect(action(page, '同键核对并重放创建')).toBeEnabled();
        }
        const before = state.requests.length;
        state.releaseReport!(503);
        await expect(
            panel(page).getByRole('status').filter({ hasText: '报告暂时不可用' }),
        ).toBeVisible();
        await expect(panel(page).locator('.notes-list,.server-copy,.notes-tools')).toHaveCount(0);
        if (mode === 'review') {
            await expect(draft(page)).toHaveValue('本地保留，不泄露服务端副本');
            await expect(action(page, '保存笔记')).toBeDisabled();
            await expect(action(page, '重新读取服务端副本')).toBeDisabled();
            await expect(action(page, '删除笔记')).toBeDisabled();
        } else {
            await expect(draft(page)).toHaveValue('未知创建原稿');
            await expect(action(page, '同键核对并重放创建')).toBeDisabled();
        }
        expect(state.requests).toHaveLength(before);
    });
}

test('HTTP sample: actual note pagination and invalid cursor recover explicitly from first page', async ({
    page,
    context,
}) => {
    const state = await samples(context, [note(40, '首条'), note(41, '后页')]);
    state.pageSize = 1;
    await openReport(page);
    await expect(panel(page).locator('.notes-list .note-body')).toHaveText('首条');
    await panel(page).getByRole('button', { name: '下一页笔记' }).click();
    await expect(panel(page).locator('.notes-list .note-body')).toHaveText('后页');
    await expect(panel(page).getByRole('button', { name: '下一页笔记' })).toHaveCount(0);
    state.listStatus = 400;
    await panel(page).getByRole('button', { name: '重新读取本页', exact: true }).click();
    await expect(panel(page).getByRole('alert')).toContainText('分页位置已失效');
    const reads = state.requests.filter((req) => req.path === '/notes' && req.method === 'GET');
    expect(new URLSearchParams(reads.at(-1)!.query).get('cursor')).toBe('1');
    state.listStatus = 200;
    await panel(page).getByRole('button', { name: '从第一页重新读取', exact: true }).click();
    await expect(panel(page).locator('.notes-list .note-body')).toHaveText('首条');
    expect(new URLSearchParams(state.requests.at(-1)!.query).has('cursor')).toBe(false);
    expect(writes(state)).toHaveLength(0);
});

for (const status of [503, 403, 404]) {
    test(`HTTP sample: note list ${status} uses correct cached-content visibility`, async ({
        page,
        context,
    }) => {
        const state = await samples(context, [note()]);
        await openReport(page);
        await expect(panel(page).locator('.notes-list .note-body')).toHaveText('服务端原笔记');
        state.listStatus = status;
        await panel(page).getByRole('button', { name: '重新读取本页', exact: true }).click();
        await expect(panel(page).getByRole('alert')).toBeVisible();
        if (status === 503) {
            await expect(panel(page).locator('.notes-list .note-body')).toHaveText('服务端原笔记');
            await expect(
                panel(page).getByText('以下保留上次读取值，请重新读取以确认。'),
            ).toBeVisible();
        } else await expect(panel(page).locator('.notes-list .note-body')).toHaveCount(0);
        expect(writes(state)).toHaveLength(0);
    });
}

test('HTTP sample: UTF16 limit and front-end controls prevent writes without normalizing text', async ({
    page,
    context,
}) => {
    const state = await samples(context);
    await openReport(page);
    await newNote(page, '😀'.repeat(10_001));
    await expect(action(page, '创建笔记')).toBeDisabled();
    await draft(page).fill('😀'.repeat(10_000));
    await expect(action(page, '创建笔记')).toBeEnabled();
    await draft(page).fill('a'.repeat(20_001));
    await expect(action(page, '创建笔记')).toBeDisabled();
    await draft(page).fill('a'.repeat(20_000));
    await expect(action(page, '创建笔记')).toBeEnabled();
    await draft(page).fill('正文\u007f');
    await expect(action(page, '创建笔记')).toBeDisabled();
    await draft(page).fill(' \t\n ');
    await expect(action(page, '创建笔记')).toBeDisabled();
    expect(writes(state)).toHaveLength(0);
});

for (const width of [320, 390, 768, 1024, 1440, 1920]) {
    test(`HTTP sample: notes ${width}, light/dark and 200% root text remain readable`, async ({
        page,
        context,
    }, testInfo) => {
        const long = `原始笔记\n${'研究来源与已保存证据需要分开阅读。'.repeat(30)}\nhttps://example.test/${'a'.repeat(360)}\n<script>ignored</script>`;
        const state = await samples(context, [note(40, long)]);
        const errors: string[] = [];
        const external: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        page.on('request', (req) => {
            if (!new URL(req.url()).hostname.match(/^(127\.0\.0\.1|localhost)$/))
                external.push(req.url());
        });
        await page.setViewportSize({ width, height: 950 });
        await openReport(page);
        await openNote(page);
        await draft(page).fill(`本地待整理\n${long}`);
        state.rows[0]!.body = `服务端副本\n${long}`;
        state.rows[0]!.revision = 2;
        await action(page, '重新读取服务端副本').click();
        await expect(editor(page).locator('.server-copy')).toBeVisible();
        await page.evaluate(() => document.fonts.ready);
        for (const dark of [false, true]) {
            await page.emulateMedia({ colorScheme: dark ? 'dark' : 'light' });
            await expect(page.locator('.scova-theme--dark')).toHaveCount(dark ? 1 : 0);
            for (const enlarged of [false, true]) {
                await page.evaluate((value) => {
                    document.documentElement.style.fontSize = value ? '200%' : '';
                }, enlarged);
                await expect
                    .poll(() =>
                        page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
                    )
                    .toBe(true);
                const geometry = await panel(page)
                    .locator('button,textarea,select')
                    .evaluateAll((elements) =>
                        elements
                            .filter((element) => element.getBoundingClientRect().width > 0)
                            .map((element) => {
                                const rect = element.getBoundingClientRect();
                                return { left: rect.left, right: rect.right, height: rect.height };
                            }),
                    );
                expect(
                    geometry.every(
                        (rect) =>
                            rect.left >= -1 &&
                            rect.right <= width + 1 &&
                            rect.height >= (enlarged ? 88 : 44) - 1,
                    ),
                ).toBe(true);
                expect(
                    await draft(page).evaluate((element) => getComputedStyle(element).cursor),
                ).toBe('text');
                expect(
                    await draft(page).evaluate((element) => getComputedStyle(element).fontFamily),
                ).toContain('Inter');
                expect(await editor(page).locator('.server-copy .note-body').textContent()).toBe(
                    state.rows[0]!.body,
                );
                await draft(page).focus();
                await draft(page).press('Tab');
                await expect(action(page, '重新读取服务端副本')).toBeFocused();
                await editor(page).screenshot({
                    path: testInfo.outputPath(
                        `notes-${width}-${dark ? 'dark' : 'light'}${enlarged ? '-text200' : ''}.png`,
                    ),
                });
            }
        }
        expect(errors).toEqual([]);
        expect(external).toEqual([]);
        expect(state.unexpected).toEqual([]);
        expect(writes(state)).toHaveLength(0);
    });
}
