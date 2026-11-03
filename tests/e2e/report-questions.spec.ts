import { logoutFromAccount, expectAccountReady } from './support/account-menu.ts';
import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import type { Report } from '../../packages/models/src/reports.ts';
import type { ReportQuestion, QuestionAnswer } from '../../packages/models/src/report-questions.ts';

// HTTP samples exercise the frozen production SFC and real requestlane validators.
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const path = `/reports/${id(1)}`;
const instant = '2026-10-31T01:00:00Z';
const errorBody = (code = 'TEST_FAILURE') => ({ code, message: 'sample', requestId: 'sample' });
const account = (switched = false) => ({
    user: {
        id: id(switched ? 101 : 100),
        email: 'reader@example.test',
        preferences: {
            defaultTimezone: 'UTC',
            notificationPreference: { mode: 'summary', runIssues: true },
        },
        createdAt: instant,
    },
    csrfToken: 'questions-test-only',
});
function report(): Report {
    return {
        id: id(1),
        taskId: id(2),
        runId: id(3),
        taskVersionId: id(4),
        baselineRunId: null,
        schemaVersion: 1,
        title: '授权证据报告',
        summary: '报告与问答用量独立，原结论保持原样。',
        format: 'brief',
        mode: 'demo',
        outcome: 'inconclusive',
        coverage: {
            completeness: 'partial',
            searchedQueries: ['已保存资料'],
            gaps: ['尚未交叉核验'],
            exhausted: ['pages'],
        },
        limitations: ['只覆盖已保存片段'],
        claims: [
            {
                id: id(10),
                kind: 'fact',
                text: '研究资料按批次公开。',
                confidenceLabel: '仅代表原文',
                evidenceIds: [id(20)],
            },
        ],
        evidence: [
            {
                id: id(20),
                sourceId: id(21),
                snapshotId: id(22),
                title: '资料原文',
                url: 'https://example.test/saved',
                quote: '  研究资料按批次公开。\n申请期限尚未确认。  ',
                location: '已保存第2段',
                observedAt: instant,
            },
        ],
        changes: [],
        publishedAt: instant,
    };
}
function question(
    savedReport: Report,
    text = '原文如何说明？',
    reason: QuestionAnswer['reason'] = 'evidence_answer',
    questionId = id(50),
): ReportQuestion {
    return {
        id: questionId,
        reportId: savedReport.id,
        question: text,
        followupRunId: null,
        createdAt: instant,
        answer: {
            status: reason === 'evidence_answer' ? 'answered' : 'insufficient',
            reason,
            statements:
                reason === 'evidence_answer'
                    ? [
                          {
                              text: savedReport.evidence[0]!.quote,
                              citations: [
                                  {
                                      evidenceId: savedReport.evidence[0]!.id,
                                      quote: savedReport.evidence[0]!.quote,
                                  },
                              ],
                          },
                      ]
                    : [],
            needsResearch: true,
            usage: {
                attempts: reason === 'model_unavailable' ? 0 : 1,
                inputTokens: reason === 'model_unavailable' ? 0 : 120,
                outputTokens: reason === 'model_unavailable' ? 0 : 40,
                estimated: reason !== 'evidence_answer' && reason !== 'model_unavailable',
            },
        },
    };
}
type RequestRecord = {
    method: string;
    path: string;
    body: string | null;
    key?: string;
    csrf?: string;
};
type State = {
    report: Report;
    saved: Map<string, ReportQuestion>;
    requests: RequestRecord[];
    unexpected: string[];
    switched: boolean;
    mode: 'ok' | 'lost' | 'pending' | 'rate' | 'unavailable' | 'mismatch';
    reason: QuestionAnswer['reason'];
    status: number;
    getStatus: number;
    mutate?: (value: ReportQuestion) => unknown;
    reportHold: boolean;
    reportWaiting: boolean;
    releaseReport?: (status: number) => void;
};
async function samples(context: BrowserContext) {
    const state: State = {
        report: report(),
        saved: new Map(),
        requests: [],
        unexpected: [],
        switched: false,
        mode: 'ok',
        reason: 'evidence_answer',
        status: 201,
        getStatus: 200,
        reportHold: false,
        reportWaiting: false,
    };
    const keys = new Map<string, string>();
    await context.route('**/api/v1/**', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const pathname = url.pathname.replace('/api/v1', '');
        const method = request.method();
        const headers = request.headers();
        state.requests.push({
            method,
            path: pathname,
            body: request.postData(),
            key: headers['idempotency-key'],
            csrf: headers['x-csrf-token'],
        });
        if (pathname === '/me') return route.fulfill({ json: account(state.switched) });
        if (pathname === `/tasks/${state.report.taskId}/feedback` && method === 'GET')
            return route.fulfill({ json: { items: [] } });
        if (pathname === '/notes' && method === 'GET')
            return route.fulfill({ json: { items: [], nextCursor: null } });
        if (pathname === '/auth/logout') return route.fulfill({ status: 204 });
        if (pathname === '/auth/login') {
            state.switched = true;
            return route.fulfill({ json: account(true) });
        }
        if (pathname === path) {
            if (state.switched) return route.fulfill({ status: 404, json: errorBody() });
            if (state.reportHold) {
                state.reportWaiting = true;
                const status = await new Promise<number>((resolve) => {
                    state.releaseReport = resolve;
                });
                return status === 200
                    ? route.fulfill({ json: state.report })
                    : route.fulfill({ status, json: errorBody() });
            }
            return route.fulfill({ json: state.report });
        }
        if (pathname === `${path}/questions` && method === 'POST') {
            const key = headers['idempotency-key']!;
            const text = (request.postDataJSON() as { question: string }).question;
            if (state.mode === 'pending')
                return route.fulfill({ status: 409, json: errorBody('QUESTION_PENDING') });
            if (state.mode === 'mismatch')
                return route.fulfill({
                    status: 409,
                    json: errorBody('IDEMPOTENCY_PAYLOAD_MISMATCH'),
                });
            const old = state.saved.get(keys.get(key) ?? '');
            const value =
                old ?? question(state.report, text, state.reason, id(50 + state.saved.size));
            if (!old) {
                state.saved.set(value.id, value);
                keys.set(key, value.id);
            }
            if (state.mode === 'lost') return route.abort('failed');
            if (state.mode === 'rate' || state.mode === 'unavailable')
                return route.fulfill({
                    status: state.mode === 'rate' ? 429 : 503,
                    headers: { 'retry-after': '2' },
                    json: errorBody(
                        state.mode === 'rate'
                            ? 'QUESTION_RATE_LIMITED'
                            : 'QUESTION_SERVICE_UNAVAILABLE',
                    ),
                });
            return route.fulfill({
                status: state.status,
                json: state.mutate ? state.mutate(structuredClone(value)) : value,
            });
        }
        if (pathname.startsWith(`${path}/questions/`) && method === 'GET') {
            const value = state.saved.get(pathname.split('/').at(-1)!);
            if (state.switched || !value) return route.fulfill({ status: 404, json: errorBody() });
            if (state.getStatus !== 200)
                return route.fulfill({ status: state.getStatus, json: errorBody() });
            return route.fulfill({
                json: state.mutate ? state.mutate(structuredClone(value)) : value,
            });
        }
        state.unexpected.push(`${method} ${pathname}`);
        return route.fulfill({ status: 501, json: errorBody() });
    });
    return state;
}
const panel = (page: Page) => page.locator('.questions');
const result = (page: Page) => panel(page).locator('.question-result');
const input = (page: Page) => panel(page).getByRole('textbox', { name: '问题', exact: true });
const button = (page: Page, name: string) => panel(page).getByRole('button', { name, exact: true });
const requests = (state: State, method?: string) =>
    state.requests.filter(
        (entry) => entry.path.includes('/questions') && (!method || entry.method === method),
    );
