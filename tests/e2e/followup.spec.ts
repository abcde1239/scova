import { logoutFromAccount, expectAccountReady } from './support/account-menu.ts';
import { expect, test, type Page } from '@playwright/test';
import type { Report, ReportQuestion, Run } from '../../packages/models/src/index.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const reportId = id(1),
    questionId = id(50),
    parentId = id(3),
    childId = id(60);
const reportPath = `/reports/${reportId}`;
const questionPath = `${reportPath}/questions/${questionId}`;
const followupPath = `${questionPath}/followup`;
const instant = '2026-10-31T01:00:00Z';
const budget = {
    maxSearches: 5,
    maxPages: 7,
    maxDurationSeconds: 91,
    maxInputTokens: 1234,
    maxOutputTokens: 567,
};
const failure = (code = 'TEST_FAILURE') => ({ code, message: 'sample', requestId: 'followup-e2e' });
const account = (owner = 100) => ({
    user: {
        id: id(owner),
        email: `reader-${owner}@example.test`,
        preferences: {
            defaultTimezone: 'UTC',
            notificationPreference: { mode: 'summary', runIssues: true },
        },
        createdAt: instant,
    },
    csrfToken: 'followup-e2e',
});
function report(mode: 'demo' | 'live' = 'demo'): Report {
    return {
        id: reportId,
        taskId: id(2),
        runId: parentId,
        taskVersionId: id(4),
        baselineRunId: null,
        schemaVersion: 1,
        title: '原报告：后续研究验证',
        summary: '保留原报告，不覆盖结论。',
        format: 'brief',
        mode,
        outcome: 'inconclusive',
        coverage: {
            completeness: 'partial',
            searchedQueries: ['已存资料'],
            gaps: ['缺少交叉核验'],
            exhausted: ['pages'],
        },
        limitations: ['只覆盖已保存片段'],
        claims: [
            {
                id: id(10),
                kind: 'fact',
                text: '原资料按批次公开。',
                confidenceLabel: '仅代表来源原文',
                evidenceIds: [id(20)],
            },
        ],
        evidence: [
            {
                id: id(20),
                sourceId: id(21),
                snapshotId: id(22),
                title: '原资料',
                url: 'https://outside.example.test/saved',
                quote: '原资料按批次公开。',
                location: '第1段',
                observedAt: instant,
            },
        ],
        changes: [],
        publishedAt: instant,
    };
}
function savedQuestion(_savedReport: Report): ReportQuestion {
    return {
        id: questionId,
        reportId,
        question: '  还需要哪些资料？\n保持保存问题原文  ',
        followupRunId: null,
        createdAt: instant,
        answer: {
            status: 'insufficient',
            reason: 'model_unavailable',
            statements: [],
            needsResearch: true,
            usage: { attempts: 0, inputTokens: 0, outputTokens: 0, estimated: false },
        },
    };
}
function run(savedReport: Report, status: Run['status'] = 'queued', child = true): Run {
    const completed = ['succeeded', 'partial', 'failed', 'canceled'].includes(status);
    return {
        id: child ? childId : parentId,
        taskId: savedReport.taskId,
        taskVersionId: savedReport.taskVersionId,
        parentRunId: child ? parentId : null,
        baselineRunId: null,
        mode: savedReport.mode,
        status,
        outcome:
            status === 'succeeded' ? 'new_findings' : status === 'partial' ? 'inconclusive' : null,
        trigger: child ? 'followup' : 'manual',
        budget: { ...budget },
        usage: { searches: 0, pages: 0, inputTokens: 0, outputTokens: 0, estimated: false },
        coverage:
            status === 'succeeded'
                ? { completeness: 'complete', searchedQueries: [], gaps: [], exhausted: [] }
                : status === 'partial'
                  ? savedReport.coverage
                  : null,
        queuedAt: instant,
        startedAt: status === 'queued' ? null : instant,
        finishedAt: completed ? instant : null,
        failureCode: status === 'failed' ? 'NO_EVIDENCE' : null,
    };
}
type Reply = { status?: number; json?: unknown; abort?: boolean };
type Call = {
    method: string;
    path: string;
    body: string | null;
    key?: string;
    csrf?: string;
    owner: number;
};
type State = {
    report: Report;
    question: ReportQuestion;
    owner: number;
    calls: Call[];
    outside: string[];
    unexpected: string[];
    release: (() => void)[];
    parentStatus: number;
    parentMutate?: (value: Run) => unknown;
    linked: Run;
    linkedMutate?: (value: Run) => unknown;
    questionMutate?: (value: ReportQuestion) => unknown;
    questionStatus: number;
    reportReads: number;
    reportWaiting: boolean;
    reportHold?: Promise<number>;
    command: (call: Call) => Reply | Promise<Reply>;
};
const states = new WeakMap<Page, State>();
function state(): State {
    const value = report();
    return {
        report: value,
        question: savedQuestion(value),
        owner: 100,
        calls: [],
        outside: [],
        unexpected: [],
        release: [],
        parentStatus: 200,
        linked: run(value, 'succeeded'),
        questionStatus: 200,
        reportReads: 0,
        reportWaiting: false,
        command: () => ({ status: 202, json: { run: run(value), reused: false } }),
    };
}
function gate(value: State) {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => (release = resolve));
    value.release.push(release);
    return { promise, release };
}
async function installApi(page: Page, value = state()) {
    states.set(page, value);
    const origin = new URL(test.info().project.use.baseURL as string).origin;
    page.on('request', (request) => {
        const url = new URL(request.url());
        if (['http:', 'https:'].includes(url.protocol) && url.origin !== origin)
            value.outside.push(request.url());
    });
    await page.route('**/api/v1/**', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const path = url.pathname.replace('/api/v1', '');
        const method = request.method();
        const call = {
            method,
            path,
            body: request.postData(),
            key: request.headers()['idempotency-key'],
            csrf: request.headers()['x-csrf-token'],
            owner: value.owner,
        };
        value.calls.push(call);
        if (path === '/me') return route.fulfill({ json: account(value.owner) });
        if (path === `/tasks/${value.report.taskId}/feedback` && method === 'GET')
            return route.fulfill({ json: { items: [] } });
        if (path === '/notes' && method === 'GET')
            return route.fulfill({ json: { items: [], nextCursor: null } });
        if (path === '/auth/logout') return route.fulfill({ status: 204 });
        if (path === '/auth/login') {
            value.owner = 101;
            return route.fulfill({ json: account(101) });
        }
        if (path === reportPath) {
            value.reportReads++;
            if (value.owner !== 100) return route.fulfill({ status: 404, json: failure() });
            if (value.reportHold) {
                value.reportWaiting = true;
                const status = await value.reportHold;
                return status === 200
                    ? route.fulfill({ json: value.report })
                    : route.fulfill({ status, json: failure() });
            }
            return route.fulfill({ json: value.report });
        }
        if (path === questionPath && method === 'GET') {
            if (value.owner !== 100) return route.fulfill({ status: 404, json: failure() });
            return value.questionStatus === 200
                ? route.fulfill({
                      json: value.questionMutate
                          ? value.questionMutate(structuredClone(value.question))
                          : value.question,
                  })
                : route.fulfill({ status: value.questionStatus, json: failure() });
        }
        if (path === `${reportPath}/questions` && method === 'POST') {
            const question = {
                ...value.question,
                id: id(51),
                question: (request.postDataJSON() as { question: string }).question,
                followupRunId: null,
            };
            return route.fulfill({ status: 201, json: question });
        }
        if (path === `${reportPath}/questions/${id(51)}` && method === 'GET')
            return route.fulfill({
                json: {
                    ...value.question,
                    id: id(51),
                    question: '另一个已保存问题',
                    followupRunId: null,
                },
            });
        if (path === followupPath && method === 'POST') {
            const reply = await value.command(call);
            return reply.abort
                ? route.abort('failed')
                : route.fulfill({ status: reply.status ?? 202, json: reply.json ?? failure() });
        }
        if (path === `/runs/${parentId}` && method === 'GET') {
            if (value.parentStatus !== 200)
                return route.fulfill({ status: value.parentStatus, json: failure() });
            const parent = run(value.report, 'partial', false);
            return route.fulfill({
                json: value.parentMutate ? value.parentMutate(parent) : parent,
            });
        }
        if (path === `/runs/${childId}` && method === 'GET')
            return route.fulfill({
                json: value.linkedMutate
                    ? value.linkedMutate(structuredClone(value.linked))
                    : value.linked,
            });
        if (path === '/reports' && method === 'GET')
            return route.fulfill({ json: { items: [], nextCursor: null } });
        if (path === `/runs/${childId}/events` && method === 'GET')
            return route.fulfill({
                status: 200,
                contentType: 'text/event-stream',
                body: ': closed\n\n',
            });
        value.unexpected.push(`${method} ${path}`);
        return route.fulfill({ status: 501, json: failure() });
    });
    return value;
}
const followup = (page: Page) => page.getByRole('region', { name: '问题的后续研究', exact: true });
const modal = (page: Page) =>
    page.getByRole('dialog', { name: '确认建立独立后续执行', exact: true });
