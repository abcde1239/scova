import { chooseOption, chooseOutputFormats, chooseTimezone } from './support/select.ts';
import { fillList } from './support/list-input.ts';
import { expect, test, type Page } from '@playwright/test';
import type { taskInput } from '../../apps/web/src/composable/useCreateTask.ts';
type CreateTaskInput = ReturnType<typeof taskInput>;

// Explicit local contract samples, not production accounts or backend evidence.
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const account = {
    user: {
        id: id(1),
        email: 'task-create@example.test',
        preferences: {
            defaultTimezone: 'UTC',
            notificationPreference: { mode: 'summary', runIssues: true },
        },
        createdAt: '2026-10-31T00:00:00Z',
    },
    csrfToken: 'sample-csrf',
};
const title = '持续跟踪跨地区招生政策与学术研究观点的变化，并保留可核验来源证据';
const startedRunId = id(13);
const taskApiPath = `/api/v1/tasks/${id(11)}`;
async function samples(page: Page, loseStartResponse = false) {
    const calls: {
        path: string;
        method: string;
        body?: CreateTaskInput;
        rawBody?: string;
        key?: string;
    }[] = [];
    let saved: CreateTaskInput | undefined;
    let queued = false;
    let startReceipt: { key?: string; rawBody?: string } | undefined;
    function queuedRun() {
        const { task, version } = detail();
        return {
            id: startedRunId,
            taskId: task.id,
            taskVersionId: version.id,
            parentRunId: null,
            baselineRunId: null,
            mode: 'live',
            status: 'queued',
            outcome: null,
            trigger: 'manual',
            budget: version.config.budget,
            usage: { searches: 0, pages: 0, inputTokens: 0, outputTokens: 0, estimated: true },
            coverage: null,
            queuedAt: version.createdAt,
            startedAt: null,
            finishedAt: null,
            failureCode: null,
        };
    }
    function detail() {
        const config = saved!.config;
        return {
            task: {
                id: id(11),
                title: config.title,
                status: 'active',
                revision: 1,
                currentVersionId: id(12),
                nextRunAt: null,
                createdAt: '2026-10-31T00:00:00Z',
                updatedAt: '2026-10-31T00:00:00Z',
            },
            version: {
                id: id(12),
                taskId: id(11),
                version: 1,
                configSchemaVersion: 1,
                config,
                comparisonScopeHash: 'a'.repeat(64),
                createdAt: '2026-10-31T00:00:00Z',
            },
            baselineResetRequired: false,
        };
    }
    await page.route('**/api/v1/me', (route) => route.fulfill({ json: account }));
    await page.route('**/api/v1/me/agent-providers', (route) =>
        route.fulfill({
            json: {
                items: [
                    {
                        id: id(901),
                        name: '研究模型（示例）',
                        protocol: 'openai_json',
                        baseUrl: 'https://example.test/v1',
                        model: 'research-example',
                        hasApiKey: true,
                        active: true,
                        draftActive: true,
                        revision: 1,
                        updatedAt: '2026-10-31T00:00:00Z',
                    },
                ],
                systemConfigured: false,
                storageReady: true,
            },
        }),
    );
    await page.route(/\/api\/v1\/(?:tasks|projects)(?:[/?]|$)/, async (route) => {
        const request = route.request();
        const { pathname } = new URL(request.url());
        const method = request.method();
        const rawBody = request.postData() ?? undefined;
        const body = rawBody ? (request.postDataJSON() as CreateTaskInput) : undefined;
        const key = request.headers()['idempotency-key'];
        calls.push({ path: pathname, method, body, rawBody, key });

        if (method === 'POST' && pathname === '/api/v1/tasks/start') {
            if (!startReceipt) {
                saved = body;
                queued = true;
                startReceipt = { key, rawBody };
                // The fixture saves the task and queues the run before it loses the first reply.
                if (loseStartResponse) return route.abort('connectionreset');
            } else if (key !== startReceipt.key || rawBody !== startReceipt.rawBody) {
                return route.fulfill({
                    status: 409,
                    json: {
                        code: 'REPLAY_MISMATCH',
                        message: '请求与首次提交不一致',
                        requestId: 'sample',
                    },
                });
            }
            return route.fulfill({ status: 201, json: { detail: detail(), runId: startedRunId } });
        }
        if (method === 'POST' && pathname === '/api/v1/tasks') {
            saved = body;
            return route.fulfill({ status: 201, json: detail() });
        }
        if (pathname === taskApiPath + '/runs' && method === 'POST' && saved) {
            queued = true;
            return route.fulfill({ status: 202, json: { run: queuedRun(), reused: false } });
        }
        if (method !== 'GET') return route.fallback();
        if (pathname === taskApiPath + '/runs')
            return route.fulfill({
                json: { items: queued ? [queuedRun()] : [], nextCursor: null },
            });
        if (pathname === taskApiPath + '/project')
            return route.fulfill({ json: { project: null } });
        if (pathname === '/api/v1/tasks')
            return route.fulfill({
                json: { items: saved ? [detail().task] : [], nextCursor: null },
            });
        if (pathname === taskApiPath && saved) return route.fulfill({ json: detail() });
        return route.fallback();
    });
    await page.route('**/api/v1/runs/' + startedRunId, (route) =>
        queued ? route.fulfill({ json: queuedRun() }) : route.fallback(),
    );
    await page.route('**/api/v1/runs/' + startedRunId + '/events**', (route) =>
        route.fulfill({ contentType: 'text/event-stream', body: ': local sample\n\n' }),
    );
    return calls;
}
async function fillMain(page: Page) {
    await page.getByLabel('任务标题', { exact: true }).fill(title);
    await page.getByLabel('查阅主题', { exact: true }).fill('各地高校招生政策');
    await page.getByLabel('查阅目标', { exact: true }).fill('比较变化并保留官方证据');
}
async function noOverflow(page: Page) {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
    );
}
test('资料收集方式保存到配置且任务显示已启用', async ({ page }) => {
    const calls = await samples(page);
    await page.goto('/tasks/new');
    await fillMain(page);
    await page.getByRole('radio', { name: /^资料采集/ }).check();
    await chooseOption(page, '输出形式', '主题清单');
    await page.getByRole('button', { name: '确认保存任务', exact: true }).click();
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
    const saved = calls.find((call) => call.method === 'POST')?.body;
    expect(saved?.config).toMatchObject({ researchMode: 'collection', outputFormat: 'list' });
    await expect(page.locator('.task-card')).toContainText('已启用');
    await expect(page.getByRole('group', { name: '本次输出形式', exact: true })).toHaveCount(0);
    await expect(page.getByLabel('本次搜索方式', { exact: true })).toContainText(
        '沿用任务搜索方式',
    );
});

