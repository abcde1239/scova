import { chooseOption, chooseOutputFormats, chooseTimezone } from './support/select.ts';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import type {
    TaskDraftResponse,
    TaskDraftInput,
    TaskDraftScope,
} from '../../packages/models/src/task/drafts.ts';
import type { taskInput } from '../../apps/web/src/composable/useCreateTask.ts';

test.use({ timezoneId: 'Asia/Tokyo' });
type CreateInput = ReturnType<typeof taskInput> & { inputText?: string };
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const taskId = id(11);
const instant = '2026-10-31T00:00:00Z';
const inputText = '  每周三09:15对比招生政策变化\n保留原文空格，预算需要核验。  ';
const parsed: TaskDraftResponse['config'] = {
    title: '持续跟踪招生政策与学术研究观点的变化',
    topic: '各地高校招生政策',
    goal: '比较变化并保留可核验来源证据',
    focusPoints: ['一项内的\n换行', '  保留空格  '],
    exclusions: ['排除\n一项'],
    sourcePreferences: {
        preferredUrls: ['https://example.test/admission'],
        excludedUrls: ['https://example.test/ads'],
        officialOnly: true,
    },
    timeRange: {
        kind: 'fixed',
        start: '2026-10-01T03:04:05.123Z',
        end: '2026-10-30T04:05:06.456Z',
    },
    timezone: 'Asia/Shanghai',
    schedule: { frequency: 'weekly', weekday: 3, localTime: '09:15' },
    outputFormat: 'comparison',
    researchMode: 'analysis',
    budget: {
        maxSearches: 9,
        maxPages: 12,
        maxDurationSeconds: 180,
        maxInputTokens: 9000,
        maxOutputTokens: 1900,
    },
    notificationPreference: { mode: 'important_change', runIssues: false },
};

// Explicit local contract samples, including model mode; no real model/storage claim.
async function samples(context: BrowserContext) {
    const calls: { method: string; path: string; body: unknown; csrf?: string; key?: string }[] =
        [];
    const state = {
        mode: 'model' as 'model' | 'manual',
        reason: 'model_unavailable' as Exclude<TaskDraftResponse['manualReason'], null>,
        failure: 0,
        wait: undefined as Promise<void> | undefined,
        saved: undefined as CreateInput | undefined,
    };
    function detail() {
        const config = state.saved!.config;
        return {
            task: {
                id: taskId,
                title: config.title,
                status: 'active',
                revision: 1,
                currentVersionId: id(12),
                nextRunAt: config.schedule.frequency === 'manual' ? null : '2026-11-04T01:15:00Z',
                createdAt: instant,
                updatedAt: instant,
            },
            version: {
                id: id(12),
                taskId,
                version: 1,
                configSchemaVersion: 1,
                config,
                comparisonScopeHash: 'a'.repeat(64),
                createdAt: instant,
            },
            baselineResetRequired: false,
        };
    }
    await context.route('**/api/v1/**', async (route) => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        if (path === '/api/v1/me')
            return route.fulfill({
                json: {
                    user: {
                        id: id(1),
                        email: 'task-draft@example.test',
                        preferences: {
                            defaultTimezone: 'UTC',
                            notificationPreference: { mode: 'summary', runIssues: true },
                        },
                        createdAt: instant,
                    },
                    csrfToken: 'sample-csrf',
                },
            });
        if (path === '/api/v1/me/agent-providers' && request.method() === 'GET')
            return route.fulfill({
                json: { storageReady: true, systemConfigured: true, items: [] },
            });
        const body: unknown = request.method() === 'POST' ? request.postDataJSON() : null;
        calls.push({
            method: request.method(),
            path,
            body,
            csrf: request.headers()['x-csrf-token'],
            key: request.headers()['idempotency-key'],
        });
        if (path === '/api/v1/task-drafts/questions') {
            const input = body as { inputText: string; round: number };
            return route.fulfill({
                json: {
                    inputText: input.inputText,
                    round: input.round,
                    summary: '已整理需求，请核对范围。',
                    questions: [],
                    scope: {
                        goal: input.inputText.trim(),
                        focusPoints: [],
                        exclusions: [],
                        sourcePreferences: {
                            preferredUrls: [],
                            excludedUrls: [],
                            officialOnly: false,
                        },
                        timeRange: { kind: 'rolling', days: 7 },
                        outputFormat: 'brief',
                        researchMode: 'analysis',
                    },
                    mode: 'model',
                    manualReason: null,
                    parsingUsage: {
                        attempts: 1,
                        inputTokens: 50,
                        outputTokens: 30,
                        estimated: false,
                    },
                },
            });
        }
        if (path === '/api/v1/task-drafts') {
            if (state.wait) await state.wait;
            if (state.failure)
                return route.fulfill({
                    status: state.failure,
                    json: { code: 'LOCAL_FAILURE', message: 'local sample', requestId: 'sample' },
                });
            const model = state.mode === 'model';
            const result: TaskDraftResponse = {
                inputText: (body as { inputText: string }).inputText,
                config: { ...structuredClone(parsed), ...(body as TaskDraftInput).searchScope },
                mode: state.mode,
                requiresConfirmation: true,
                manualReason: model ? null : state.reason,
                warnings: [
                    { path: '/config/schedule', message: '周期计划待确认，尚未启用。' },
                    { path: '/config/budget', message: '请检查独立单次执行预算。' },
                ],
                parsingUsage: {
                    attempts: model ? 2 : 0,
                    inputTokens: model ? 512 : 0,
                    outputTokens: model ? 80 : 0,
                    estimated: model,
                },
            };
            return route.fulfill({ json: result });
        }
        if (path === '/api/v1/tasks' && request.method() === 'POST') {
            state.saved = body as CreateInput;
            return route.fulfill({ status: 201, headers: { etag: '"1"' }, json: detail() });
        }
        if (path.endsWith('/runs')) return route.fulfill({ json: { items: [], nextCursor: null } });
        if (path === '/api/v1/tasks')
            return route.fulfill({
                json: { items: state.saved ? [detail().task] : [], nextCursor: null },
            });
        if (path === `/api/v1/tasks/${taskId}` && request.method() === 'GET' && state.saved)
            return route.fulfill({ headers: { etag: '"1"' }, json: detail() });
        return route.fulfill({
            status: 501,
            json: {
                code: 'UNEXPECTED_ENDPOINT',
                message: 'Unknown sample endpoint',
                requestId: 'sample',
            },
        });
    });
    return { calls, state };
}
const panel = (page: Page) => page.getByRole('region', { name: '用 AI 整理需求' });
const original = (page: Page) => page.getByLabel('需求描述', { exact: true });
const timezone = (page: Page) => page.getByLabel('需求时区', { exact: true });
const title = (page: Page) => page.getByLabel('任务标题', { exact: true });
const parse = (page: Page) =>
    panel(page).getByRole('button', { name: '生成任务草稿', exact: true });