const action = (page: Page, name: string) =>
    followup(page).getByRole('button', { name, exact: true });
const posts = (value: State) =>
    value.calls.filter((call) => call.path === followupPath && call.method === 'POST');
const gets = (value: State, path: string) =>
    value.calls.filter((call) => call.path === path && call.method === 'GET');
async function open(page: Page, question = true) {
    await page.goto(`${reportPath}${question ? `?questionId=${questionId}` : ''}`);
    await expect(page.locator('.report-brief')).toBeVisible();
    if (question) await expect(followup(page)).toBeVisible();
}
async function openModal(page: Page) {
    await action(page, '确认后建立独立后续执行').click();
    await expect(modal(page)).toBeVisible();
    await expect(modal(page).getByRole('button', { name: '取消', exact: true })).toBeFocused();
}
async function confirm(page: Page) {
    await openModal(page);
    await modal(page).getByRole('button', { name: '确认并建立后续执行', exact: true }).click();
}
async function uncertain(page: Page) {
    await expect(action(page, '使用同一请求重发')).toBeVisible();
    await expect(action(page, '读取已保存关联')).toBeEnabled();
    await expect(followup(page)).toContainText('原问题、模式、预算和请求标识已保留');
}
async function switchOwner(page: Page) {
    await logoutFromAccount(page);
    await page.getByLabel('邮箱', { exact: true }).fill('reader-101@example.test');
    await page.getByLabel('密码', { exact: true }).fill('local-only-password');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expectAccountReady(page);
}
test.beforeAll(async ({ browser }) => console.log(`Browser: Chromium ${browser.version()}`));
test.afterEach(async ({ page }) => {
    const value = states.get(page);
    if (!value) return;
    value.release.forEach((release) => release());
    expect(value.outside, 'no external search/model/source requests').toEqual([]);
    expect(value.unexpected, 'no latest-task/config or unexpected API').toEqual([]);
    expect(
        value.calls.filter(
            (call) =>
                call.method !== 'GET' &&
                ![followupPath, `${reportPath}/questions`, '/auth/login', '/auth/logout'].includes(
                    call.path,
                ),
        ),
    ).toEqual([]);
});

