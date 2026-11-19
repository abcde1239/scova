import { logoutFromAccount, expectAccountReady } from './support/account-menu.ts';
import { expect, test, type Page } from '@playwright/test';
import type {
    Report,
    ReportQuestion,
    Run,
    SearchConfiguration,
} from '../../packages/models/src/index.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const reportId = id(1),
    questionId = id(50),
    parentId = id(3),
    childId = id(60);
const reportPath = `/reports/${reportId}`;
const questionPath = `${reportPath}/questions/${questionId}`;
const composerPath = `${reportPath}/followup`;
const composerQuestionId = id(52);
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
function report(mode: 'demo' | 'live' = 'live'): Report {
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
    searchConfiguration?: SearchConfiguration;
    composerTurn?: Omit<ReportQuestion, 'answer'> & {
        answer: null;
        searchSelection: { searchMode: 'api'; searchConfigRevision: number };
    };
    composerCommand?: (call: Call) => Reply | Promise<Reply>;
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
        if (path === '/me/search-configuration' && method === 'GET')
            return route.fulfill({
                json: { configuration: value.searchConfiguration ?? null, storageReady: true },
            });
        if (
            path === `${reportPath}/questions/${composerQuestionId}` &&
            method === 'GET' &&
            value.composerTurn
        )
            return route.fulfill({ json: value.composerTurn });
        if (path === composerPath && method === 'POST' && value.composerCommand) {
            const reply = await value.composerCommand(call);
            return reply.abort
                ? route.abort('failed')
                : route.fulfill({ status: reply.status ?? 202, json: reply.json ?? failure() });
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
        if (path === `${reportPath}/conversation` && method === 'GET') {
            if (value.owner !== 100) return route.fulfill({ status: 404, json: failure() });
            return route.fulfill({
                json: {
                    reportId: value.report.id,
                    turns: value.composerTurn
                        ? [value.question, value.composerTurn]
                        : [value.question],
                    hasEarlier: false,
                },
            });
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
const followup = (page: Page) => page.getByRole('region', { name: '补充研究', exact: true });
const plan = (page: Page) => followup(page).locator('.plan-card');
const action = (page: Page, name: string) =>
    followup(page).getByRole('button', { name, exact: true });
const posts = (value: State) =>
    value.calls.filter((call) => call.path === followupPath && call.method === 'POST');
const gets = (value: State, path: string) =>
    value.calls.filter((call) => call.path === path && call.method === 'GET');
async function open(page: Page) {
    await page.goto(`${reportPath}?questionId=${questionId}`);
    await expect(page.locator('.report-brief')).toBeVisible();
    await expect(followup(page)).toBeVisible();
}
async function openPlan(page: Page) {
    await action(page, '据此补查新资料').click();
    await expect(plan(page)).toBeVisible();
    await expect(plan(page).getByRole('heading')).toBeFocused();
}
async function confirm(page: Page) {
    await openPlan(page);
    await plan(page).getByRole('button', { name: '开始执行', exact: true }).click();
}
async function uncertain(page: Page) {
    await expect(action(page, '使用同一请求重发')).toBeVisible();
    await expect(action(page, '读取已保存关联')).toBeEnabled();
}
async function switchOwner(page: Page) {
    await logoutFromAccount(page);
    await page.getByLabel('邮箱', { exact: true }).fill('reader-101@example.test');
    await page.getByLabel('密码', { exact: true }).fill('local-only-password');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expectAccountReady(page);
}

test.afterEach(async ({ page }) => {
    const value = states.get(page);
    if (!value) return;
    value.release.forEach((release) => release());
    expect(value.outside).toEqual([]);
    expect(value.unexpected).toEqual([]);
});

test('原位计划可收起，保留普通问题草稿；开始前显示费用且不创建执行', async ({ page }) => {
    const value = await installApi(page);
    await open(page);
    await page.getByRole('textbox', { name: '问题', exact: true }).fill('普通提问不会授权研究');
    await openPlan(page);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(plan(page)).toContainText('最多搜索 5 次');
    await expect(plan(page)).toContainText('计入模型额度');
    await expect(plan(page)).toContainText('搜索方式：沿用任务');
    await plan(page).getByText('预算详情', { exact: true }).click();
    await expect(plan(page)).toContainText('91 秒');
    await expect(plan(page)).toContainText('1234');
    await plan(page).getByRole('button', { name: '收起执行计划', exact: true }).click();
    await expect(action(page, '据此补查新资料')).toBeFocused();
    await expect(page.getByRole('textbox', { name: '问题', exact: true })).toHaveValue(
        '普通提问不会授权研究',
    );
    expect(posts(value)).toHaveLength(0);
});

test('冻结多种成果形式并创建一次执行，权威终态替代排队响应', async ({ page }) => {
    const value = await installApi(page);
    await open(page);
    const original = await page.locator('.report-brief').textContent();
    await openPlan(page);
    await plan(page).locator('input[value="list"]').check();
    await plan(page).locator('input[value="research_report"]').check();
    await plan(page).getByRole('button', { name: '开始执行', exact: true }).click();
    await expect(followup(page)).toContainText('已完成');
    await expect(
        followup(page).getByRole('link', { name: '执行详情', exact: true }),
    ).toHaveAttribute('href', `/runs/${childId}`);
    expect(posts(value)).toHaveLength(1);
    expect(JSON.parse(posts(value)[0]!.body!)).toEqual({
        confirm: true,
        outputFormats: ['list', 'research_report'],
    });
    expect(posts(value)[0]!.csrf).toBe('followup-e2e');
    expect(await page.locator('.report-brief').textContent()).toBe(original);
});

test('处理中重复点击和键盘操作只发送一次命令', async ({ page }) => {
    const value = await installApi(page),
        waiting = gate(value);
    value.command = async () => {
        await waiting.promise;
        return { status: 202, json: { run: run(value.report), reused: false } };
    };
    await open(page);
    await openPlan(page);
    const start = plan(page).locator('.scova-action-button').last();
    await start.click();
    await expect.poll(() => posts(value).length).toBe(1);
    await expect(plan(page).getByRole('button', { name: '正在提交', exact: true })).toBeDisabled();
    await start.dispatchEvent('click');
    await page.keyboard.press('Enter');
    expect(posts(value)).toHaveLength(1);
    waiting.release();
    await expect(followup(page)).toContainText('已完成');
});

for (const badParent of ['503', 'wrong-task', 'wrong-mode', 'wrong-version'] as const)
    test(`原执行 ${badParent} 禁止开始，重读恢复`, async ({ page }) => {
        const value = await installApi(page);
        if (badParent === '503') value.parentStatus = 503;
        else
            value.parentMutate = (parent) => ({
                ...parent,
                ...(badParent === 'wrong-task'
                    ? { taskId: id(999) }
                    : badParent === 'wrong-mode'
                      ? { mode: 'demo' }
                      : { taskVersionId: id(999) }),
            });
        await open(page);
        await openPlan(page);
        await expect(plan(page).getByRole('alert')).toContainText('无法开始');
        await expect(plan(page).getByRole('button', { name: '开始执行', exact: true })).toHaveCount(
            0,
        );
        value.parentStatus = 200;
        value.parentMutate = undefined;
        await plan(page).getByRole('button', { name: '重新读取预算', exact: true }).click();
        await expect(
            plan(page).getByRole('button', { name: '开始执行', exact: true }),
        ).toBeEnabled();
        expect(posts(value)).toHaveLength(0);
    });

for (const error of ['network', 408, 503, 'IDEMPOTENCY_PENDING'] as const)
    test(`未知结果 ${error} 保留请求，读取空关联后仍同键重发`, async ({ page }) => {
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
        await action(page, '读取已保存关联').click();
        await expect(page.locator('.scova-notifications')).toContainText('不能证明原命令未成功');
        expect(posts(value)).toHaveLength(1);
        value.command = () => ({ status: 202, json: { run: run(value.report), reused: false } });
        await action(page, '使用同一请求重发').click();
        await expect(
            followup(page).getByRole('link', { name: '执行详情', exact: true }),
        ).toBeVisible();
        expect(posts(value)[1]).toMatchObject({
            key: original.key,
            body: original.body,
            owner: 100,
        });
    });

test('GET恢复已有执行不再POST，刷新后沿用关联', async ({ page }) => {
    const value = await installApi(page);
    value.command = () => {
        value.question.followupRunId = childId;
        return { abort: true };
    };
    await open(page);
    await confirm(page);
    await uncertain(page);
    await action(page, '读取已保存关联').click();
    await expect(followup(page)).toContainText('已完成');
    await page.reload();
    await expect(followup(page)).toContainText('已完成');
    expect(posts(value)).toHaveLength(1);
    expect(gets(value, questionPath).length).toBeGreaterThan(0);
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
] as const)
    test(`错误命令响应 ${wrong} 不能展示关联，保留原key`, async ({ page }) => {
        const value = await installApi(page);
        value.command = () => {
            let result: unknown = run(value.report);
            if (wrong === 'parent' || wrong === 'reused-wrong')
                result = { ...run(value.report), parentRunId: id(999) };
            if (wrong === 'budget')
                result = { ...run(value.report), budget: { ...budget, maxSearches: 99 } };
            if (wrong === 'mode') result = { ...run(value.report), mode: 'demo' };
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
            followup(page).getByRole('link', { name: '执行详情', exact: true }),
        ).toHaveCount(0);
        const key = posts(value)[0]!.key;
        value.command = () => ({
            status: 202,
            json: { run: run(value.report, 'succeeded'), reused: true },
        });
        await action(page, '使用同一请求重发').click();
        await expect(followup(page)).toContainText('已完成');
        expect(posts(value)[1]!.key).toBe(key);
    });

for (const wrong of ['question', 'linked-parent', 'linked-budget'] as const)
    test(`读取恢复拒绝 ${wrong} 并保留请求`, async ({ page }) => {
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
        await expect(page.locator('.scova-notifications')).toContainText('关联暂时无法核验');
        await expect(
            followup(page).getByRole('link', { name: '执行详情', exact: true }),
        ).toHaveCount(0);
        value.question.followupRunId = null;
        value.questionMutate = undefined;
        value.linkedMutate = undefined;
        value.command = () => ({ status: 202, json: { run: run(value.report), reused: false } });
        await action(page, '使用同一请求重发').click();
        await expect(followup(page)).toContainText('已完成');
        expect(posts(value)[1]!.key).toBe(key);
    });

for (const [code, text] of [
    ['RUN_ALREADY_ACTIVE', '任务已有其他活动执行'],
    ['TASK_ARCHIVED', '任务已归档'],
    ['TASK_VERSION_MISSING', '配置版本不可用'],
    ['FOLLOWUP_UNAVAILABLE', '未创建第二个执行'],
] as const)
    test(`业务冲突 ${code} 不自动重发`, async ({ page }) => {
        const value = await installApi(page);
        value.command = () => ({ status: 409, json: failure(code) });
        await open(page);
        await confirm(page);
        await expect(followup(page)).toContainText(text);
        await expect(action(page, '使用同一请求重发')).toHaveCount(0);
        expect(posts(value)).toHaveLength(1);
        expect(new URL(page.url()).pathname).toBe(reportPath);
    });

test('幂等内容不一致停止重发，仍可明确读取', async ({ page }) => {
    const value = await installApi(page);
    value.command = () => ({ status: 409, json: failure('IDEMPOTENCY_PAYLOAD_MISMATCH') });
    await open(page);
    await confirm(page);
    await expect(action(page, '使用同一请求重发')).toHaveCount(0);
    await action(page, '读取已保存关联').click();
    await expect(page.locator('.scova-notifications')).toContainText('重发已停止');
    value.question.followupRunId = childId;
    await action(page, '读取已保存关联').click();
    await expect(followup(page)).toContainText('已完成');
    expect(posts(value)).toHaveLength(1);
});

for (const status of ['succeeded', 'failed', 'running'] as const)
    test(`已关联 ${status} 刷新只读取`, async ({ page }) => {
        const value = await installApi(page);
        value.question.followupRunId = childId;
        value.linked = run(value.report, status);
        await open(page);
        await expect(followup(page)).toContainText(
            status === 'succeeded' ? '已完成' : status === 'failed' ? '执行失败' : '正在查阅',
        );
        await page.reload();
        await expect(
            followup(page).getByRole('link', { name: '执行详情', exact: true }),
        ).toBeVisible();
        expect(posts(value)).toHaveLength(0);
    });

test('演示报告只读，无补查或改写开始入口', async ({ page }) => {
    const value = await installApi(page);
    value.report.mode = 'demo';
    await open(page);
    await expect(action(page, '据此补查新资料')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '用已有资料改写', exact: true })).toHaveCount(0);
    expect(posts(value)).toHaveLength(0);
});

test('未知请求阻止普通发送与未确认离开，换账号不泄露旧关联', async ({ page }) => {
    const value = await installApi(page);
    value.command = () => ({ abort: true });
    await open(page);
    await confirm(page);
    await uncertain(page);
    await page.getByRole('textbox', { name: '问题', exact: true }).fill('继续讨论');
    await expect(page.getByRole('button', { name: '提问', exact: true })).toBeDisabled();
    page.once('dialog', (dialog) => dialog.dismiss());
    await page.getByRole('link', { name: '阅读外观', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(reportPath));
    await expect(action(page, '使用同一请求重发')).toBeVisible();
    await switchOwner(page);
    await expect(followup(page)).toHaveCount(0);
    await expectAccountReady(page);
});

test('资料内改写冻结独立形式，未知结果同键恢复且不启动补查', async ({ page }) => {
    const value = await installApi(page);
    value.command = () => ({ abort: true });
    await open(page);
    const revision = page.getByRole('region', { name: '资料内改写', exact: true });
    await revision.getByRole('button', { name: '用已有资料改写', exact: true }).click();
    const card = revision.locator('.plan-card');
    await card.locator('input[value="list"]').check();
    await expect(card).toContainText('不联网');
    await card.getByRole('button', { name: '开始执行', exact: true }).click();
    await expect(
        revision.getByRole('button', { name: '使用同一请求重发', exact: true }),
    ).toBeVisible();
    const first = posts(value)[0]!;
    expect(JSON.parse(first.body!)).toEqual({
        confirm: true,
        operation: 'revise',
        outputFormats: ['list'],
    });
    value.command = () => ({ status: 202, json: { run: run(value.report), reused: false } });
    await revision.getByRole('button', { name: '使用同一请求重发', exact: true }).click();
    await expect(revision).toContainText('已完成');
    expect(posts(value)[1]!.key).toBe(first.key);
});

const composerPosts = (value: State) =>
    value.calls.filter((call) => call.path === composerPath && call.method === 'POST');
const composerPlan = (page: Page) => page.getByRole('region', { name: '补查新资料', exact: true });
const composerTrigger = (page: Page) =>
    page.getByRole('button', { name: '补查新资料', exact: true });

test('输入区确认可取消，恢复焦点，未配置 API 时仍可选内置搜索', async ({ page }) => {
    const value = await installApi(page);
    await open(page);
    const input = page.getByRole('textbox', { name: '问题', exact: true });
    await input.fill('查阅新的官方公告');
    await composerTrigger(page).click();
    const panel = composerPlan(page);
    await expect(panel.getByRole('heading')).toBeFocused();
    await expect(panel.getByText('账号 Search API 尚不可用')).toBeVisible();
    await expect(panel.getByRole('option', { name: '账号 Search API' })).toBeDisabled();
    await expect(panel.getByRole('button', { name: '开始补查' })).toBeDisabled();
    await panel.getByLabel('搜索方式').selectOption('searxng');
    await expect(panel.getByRole('button', { name: '开始补查' })).toBeEnabled();
    await panel.getByLabel('搜索方式').press('Escape');
    await expect(panel).toHaveCount(0);
    await expect(composerTrigger(page)).toBeFocused();
    await expect(input).toHaveValue('查阅新的官方公告');
    expect(value.calls.filter((call) => call.method === 'POST')).toEqual([]);
});

test('输入区使用选定的账号搜索，未知结果重发原命令并恢复已创建的执行', async ({ page }) => {
    const value = await installApi(page);
    const question = '  查阅最新官方公告\n保留提问原文  ';
    const searchSelection = { searchMode: 'api', searchConfigRevision: 7 } as const;
    value.searchConfiguration = {
        revision: 7,
        defaultMode: 'searxng',
        api: {
            protocol: 'tavily',
            baseUrl: 'https://api.tavily.com',
            contentMode: 'reader',
            hasApiKey: true,
        },
        updatedAt: instant,
    };
    const turn = {
        id: composerQuestionId,
        reportId,
        question,
        answer: null,
        followupRunId: childId,
        revisionRunId: null,
        createdAt: '2026-10-31T01:01:00Z',
        searchSelection,
    };
    value.composerCommand = () => {
        if (composerPosts(value).length === 1)
            return { status: 409, json: failure('IDEMPOTENCY_PENDING') };
        value.composerTurn = turn;
        return { json: { question: turn, run: value.linked, reused: true } };
    };
    await open(page);
    const input = page.getByRole('textbox', { name: '问题', exact: true });
    await input.fill(question);
    await composerTrigger(page).click();
    const panel = composerPlan(page);
    await expect(panel.getByRole('option', { name: '账号 Search API' })).toBeEnabled();
    await panel.getByLabel('搜索方式').selectOption('api');
    await panel.getByRole('checkbox', { name: '简报' }).check();
    await panel.getByRole('button', { name: '开始补查' }).click();
    const replay = panel.getByRole('button', { name: '使用同一请求重发' });
    await expect(replay).toBeEnabled();
    await expect(input).toHaveValue(question);
    expect(composerPosts(value)).toHaveLength(1);
    await replay.click();
    await expect(page).toHaveURL(new RegExp(`questionId=${composerQuestionId}$`));
    await expect(input).toHaveValue('');
    await expect(
        page.locator(`#turn-${composerQuestionId}`).getByRole('region', { name: '补充研究' }),
    ).toBeVisible();
    await expect(page.locator(`#turn-${composerQuestionId}`)).not.toContainText(
        '正在根据报告资料回答',
    );
    const calls = composerPosts(value);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.key).toBeTruthy();
    expect(calls[0]?.csrf).toBe(account().csrfToken);
    expect(calls[1]).toEqual(calls[0]);
    expect(JSON.parse(calls[0]!.body!)).toEqual({
        confirm: true,
        question,
        afterQuestionId: questionId,
        outputFormats: ['brief'],
        ...searchSelection,
    });
    expect(
        value.calls.filter((call) => call.method === 'POST' && call.path !== composerPath),
    ).toEqual([]);
});

test('输入区请求中切换账号，迟到回执不能恢复原账号的草稿或执行', async ({ page }) => {
    const value = await installApi(page);
    const wait = gate(value);
    value.composerCommand = async () => {
        await wait.promise;
        return { abort: true };
    };
    await open(page);
    await page.getByRole('textbox', { name: '问题', exact: true }).fill('旧账号补查草稿');
    await composerTrigger(page).click();
    await composerPlan(page).getByLabel('搜索方式').selectOption('searxng');
    await composerPlan(page).getByRole('button', { name: '开始补查' }).click();
    await expect.poll(() => composerPosts(value).length).toBe(1);
    await switchOwner(page);
    wait.release();
    await expect(composerPlan(page)).toHaveCount(0);
    await expect(page.getByText('旧账号补查草稿')).toHaveCount(0);
    expect(composerPosts(value)).toHaveLength(1);
});