const confirmedScope: TaskDraftScope = {
    goal: parsed.goal,
    focusPoints: parsed.focusPoints,
    exclusions: parsed.exclusions,
    sourcePreferences: parsed.sourcePreferences,
    timeRange: parsed.timeRange,
    outputFormat: parsed.outputFormat,
    researchMode: 'analysis',
};
async function generateDraft(
    page: Page,
    activation: 'click' | 'keyboard' | 'double' = 'click',
    formats = ['对比表'],
) {
    const text = await original(page).inputValue();
    if (activation === 'keyboard') await parse(page).press('Enter');
    else await parse(page).click();
    if (!text.trim() || text.length > 2000) return;
    const questions = panel(page).locator('.scope-questions');
    await questions.getByLabel('希望回答的核心问题', { exact: true }).fill(parsed.goal);
    for (const [label, button, values] of [
        ['必须收集的内容（可选）', '添加搜索重点', parsed.focusPoints],
        ['不查哪些内容（可选）', '添加排除内容', parsed.exclusions],
    ] as const) {
        for (const [i, value] of values.entries()) {
            const field = questions.getByLabel(label + ' ' + (i + 1), { exact: true });
            if (!(await field.count()))
                await questions.getByRole('button', { name: button, exact: true }).click();
            await field.fill(value);
        }
    }
    await questions.getByRole('button', { name: '下一步', exact: true }).click();
    await chooseOption(page, '搜索时间范围', '指定时间段');
    await questions.getByLabel('搜索起始时间', { exact: true }).fill('2026-10-01 12:04:05.123');
    await questions.getByLabel('搜索截止时间', { exact: true }).fill('2026-10-30 13:05:06.456');
    for (const [label, button, values] of [
        ['优先查阅的网址（可选）', '添加优先网址', parsed.sourcePreferences.preferredUrls],
        ['不查阅的网址（可选）', '添加排除网址', parsed.sourcePreferences.excludedUrls],
    ] as const) {
        for (const [i, value] of values.entries()) {
            const field = questions.getByLabel(label + ' ' + (i + 1), { exact: true });
            if (!(await field.count()))
                await questions.getByRole('button', { name: button, exact: true }).click();
            await field.fill(value);
        }
    }
    await questions.getByLabel('限定官方来源', { exact: true }).check();
    await questions.getByRole('button', { name: '下一步', exact: true }).click();
    await chooseOption(page, '此次需要的工作', '分析研究');
    await chooseOutputFormats(page, '希望得到的形式', formats);
    const confirm = questions.getByRole('button', { name: '确认范围并生成草稿', exact: true });
    if (activation === 'double') await confirm.dblclick();
    else if (activation === 'keyboard') await confirm.press('Enter');
    else await confirm.click();
}
const apply = (page: Page) =>
    panel(page).getByRole('button', { name: '应用草稿并替换当前配置', exact: true });