test('普通提问、刷新、确认前预算GET、取消与Escape均零followupPOST', async ({ page }) => {
    const value = await installApi(page);
    await open(page, false);
    await expect(page.getByRole('textbox', { name: '问题', exact: true })).toHaveCSS(
        'cursor',
        'text',
    );
    await page.getByRole('textbox', { name: '问题', exact: true }).fill('普通提问不会授权研究');
    await page.getByRole('button', { name: '提问', exact: true }).click();
    await expect(followup(page)).toBeVisible();
    expect(posts(value)).toHaveLength(0);
    await open(page);
    await openModal(page);
    await expect(modal(page)).toContainText('搜索上限');
    await modal(page).getByRole('button', { name: '取消', exact: true }).press('Enter');
    await expect(modal(page)).not.toBeVisible();
    await expect(action(page, '确认后建立独立后续执行')).toBeFocused();
    await openModal(page);
    await page.keyboard.press('Escape');
    await expect(modal(page)).not.toBeVisible();
    await expect(action(page, '确认后建立独立后续执行')).toBeFocused();
    await page.reload();
    await expect(followup(page)).toBeVisible();
    expect(posts(value)).toHaveLength(0);
});

for (const mode of ['demo', 'live'] as const) {
    test(`${mode}显示原版本真实五项预算和配置后果，确认仅confirm:true`, async ({ page }) => {
        const value = state();
        value.report = report(mode);
        value.question = savedQuestion(value.report);
        value.linked = run(value.report, 'succeeded');
        value.command = () => ({ status: 202, json: { run: run(value.report), reused: false } });
        await installApi(page, value);
        await open(page);
        const original = await page.locator('.report-brief').textContent();
        await openModal(page);
        await expect(modal(page)).toContainText(
            mode === 'demo'
                ? '本次不会升级为 live'
                : '可能调用部署者配置的搜索与模型并使用服务额度',
        );
        await expect(modal(page)).toContainText('清空重点条目并改为手动执行');
        await expect(modal(page)).toContainText('原任务计划不改，普通监控基线不变');
        for (const [label, text] of [
            ['原配置版本', id(4)],
            ['搜索上限', '5 次'],
            ['页面读取上限', '7 页'],
            ['执行时长上限', '91 秒'],
            ['输入 token 上限', '1234'],
            ['输出 token 上限', '567'],
        ])
            await expect(
                modal(page)
                    .locator('dl > div')
                    .filter({ has: page.getByText(label!, { exact: true }) })
                    .getByRole('definition'),
            ).toHaveText(text!);
        await expect(modal(page).locator('select,input,textarea')).toHaveCount(0);
        expect(posts(value)).toHaveLength(0);
        await modal(page)
            .getByRole('button', { name: '确认并建立后续执行', exact: true })
            .press('Enter');
        await expect(
            followup(page).getByRole('link', { name: '查看关联执行', exact: true }),
        ).toHaveAttribute('href', `/runs/${childId}`);
        expect(posts(value)).toHaveLength(1);
        expect(posts(value)[0]).toMatchObject({ body: '{"confirm":true}', csrf: 'followup-e2e' });
        expect(posts(value)[0]!.key).toMatch(/^[\w-]{16,128}$/);
        expect(
            value.calls.filter((call) => /^\/tasks\/[^/]+(?:\/config)?$/.test(call.path)),
        ).toEqual([]);
        expect(await page.locator('.report-brief').textContent()).toBe(original);
        await expect(page.locator('.question-result')).not.toContainText('本次没有启动后续研究');
        await expect(followup(page)).toContainText('已完成');
    });
}