async function open(page: Page, query = '') {
    await page.goto(`${path}${query}`);
    await expect(page.locator('.report-brief')).toBeVisible();
    await expect(panel(page)).toBeVisible();
}
async function ask(page: Page, text = '原文如何说明？') {
    await input(page).fill(text);
    await button(page, '提问').click();
}
async function notice(page: Page, text: string) {
    await expect(panel(page).getByRole('status').filter({ hasText: text })).toBeVisible();
}
async function dismissClick(page: Page, name: string, accept: boolean) {
    page.once('dialog', (dialog) => (accept ? dialog.accept() : dialog.dismiss()));
    await button(page, name).click();
}
async function switchAccount(page: Page) {
    await logoutFromAccount(page);
    await page.getByRole('textbox', { name: '邮箱', exact: true }).fill('next@example.test');
    await page.getByLabel('密码', { exact: true }).fill('another-password-123');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expectAccountReady(page);
}
async function staleReturn(page: Page, state: State) {
    const now = await page.evaluate(() => Date.now());
    await page.getByRole('link', { name: '阅读外观', exact: true }).click();
    await expect(page).toHaveURL(/\/account\/appearance$/);
    await page.clock.setFixedTime(now + 31_000);
    state.reportHold = true;
    await page.goBack();
    await expect.poll(() => state.reportWaiting).toBe(true);
    await expect(page.locator('.report-brief')).toBeVisible();
}
test.beforeAll(async ({ browser }) => console.log(`Browser: Chromium ${browser.version()}`));