test('任务保存多种采集目标，最后一个必选成果不能取消', async ({ page }) => {
    const calls = await samples(page);
    await page.goto('/tasks/new');
    await fillMain(page);
    await chooseOutputFormats(page, '输出形式', ['简报', '对比表']);
    await chooseOption(page, '搜索方式', 'Search API／自定义搜索（沿用账号读取方式）');
    const group = page.getByRole('group', { name: '输出形式', exact: true });
    await expect(group).toContainText('核心答案与重要发现');
    await expect(group).toContainText('共同维度与差异依据');
    await page.getByRole('button', { name: '确认保存任务', exact: true }).click();
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
    expect(calls.find((call) => call.method === 'POST')?.body?.config).toMatchObject({
        outputFormat: 'brief',
        outputFormats: ['brief', 'comparison'],
        searchMode: 'api',
    });
    await page.goto('/tasks/new');
    const brief = page
        .getByRole('group', { name: '输出形式', exact: true })
        .getByRole('checkbox', { name: /^简报/ });
    await brief.click();
    await expect(brief).toBeChecked();
});

for (const width of [320, 390, 1440]) {
    test(`Naive日历${width}：选择日期、清空与时分选择，预算说明按需打开`, async ({
        page,
    }, info) => {
        await samples(page);
        await page.setViewportSize({ width, height: 1000 });
        await page.goto('/tasks/new');
        await chooseOption(page, '查阅时间范围', '固定范围');
        const start = page.getByLabel('开始时间', { exact: true });
        await start.click();
        const calendar = page.locator('.n-date-panel').filter({ visible: true });
        await expect(calendar).toBeVisible();
        const box = await calendar.boundingBox();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(width);
        await calendar
            .locator(
                '.n-date-panel-date:not(.n-date-panel-date--excluded):not(.n-date-panel-date--disabled)',
            )
            .filter({ hasText: /^15$/ })
            .click();
        await calendar.getByRole('button', { name: '确认', exact: true }).click();
        await expect(start).not.toHaveValue('');
        await start.fill('');
        await start.press('Tab');
        await expect(start).toHaveValue('');
        await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
        await start.click();
        const doubledBox = await calendar.boundingBox();
        expect(doubledBox!.x).toBeGreaterThanOrEqual(0);
        expect(doubledBox!.x + doubledBox!.width).toBeLessThanOrEqual(width);
        const cells = await calendar.locator('.n-date-panel-date').evaluateAll((items) =>
            items.map((item) => {
                const rect = item.getBoundingClientRect();
                return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
            }),
        );
        expect(cells[1]!.x).toBeGreaterThanOrEqual(cells[0]!.x + cells[0]!.width);
        expect(cells[7]!.y).toBeGreaterThanOrEqual(cells[0]!.y + cells[0]!.height);
        const monthTitle = await calendar.locator('.n-date-panel-month__month-year').boundingBox();
        expect(monthTitle!.x).toBeGreaterThanOrEqual(doubledBox!.x);
        expect(monthTitle!.x + monthTitle!.width).toBeLessThanOrEqual(
            doubledBox!.x + doubledBox!.width,
        );
        const monthText = await calendar.locator('.n-date-panel-month__text').innerText();
        await calendar.locator('.n-date-panel-month__next').click();
        await expect(calendar.locator('.n-date-panel-month__text')).not.toHaveText(monthText);
        await calendar.locator('.n-date-panel-month__prev').click();
        await expect(calendar.locator('.n-date-panel-month__text')).toHaveText(monthText);
        await calendar.getByRole('button', { name: '确认', exact: true }).scrollIntoViewIfNeeded();
        await calendar.screenshot({ path: info.outputPath(`calendar-${width}.png`) });
        await page.keyboard.press('Escape');
        await chooseOption(page, '计划频率', '每日');
        await page.getByLabel('执行当地时间', { exact: true }).click();
        const timePanel = page.locator('.n-time-picker-panel').filter({ visible: true });
        await expect(timePanel).toBeVisible();
        await timePanel
            .locator('.n-time-picker-col')
            .nth(0)
            .getByText('09', { exact: true })
            .click();
        await timePanel
            .locator('.n-time-picker-col')
            .nth(1)
            .getByText('15', { exact: true })
            .click();
        await timePanel.getByRole('button', { name: '确认', exact: true }).click();
        await expect(page.getByLabel('执行当地时间', { exact: true })).toHaveValue('09:15');
        await expect(page.getByRole('region', { name: 'Token 分配测算' })).toHaveCount(0);
        await page.getByRole('button', { name: '查看预算说明', exact: true }).click();
        const modal = page.getByRole('dialog', { name: '执行预算与 Token 分配' });
        await expect(modal.getByRole('table')).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(modal).not.toBeVisible();
    });
}