test('busy鼠标、Enter、Space重复确认只能发一POST且实际GET权威状态赢过命令queued', async ({
    page,
}) => {
    const value = await installApi(page);
    const pending = gate(value);
    value.command = async () => {
        await pending.promise;
        return { status: 202, json: { run: run(value.report), reused: false } };
    };
    await open(page);
    await openModal(page);
    const button = modal(page).getByRole('button', { name: '确认并建立后续执行', exact: true });
    await button.focus();
    await button.press('Enter');
    await expect.poll(() => posts(value).length).toBe(1);
    await expect(button).toBeDisabled();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');
    await button.dispatchEvent('click');
    expect(posts(value)).toHaveLength(1);
    pending.release();
    await expect(followup(page)).toContainText('关联执行：演示 demo · 已完成');
    expect(gets(value, `/runs/${childId}`).length).toBeGreaterThan(0);
    expect(posts(value)).toHaveLength(1);
    await followup(page).getByRole('link', { name: '查看关联执行', exact: true }).click();
    await expect(page.locator('#execution-status')).toHaveText('已完成');
});

for (const badParent of ['503', 'wrong-task', 'wrong-mode', 'wrong-version'] as const) {
    test(`父执行${badParent}禁确认，重读后才允许，零POST`, async ({ page }) => {
        const value = await installApi(page);
        if (badParent === '503') value.parentStatus = 503;
        else
            value.parentMutate = (parent) => ({
                ...parent,
                ...(badParent === 'wrong-task'
                    ? { taskId: id(999) }
                    : badParent === 'wrong-mode'
                      ? { mode: 'live' }
                      : { taskVersionId: id(999) }),
            });
        await open(page);
        await openModal(page);
        await expect(modal(page).getByRole('alert')).toContainText('不能确认创建');
        await expect(
            modal(page).getByRole('button', { name: '确认并建立后续执行', exact: true }),
        ).toBeDisabled();
        value.parentStatus = 200;
        value.parentMutate = undefined;
        const before = gets(value, `/runs/${parentId}`).length;
        await modal(page).getByRole('button', { name: '重新读取原执行', exact: true }).click();
        await expect(
            modal(page).getByRole('button', { name: '确认并建立后续执行', exact: true }),
        ).toBeEnabled();
        expect(gets(value, `/runs/${parentId}`).length).toBeGreaterThan(before);
        expect(posts(value)).toHaveLength(0);
    });
}