test('HTTP sample: answered sends raw body once, updates ID URL without dirty dialog and refreshes GET-only', async ({
    page,
    context,
}) => {
    const state = await samples(context);
    await open(page);
    const original = await page.locator('.report-brief').textContent();
    let dialogs = 0;
    page.on('dialog', async (dialog) => {
        dialogs++;
        await dialog.dismiss();
    });
    await input(page).fill('  原始问题\n保留空格  ');
    await input(page).press('Tab');
    await expect(button(page, '提问')).toBeFocused();
    await button(page, '提问').press('Enter');
    await expect(result(page)).toBeVisible();
    await expect(page.locator('#question-result-title')).toBeFocused();
    expect(dialogs).toBe(0);
    expect(requests(state, 'POST')).toHaveLength(1);
    const posted = requests(state, 'POST')[0]!;
    expect(posted.body).toBe(JSON.stringify({ question: '  原始问题\n保留空格  ' }));
    expect(posted.key).toMatch(/^[\w-]{16,128}$/);
    expect(posted.csrf).toBe('questions-test-only');
    const url = new URL(page.url());
    expect(url.searchParams.get('questionId')).toBe(id(50));
    expect([...url.searchParams.keys()]).toEqual(['questionId']);
    await expect(result(page).getByRole('heading', { name: '证据回答' })).toBeVisible();
    await expect(result(page).getByText('仍需更多资料。本次没有启动后续研究。')).toBeVisible();
    expect(await page.locator('.report-brief').textContent()).toBe(original);
    await page.reload();
    await expect(result(page)).toBeVisible();
    expect(requests(state, 'POST')).toHaveLength(1);
    expect(requests(state, 'GET')).toHaveLength(1);
    await button(page, '提出新问题').click();
    await expect(input(page)).toBeFocused();
    expect(new URL(page.url()).searchParams.has('questionId')).toBe(false);
    expect(state.unexpected).toEqual([]);
});

const reasons = {
    insufficient_evidence: '报告现有证据不足以回答此问题。',
    model_unavailable: '未配置可用的问答模型，暂时无法提取回答。',
    model_failed: '本次模型调用失败，未获得可核验的回答。',
    invalid_output: '模型输出未通过原文核验，未作为回答展示。',
    aborted: '本次问答已中止，未获得可核验的回答。',
} as const;
for (const reason of Object.keys(reasons) as (keyof typeof reasons)[]) {
    test(`HTTP sample: saved ${reason} is honest insufficient with independent usage`, async ({
        page,
        context,
    }) => {
        const state = await samples(context);
        state.reason = reason;
        await open(page);
        await ask(page);
        await expect(result(page).getByRole('heading', { name: '未获得可核验回答' })).toBeVisible();
        await expect(result(page).getByText(reasons[reason], { exact: true })).toBeVisible();
        await expect(result(page).locator('.statement,.question-citation')).toHaveCount(0);
        await expect(result(page)).toContainText(reason === 'model_unavailable' ? '0 次' : '1 次');
        await expect(result(page)).toContainText(
            reason === 'model_unavailable'
                ? '以上为本次问答记录的用量。'
                : '以上含保守估算或未知调用预留，并非精确扣款。',
        );
        await expect(result(page)).toContainText('不计入原报告 Run 预算。');
        expect(state.unexpected).toEqual([]);
    });
}