for (const width of [390, 1440]) {
    test(`Token 预算即时分配、超额阻止保存、修正后可保存 ${width}`, async ({ page }, info) => {
        const calls = await samples(page);
        await page.setViewportSize({ width, height: 1000 });
        await page.goto('/tasks/new');
        await fillMain(page);
        const preview = page.getByRole('region', { name: 'Token 分配测算', exact: true });
        const help = page.getByRole('button', { name: '查看预算说明', exact: true });
        const inspect = async (check: () => Promise<unknown>) => {
            await help.click();
            await expect(page.getByRole('dialog', { name: '执行预算与 Token 分配' })).toBeVisible();
            await check();
            await page.keyboard.press('Escape');
            await expect(preview).not.toBeVisible();
            await expect(help).toBeFocused();
        };
        await expect(preview).toHaveCount(0);
        await inspect(() => expect(preview).toContainText('网页读取次数降至 15 页以内'));
        await page.getByLabel('网页读取次数上限', { exact: true }).fill('10');
        await inspect(() => expect(preview).not.toContainText('比较额度偏紧'));
        await page.getByLabel('累计输出 token 上限', { exact: true }).fill('64000');
        await inspect(() => expect(preview).toContainText('网页读取次数降至 7 页以内'));
        await page.getByLabel('累计输出 token 上限', { exact: true }).fill('128000');
        await inspect(async () => {
            await expect(preview.locator('.token-output-total')).toHaveText(
                '分配合计 127,999 / 128,000；未分配 1 token。',
            );
            await expect(
                preview.getByRole('row', { name: '来源比较 31,996 31,997', exact: true }),
            ).toBeVisible();
        });
        await page.getByLabel('累计输出 token 上限', { exact: true }).fill('1');
        await inspect(() => expect(preview.getByRole('alert')).toContainText('输出总额不足'));
        await page.getByRole('button', { name: '确认保存任务', exact: true }).click();
        await expect(page.getByLabel('累计输出 token 上限', { exact: true })).toBeFocused();
        expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
        await page.getByLabel('累计输出 token 上限', { exact: true }).fill('8000');
        await inspect(() =>
            expect(preview.locator('.token-output-total')).toHaveText(
                '分配合计 7,999 / 8,000；未分配 1 token。',
            ),
        );
        await page.getByLabel('累计输入 token 上限', { exact: true }).fill('');
        await inspect(() => expect(preview).toContainText('请填写有效的正整数'));
        await page.getByRole('button', { name: '确认保存任务', exact: true }).click();
        expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
        await page.getByLabel('累计输入 token 上限', { exact: true }).fill('40000');
        for (const size of ['100%', '200%']) {
            await page.evaluate((value) => {
                document.documentElement.style.fontSize = value;
            }, size);
            await noOverflow(page);
            await inspect(() => expect(preview.getByRole('table')).toBeVisible());
        }
        await inspect(() =>
            preview.screenshot({ path: info.outputPath(`token-budget-${width}.png`) }),
        );
        await page.getByRole('button', { name: '确认保存任务', exact: true }).click();
        await expect(page).toHaveURL(new RegExp(`/tasks/${id(11)}$`));
        expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
        expect(calls.find((c) => c.method === 'POST')?.body?.config.budget).toMatchObject({
            maxOutputTokens: 8000,
            maxInputTokens: 40000,
            maxPages: 10,
        });
    });
}
for (const width of [1440, 320]) {
    test(`输出布局示例：四种形式、文字入口、键盘关闭且不修改任务 ${width}`, async ({
        page,
    }, info) => {
        const calls = await samples(page);
        await page.setViewportSize({ width, height: 1000 });
        if (width === 320)
            await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
        await page.goto('/tasks/new');
        const output = page.getByRole('group', { name: '输出形式', exact: true });
        await expect(output.getByRole('checkbox')).toHaveCount(4);
        const originalOutput = await output
            .getByRole('checkbox')
            .evaluateAll((elements) =>
                elements.map((element) => (element as HTMLInputElement).checked),
            );
        if (width === 320)
            await page.evaluate(() => {
                document.documentElement.style.fontSize = '200%';
            });
        const trigger = page.getByRole('button', { name: '查看输出示例', exact: true });
        await expect(trigger).toHaveClass(/scova-action--text/);
        await trigger.press('Enter');
        const dialog = page.getByRole('dialog');
        await expect(dialog).toContainText('虚构内容');
        for (const [label, heading] of [
            ['简报', '两馆预约要求不同，均需读者证'],
            ['主题清单', '甲馆'],
            ['对比', '两馆的共同维度'],
            ['研究报告', '预约与开放安排'],
        ]) {
            const choice = dialog.getByRole('button', { name: label, exact: true });
            await choice.press('Enter');
            await expect(choice).toHaveAttribute('aria-pressed', 'true');
            await expect(
                dialog.getByRole(label === '对比' ? 'table' : 'heading', {
                    name: heading,
                    exact: true,
                }),
            ).toBeVisible();
            await expect(
                dialog.getByRole('heading', { name: '来源与引用', exact: true }),
            ).toBeVisible();
            await noOverflow(page);
            const sample = dialog.getByRole('article');
            await expect(sample.locator('footer p')).toHaveText([
                '[1] 虚构来源：甲馆开放说明',
                '[2] 虚构来源：乙馆预约说明',
            ]);
            await expect(sample).not.toContainText('待核实');
            await expect(sample).toContainText('免费');
            expect(await sample.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
            expect(await sample.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
                width === 320 ? 'rgb(25, 31, 38)' : 'rgb(255, 255, 255)',
            );
            await page.screenshot({
                path: info.outputPath(`output-${label}-${width}.png`),
                animations: 'disabled',
            });
        }
        await page.keyboard.press('Escape');
        await expect(dialog).not.toBeVisible();
        await expect(trigger).toBeFocused();
        expect(
            await output
                .getByRole('checkbox')
                .evaluateAll((elements) =>
                    elements.map((element) => (element as HTMLInputElement).checked),
                ),
        ).toEqual(originalOutput);
        expect(calls.filter((call) => call.method !== 'GET')).toHaveLength(0);
    });
}
for (const width of [320, 390, 768, 1024, 1440, 1920]) {
    test(`本地手工任务样本${width}：完整配置、200%文字、确认保存不运行`, async ({
        page,
    }, testInfo) => {
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        const calls = await samples(page);
        await page.setViewportSize({ width, height: 1000 });
        await page.goto('/tasks');
        await expect(page.getByRole('status')).toContainText('没有匹配的任务');
        await page.getByRole('link', { name: '新建任务', exact: true }).click();
        await expect(page).toHaveURL(/\/tasks\/new$/);
        await fillMain(page);
        await page.getByText('关注范围与来源偏好', { exact: true }).click();
        await fillList(page, '重点关注（可选）', ['资格', '费用']);
        await fillList(page, '排除主题或条件（可选）', ['商业广告']);
        await fillList(page, '优先来源网址（可选）', ['https://example.test/admission']);
        await fillList(page, '排除来源网址（可选）', ['https://example.test/ads']);
        await page.getByLabel('仅查阅官方来源', { exact: true }).check();
        await chooseOption(page, '输出形式', '对比表');
        await page.getByLabel('搜索次数上限', { exact: true }).fill('3');
        await page.getByLabel('网页读取次数上限', { exact: true }).fill('4');
        await page.getByLabel('执行时长上限（秒）', { exact: true }).fill('60');
        await page.getByLabel('累计输入 token 上限', { exact: true }).fill('1000');
        await page.getByLabel('累计输出 token 上限', { exact: true }).fill('500');
        await chooseTimezone(page, 'Asia/Shanghai', '任务时区');
        await chooseOption(page, '结果提醒', '仅重要变化');
        await page.getByLabel('提醒失败或不完整执行', { exact: true }).uncheck();
        await noOverflow(page);
        await chooseOption(page, '查阅时间范围', '固定范围');
        await page.getByLabel('开始时间', { exact: true }).fill('2026-10-01 09:00:00.000');
        await page.getByLabel('结束时间', { exact: true }).fill('2026-10-30 17:00:00.000');
        for (const doubled of [false, true]) {
            if (doubled)
                await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
            await noOverflow(page);
            const manageAgent = page.getByRole('link', { name: '管理 Agent 配置', exact: true });
            expect(
                await page.locator('.task-execution-settings').evaluate((group) => {
                    const search = group.querySelector('[aria-label="搜索方式"]')!;
                    const footer = group.querySelector('.execution-settings-footer')!;
                    return (
                        footer.getBoundingClientRect().top >= search.getBoundingClientRect().bottom
                    );
                }),
            ).toBe(true);
            await manageAgent.hover();
            expect(
                await manageAgent.evaluate((link) => ({
                    background: getComputedStyle(link).backgroundColor,
                    align: getComputedStyle(link).justifySelf,
                    height: link.getBoundingClientRect().height,
                    width: link.getBoundingClientRect().width,
                    container: link.parentElement!.getBoundingClientRect().width,
                })),
            ).toMatchObject({ background: 'rgba(0, 0, 0, 0)', align: 'start' });
            await expect(manageAgent.locator('.app-icon')).toHaveCount(1);
            if (width >= 768)
                expect(
                    await manageAgent.evaluate(
                        (link) =>
                            link.getBoundingClientRect().width <
                            link.parentElement!.getBoundingClientRect().width - 24,
                    ),
                ).toBe(true);
            await page.keyboard.press('Tab');
            await manageAgent.focus();
            expect(await manageAgent.evaluate((link) => getComputedStyle(link).outlineStyle)).toBe(
                'solid',
            );
            if (!doubled) {
                await page.getByLabel('任务标题', { exact: true }).focus();
                await page.mouse.move(0, 0);
                await page.locator('.task-execution-settings').screenshot({
                    path: `artifacts/link-navigation-refinement/internal-${width}.png`,
                });
            }
            for (const label of ['开始时间', '结束时间']) {
                expect(
                    await page.getByLabel(label, { exact: true }).evaluate((input) => {
                        const bounds = input.getBoundingClientRect();
                        return bounds.left >= 0 && bounds.right <= innerWidth;
                    }),
                ).toBe(true);
            }
            expect(
                await page
                    .getByLabel('任务标题', { exact: true })
                    .evaluate(
                        (input) =>
                            input.clientHeight >=
                            parseFloat(getComputedStyle(input).fontSize) * 1.5,
                    ),
            ).toBe(true);
            await page
                .getByRole('button', { name: '确认保存任务', exact: true })
                .scrollIntoViewIfNeeded();
            await expect(
                page.getByRole('button', { name: '确认保存任务', exact: true }),
            ).toBeVisible();
            await page.getByLabel('任务标题', { exact: true }).scrollIntoViewIfNeeded();
            await testInfo.attach(`${width}-${doubled ? 'double' : 'normal'}`, {
                body: await page.screenshot({
                    path: testInfo.outputPath(`${doubled ? 'double' : 'normal'}.png`),
                    fullPage: true,
                }),
                contentType: 'image/png',
            });
        }
        const save = page.getByRole('button', { name: '确认保存任务', exact: true });
        await save.focus();
        await save.press('Enter');
        await expect(page).toHaveURL(new RegExp(`/tasks/${id(11)}`));
        await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
        await expect(page.getByText('尚无执行', { exact: true })).toBeVisible();
        const posts = calls.filter((call) => call.method === 'POST');
        expect(posts).toHaveLength(1);
        expect(posts[0]!.path).toBe('/api/v1/tasks');
        expect(posts[0]!.key).toBeTruthy();
        expect(posts[0]!.body?.config).toMatchObject({
            schedule: { frequency: 'manual' },
            sourcePreferences: { officialOnly: true },
            focusPoints: ['资格', '费用'],
            timezone: 'Asia/Shanghai',
            budget: {
                maxSearches: 3,
                maxPages: 4,
                maxDurationSeconds: 60,
                maxInputTokens: 1000,
                maxOutputTokens: 500,
            },
            notificationPreference: { mode: 'important_change', runIssues: false },
            outputFormat: 'comparison',
            timeRange: { kind: 'fixed' },
        });
        expect(
            calls.filter((call) => call.method === 'POST' && call.path.includes('/runs')),
        ).toEqual([]);
        await page
            .getByRole('navigation', { name: '面包屑导航' })
            .getByRole('link', { name: '任务', exact: true })
            .click();
        await expect(page.getByRole('link', { name: title, exact: true })).toBeVisible();
        expect(errors).toEqual([]);
    });
}

test('列表逐项新增删除与键盘操作，不拆分项内内容', async ({ page }) => {
    const calls = await samples(page);
    await page.goto('/tasks/new');
    await fillMain(page);
    await page.getByText('关注范围与来源偏好', { exact: true }).click();
    await fillList(page, '重点关注（可选）', ['关键词，资格\n费用', '保留这项']);
    const group = page.getByRole('region', { name: '重点关注（可选）', exact: true });
    await group.getByRole('textbox').first().press('Enter');
    await expect(group.getByRole('textbox')).toHaveCount(3);
    await expect(group.getByRole('textbox').nth(1)).toBeFocused();
    await group.getByRole('textbox').nth(1).fill('新增项目');
    await group.getByRole('button', { name: '删除重点关注（可选） 2', exact: true }).click();
    await expect(group.getByRole('textbox').first()).toHaveValue('关键词，资格\n费用');
    await expect(group.getByRole('textbox').nth(1)).toHaveValue('保留这项');
    await expect(group.getByRole('textbox').nth(1)).toBeFocused();
    await fillList(page, '排除主题或条件（可选）', ['临时项']);
    const exclusions = page.getByRole('region', { name: '排除主题或条件（可选）', exact: true });
    await exclusions.getByRole('button', { name: /^删除/ }).click();
    await expect(
        exclusions.getByRole('button', { name: '添加排除条件', exact: true }),
    ).toBeFocused();
    await page.getByRole('button', { name: '确认保存任务', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/tasks/${id(11)}$`));
    const saved = calls.find((call) => call.method === 'POST')!.body!;
    expect(saved.config.focusPoints).toEqual(['关键词，资格\n费用', '保留这项']);
    expect(saved.config.exclusions).toEqual([]);
});

test('字段错误聚焦、来源校验、固定日期与失败保留重试', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 1000 });
    const calls = await samples(page);
    await page.goto('/tasks/new');
    await page.getByRole('button', { name: '确认保存任务', exact: true }).click();
    await expect(page.getByLabel('任务标题', { exact: true })).toBeFocused();
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0);
    await fillMain(page);
    await page.getByText('关注范围与来源偏好', { exact: true }).click();
    await fillList(page, '优先来源网址（可选）', ['ftp://bad.test']);
    await page.getByRole('button', { name: '确认保存任务', exact: true }).click();
    await expect(page.getByLabel('优先来源网址（可选） 1', { exact: true })).toBeFocused();
    await noOverflow(page);
    await page.screenshot({ path: testInfo.outputPath('source-error-390.png'), fullPage: true });
    await fillList(page, '优先来源网址（可选）', ['https://example.test']);
    await chooseOption(page, '查阅时间范围', '固定范围');
    await page.getByLabel('开始时间', { exact: true }).fill('2026-10-31 08:00:00.000');
    await page.getByLabel('结束时间', { exact: true }).fill('2026-10-30 08:00:00.000');
    await page.getByRole('button', { name: '确认保存任务', exact: true }).click();
    await expect(page.getByLabel('结束时间', { exact: true })).toBeFocused();
    await page.getByLabel('结束时间', { exact: true }).fill('2026-11-01 08:00:00.000');
    let attempt = 0;
    const keys: string[] = [];
    await page.route('**/api/v1/tasks', async (route) => {
        if (route.request().method() !== 'POST') return route.fallback();
        attempt++;
        keys.push(route.request().headers()['idempotency-key']!);
        if (attempt === 1)
            return route.fulfill({
                status: 422,
                json: {
                    code: 'LIMIT',
                    message: '部署上限',
                    requestId: 'sample',
                    fieldErrors: [
                        { path: '/config/budget/maxSearches', message: '部署预算上限为10' },
                    ],
                },
            });
        return route.fallback();
    });
    await page.getByRole('button', { name: '确认保存任务', exact: true }).click();
    await expect(page.getByLabel('搜索次数上限', { exact: true })).toBeFocused();
    await expect(page.getByLabel('任务标题', { exact: true })).toHaveValue(title);
    await page.getByRole('button', { name: '确认保存任务', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/tasks/${id(11)}`));
    expect(keys[1]).toBe(keys[0]);
});

test('未保存离开可取消，确认后放弃；重进不泄露草稿', async ({ page }) => {
    await samples(page);
    await page.goto('/tasks/new');
    await fillMain(page);
    page.once('dialog', (dialog) => dialog.dismiss());
    await page.getByRole('link', { name: '返回任务列表', exact: true }).click();
    await expect(page).toHaveURL(/\/tasks\/new$/);
    await expect(page.getByLabel('任务标题', { exact: true })).toHaveValue(title);
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('link', { name: '返回任务列表', exact: true }).click();
    await expect(page).toHaveURL(/\/tasks$/);
    await page.getByRole('link', { name: '新建任务', exact: true }).click();
    await expect(page.getByLabel('任务标题', { exact: true })).toHaveValue('');
});

test('在途双击只一次，不确定结果不能直接重发', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 320, height: 1000 });
    await samples(page);
    let count = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    await page.route('**/api/v1/tasks', async (route) => {
        if (route.request().method() !== 'POST') return route.fallback();
        count++;
        await gate;
        return route.fulfill({
            status: 503,
            json: { code: 'FAIL', message: '样例', requestId: 'sample' },
        });
    });
    await page.goto('/tasks/new');
    await fillMain(page);
    await page.getByRole('button', { name: '确认保存任务', exact: true }).dblclick();
    await expect(page.getByRole('button', { name: '正在保存', exact: true })).toHaveAttribute(
        'aria-busy',
        'true',
    );
    expect(count).toBe(1);
    release();
    await expect(page.locator('.scova-notifications .n-notification').last()).toContainText('核对');
    await expect(page.getByRole('button', { name: '确认保存任务', exact: true })).toBeDisabled();
    await expect(page.getByLabel('任务标题', { exact: true })).toHaveValue(title);
    await expect(page.locator('.scova-notifications .n-notification').last()).not.toBeFocused();
    await noOverflow(page);
    await page.screenshot({ path: testInfo.outputPath('uncertain-320.png'), fullPage: true });
    expect(count).toBe(1);
});