for (const error of ['network', 408, 503, 'IDEMPOTENCY_PENDING'] as const) {
    test(`未知${error}保原key，GETnull不解锁，明确同请求重放`, async ({ page }) => {
        const value = await installApi(page);
        value.command = () =>
            error === 'network'
                ? { abort: true }
                : error === 'IDEMPOTENCY_PENDING'
                  ? { status: 409, json: failure(error) }
                  : { status: error, json: failure() };
        await open(page);
        await confirm(page);
        await uncertain(page);
        const original = posts(value)[0]!;
        const beforeGet = gets(value, questionPath).length;
        await action(page, '读取已保存关联').click();
        await expect(followup(page)).toContainText('不能证明原命令未成功');
        expect(gets(value, questionPath).length).toBeGreaterThan(beforeGet);
        expect(posts(value)).toHaveLength(1);
        await expect(action(page, '确认后建立独立后续执行')).toHaveCount(0);
        value.command = () => ({ status: 202, json: { run: run(value.report), reused: false } });
        await action(page, '使用同一请求重发').click();
        await expect(
            followup(page).getByRole('link', { name: '查看关联执行', exact: true }),
        ).toBeVisible();
        expect(posts(value)).toHaveLength(2);
        expect(posts(value)[1]).toMatchObject({
            key: original.key,
            body: original.body,
            path: original.path,
            owner: 100,
        });
    });
}

test('未知POST明确GET非空关联恢复，全程不再POST，refresh仍GET-only', async ({ page }) => {
    const value = await installApi(page);
    value.command = () => {
        value.question.followupRunId = childId;
        return { abort: true };
    };
    await open(page);
    await confirm(page);
    await uncertain(page);
    await action(page, '读取已保存关联').click();
    await expect(followup(page)).toContainText('已从保存的问题恢复关联执行');
    await expect(
        followup(page).getByRole('link', { name: '查看关联执行', exact: true }),
    ).toBeVisible();
    await expect(action(page, '使用同一请求重发')).toHaveCount(0);
    await page.reload();
    await expect(
        followup(page).getByRole('link', { name: '查看关联执行', exact: true }),
    ).toBeVisible();
    expect(posts(value)).toHaveLength(1);
    await expect(action(page, '确认后建立独立后续执行')).toHaveCount(0);
});

for (const wrong of [
    'parent',
    'budget',
    'mode',
    'task',
    'version',
    'trigger',
    'same-id',
    'malformed',
    'http-status',
    'reused-wrong',
] as const) {
    test(`未知坏响应${wrong}严格拒绝，原key仍可恢复`, async ({ page }) => {
        const value = await installApi(page);
        value.command = () => {
            let result: unknown = run(value.report);
            if (wrong === 'parent' || wrong === 'reused-wrong')
                result = { ...run(value.report), parentRunId: id(999) };
            if (wrong === 'budget')
                result = { ...run(value.report), budget: { ...budget, maxSearches: 99 } };
            if (wrong === 'mode') result = { ...run(value.report), mode: 'live' };
            if (wrong === 'task') result = { ...run(value.report), taskId: id(999) };
            if (wrong === 'version') result = { ...run(value.report), taskVersionId: id(999) };
            if (wrong === 'trigger') result = { ...run(value.report), trigger: 'manual' };
            if (wrong === 'same-id') result = { ...run(value.report), id: parentId };
            if (wrong === 'malformed') result = { id: childId };
            return {
                status: wrong === 'http-status' ? 200 : 202,
                json: { run: result, reused: wrong === 'reused-wrong' },
            };
        };
        await open(page);
        await confirm(page);
        await uncertain(page);
        await expect(
            followup(page).getByRole('link', { name: '查看关联执行', exact: true }),
        ).toHaveCount(0);
        const original = posts(value)[0]!.key;
        value.command = () => ({
            status: 202,
            json: { run: run(value.report, 'succeeded'), reused: true },
        });
        await action(page, '使用同一请求重发').click();
        await expect(followup(page)).toContainText('已复用这个问题的关联执行，可能已结束');
        expect(posts(value)[1]!.key).toBe(original);
    });
}

