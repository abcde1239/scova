import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import type { TaskDraftResponse } from '../../packages/models/src/task-drafts.ts';
import type { taskInput } from '../../apps/web/src/composables/useCreateTask.ts';

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
        start: '2026-10-01T03:04:05.123456Z',
        end: '2026-10-30T04:05:06.456789Z',
    },
    timezone: 'Asia/Shanghai',
    schedule: { frequency: 'weekly', weekday: 3, localTime: '09:15' },
    outputFormat: 'comparison',
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
        const body: unknown = request.method() === 'POST' ? request.postDataJSON() : null;
        calls.push({
            method: request.method(),
            path,
            body,
            csrf: request.headers()['x-csrf-token'],
            key: request.headers()['idempotency-key'],
        });
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
                config: structuredClone(parsed),
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
        return route.fulfill({ headers: { etag: '"1"' }, json: detail() });
    });
    return { calls, state };
}
const panel = (page: Page) => page.getByRole('region', { name: '从描述生成草稿' });
const original = (page: Page) => page.getByLabel('原始需求描述', { exact: true });
const timezone = (page: Page) => page.getByLabel('解析时区（可选，IANA）', { exact: true });
const title = (page: Page) => page.getByLabel('任务标题', { exact: true });
const parse = (page: Page) => panel(page).getByRole('button', { name: '解析为草稿', exact: true });
const apply = (page: Page) =>
    panel(page).getByRole('button', { name: '应用草稿并替换当前配置', exact: true });
const feedback = (page: Page) => panel(page).getByRole('status');
const taskPosts = (calls: Awaited<ReturnType<typeof samples>>['calls']) =>
    calls.filter((call) => call.method === 'POST' && call.path !== '/api/v1/task-drafts');
const draftPosts = (calls: Awaited<ReturnType<typeof samples>>['calls']) =>
    calls.filter((call) => call.method === 'POST' && call.path === '/api/v1/task-drafts');
async function noOverflow(page: Page) {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
    );
    for (const target of await panel(page).locator('input,textarea,button').all()) {
        if (!(await target.isVisible())) continue;
        const bounds = await target.boundingBox();
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
        await timezone(page).fill('Asia/Tokyo');
        await parse(page).focus();
        await parse(page).press('Enter');
        await expect(apply(page)).toBeEnabled();
        await expect(feedback(page)).toBeFocused();
        await expect(title(page)).toHaveValue('原有手工配置');
        await expect(page.getByLabel('搜索次数上限', { exact: true })).toHaveValue('1');
        await expect(original(page)).toHaveValue(inputText);
        await expect(
            panel(page).getByRole('heading', {
                name: state.mode === 'model' ? '模型解析草稿' : '手工编辑草稿',
                exact: true,
            }),
        ).toBeVisible();
        await expect(panel(page).getByRole('list', { name: '解析警告' })).toContainText(
            '周期计划待确认',
        );
        await expect(panel(page).getByRole('list', { name: '解析警告' })).toContainText(
            '请检查独立单次执行预算',
        );
        const usage = panel(page).getByRole('region', { name: '独立解析用量' });
        await expect(usage).toContainText(`模型调用 ${state.mode === 'model' ? 2 : 0} 次`);
        await expect(usage).toContainText('不计入任何 Run 预算');
        if (state.mode === 'manual') await expect(panel(page)).toContainText('未使用演示研究资料');
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
        await expect(page.getByLabel('保留解析建议的周期计划', { exact: true })).toBeChecked();
        await expect(page.getByLabel('开始时间', { exact: true })).toHaveValue(
            '2026-10-01T12:04:05.123',
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
            await page.getByLabel('保留解析建议的周期计划', { exact: true }).uncheck();
            await expect(schedule).toContainText('本次保存将明确改为仅手动执行');
            await schedule.scrollIntoViewIfNeeded();
            await info.attach('320-explicit-manual-text-200', {
                body: await page.screenshot({
                    path: info.outputPath('explicit-manual-text-200.png'),
                }),
                contentType: 'image/png',
            });
            await page.getByLabel('保留解析建议的周期计划', { exact: true }).check();
        }
        if (width === 390)
            await page.getByLabel('保留解析建议的周期计划', { exact: true }).uncheck();
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
        expect(draftPosts(calls)[0]!.body).toEqual({ inputText, timezone: 'Asia/Tokyo' });
        expect(draftPosts(calls)[0]!.csrf).toBe('sample-csrf');
        expect(draftPosts(calls)[0]!.key).toBeUndefined();
        expect(calls.some((call) => call.method === 'POST' && call.path.includes('/runs'))).toBe(
            false,
        );
    });
}