const feedback = (page: Page) => page.locator('.scova-notifications .n-notification').last();
const taskPosts = (calls: Awaited<ReturnType<typeof samples>>['calls']) =>
    calls.filter((call) => call.method === 'POST' && !call.path.startsWith('/api/v1/task-drafts'));
const draftPosts = (calls: Awaited<ReturnType<typeof samples>>['calls']) =>
    calls.filter((call) => call.method === 'POST' && call.path === '/api/v1/task-drafts');

test('自然需求确认传递多种成果目标，确认前不创建任务或执行', async ({ page }) => {
    const { calls } = await samples(page.context());
    await page.goto('/tasks/new');
    await original(page).fill(inputText);
    await generateDraft(page, 'click', ['简报', '对比表']);
    await expect(apply(page)).toBeEnabled();
    expect(draftPosts(calls)[0]!.body).toMatchObject({
        searchScope: { outputFormat: 'brief', outputFormats: ['brief', 'comparison'] },
    });
    expect(taskPosts(calls)).toHaveLength(0);
    expect(calls.some((call) => call.method === 'POST' && call.path.includes('/runs'))).toBe(false);
});

for (const width of [390, 1440]) {
    test(`AI交互澄清${width}：根据回答继续追问，最终范围与对话进入草稿而不创建任务`, async ({
        page,
    }, info) => {
        const { calls } = await samples(page.context());
        const questionCalls: {
            round: number;
            clarifications: { question: string; answer: string }[];
        }[] = [];
        const scope: TaskDraftScope = {
            goal: '收集上海线下编程课程价格与申请条件',
            focusPoints: ['价格', '申请条件'],
            exclusions: ['在线课程'],
            sourcePreferences: { preferredUrls: [], excludedUrls: [], officialOnly: true },
            timeRange: { kind: 'rolling', days: 30 },
            outputFormat: 'comparison',
            researchMode: 'collection',
        };
        await page.context().route('**/api/v1/task-drafts/questions', (route) => {
            const body = route.request().postDataJSON();
            questionCalls.push(body);
            return route.fulfill({
                json: {
                    inputText: body.inputText,
                    round: body.round,
                    summary:
                        body.round === 2
                            ? '收集上海线下编程课程，比较费用与申请条件。'
                            : '需要进一步确认课程范围。',
                    scope,
                    questions:
                        body.round === 0
                            ? [
                                  {
                                      id: 'q1',
                                      question: '查哪个城市的课程？',
                                      reason: '城市决定可报名范围',
                                      options: ['上海', '杭州'],
                                  },
                              ]
                            : body.round === 1
                              ? [
                                    {
                                        id: 'q1',
                                        question: '上海需要哪一类课程？',
                                        reason: '只搜索你需要的课程',
                                        options: ['语言', '编程'],
                                    },
                                ]
                              : [],
                    mode: 'model',
                    manualReason: null,
                    parsingUsage: {
                        attempts: 1,
                        inputTokens: 80,
                        outputTokens: 60,
                        estimated: false,
                    },
                },
            });
        });
        await page.setViewportSize({ width, height: 1000 });
        await page.goto('/tasks/new');
        await original(page).fill('比较课程价格');
        await parse(page).click();
        await expect(
            panel(page).getByRole('heading', { name: /AI 正在与你确认需求/ }),
        ).toBeFocused();
        await panel(page).getByRole('button', { name: '继续与 AI 确认', exact: true }).click();
        expect(questionCalls).toHaveLength(1);
        await expect(feedback(page)).toContainText('请逐项回答');
        await panel(page).getByRole('button', { name: '上海', exact: true }).click();
        await panel(page).getByRole('button', { name: '继续与 AI 确认', exact: true }).click();
        await expect(panel(page)).toContainText('上海需要哪一类课程？');
        expect(questionCalls[1]!.clarifications).toEqual([
            { question: '查哪个城市的课程？', answer: '上海' },
        ]);
        await panel(page)
            .getByLabel('你的回答：上海需要哪一类课程？', { exact: true })
            .fill('编程，只查线下课程');
        await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
        await noOverflow(page);
        await panel(page).screenshot({ path: info.outputPath(`ai-clarification-${width}.png`) });
        await panel(page).getByRole('button', { name: '继续与 AI 确认', exact: true }).click();
        const review = panel(page).locator('.scope-questions');
        await expect(review).toContainText('收集上海线下编程课程');
        expect(draftPosts(calls)).toHaveLength(0);
        await review.getByRole('button', { name: '下一步', exact: true }).click();
        await review.getByRole('button', { name: '下一步', exact: true }).click();
        await expect(
            review
                .getByRole('group', { name: '希望得到的形式', exact: true })
                .getByRole('checkbox', { name: /^对比表/ }),
        ).toBeChecked();
        await review.getByRole('button', { name: '确认范围并生成草稿', exact: true }).click();
        await expect(apply(page)).toBeEnabled();
        expect(draftPosts(calls)[0]!.body).toMatchObject({
            searchScope: scope,
            clarifications: questionCalls[2]!.clarifications,
        });
        await apply(page).click();
        await expect(page.getByLabel('查阅目标', { exact: true })).toHaveValue(scope.goal);
        expect(taskPosts(calls)).toHaveLength(0);
    });
}