const badSamples: Record<string, (value: ReportQuestion) => unknown> = {
    'wrong-report': (value) => ({ ...value, reportId: id(999) }),
    'wrong-question-text': (value) => ({ ...value, question: '其它问题' }),
    'foreign-evidence': (value) => {
        value.answer.statements[0]!.citations[0]!.evidenceId = id(999);
        return value;
    },
    'forged-quote': (value) => {
        value.answer.statements[0]!.citations[0]!.quote = '未经授权原文';
        return value;
    },
    'unsupported-statement': (value) => {
        value.answer.statements[0]!.text = '根据常识编造的结论';
        return value;
    },
    'contradictory-status': (value) => {
        value.answer.status = 'insufficient';
        return value;
    },
    'empty-citations': (value) => {
        value.answer.statements[0]!.citations = [];
        return value;
    },
};
for (const [name, mutate] of Object.entries(badSamples)) {
    test(`HTTP sample: ${name} response fails closed and preserves immutable original question`, async ({
        page,
        context,
    }) => {
        const state = await samples(context);
        state.mutate = mutate;
        await open(page);
        await ask(page, '必须保留的原始问题');
        await notice(page, '本次结果尚未确认');
        await expect(result(page)).toHaveCount(0);
        await expect(panel(page).locator('.question-citation')).toHaveCount(0);
        await expect(input(page)).toHaveValue('必须保留的原始问题');
        await expect(input(page)).not.toBeEditable();
        expect(new URL(page.url()).searchParams.has('questionId')).toBe(false);
        expect(requests(state, 'POST')).toHaveLength(1);
    });
}

for (const mode of ['lost', 'pending', 'rate', 'unavailable'] as const) {
    test(`HTTP sample: ${mode} keeps original key/body and explicitly reads persisted result without automatic retry`, async ({
        page,
        context,
    }) => {
        await page.clock.install();
        const state = await samples(context);
        state.mode = mode;
        state.reason = 'model_failed';
        await open(page);
        await ask(page, '  不确定请求\n保持原文  ');
        await expect(button(page, '读取本次结果')).toBeVisible();
        await expect(input(page)).toHaveValue('  不确定请求\n保持原文  ');
        await expect(input(page)).not.toBeEditable();
        if (mode === 'rate' || mode === 'unavailable') {
            await expect(button(page, '读取本次结果')).toBeDisabled();
            await expect(panel(page)).toContainText('读取可能返回已保存结果，不代表重新调用模型');
        }
        await page.clock.runFor(2100);
        await expect(button(page, '读取本次结果')).toBeEnabled();
        expect(requests(state, 'POST')).toHaveLength(1);
        const before = state.saved.values().next().value as ReportQuestion | undefined;
        state.mode = 'ok';
        await button(page, '读取本次结果').click();
        await expect(result(page)).toBeVisible();
        expect(requests(state, 'POST')[1]).toEqual(requests(state, 'POST')[0]);
        if (before) expect(new URL(page.url()).searchParams.get('questionId')).toBe(before.id);
        await expect(result(page)).toContainText('未获得可核验回答');
        expect(requests(state, 'POST')).toHaveLength(2);
        expect(state.unexpected).toEqual([]);
    });
}

test('HTTP sample: double submit has one POST; mismatch stays terminal until explicit discard', async ({
    page,
    context,
}) => {
    const state = await samples(context);
    state.mode = 'mismatch';
    await open(page);
    await input(page).fill('一次用户动作');
    await button(page, '提问').dblclick();
    await notice(page, '请求标识与服务端问题不一致');
    expect(requests(state, 'POST')).toHaveLength(1);
    await expect(button(page, '读取本次结果')).toBeDisabled();
    await dismissClick(page, '结束本次请求', false);
    await expect(input(page)).toHaveValue('一次用户动作');
    await dismissClick(page, '结束本次请求', true);
    await expect(input(page)).toHaveValue('');
    state.mode = 'ok';
    await ask(page, '新的独立动作');
    await expect(result(page)).toBeVisible();
    expect(requests(state, 'POST')[1]!.key).not.toBe(requests(state, 'POST')[0]!.key);
});