for (const wrong of ['question', 'linked-parent', 'linked-budget'] as const) {
    test(`GET恢复错${wrong}不接受关联且保原key`, async ({ page }) => {
        const value = await installApi(page);
        value.command = () => ({ status: 503, json: failure() });
        await open(page);
        await confirm(page);
        await uncertain(page);
        const key = posts(value)[0]!.key;
        value.question.followupRunId = childId;
        if (wrong === 'question')
            value.questionMutate = (question) => ({ ...question, question: '不同问题' });
        else
            value.linkedMutate = (linked) => ({
                ...linked,
                ...(wrong === 'linked-parent'
                    ? { parentRunId: id(999) }
                    : { budget: { ...budget, maxPages: 99 } }),
            });
        await action(page, '读取已保存关联').click();
        await expect(followup(page)).toContainText('关联暂时无法核验');
        await expect(
            followup(page).getByRole('link', { name: '查看关联执行', exact: true }),
        ).toHaveCount(0);
        value.question.followupRunId = null;
        value.questionMutate = undefined;
        value.linkedMutate = undefined;
        value.command = () => ({ status: 202, json: { run: run(value.report), reused: false } });
        await action(page, '使用同一请求重发').click();
        await expect(
            followup(page).getByRole('link', { name: '查看关联执行', exact: true }),
        ).toBeVisible();
        expect(posts(value)[1]!.key).toBe(key);
    });
}

for (const [code, text] of [
    ['RUN_ALREADY_ACTIVE', '任务已有其他活动执行'],
    ['TASK_ARCHIVED', '任务已归档'],
    ['TASK_VERSION_MISSING', '配置版本不可用'],
    ['FOLLOWUP_UNAVAILABLE', '未创建第二个执行'],
] as const) {
    test(`明确409 ${code}不自动重发/取消/导航`, async ({ page }) => {
        const value = await installApi(page);
        value.command = () => ({ status: 409, json: failure(code) });
        await open(page);
        await confirm(page);
        await expect(followup(page)).toContainText(text);
        await expect(action(page, '使用同一请求重发')).toHaveCount(0);
        await expect(followup(page).getByRole('link')).toHaveCount(0);
        expect(posts(value)).toHaveLength(1);
        expect(new URL(page.url()).pathname).toBe(reportPath);
    });
}

test('payload mismatch冻结原标识停止重发，仍允许GET恢复', async ({ page }) => {
    const value = await installApi(page);
    value.command = () => ({ status: 409, json: failure('IDEMPOTENCY_PAYLOAD_MISMATCH') });
    await open(page);
    await confirm(page);
    await expect(followup(page)).toContainText('已停止重发并保留原标识');
    await expect(action(page, '使用同一请求重发')).toHaveCount(0);
    await action(page, '读取已保存关联').click();
    await expect(followup(page)).toContainText('重发已停止');
    value.question.followupRunId = childId;
    await action(page, '读取已保存关联').click();
    await expect(
        followup(page).getByRole('link', { name: '查看关联执行', exact: true }),
    ).toBeVisible();
    expect(posts(value)).toHaveLength(1);
});

for (const status of ['succeeded', 'failed', 'running'] as const) {
    test(`已关联刷新GET-only，真实${status}复用语义且无二次创建`, async ({ page }) => {
        const value = await installApi(page);
        value.question.followupRunId = childId;
        value.linked = run(value.report, status);
        await open(page);
        await expect(
            followup(page).getByRole('link', { name: '查看关联执行', exact: true }),
        ).toBeVisible();
        await expect(followup(page)).toContainText(
            status === 'succeeded' ? '已完成' : status === 'failed' ? '执行失败' : '正在查阅',
        );
        await expect(action(page, '确认后建立独立后续执行')).toHaveCount(0);
        await page.reload();
        await expect(
            followup(page).getByRole('link', { name: '查看关联执行', exact: true }),
        ).toBeVisible();
        expect(posts(value)).toHaveLength(0);
    });
}

test('needsResearch=false的已完成回答仍可明确创建，不由模型输出授权', async ({ page }) => {
    const value = await installApi(page);
    value.question.answer = {
        status: 'answered',
        reason: 'evidence_answer',
        statements: [
            {
                text: value.report.evidence[0]!.quote,
                citations: [{ evidenceId: id(20), quote: value.report.evidence[0]!.quote }],
            },
        ],
        needsResearch: false,
        usage: { attempts: 1, inputTokens: 100, outputTokens: 20, estimated: false },
    };
    await open(page);
    await openModal(page);
    expect(posts(value)).toHaveLength(0);
    await modal(page).getByRole('button', { name: '确认并建立后续执行', exact: true }).click();
    await expect(
        followup(page).getByRole('link', { name: '查看关联执行', exact: true }),
    ).toBeVisible();
    expect(posts(value)).toHaveLength(1);
});