test('AI追问失败保留当前回答，显式重试不重复追加对话', async ({ page }) => {
    const { calls } = await samples(page.context());
    let attempts = 0;
    const bodies: unknown[] = [];
    await page.context().route('**/api/v1/task-drafts/questions', (route) => {
        const body = route.request().postDataJSON();
        bodies.push(body);
        attempts++;
        if (attempts === 2)
            return route.fulfill({
                status: 503,
                json: { code: 'MODEL_UNAVAILABLE', message: 'local fixture', requestId: 'sample' },
            });
        return route.fulfill({
            json: {
                inputText: body.inputText,
                round: body.round,
                summary: '请明确范围',
                scope: confirmedScope,
                questions:
                    body.round === 0
                        ? [
                              {
                                  id: 'q1',
                                  question: '关注哪种课程？',
                                  reason: '缩小范围',
                                  options: [],
                              },
                          ]
                        : [],
                mode: 'model',
                manualReason: null,
                parsingUsage: { attempts: 1, inputTokens: 80, outputTokens: 40, estimated: false },
            },
        });
    });
    await page.goto('/tasks/new');
    await original(page).fill('收集课程信息');
    await parse(page).click();
    const answer = panel(page).getByLabel('你的回答：关注哪种课程？', { exact: true });
    await answer.fill('编程，保留原回答');
    await panel(page).getByRole('button', { name: '继续与 AI 确认', exact: true }).click();
    await expect(feedback(page)).toContainText('已有回答已保留');
    await expect(answer).toHaveValue('编程，保留原回答');
    expect(attempts).toBe(2);
    await panel(page).getByRole('button', { name: '继续与 AI 确认', exact: true }).click();
    await expect(panel(page).locator('.scope-questions')).toBeVisible();
    expect(bodies[2]).toEqual(bodies[1]);
    expect(draftPosts(calls)).toHaveLength(0);
});

test('AI先整理范围，非法日期可回退修正，确认前不生成草稿', async ({ page }, info) => {
    const { calls } = await samples(page.context());
    await page.setViewportSize({ width: 390, height: 1000 });
    await page.goto('/tasks/new');
    await original(page).fill('收集最新课程和价格');
    await parse(page).click();
    const questions = panel(page).locator('.scope-questions');
    await expect(questions.getByRole('heading')).toBeFocused();
    await questions.getByLabel('希望回答的核心问题', { exact: true }).fill('');
    await questions.getByRole('button', { name: '下一步', exact: true }).click();
    await expect(questions.getByRole('alert')).toContainText('请填写核心问题');
    await questions.getByLabel('希望回答的核心问题', { exact: true }).fill('课程与价格');
    await questions.getByRole('button', { name: '下一步', exact: true }).click();
    await chooseOption(page, '搜索时间范围', '指定时间段');
    await questions.getByRole('button', { name: '下一步', exact: true }).click();
    await expect(questions.getByRole('alert')).toContainText('请检查日期');
    await questions.getByRole('button', { name: '上一步', exact: true }).click();
    await questions.getByRole('button', { name: '下一步', exact: true }).click();
    await expect(questions.getByLabel('搜索时间范围', { exact: true })).toBeVisible();
    await chooseOption(page, '搜索时间范围', '最近一段时间');
    await questions.getByLabel('搜索最近多少天', { exact: true }).fill('30');
    await questions.getByRole('button', { name: '下一步', exact: true }).click();
    await chooseOption(page, '此次需要的工作', '资料采集');
    await chooseOption(page, '希望得到的形式', '简报');
    expect(draftPosts(calls)).toHaveLength(0);
    await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
    await noOverflow(page);
    await questions.screenshot({ path: info.outputPath('scope-confirmation-mobile.png') });
    await questions.getByRole('button', { name: '确认范围并生成草稿', exact: true }).click();
    await expect(apply(page)).toBeEnabled();
    expect(draftPosts(calls)[0]!.body).toEqual({
        inputText: '收集最新课程和价格',
        timezone: 'UTC',
        searchScope: {
            goal: '课程与价格',
            focusPoints: [],
            exclusions: [],
            sourcePreferences: { preferredUrls: [], excludedUrls: [], officialOnly: false },
            timeRange: { kind: 'rolling', days: 30 },
            researchMode: 'collection',
            outputFormat: 'brief',
            collectionDateUnknown: 'separate',
        },
    });
    await apply(page).click();
    await expect(page.getByRole('radio', { name: /^资料采集/ })).toBeChecked();
    expect(taskPosts(calls)).toHaveLength(0);
});

