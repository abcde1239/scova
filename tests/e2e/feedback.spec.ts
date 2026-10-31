import { expect, test, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import type { Feedback, FeedbackInput } from '../../packages/models/src/feedback.ts';
import type { Report } from '../../packages/models/src/reports.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const instant = '2026-10-31T02:00:00Z';
const path = `/reports/${id(1)}`;
const source = `source:${id(21)}`;
const claim = `claim:${id(10)}`;
function fixture(): Report {
    return {
        id: id(1),
        taskId: id(2),
        runId: id(3),
        taskVersionId: id(4),
        baselineRunId: id(5),
        schemaVersion: 1,
        title: '招生政策研究报告',
        summary: '保留来源事实与尚未核验的缺口。',
        format: 'brief',
        mode: 'demo',
        outcome: 'inconclusive',
        coverage: {
            completeness: 'partial',
            searchedQueries: ['招生政策'],
            gaps: ['部分来源尚未核验'],
            exhausted: [],
        },
        limitations: ['仅代表保存来源'],
        claims: [
            {
                id: id(10),
                kind: 'fact',
                text: '招生政策的适用批次、申请范围与费用需要结合原始公告逐项核验，当前申请费为100元。',
                confidenceLabel: '仅代表来源陈述',
                evidenceIds: [id(20)],
            },
        ],
        evidence: [
            {
                id: id(20),
                sourceId: id(21),
                snapshotId: id(120),
                title: '持续跟踪招生政策与研究资料变化：来自原始公告的适用范围、申请条件和阶段性信息',
                url: 'https://example.test/source',
                quote: '当前申请费为100元。',
                location: '第2段',
                observedAt: instant,
            },
            {
                id: id(23),
                sourceId: id(21),
                snapshotId: id(123),
                title: '同一来源的第二条引用',
                url: 'https://example.test/source',
                quote: '申请范围按批次公开。',
                location: '第3段',
                observedAt: instant,
            },
        ],
        changes: [],
        publishedAt: instant,
    };
}
function feedback(extra: Partial<Feedback> = {}): Feedback {
    return {
        id: id(40),
        taskId: id(2),
        sourceId: id(21),
        claimId: null,
        kind: 'known',
        active: true,
        updatedAt: instant,
        ...extra,
    };
}
type Fault = number | 'protocol' | 'semantic' | null;
async function samples(context: BrowserContext) {
    const state = {
        report: fixture(),
        owner: 900,
        stored: { 900: [] } as Record<number, Feedback[]>,
        readFailure: null as Fault,
        writeFailure: null as Fault,
        acceptUnknown: false,
        concurrent: false,
        writeWait: undefined as Promise<void> | undefined,
        getWait: undefined as Promise<void> | undefined,
    };
    const account = () => ({
        user: {
            id: id(state.owner),
            email: 'feedback@example.test',
            createdAt: instant,
            preferences: {
                defaultTimezone: 'UTC',
                notificationPreference: { mode: 'summary', runIssues: true },
            },
        },
        csrfToken: 'sample-csrf',
    });
    const calls: { method: string; path: string; body?: unknown; csrf?: string }[] = [];
    await context.route('**/api/v1/**', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.pathname === '/api/v1/me') return route.fulfill({ json: account() });
        if (url.pathname === '/api/v1/auth/logout') return route.fulfill({ status: 204 });
        if (url.pathname === '/api/v1/auth/login') {
            state.owner++;
            return route.fulfill({ json: account() });
        }
        const owner = state.owner;
        const stored = () => state.stored[owner] ?? (state.stored[owner] = []);
        const body: unknown = request.method() === 'POST' ? request.postDataJSON() : undefined;
        calls.push({
            method: request.method(),
            path: url.pathname,
            body,
            csrf: request.headers()['x-csrf-token'],
        });
        const failure = (fault: Exclude<Fault, null>) =>
            fault === 'protocol'
                ? route.fulfill({ contentType: 'application/json', body: '{"broken"' })
                : route.fulfill({
                      status: typeof fault === 'number' ? fault : 400,
                      json: {
                          code: fault === 409 ? 'FEEDBACK_LIMIT' : 'LOCAL_FAILURE',
                          message: 'local sample',
                          requestId: 'sample',
                      },
                  });
        if (url.pathname.startsWith('/api/v1/reports/'))
            return route.fulfill({ json: state.report });
        if (request.method() === 'GET') {
            const items = structuredClone(stored().filter((entry) => entry.active));
            if (state.getWait) await state.getWait;
            if (state.readFailure === 'semantic')
                return route.fulfill({ json: { items: [feedback({ active: false })] } });
            if (state.readFailure) return failure(state.readFailure);
            return route.fulfill({ json: { items } });
        }
        if (state.writeWait) await state.writeWait;
        if (state.writeFailure && !state.acceptUnknown) return failure(state.writeFailure);
        let result: Feedback;
        if (request.method() === 'DELETE') {
            result = stored().find((entry) => entry.id === url.pathname.split('/').at(-1))!;
            result.active = false;
        } else {
            const input = body as FeedbackInput;
            const existing = stored().find((entry) =>
                input.sourceId
                    ? entry.sourceId === input.sourceId
                    : entry.claimId === input.claimId,
            );
            if (!existing && stored().filter((entry) => entry.active).length >= 200)
                return failure(409);
            result =
                existing ??
                feedback({
                    id: id(40 + stored().length),
                    sourceId: input.sourceId ?? null,
                    claimId: input.claimId ?? null,
                });
            if (!existing) stored().push(result);
            result.kind = input.kind;
            result.active = true;
            if (state.concurrent)
                stored().push(feedback({ id: id(777), sourceId: id(778), kind: 'irrelevant' }));
        }
        if (state.writeFailure) return failure(state.writeFailure);
        return route.fulfill({ json: result });
    });
    return { state, calls };
}
const panel = (page: Page) => page.getByRole('region', { name: '调整后续研究', exact: true });
const select = (page: Page) =>
    panel(page).getByRole('combobox', { name: '选择反馈资料或结论', exact: true });