for (const query of [
    '?questionId=bad',
    `?questionId=${id(50)}&questionId=${id(50)}`,
    '?questionId=',
]) {
    test(`HTTP sample: invalid or repeated URL ${query} makes zero question requests`, async ({
        page,
        context,
    }) => {
        const state = await samples(context);
        await open(page, query);
        await expect(panel(page).getByRole('alert')).toContainText('回答地址无效');
        expect(requests(state)).toHaveLength(0);
        await expect(result(page)).toHaveCount(0);
        await button(page, '提出新问题').click();
        await expect(input(page)).toBeFocused();
        expect(new URL(page.url()).searchParams.has('questionId')).toBe(false);
    });
}

test('HTTP sample: known URL ID waits for authorized Report and failed explicit GET hides cache', async ({
    page,
    context,
}) => {
    const state = await samples(context);
    state.saved.set(id(50), question(state.report));
    state.reportHold = true;
    await page.goto(`${path}?questionId=${id(50)}`);
    await expect.poll(() => state.reportWaiting).toBe(true);
    expect(requests(state)).toHaveLength(0);
    state.releaseReport!(200);
    await expect(result(page)).toBeVisible();
    expect(requests(state, 'GET')).toHaveLength(1);
    expect(requests(state, 'POST')).toHaveLength(0);
    await page.clock.install();
    const now = await page.evaluate(() => Date.now());
    state.reportHold = false;
    await page.getByRole('link', { name: '阅读外观', exact: true }).click();
    await expect(page).toHaveURL(/\/account\/appearance$/);
    state.getStatus = 503;
    await page.clock.setFixedTime(now + 31_000);
    await page.goBack();
    await expect(result(page)).toHaveCount(0);
    await expect(panel(page).getByRole('alert')).toContainText('暂时无法读取');
    const reads = requests(state, 'GET').length;
    state.getStatus = 200;
    await button(page, '读取本次结果').click();
    await expect(result(page)).toBeVisible();
    expect(requests(state, 'GET')).toHaveLength(reads + 1);
    expect(requests(state, 'POST')).toHaveLength(0);
});

test('HTTP sample: wrong known question ID is hidden despite valid report/citations', async ({
    page,
    context,
}) => {
    const state = await samples(context);
    state.saved.set(id(50), question(state.report));
    state.mutate = (value) => ({ ...value, id: id(999) });
    await open(page, `?questionId=${id(50)}`);
    await expect(panel(page).getByRole('alert')).toContainText('原文核验失败');
    await expect(result(page)).toHaveCount(0);
    expect(requests(state, 'POST')).toHaveLength(0);
});

test('HTTP sample: draft and unknown attempt guard external route changes; accepted departure ignores late result', async ({
    page,
    context,
}) => {
    const state = await samples(context);
    await open(page);
    await input(page).fill('未提交原稿');
    const appearance = page.getByRole('link', { name: '阅读外观', exact: true });
    page.once('dialog', (dialog) => dialog.dismiss());
    await appearance.click();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(input(page)).toHaveValue('未提交原稿');
    state.mode = 'pending';
    await button(page, '提问').click();
    await notice(page, '仍在处理中');
    page.once('dialog', (dialog) => dialog.dismiss());
    await appearance.click();
    await expect(input(page)).toHaveValue('未提交原稿');
    let release!: () => void;
    let reading = false;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    await page.route(`**/api/v1${path}/questions`, async (route) => {
        if (route.request().method() !== 'POST') return route.fallback();
        reading = true;
        await gate;
        return route.fulfill({ status: 201, json: question(state.report, '未提交原稿') });
    });
    await button(page, '读取本次结果').click();
    await expect.poll(() => reading).toBe(true);
    page.once('dialog', (dialog) => dialog.accept());
    await appearance.click();
    await expect(page).toHaveURL(/\/account\/appearance$/);
    release();
    await page.goBack();
    await expect(panel(page)).toBeVisible();
    await expect(result(page)).toHaveCount(0);
    await expect(input(page)).toHaveValue('');
    expect(new URL(page.url()).searchParams.has('questionId')).toBe(false);
});