test('手动填写保留原文和配置，取消在途解析并可返回问答入口', async ({ page }) => {
    const { state, calls } = await samples(page.context());
    let release!: () => void;
    state.wait = new Promise<void>((resolve) => {
        release = resolve;
    });
    await page.goto('/tasks/new');
    await original(page).fill(inputText);
    await title(page).fill('保留手工内容');
    await generateDraft(page);
    await expect.poll(() => draftPosts(calls).length).toBe(1);
    await panel(page).getByRole('button', { name: '手动填写', exact: true }).click();
    await expect(feedback(page)).toContainText('已进入手工配置');
    await expect(title(page)).toBeFocused();
    release();
    await expect(title(page)).toHaveValue('保留手工内容');
    await panel(page).getByRole('button', { name: '返回 AI 整理需求', exact: true }).click();
    await expect(original(page)).toHaveValue(inputText);
    await expect(apply(page)).toHaveCount(0);
    expect(taskPosts(calls)).toHaveLength(0);
    expect(draftPosts(calls)).toHaveLength(1);
});

test('草稿解析显示就地进度和按钮加载，取消后清除且不应用迟到结果', async ({ page }, info) => {
    const { state, calls } = await samples(page.context());
    let release!: () => void;
    state.wait = new Promise<void>((resolve) => {
        release = resolve;
    });
    await page.setViewportSize({ width: 390, height: 1000 });
    await page.goto('/tasks/new');
    await original(page).fill(inputText);
    await title(page).fill('保留手工标题');
    await generateDraft(page);
    const loading = panel(page).locator('.state-panel--loading');
    await expect(loading).toContainText('正在整理需求与生成建议配置');
    await expect(panel(page).locator('.action-spinner')).toBeVisible();
    const imageBox = await loading.locator('img').boundingBox();
    const textBox = await loading.getByRole('status').boundingBox();
    expect(imageBox!.x + imageBox!.width).toBeLessThanOrEqual(textBox!.x);
    await loading.screenshot({ path: info.outputPath('draft-loading.png') });
    await panel(page).getByRole('button', { name: '停止解析', exact: true }).click();
    await expect(loading).toHaveCount(0);
    await expect(panel(page).locator('.action-spinner')).toHaveCount(0);
    release();
    await expect(feedback(page)).toContainText('解析已停止');
    await expect(title(page)).toHaveValue('保留手工标题');
    await expect(apply(page)).toHaveCount(0);
    expect(taskPosts(calls)).toHaveLength(0);
});
async function noOverflow(page: Page) {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
    );
    for (const target of await panel(page).locator('input,textarea,button').all()) {
        if (!(await target.isVisible())) continue;
        const hitTarget =
            (await target.getAttribute('type')) === 'checkbox'
                ? target.locator('xpath=ancestor::label[1]')
                : target;
        const bounds = await hitTarget.boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
        expect(bounds!.height).toBeGreaterThanOrEqual(44);
    }
}