for (const status of [429, 408]) {
    test(`${status}保留原文与手工内容、允许继续填写且不重试`, async ({ page }, info) => {
        const { state, calls } = await samples(page.context());
        state.failure = status;
        await page.setViewportSize({ width: 320, height: 1000 });
        await page.goto('/tasks/new');
        await original(page).fill(inputText);
        await title(page).fill('解析失败前的手工标题');
        await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
        await parse(page).click();
        await expect(feedback(page)).toContainText(status === 429 ? '解析过于频繁' : '解析超时');
        await expect(feedback(page)).toBeFocused();
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
        await panel(page).getByRole('button', { name: '直接手工填写', exact: true }).click();
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
            await parse(page).click();
            await expect.poll(() => draftPosts(calls).length).toBe(1);
            if (timing === 'after') await expect(apply(page)).toBeEnabled();
            const edited =
                changed === 'text'
                    ? original(page)
                    : changed === 'form'
                      ? title(page)
                      : timezone(page);
            const newValue = changed === 'timezone' ? 'Asia/Tokyo' : '解析之后的新内容';
            await edited.fill(newValue);
            if (timing === 'during') release();
            await expect(apply(page)).toBeDisabled();
            await expect(panel(page)).toContainText('此结果不能覆盖当前配置');
            await expect(edited).toBeFocused();
            await expect(edited).toHaveValue(newValue);
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
            await parse(page).click();
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
    await parse(page).click();
    await expect(original(page)).toHaveAttribute('aria-invalid', 'true');
    await expect(original(page)).toBeFocused();
    await expect(original(page)).toHaveValue(excessive);
    expect(draftPosts(calls)).toHaveLength(0);
    const boundary = '中'.repeat(2000);
    expect(new TextEncoder().encode(boundary).byteLength).toBe(6000);
    await original(page).fill(boundary);
    await timezone(page).fill('Mars/Olympus');
    await parse(page).click();
    await expect(timezone(page)).toHaveAttribute('aria-invalid', 'true');
    await expect(timezone(page)).toBeFocused();
    expect(draftPosts(calls)).toHaveLength(0);
    await timezone(page).fill('');
    await parse(page).click();
    await expect(apply(page)).toBeEnabled();
    expect(draftPosts(calls)[0]!.body).toEqual({ inputText: boundary });
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
    await parse(page).dblclick();
    const pending = panel(page).getByRole('button', { name: '正在解析', exact: true });
    await expect(pending).toHaveAttribute('aria-busy', 'true');
    await pending.press('Enter');
    await pending.press('Space');
    await panel(page).getByRole('button', { name: '停止解析', exact: true }).click();
    await expect(feedback(page)).toContainText('解析已停止');
    await expect(feedback(page)).toBeFocused();
    release();
    await expect(parse(page)).toBeEnabled();
    await expect(apply(page)).toHaveCount(0);
    await expect(original(page)).toHaveValue(inputText);
    expect(draftPosts(calls)).toHaveLength(1);
    expect(taskPosts(calls)).toHaveLength(0);
});

test('原文Enter保留换行，时区Enter仅解析不触发表单保存', async ({ page }) => {
    const { calls } = await samples(page.context());
    await page.goto('/tasks/new');
    await original(page).fill('原文第一行');
    await original(page).press('End');
    await original(page).press('Enter');
    await original(page).pressSequentially('第二行');
    await expect(original(page)).toHaveValue('原文第一行\n第二行');
    expect(draftPosts(calls)).toHaveLength(0);
    await timezone(page).fill('Asia/Tokyo');
    await timezone(page).press('Enter');
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
    await parse(page).click();
    await expect.poll(() => draftPosts(calls).length).toBe(1);
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('link', { name: '返回任务列表', exact: true }).click();
    await expect(page).toHaveURL(/\/tasks$/);
    release();
    await expect(panel(page)).toHaveCount(0);
    await page.getByRole('link', { name: '新建任务', exact: true }).click();
    await expect(original(page)).toHaveValue('');
    await expect(title(page)).toHaveValue('');
    await expect(apply(page)).toHaveCount(0);
    expect(taskPosts(calls)).toHaveLength(0);
});