for (const change of ['question', 'route', 'owner'] as const) {
    test(`${change}改变隔离迟到成功，未知离开仅一个后果确认`, async ({ page }) => {
        const value = await installApi(page);
        const pending = gate(value);
        value.command = async () => {
            await pending.promise;
            return { status: 202, json: { run: run(value.report), reused: false } };
        };
        await open(page);
        await confirm(page);
        await expect.poll(() => posts(value).length).toBe(1);
        let prompts = 0;
        page.on('dialog', async (dialog) => {
            prompts++;
            expect(dialog.message()).toContain('后续执行结果尚未确认');
            await dialog.accept();
        });
        if (change === 'question')
            await page.getByRole('button', { name: '提出新问题', exact: true }).click();
        else if (change === 'route')
            await page.getByRole('link', { name: '阅读外观', exact: true }).click();
        else await switchOwner(page);
        pending.release();
        await page.waitForTimeout(100);
        await expect(page.getByRole('link', { name: '查看关联执行', exact: true })).toHaveCount(0);
        expect(posts(value)).toHaveLength(1);
        expect(prompts).toBe(change === 'owner' ? 0 : 1);
        if (change === 'question')
            await expect(page.getByRole('textbox', { name: '问题', exact: true })).toBeEditable();
        if (change === 'route') expect(new URL(page.url()).pathname).toBe('/account/appearance');
        if (change === 'owner') await expectAccountReady(page);
    });
}

test('拒绝放弃未知请求保留原scope/key，随后新问题单次确认清除', async ({ page }) => {
    const value = await installApi(page);
    value.command = () => ({ status: 503, json: failure() });
    await open(page);
    await confirm(page);
    await uncertain(page);
    let prompts = 0;
    page.once('dialog', async (dialog) => {
        prompts++;
        await dialog.dismiss();
    });
    await page.getByRole('button', { name: '提出新问题', exact: true }).click();
    await expect(action(page, '使用同一请求重发')).toBeVisible();
    expect(new URL(page.url()).searchParams.get('questionId')).toBe(questionId);
    page.once('dialog', async (dialog) => {
        prompts++;
        await dialog.accept();
    });
    await page.getByRole('button', { name: '提出新问题', exact: true }).click();
    await expect(page.getByRole('textbox', { name: '问题', exact: true })).toBeEditable();
    await expect(action(page, '使用同一请求重发')).toHaveCount(0);
    expect(prompts).toBe(2);
    expect(posts(value)).toHaveLength(1);
});

test('同owner同question暂时Report失败保未知attempt，恢复后同key重发', async ({ page }) => {
    const value = await installApi(page);
    value.command = () => ({ status: 503, json: failure() });
    await page.clock.install();
    await open(page);
    const now = await page.evaluate(() => Date.now());
    await page.getByRole('link', { name: '阅读外观', exact: true }).click();
    await expect(page).toHaveURL(/\/account\/appearance$/);
    await page.clock.setFixedTime(now + 31_000);
    let releaseReport!: (status: number) => void;
    value.reportHold = new Promise<number>((resolve) => (releaseReport = resolve));
    value.release.push(() => releaseReport(200));
    await page.goBack();
    await expect.poll(() => value.reportWaiting).toBe(true);
    await expect(followup(page)).toBeVisible();
    await confirm(page);
    await uncertain(page);
    const key = posts(value)[0]!.key;
    releaseReport(503);
    await expect(followup(page)).toContainText('原请求与标识已保留');
    await expect(action(page, '使用同一请求重发')).toBeDisabled();
    await expect(action(page, '读取已保存关联')).toBeDisabled();
    value.reportHold = undefined;
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await expect(action(page, '使用同一请求重发')).toBeEnabled();
    value.command = () => ({ status: 202, json: { run: run(value.report), reused: false } });
    await action(page, '使用同一请求重发').click();
    await expect(
        followup(page).getByRole('link', { name: '查看关联执行', exact: true }),
    ).toBeVisible();
    expect(posts(value)[1]!.key).toBe(key);
});