for (const width of [320, 390, 768, 1024, 1440, 1920]) {
    test(`本地草稿样本${width}：模式警告与独立用量、显式应用、200%文字及保真保存`, async ({
        page,
    }, info) => {
        const { state, calls } = await samples(page.context());
        state.mode = [320, 768, 1440].includes(width) ? 'manual' : 'model';
        if (width === 768) state.reason = 'budget_exceeded';
        if (width === 1440) state.reason = 'ambiguous_timezone';
        await page.setViewportSize({ width, height: 1000 });
        await page.goto('/tasks/new');
        await original(page).fill(inputText);
        await title(page).fill('原有手工配置');
        await page.getByLabel('搜索次数上限', { exact: true }).fill('1');
        await chooseTimezone(page, 'Asia/Tokyo', '需求时区');
        await generateDraft(page, 'keyboard');
        await expect(apply(page)).toBeEnabled();
        await expect(feedback(page)).not.toBeFocused();
        await expect(title(page)).toHaveValue('原有手工配置');
        await expect(page.getByLabel('搜索次数上限', { exact: true })).toHaveValue('1');
        await expect(original(page)).toHaveValue(inputText);
        await expect(
            panel(page).getByRole('heading', {
                name: state.mode === 'model' ? '建议配置' : '待完善的配置',
                exact: true,
            }),
        ).toBeVisible();
        await expect(panel(page).getByRole('list', { name: '解析警告' })).toContainText(
            '周期计划待确认',
        );
        await expect(panel(page).getByRole('list', { name: '解析警告' })).toContainText(
            '请检查独立单次执行预算',
        );
        await panel(page).getByRole('button', { name: '查看生成详情' }).click();
        const usage = page.getByRole('dialog');
        await expect(usage).toContainText(`模型调用 ${state.mode === 'model' ? 2 : 0} 次`);
        await expect(usage).toContainText('不计入后续研究预算');
        await page.keyboard.press('Escape');
        await expect(usage).not.toBeVisible();
        await panel(page).getByText('本次解析原文', { exact: true }).click();
        expect(await panel(page).locator('.original-text').textContent()).toBe(inputText);
        expect(taskPosts(calls)).toHaveLength(0);
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
        await apply(page).focus();
        await apply(page).press('Space');
        await expect(title(page)).toBeFocused();
        await expect(title(page)).toHaveValue(parsed.title);
        await expect(title(page)).toBeEditable();
        await expect(apply(page)).toBeDisabled();
        await expect(panel(page).getByText(/原文、解析时区或表单已变化/)).toHaveCount(0);
        await expect(page.getByLabel('计划频率', { exact: true })).toContainText('每周');
        await expect(page.getByLabel('开始时间', { exact: true })).toHaveValue(
            '2026-10-01 12:04:05.123',
        );
        expect(taskPosts(calls)).toHaveLength(0);
        if (width === 320) {
            const schedule = page.getByRole('group', { name: '执行计划', exact: true });
            await schedule.scrollIntoViewIfNeeded();
            await info.attach('320-applied-periodic-text-200', {
                body: await page.screenshot({
                    path: info.outputPath('applied-periodic-text-200.png'),
                }),
                contentType: 'image/png',
            });
            await chooseOption(page, '计划频率', '仅手动');
            await expect(schedule).toContainText('仅手动执行');
            await schedule.scrollIntoViewIfNeeded();
            await info.attach('320-explicit-manual-text-200', {
                body: await page.screenshot({
                    path: info.outputPath('explicit-manual-text-200.png'),
                }),
                contentType: 'image/png',
            });
            await chooseOption(page, '计划频率', '每周');
        }
        if (width === 390) await chooseOption(page, '计划频率', '仅手动');
        await title(page).fill('用户确认后的标题');
        await page.getByRole('button', { name: '确认保存任务', exact: true }).click();
        await expect(page).toHaveURL(new RegExp(`/tasks/${taskId}$`));
        expect(taskPosts(calls)).toHaveLength(1);
        expect(state.saved).toEqual({
            inputText,
            config: {
                ...parsed,
                title: '用户确认后的标题',
                ...(width === 390 ? { schedule: { frequency: 'manual' } } : {}),
            },
        });
        expect(draftPosts(calls)[0]!.body).toEqual({
            inputText,
            timezone: 'Asia/Tokyo',
            searchScope: confirmedScope,
        });
        expect(draftPosts(calls)[0]!.csrf).toBe('sample-csrf');
        expect(draftPosts(calls)[0]!.key).toBeUndefined();
        expect(calls.some((call) => call.method === 'POST' && call.path.includes('/runs'))).toBe(
            false,
        );
    });
}