for (const status of [503, 403, 404]) {
    test(`HTTP sample: Report ${status} retains only local question and disables all communication`, async ({
        page,
        context,
    }) => {
        await page.clock.install();
        const state = await samples(context);
        await open(page);
        await staleReturn(page, state);
        await input(page).fill(`保稿-${status}`);
        state.releaseReport!(status);
        await notice(page, '本地问题仍可复制');
        await expect(page.locator('.report-brief')).toHaveCount(0);
        await expect(input(page)).toHaveValue(`保稿-${status}`);
        await expect(input(page)).not.toBeEditable();
        await expect(button(page, '提问')).toBeDisabled();
        await expect(result(page)).toHaveCount(0);
        expect(requests(state)).toHaveLength(0);
        if (status === 503) {
            state.reportHold = false;
            await page.getByRole('button', { name: '重试', exact: true }).click();
            await expect(input(page)).toBeEditable();
            await expect(input(page)).toHaveValue('保稿-503');
            await expect(button(page, '提问')).toBeEnabled();
        }
    });
}

test('HTTP sample: unavailable Report hides saved answer and citations, keeps copyable local question', async ({
    page,
    context,
}) => {
    await page.clock.install();
    const state = await samples(context);
    await open(page);
    await staleReturn(page, state);
    await ask(page, '结果后的本地问题');
    await expect(result(page)).toBeVisible();
    state.releaseReport!(503);
    await notice(page, '本地问题仍可复制');
    await expect(result(page)).toHaveCount(0);
    await expect(panel(page).locator('.question-citation')).toHaveCount(0);
    await expect(input(page)).toHaveValue('结果后的本地问题');
    await expect(input(page)).not.toBeEditable();
    state.reportHold = false;
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await expect(result(page)).toBeVisible();
    expect(requests(state, 'POST')).toHaveLength(1);
});

test('HTTP sample: unavailable Report keeps unresolved attempt locked and recovery reuses original key', async ({
    page,
    context,
}) => {
    await page.clock.install();
    const state = await samples(context);
    await open(page);
    await staleReturn(page, state);
    state.mode = 'pending';
    await ask(page, '授权恢复前保留的未知请求');
    await notice(page, '仍在处理中');
    state.releaseReport!(503);
    await notice(page, '本地问题仍可复制');
    await expect(button(page, '读取本次结果')).toBeDisabled();
    await expect(input(page)).toHaveValue('授权恢复前保留的未知请求');
    expect(requests(state, 'POST')).toHaveLength(1);
    state.reportHold = false;
    state.mode = 'ok';
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await expect(button(page, '读取本次结果')).toBeEnabled();
    await button(page, '读取本次结果').click();
    await expect(result(page)).toBeVisible();
    expect(requests(state, 'POST')[1]).toEqual(requests(state, 'POST')[0]);
});

for (const late of [201, 401]) {
    test(`HTTP sample: old-account delayed POST${late} cannot restore text or expire replacement`, async ({
        page,
        context,
    }) => {
        const state = await samples(context);
        let release!: () => void;
        let posted = false;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        await page.route(`**/api/v1${path}/questions`, async (route) => {
            posted = true;
            await gate;
            return route.fulfill({
                status: late,
                json: late === 201 ? question(state.report, '旧账号私密问题') : errorBody(),
            });
        });
        await open(page);
        await ask(page, '旧账号私密问题');
        await expect.poll(() => posted).toBe(true);
        await switchAccount(page);
        release();
        await expect(panel(page)).toHaveCount(0);
        await expect(page.locator('.report-brief')).toHaveCount(0);
        await expect(page.getByText('旧账号私密问题', { exact: true })).toHaveCount(0);
        await expectAccountReady(page);
        expect(state.switched).toBe(true);
    });
}

test('HTTP sample: UTF16 boundaries reject empty/2001 and allow 2000 without writing', async ({
    page,
    context,
}) => {
    const state = await samples(context);
    await open(page);
    for (const text of [' \t\n ', '中'.repeat(2001), '😀'.repeat(1001)]) {
        await input(page).fill(text);
        await expect(button(page, '提问')).toBeDisabled();
    }
    for (const text of ['中'.repeat(2000), '😀'.repeat(1000)]) {
        await input(page).fill(text);
        await expect(button(page, '提问')).toBeEnabled();
    }
    expect(requests(state)).toHaveLength(0);
});