for (const scheme of ['light', 'dark'] as const) {
    for (const width of [320, 360, 390, 768, 1024, 1440]) {
        test(`确认dialog ${scheme} ${width} 正常及200%文字、全文滚动/安全焦点/零POST`, async ({
            page,
        }, info) => {
            const value = await installApi(page);
            value.question.question = `原始问题<script>globalThis.scovaInjected=1</script>\n${'完整问题与所有费用后果均需可读。'.repeat(60)}`;
            await page.emulateMedia({ colorScheme: scheme });
            await page.setViewportSize({ width, height: 900 });
            await open(page);
            for (const zoom of [100, 200]) {
                await page.evaluate((value) => {
                    document.documentElement.style.fontSize = `${value}%`;
                }, zoom);
                await openModal(page);
                await expect(modal(page).locator('.question-text')).toHaveText(
                    value.question.question,
                );
                await expect(followup(page)).toHaveCSS('cursor', 'default');
                await expect(modal(page)).toHaveCSS('cursor', 'default');
                await expect(modal(page).locator('.dialog-body')).toHaveCSS('cursor', 'default');
                await expect(modal(page).locator('.question-text')).toHaveCSS('cursor', 'default');
                const geometry = await modal(page).evaluate((element) => {
                    const box = element.getBoundingClientRect();
                    const body = element.querySelector('.dialog-body')!;
                    return {
                        left: box.left,
                        right: box.right,
                        top: box.top,
                        bottom: box.bottom,
                        bodyHeight: body.clientHeight,
                        bodyWidth: body.clientWidth,
                        bodyScrollWidth: body.scrollWidth,
                        bodyScrollHeight: body.scrollHeight,
                        pageWidth: Math.max(
                            document.body.scrollWidth,
                            document.documentElement.scrollWidth,
                        ),
                    };
                });
                expect(geometry.left).toBeGreaterThanOrEqual(0);
                expect(geometry.right).toBeLessThanOrEqual(width + 1);
                expect(geometry.top).toBeGreaterThanOrEqual(0);
                expect(geometry.bottom).toBeLessThanOrEqual(901);
                expect(geometry.pageWidth).toBe(width);
                expect(geometry.bodyHeight).toBeGreaterThan(0);
                expect(geometry.bodyScrollWidth).toBeLessThanOrEqual(geometry.bodyWidth);
                await expect(modal(page).getByRole('heading')).toBeInViewport();
                await expect(
                    modal(page).getByRole('button', { name: '取消', exact: true }),
                ).toBeInViewport();
                await expect(
                    modal(page).getByRole('button', { name: '确认并建立后续执行', exact: true }),
                ).toBeInViewport();
                await modal(page)
                    .locator('.dialog-body')
                    .evaluate((element) => {
                        element.scrollTop = 0;
                    });
                await expect(modal(page).locator('#followup-dialog-consequences')).toBeInViewport();
                await modal(page)
                    .locator('.dialog-body')
                    .evaluate((element) => {
                        element.scrollTop = element.scrollHeight;
                    });
                await expect(
                    modal(page).getByText('输出 token 上限', { exact: true }),
                ).toBeInViewport();
                await expect(modal(page).locator('script,img,iframe')).toHaveCount(0);
                expect(
                    await page.evaluate(() => Reflect.get(globalThis, 'scovaInjected')),
                ).toBeUndefined();
                await expect(
                    modal(page).getByRole('button', { name: '取消', exact: true }),
                ).toHaveCSS('cursor', 'pointer');
                await expect(
                    modal(page).getByRole('button', { name: '确认并建立后续执行', exact: true }),
                ).toBeEnabled();
                await expect(
                    modal(page).getByRole('button', { name: '确认并建立后续执行', exact: true }),
                ).toHaveCSS('cursor', 'pointer');
                if (zoom === 200 && (width === 320 || width === 1440))
                    await page.screenshot({
                        path: info.outputPath(`${scheme}-${width}-${zoom}.png`),
                    });
                await page.keyboard.press('Escape');
                await expect(modal(page)).not.toBeVisible();
                await expect(action(page, '确认后建立独立后续执行')).toBeFocused();
            }
            expect(posts(value)).toHaveLength(0);
        });
    }
}