const action = (page: Page, name: string) => panel(page).getByRole('button', { name, exact: true });
const current = (page: Page) =>
    panel(page)
        .locator('.selected-target')
        .getByText(/当前反馈：/);
const summary = (page: Page) => panel(page).locator('.active-feedback > summary');
const reread = (page: Page) => action(page, '重新读取反馈');
const writes = (calls: Awaited<ReturnType<typeof samples>>['calls']) =>
    calls.filter((entry) => ['POST', 'DELETE'].includes(entry.method));
const reads = (calls: Awaited<ReturnType<typeof samples>>['calls']) =>
    calls.filter((entry) => entry.path.endsWith('/feedback') && entry.method === 'GET');
async function ready(page: Page, target = source) {
    await expect(panel(page)).toBeVisible();
    await select(page).selectOption(target);
    await expect(action(page, '希望深入')).toBeEnabled();
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
async function noOverflow(page: Page) {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
    );
    for (const control of await panel(page).locator('button, select, summary').all()) {
        if (!(await control.isVisible())) continue;
        const box = await control.boundingBox();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
        expect(box!.height).toBeGreaterThanOrEqual(44);
    }
}
for (const width of [320, 390, 768, 1024, 1440, 1920]) {
    test(`反馈${width}：长资料/结论、200%重排、确认不改原报告`, async ({ page, baseURL }, info) => {
        const { state, calls } = await samples(page.context());
        const external: string[] = [];
        const errors: string[] = [];
        page.on('request', (request) => {
            if (new URL(request.url()).origin !== new URL(baseURL!).origin)
                external.push(request.url());
        });
        page.on('pageerror', (error) => errors.push(error.message));
        await page.setViewportSize({ width, height: 1000 });
        await page.goto(path);
        await ready(page);
        const original = await page.locator('.report-brief').innerText();
        await expect(select(page).locator(`option[value="${source}"]`)).toHaveCount(1);
        await expect(panel(page)).toContainText('仅供后续新执行捕获');
        await expect(panel(page)).toContainText('不修改配置版本与比较基线');
        expect(await select(page).evaluate((element) => getComputedStyle(element).cursor)).toBe(
            'pointer',
        );
        expect(
            await action(page, '已了解').evaluate((element) => getComputedStyle(element).cursor),
        ).toBe('pointer');
        await summary(page).press('Enter');
        await expect(panel(page)).toContainText('当前没有生效反馈');
        await panel(page).locator('h2').scrollIntoViewIfNeeded();
        await screenshot(page, info, 'empty-viewport');
        for (const enlarged of [false, true]) {
            if (enlarged)
                await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
            await noOverflow(page);
            await panel(page).locator('h2').scrollIntoViewIfNeeded();
            await screenshot(page, info, enlarged ? 'source-text-200-viewport' : 'source-viewport');
            await screenshot(page, info, enlarged ? 'source-text-200' : 'source-normal', true);
        }
        await action(page, '已了解').press('Enter');
        await expect(current(page)).toHaveText('当前反馈：已了解');
        await expect(action(page, '希望深入')).toBeEnabled();
        await select(page).selectOption(claim);
        await expect(panel(page).locator('.selected-target')).toContainText(
            state.report.claims[0]!.text,
        );
        await action(page, '希望深入').press('Enter');
        await expect(current(page)).toHaveText('当前反馈：希望深入');
        await expect(summary(page)).toContainText('2 / 200');
        await noOverflow(page);
        await panel(page).locator('.selected-target').scrollIntoViewIfNeeded();
        await screenshot(page, info, 'claim-confirmed-text-200-viewport');
        expect(await page.locator('.report-brief').innerText()).toBe(original);
        expect(writes(calls).map((entry) => entry.body)).toEqual([
            { taskId: id(2), sourceId: id(21), kind: 'known' },
            { taskId: id(2), claimId: id(10), kind: 'deeper' },
        ]);
        expect(calls.filter((entry) => entry.path.startsWith('/api/v1/reports/'))).toHaveLength(1);
        expect(external).toEqual([]);
        expect(errors).toEqual([]);
    });
}
test('三kind切换复用ID、同kind不重发、DELETE200false撤销且刷新一致', async ({ page }) => {
    const { state, calls } = await samples(page.context());
    await page.goto(path);
    await ready(page);
    for (const label of ['不相关', '已了解', '希望深入']) {
        await expect(action(page, label)).toBeEnabled();
        await action(page, label).click();
        await expect(current(page)).toHaveText(`当前反馈：${label}`);
        await expect(action(page, label)).toBeDisabled();
        const count = writes(calls).length;
        await action(page, label).press('Enter');
        await action(page, label).press('Space');
        expect(writes(calls)).toHaveLength(count);
        expect(state.stored[900]).toHaveLength(1);
        expect(state.stored[900]![0]!.id).toBe(id(40));
        await expect(reread(page)).toBeEnabled();
    }
    await page.reload();
    await select(page).selectOption(source);
    await expect(current(page)).toHaveText('当前反馈：希望深入');
    await expect(action(page, '撤销所选反馈')).toBeEnabled();
    await action(page, '撤销所选反馈').click();
    await expect(current(page)).toHaveText('当前反馈：未设置');
    await expect(summary(page)).toContainText('0 / 200');
    expect(writes(calls).at(-1)).toMatchObject({
        method: 'DELETE',
        path: `/api/v1/feedback/${id(40)}`,
    });
    expect(state.stored[900]![0]!.active).toBe(false);
    expect(writes(calls).every((entry) => entry.csrf === 'sample-csrf')).toBe(true);
    await page.reload();
    await ready(page);
    await expect(current(page)).toHaveText('当前反馈：未设置');
});
test('pending保原反馈，禁重复鼠标键盘与目标选择', async ({ page }, info) => {
    const { state, calls } = await samples(page.context());
    state.stored[900] = [feedback()];
    let release!: () => void;
    state.writeWait = new Promise<void>((resolve) => {
        release = resolve;
    });
    await page.setViewportSize({ width: 390, height: 1000 });
    await page.goto(path);
    await ready(page);
    await action(page, '希望深入').dblclick();
    await expect(select(page)).toBeDisabled();
    await expect(current(page)).toHaveText('当前反馈：已了解');
    for (const label of ['不相关', '已了解', '希望深入', '撤销所选反馈']) {
        await expect(action(page, label)).toBeDisabled();
        await expect(action(page, label)).toHaveAttribute('aria-busy', 'true');
        await action(page, label).press('Enter');
        await action(page, label).press('Space');
    }
    expect(writes(calls)).toHaveLength(1);
    expect(await select(page).evaluate((element) => getComputedStyle(element).cursor)).toBe(
        'not-allowed',
    );
    await panel(page).locator('.selected-target').scrollIntoViewIfNeeded();
    await screenshot(page, info, 'pending-viewport');
    release();
    await expect(current(page)).toHaveText('当前反馈：希望深入');
    await expect(select(page)).toBeEnabled();
});
test('未知写可能已保存：失败重读继续锁，只有新验证GET解锁', async ({ page }, info) => {
    const { state, calls } = await samples(page.context());
    state.stored[900] = [feedback()];
    state.acceptUnknown = true;
    state.writeFailure = 503;
    await page.setViewportSize({ width: 320, height: 1000 });
    await page.goto(path);
    await ready(page);
    await action(page, '希望深入').click();
    await expect(panel(page)).toContainText('提交结果尚未确认');
    await expect(current(page)).toHaveText('当前反馈：已了解');
    await expect(select(page)).toBeDisabled();
    await expect(action(page, '不相关')).toBeDisabled();
    expect(state.stored[900]![0]!.kind).toBe('deeper');
    state.readFailure = 503;
    await reread(page).click();
    await expect(panel(page).getByRole('alert')).toContainText('重新读取');
    await expect(select(page)).toBeDisabled();
    await expect(action(page, '不相关')).toBeDisabled();
    await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
    await noOverflow(page);
    await panel(page).locator('.selected-target').scrollIntoViewIfNeeded();
    await screenshot(page, info, 'unknown-failed-reread-200-viewport');
    state.readFailure = null;
    state.writeFailure = null;
    await reread(page).click();
    await expect(current(page)).toHaveText('当前反馈：希望深入');
    await expect(select(page)).toBeEnabled();
    await expect(action(page, '不相关')).toBeEnabled();
    expect(writes(calls)).toHaveLength(1);
    expect(reads(calls)).toHaveLength(3);
});
test('未知写面板卸载重挂使旧缓存stale并实际GET，成功前不能重发', async ({ page }) => {
    const { state, calls } = await samples(page.context());
    state.stored[900] = [feedback()];
    state.acceptUnknown = true;
    state.writeFailure = 503;
    await page.goto(path);
    await ready(page);
    await action(page, '希望深入').click();
    await expect(select(page)).toBeDisabled();
    await page.getByRole('link', { name: '阅读外观', exact: true }).click();
    await expect(page).toHaveURL(/\/account\/appearance$/);
    let release!: () => void;
    state.getWait = new Promise<void>((resolve) => {
        release = resolve;
    });
    await page.goBack();
    await expect(panel(page)).toBeVisible();
    await select(page).selectOption(source);
    await expect.poll(() => reads(calls).length).toBe(2);
    await expect(action(page, '不相关')).toBeDisabled();
    release();
    state.getWait = undefined;
    await expect(current(page)).toHaveText('当前反馈：希望深入');
    await expect(action(page, '不相关')).toBeEnabled();
    expect(writes(calls)).toHaveLength(1);
});
test('满200允许同目标切换，新增第201返回409并保原列表', async ({ page }, info) => {
    const { state, calls } = await samples(page.context());
    state.stored[900] = [
        feedback(),
        ...Array.from({ length: 199 }, (_, index) =>
            feedback({ id: id(1000 + index), sourceId: id(2000 + index) }),
        ),
    ];
    await page.goto(path);
    await ready(page);
    await expect(summary(page)).toContainText('200 / 200');
    await action(page, '希望深入').click();
    await expect(current(page)).toHaveText('当前反馈：希望深入');
    await expect(select(page)).toBeEnabled();
    await select(page).selectOption(claim);
    await action(page, '已了解').click();
    await expect(panel(page)).toContainText('最多同时生效 200 条反馈');
    await expect(current(page)).toHaveText('当前反馈：未设置');
    await expect(summary(page)).toContainText('200 / 200');
    await expect(select(page)).toBeEnabled();
    expect(state.stored[900]).toHaveLength(200);
    expect(writes(calls)).toHaveLength(2);
    await panel(page).locator('.selected-target').scrollIntoViewIfNeeded();
    await screenshot(page, info, 'limit-200-viewport');
});
test('确认写后精确GET包含其他目标并发变更，局部列表可单项撤销', async ({ page }) => {
    const { state, calls } = await samples(page.context());
    state.concurrent = true;
    await page.goto(path);
    await ready(page);
    const report = await page.locator('.report-brief').innerText();
    await action(page, '已了解').click();
    await expect(summary(page)).toContainText('2 / 200');
    expect(reads(calls)).toHaveLength(2);
    await summary(page).press('Enter');
    const other = panel(page)
        .locator('li')
        .filter({ hasText: id(778) });
    await expect(other).toHaveCount(1);
    await other.getByRole('button', { name: '撤销此项', exact: true }).click();
    await expect(summary(page)).toContainText('1 / 200');
    expect(await page.locator('.report-brief').innerText()).toBe(report);
    expect(writes(calls).at(-1)!.path).toBe(`/api/v1/feedback/${id(777)}`);
    expect(calls.filter((entry) => entry.path.startsWith('/api/v1/reports/'))).toHaveLength(1);
});
for (const status of [404, 403, 409]) {
    test(`已知写${status}保原且不自动重试`, async ({ page }, info) => {
        const { state, calls } = await samples(page.context());
        state.stored[900] = [feedback()];
        state.writeFailure = status;
        await page.goto(path);
        await ready(page);
        await action(page, '希望深入').click();
        await expect(panel(page).getByRole('status')).toContainText(
            status === 404 ? '目标不存在' : status === 409 ? '200' : '未能提交',
        );
        await expect(current(page)).toHaveText('当前反馈：已了解');
        await expect(select(page)).toBeEnabled();
        await expect(action(page, '希望深入')).toBeEnabled();
        expect(writes(calls)).toHaveLength(1);
        await panel(page).locator('.selected-target').scrollIntoViewIfNeeded();
        await screenshot(page, info, `write-${status}-viewport`);
    });
}
for (const phase of ['initial', 'refresh'] as const) {
    for (const status of [403, 404, 'protocol', 'semantic', 503] as const) {
        test(`${phase}反馈列表${status}：权限协议隐藏、503说明保原`, async ({ page }, info) => {
            const { state } = await samples(page.context());
            state.stored[900] = [feedback()];
            if (phase === 'initial') state.readFailure = status;
            await page.setViewportSize({ width: 390, height: 1000 });
            await page.goto(path);
            if (phase === 'refresh') {
                await ready(page);
                state.readFailure = status;
                await reread(page).click();
            }
            await expect(panel(page).getByRole('alert')).toBeVisible();
            await select(page).selectOption(source);
            await expect(current(page)).toHaveText(
                phase === 'refresh' && status === 503
                    ? '当前反馈：已了解'
                    : '当前反馈：尚未读取确认',
            );
            await expect(action(page, '希望深入')).toBeDisabled();
            await summary(page).press('Enter');
            await expect(panel(page).locator('li')).toHaveCount(
                phase === 'refresh' && status === 503 ? 1 : 0,
            );
            await panel(page).locator('.selected-target').scrollIntoViewIfNeeded();
            await screenshot(page, info, `${phase}-${status}-viewport`);
            state.readFailure = null;
            await reread(page).click();
            await expect(action(page, '希望深入')).toBeEnabled();
        });
    }
}
for (const status of [200, 401]) {
    test(`换号后迟到旧POST${status}不污染新会话`, async ({ page }) => {
        const { state, calls } = await samples(page.context());
        let release!: () => void;
        state.writeWait = new Promise<void>((resolve) => {
            release = resolve;
        });
        await page.goto(path);
        await ready(page);
        await action(page, '希望深入').click();
        await expect.poll(() => writes(calls).length).toBe(1);
        await page.getByRole('button', { name: '退出登录', exact: true }).click();
        await page.getByLabel('邮箱', { exact: true }).fill('new@example.test');
        await page.getByLabel('密码', { exact: true }).fill('local-only-password');
        await page.getByRole('button', { name: '登录', exact: true }).click();
        await expect(page).toHaveURL(new RegExp(`${path}$`));
        await ready(page);
        state.writeFailure = status === 401 ? 401 : null;
        release();
        await expect(current(page)).toHaveText('当前反馈：未设置');
        await expect(page.getByRole('button', { name: '退出登录', exact: true })).toBeVisible();
        await expect(action(page, '希望深入')).toBeEnabled();
        expect(state.owner).toBe(901);
    });
}