for (const loseStartResponse of [false, true]) {
    test(
        loseStartResponse
            ? '独立任务开跑响应丢失后，以相同幂等键和请求体重放'
            : '独立任务保存并立即运行，直接打开排队中的执行',
        async ({ page }) => {
            const calls = await samples(page, loseStartResponse);
            const writes = () => calls.filter(({ method }) => method !== 'GET');
            await page.goto('/tasks/new');
            await fillMain(page);
            const start = page.getByRole('button', { name: '保存并立即运行', exact: true });
            await start.click();

            if (loseStartResponse) {
                const retry = page.getByRole('button', { name: '重试同一次提交', exact: true });
                await expect(retry).toBeVisible();
                await expect(page).toHaveURL('/tasks/new');
                const titleInput = page.getByLabel('任务标题', { exact: true });
                await expect(titleInput).toHaveValue(title);
                await expect(titleInput).toBeDisabled();
                await expect(start).toHaveCount(0);
                await expect(
                    page.getByRole('button', { name: '确认保存任务', exact: true }),
                ).toBeDisabled();
                expect(writes()).toHaveLength(1);
                await retry.click();
            }

            await expect(page).toHaveURL('/runs/' + startedRunId);
            await expect(
                page.getByRole('heading', { name: '等待执行', exact: true }),
            ).toBeVisible();
            const attempts = writes();
            expect(attempts).toHaveLength(loseStartResponse ? 2 : 1);
            expect(attempts[0]).toMatchObject({
                path: '/api/v1/tasks/start',
                method: 'POST',
                key: expect.stringMatching(/\S/),
                body: {
                    config: { title, topic: '各地高校招生政策', goal: '比较变化并保留官方证据' },
                },
            });
            if (loseStartResponse) expect(attempts[1]).toEqual(attempts[0]);
        },
    );
}