test('应用解析草稿后手改星期和当地时间，保存使用修改值且其余配置保真', async ({ page }) => {
    const { state, calls } = await samples(page.context());
    await page.goto('/tasks/new');
    await original(page).fill(inputText);
    await generateDraft(page);
    await expect(apply(page)).toBeEnabled();
    await apply(page).click();
    await expect(page.getByLabel('计划频率', { exact: true })).toContainText('每周');
    await expect(page.getByLabel('每周执行星期', { exact: true })).toContainText('周三');
    await expect(page.getByLabel('执行当地时间', { exact: true })).toHaveValue('09:15');
    await chooseOption(page, '每周执行星期', '周五');
    await page.getByLabel('执行当地时间', { exact: true }).fill('18:40');
    await expect(apply(page)).toBeDisabled();
    expect(taskPosts(calls)).toHaveLength(0);
    await page.getByRole('button', { name: '确认保存任务', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/tasks/${taskId}$`));
    expect(state.saved).toEqual({
        inputText,
        config: {
            ...parsed,
            schedule: { frequency: 'weekly', weekday: 5, localTime: '18:40' },
        },
    });
    expect(taskPosts(calls)).toHaveLength(1);
    expect(draftPosts(calls)).toHaveLength(1);
    expect(calls.some((call) => call.method === 'POST' && call.path.includes('/runs'))).toBe(false);
});

for (const status of [429, 408]) {
    test(`${status}保留原文与手工内容、允许继续填写且不重试`, async ({ page }, info) => {
        const { state, calls } = await samples(page.context());
        state.failure = status;
        await page.setViewportSize({ width: 320, height: 1000 });
        await page.goto('/tasks/new');
        await original(page).fill(inputText);
        await title(page).fill('解析失败前的手工标题');
        await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
        await generateDraft(page);
        await expect(feedback(page)).toContainText(status === 429 ? '解析过于频繁' : '解析超时');
        await expect(feedback(page)).not.toBeFocused();
        await expect(original(page)).toHaveValue(inputText);
        await expect(title(page)).toHaveValue('解析失败前的手工标题');
        await expect(title(page)).toBeEditable();
        await expect(apply(page)).toHaveCount(0);
        expect(draftPosts(calls)).toHaveLength(1);
        expect(taskPosts(calls)).toHaveLength(0);
        await noOverflow(page);
        await feedback(page).scrollIntoViewIfNeeded();
        await info.attach(`${status}-failure-text-200`, {
            body: await page.screenshot({ path: info.outputPath('failure-text-200.png') }),
            contentType: 'image/png',
        });
        await panel(page).getByRole('button', { name: '手动填写', exact: true }).click();
        await expect(title(page)).toBeFocused();
        await title(page).fill('失败后继续手工填写');
        expect(draftPosts(calls)).toHaveLength(1);
    });
}

for (const timing of ['during', 'after'] as const) {
    for (const changed of ['text', 'form', 'timezone'] as const) {
        test(`${timing}-${changed}修改禁用旧草稿且不抢焦点，重新解析才允许应用`, async ({
            page,
        }, info) => {
            const { calls, state } = await samples(page.context());
            let release!: () => void;
            if (timing === 'during')
                state.wait = new Promise<void>((resolve) => {
                    release = resolve;
                });
            if (timing === 'during' && changed === 'form')
                await page.setViewportSize({ width: 320, height: 1000 });
            await page.goto('/tasks/new');
            if (timing === 'during' && changed === 'form')
                await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
            await original(page).fill(inputText);
            await title(page).fill('手工标题');
            await generateDraft(page);
            await expect.poll(() => draftPosts(calls).length).toBe(1);
            if (timing === 'after') await expect(apply(page)).toBeEnabled();
            const edited =
                changed === 'text'
                    ? original(page)
                    : changed === 'form'
                      ? title(page)
                      : timezone(page);
            const newValue = changed === 'timezone' ? 'Asia/Tokyo' : '解析之后的新内容';
            if (changed === 'timezone') await chooseTimezone(page, newValue, '需求时区');
            else await edited.fill(newValue);
            if (timing === 'during') release();
            await expect(apply(page)).toBeDisabled();
            await expect(panel(page)).toContainText('此结果不能覆盖当前配置');
            await expect(edited).toBeFocused();
            if (changed === 'timezone') await expect(edited).toContainText(newValue);
            else await expect(edited).toHaveValue(newValue);
            await expect(title(page)).toHaveValue(changed === 'form' ? newValue : '手工标题');
            expect(taskPosts(calls)).toHaveLength(0);
            if (timing === 'during' && changed === 'form') {
                await noOverflow(page);
                await apply(page).scrollIntoViewIfNeeded();
                await info.attach('320-stale-text-200', {
                    body: await page.screenshot({ path: info.outputPath('stale-text-200.png') }),
                    contentType: 'image/png',
                });
            }
            state.wait = undefined;
            await generateDraft(page);
            await expect(apply(page)).toBeEnabled();
            await apply(page).click();
            await expect(title(page)).toHaveValue(parsed.title);
            await expect(title(page)).toBeFocused();
            expect(taskPosts(calls)).toHaveLength(0);
        });
    }
}

test('字符边界与非法时区前端拦截保留原文，2000中文字符合法', async ({ page }) => {
    const { calls } = await samples(page.context());
    await page.goto('/tasks/new');
    const excessive = '中'.repeat(2001);
    await original(page).fill(excessive);
    await generateDraft(page);
    await expect(original(page)).toHaveAttribute('aria-invalid', 'true');
    await expect(original(page)).toBeFocused();
    await expect(original(page)).toHaveValue(excessive);
    expect(draftPosts(calls)).toHaveLength(0);
    const boundary = '中'.repeat(2000);
    expect(new TextEncoder().encode(boundary).byteLength).toBe(6000);
    await original(page).fill(boundary);
    await timezone(page).click();
    await page.getByRole('combobox', { name: '搜索需求时区' }).fill('Mars/Olympus');
    const options = page.getByRole('listbox', { name: '需求时区', exact: true });
    await expect(options).toBeVisible();
    await expect(options.getByRole('option')).toHaveCount(0);
    await page.keyboard.press('Escape');
    expect(draftPosts(calls)).toHaveLength(0);
    await generateDraft(page);
    await expect(apply(page)).toBeEnabled();
    expect(draftPosts(calls)[0]!.body).toEqual({
        inputText: boundary,
        timezone: 'UTC',
        searchScope: confirmedScope,
    });
    expect(taskPosts(calls)).toHaveLength(0);
});

test('在途重复解析与停止不会写任务，迟到结果不复活', async ({ page }) => {
    const { calls, state } = await samples(page.context());
    let release!: () => void;
    state.wait = new Promise<void>((resolve) => {
        release = resolve;
    });
    await page.goto('/tasks/new');
    await original(page).fill(inputText);
    await generateDraft(page, 'double');
    const pending = panel(page).getByRole('button', { name: '正在整理', exact: true });
    await expect(pending).toHaveAttribute('aria-busy', 'true');
    await pending.press('Enter');
    await pending.press('Space');
    await panel(page).getByRole('button', { name: '停止解析', exact: true }).click();
    await expect(feedback(page)).toContainText('解析已停止');
    await expect(feedback(page)).not.toBeFocused();
    release();
    await expect(parse(page)).toBeEnabled();
    await expect(apply(page)).toHaveCount(0);
    await expect(original(page)).toHaveValue(inputText);
    expect(draftPosts(calls)).toHaveLength(1);
    expect(taskPosts(calls)).toHaveLength(0);
});

test('原文Enter保留换行，时区Enter选择预设且不生成草稿或保存', async ({ page }) => {
    const { calls } = await samples(page.context());
    await page.goto('/tasks/new');
    await original(page).fill('原文第一行');
    await original(page).press('End');
    await original(page).press('Enter');
    await original(page).pressSequentially('第二行');
    await expect(original(page)).toHaveValue('原文第一行\n第二行');
    expect(draftPosts(calls)).toHaveLength(0);
    await timezone(page).press('Enter');
    await page.getByRole('combobox', { name: '搜索需求时区' }).fill('Asia/Tokyo');
    await page.keyboard.press('Enter');
    await expect(timezone(page)).toContainText('Asia/Tokyo');
    expect(draftPosts(calls)).toHaveLength(0);
    await generateDraft(page);
    await expect(apply(page)).toBeEnabled();
    expect(draftPosts(calls)).toHaveLength(1);
    expect(taskPosts(calls)).toHaveLength(0);
});

test('离开解析页后迟到结果不会应用到新页面', async ({ page }) => {
    const { state, calls } = await samples(page.context());
    let release!: () => void;
    state.wait = new Promise<void>((resolve) => {
        release = resolve;
    });
    await page.goto('/tasks/new');
    await original(page).fill(inputText);
    await generateDraft(page);
    await expect.poll(() => draftPosts(calls).length).toBe(1);
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('link', { name: '返回任务列表', exact: true }).click();
    await expect(page).toHaveURL(/\/tasks$/);
    release();
    await expect(panel(page)).toHaveCount(0);
    await page.getByRole('main').getByRole('link', { name: '新建任务', exact: true }).click();
    await expect(original(page)).toHaveValue('');
    await expect(title(page)).toHaveValue('');
    await expect(apply(page)).toHaveCount(0);
    expect(taskPosts(calls)).toHaveLength(0);
});

test('空描述只显示简短提示；创建说明弹窗支持 Esc 和焦点返回', async ({ page }, info) => {
    const { calls } = await samples(page.context());
    await page.goto('/tasks/new');
    await expect(timezone(page)).toContainText('UTC');
    await generateDraft(page);
    await expect(panel(page)).toContainText('请先描述你想研究的内容。');
    await expect(panel(page)).not.toContainText('UTF-8');
    await expect(panel(page)).not.toContainText('接口约束');
    await expect(original(page)).toBeFocused();
    expect(draftPosts(calls)).toHaveLength(0);
    const help = panel(page).getByRole('button', { name: '如何创建任务' });
    await help.click();
    const modal = page.getByRole('dialog');
    await expect(modal).toContainText('两种方式最终创建的是同一种任务');
    await page.screenshot({ path: info.outputPath('draft-help.png'), animations: 'disabled' });
    await page.keyboard.press('Escape');
    await expect(modal).not.toBeVisible();
    await expect(help).toBeFocused();
});