for (const width of [320, 390, 768, 1024, 1440, 1920]) {
    test(`HTTP sample: questions ${width} light/dark and 200% text have readable literal quotes and keyboard controls`, async ({
        page,
        context,
    }, info) => {
        const state = await samples(context);
        const raw = `  中文来源逐字片段需要完整阅读。\n${'跨来源核验仍待完成。'.repeat(20)}\n<script>window.questionInjected=1</script>\nhttps://example.test/${'x'.repeat(160)}  `;
        state.report.evidence[0]!.quote = raw;
        const errors: string[] = [];
        const external: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        page.on('request', (request) => {
            if (new URL(request.url()).hostname === 'example.test') external.push(request.url());
        });
        await page.setViewportSize({ width, height: 1000 });
        await open(page);
        await input(page).fill(`长问题：${'资料如何解释？'.repeat(40)}`);
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
                const geometry = await input(page).evaluate((element) => {
                    const rect = element.getBoundingClientRect();
                    const style = getComputedStyle(element);
                    return {
                        left: rect.left,
                        right: rect.right,
                        height: rect.height,
                        font: style.fontFamily,
                        cursor: style.cursor,
                    };
                });
                expect(
                    geometry.left >= -1 &&
                        geometry.right <= width + 1 &&
                        geometry.height >= (enlarged ? 88 : 44),
                ).toBe(true);
                expect(geometry.cursor).toBe('text');
                expect(geometry.font).toContain('Inter');
                await input(page).focus();
                await page.screenshot({
                    path: info.outputPath(
                        `question-input-${width}-${dark ? 'dark' : 'light'}${enlarged ? '-text200' : ''}.png`,
                    ),
                    fullPage: false,
                });
            }
        }
        await page.evaluate(() => {
            document.documentElement.style.fontSize = '';
        });
        await page.emulateMedia({ colorScheme: 'light' });
        await button(page, '提问').click();
        await expect(result(page)).toBeVisible();
        const summary = result(page).locator('summary').first();
        await summary.focus();
        await summary.press('Enter');
        await expect(result(page).locator('details blockquote')).toBeVisible();
        const link = result(page).getByRole('link', { name: '打开原始来源（新窗口）' });
        await summary.press('Tab');
        await expect(link).toBeFocused();
        await expect(link).toHaveAttribute('href', 'https://example.test/saved');
        await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
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
                const quotes = await result(page)
                    .locator('blockquote')
                    .evaluateAll((elements) =>
                        elements.map((element) => {
                            const style = getComputedStyle(element);
                            return {
                                raw: element.textContent,
                                width:
                                    (element.clientWidth -
                                        parseFloat(style.paddingLeft) -
                                        parseFloat(style.paddingRight)) /
                                    parseFloat(style.fontSize),
                                font: style.fontFamily,
                            };
                        }),
                    );
                expect(quotes.length).toBe(2);
                expect(
                    quotes.every(
                        (quote) =>
                            quote.raw === raw && quote.width >= 4 && quote.font.includes('Inter'),
                    ),
                ).toBe(true);
                const controls = await panel(page)
                    .locator('button,summary,a')
                    .evaluateAll((elements) =>
                        elements
                            .filter((element) => element.getBoundingClientRect().width > 0)
                            .map((element) => {
                                const rect = element.getBoundingClientRect();
                                return {
                                    left: rect.left,
                                    right: rect.right,
                                    height: rect.height,
                                    cursor: getComputedStyle(element).cursor,
                                };
                            }),
                    );
                expect(
                    controls.every(
                        (control) =>
                            control.left >= -1 &&
                            control.right <= width + 1 &&
                            control.height >= (enlarged ? 88 : 44) - 1 &&
                            control.cursor === 'pointer',
                    ),
                ).toBe(true);
                await summary.focus();
                expect(
                    await summary.evaluate((element) => getComputedStyle(element).outlineStyle),
                ).not.toBe('none');
                await page.screenshot({
                    path: info.outputPath(
                        `questions-${width}-${dark ? 'dark' : 'light'}${enlarged ? '-text200' : ''}.png`,
                    ),
                    fullPage: false,
                });
            }
        }
        await summary.press('Space');
        await expect(result(page).locator('details blockquote')).toBeHidden();
        await expect(panel(page).locator('script,img,iframe')).toHaveCount(0);
        expect(await page.evaluate(() => 'questionInjected' in window)).toBe(false);
        expect(external).toEqual([]);
        expect(errors).toEqual([]);
        expect(state.unexpected).toEqual([]);
        expect(requests(state, 'POST')).toHaveLength(1);
    });
}