test('独立任务只保存时保持未归类，任务摘要仍可手动运行', async ({ page }) => {
    const calls = await samples(page);
    const writes = () => calls.filter(({ method }) => method !== 'GET');
    await page.goto('/tasks/new');
    await fillMain(page);
    await page.getByRole('button', { name: '确认保存任务', exact: true }).click();
    await expect(page).toHaveURL('/tasks/' + id(11));
    const classification = page.getByRole('region', { name: '项目归类' });
    await expect(classification.getByText('未归类', { exact: true })).toBeVisible();
    expect(writes().map(({ method, path }) => ({ method, path }))).toEqual([
        { method: 'POST', path: '/api/v1/tasks' },
    ]);

    const controls = page.getByRole('region', { name: '立即执行' });
    await controls.getByRole('button', { name: '立即执行', exact: true }).click();
    await expect(controls.getByRole('link', { name: '查看执行', exact: true })).toHaveAttribute(
        'href',
        '/runs/' + startedRunId,
    );
    await expect(classification.getByText('未归类', { exact: true })).toBeVisible();
    const requests = writes();
    expect(requests.map(({ method, path }) => ({ method, path }))).toEqual([
        { method: 'POST', path: '/api/v1/tasks' },
        { method: 'POST', path: '/api/v1/tasks/' + id(11) + '/runs' },
    ]);
    expect(requests[1]?.body).toEqual({ mode: 'live' });
});
