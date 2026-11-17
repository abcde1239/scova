import { chooseOption, chooseTimezone } from './support/select.ts';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import type { taskInput } from '../../apps/web/src/composables/useCreateTask.ts';

test.use({ timezoneId: 'Asia/Tokyo' });
type TaskConfig = ReturnType<typeof taskInput>['config'];
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const taskId = id(11);
const instant = '2026-10-31T00:00:00Z';
const original: TaskConfig = {
    title: '持续跟踪招生政策与学术研究观点的变化',
    topic: '各地高校招生政策',
    goal: '比较变化并保留可核验来源证据',
    focusPoints: ['一项内的\n换行', '  保留空格  '],
    exclusions: ['排除\n一项'],
    sourcePreferences: {
        preferredUrls: ['https://example.test/policy'],
        excludedUrls: [],
        officialOnly: true,
    },
    timeRange: {
        kind: 'fixed',
        start: '2026-10-01T03:04:05.123456Z',
        end: '2026-10-30T04:05:06.456789Z',
    },
    timezone: 'America/New_York',
    schedule: { frequency: 'weekly', weekday: 7, localTime: '01:30' },
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

// Local HTTP samples only; real scheduling and DST algorithm verification belong to backend QA.
async function samples(context: BrowserContext) {
    const calls: { method: string; path: string; body?: { config: TaskConfig }; etag?: string }[] =
        [];
    const state = {
        config: structuredClone(original),
        revision: 1,
        failure: 0,
        nextRunAt: '2026-11-01T05:30:00Z' as string | null,
        status: 'active' as 'active' | 'paused' | 'archived',
        wait: undefined as Promise<void> | undefined,
    };
    function detail() {
        return {
            task: {
                id: taskId,
                title: state.config.title,
                status: state.status,
                revision: state.revision,
                currentVersionId: id(100 + state.revision),
                nextRunAt: state.nextRunAt,
                createdAt: instant,
                updatedAt: instant,
            },
            version: {
                id: id(100 + state.revision),
                taskId,
                version: state.revision,
                configSchemaVersion: 1,
                config: state.config,
                comparisonScopeHash: 'a'.repeat(64),
                createdAt: instant,
            },
            baselineResetRequired: false,
        };
    }
    await context.route('**/api/v1/me', (route) =>
        route.fulfill({
            json: {
                user: {
                    id: id(1),
                    email: 'schedule@example.test',
                    preferences: {
                        defaultTimezone: 'UTC',
                        notificationPreference: original.notificationPreference,
                    },
                    createdAt: instant,
                },
                csrfToken: 'sample-csrf',
            },
        }),
    );
    await context.route('**/api/v1/me/agent-providers', (route) =>
        route.fulfill({ json: { storageReady: true, systemConfigured: true, items: [] } }),
    );
    await context.route('**/api/v1/tasks**', async (route) => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        const writing = request.method() === 'POST' || request.method() === 'PATCH';
        const body = writing ? (request.postDataJSON() as { config: TaskConfig }) : undefined;
        calls.push({ method: request.method(), path, body, etag: request.headers()['if-match'] });
        if (writing) {
            if (state.wait) await state.wait;
            if (state.failure)
                return route.fulfill({
                    status: state.failure,
                    json: {
                        code: 'REVISION_CONFLICT',
                        message: 'local sample',
                        requestId: 'sample',
                    },
                });
            if (
                request.method() === 'PATCH' &&
                request.headers()['if-match'] !== `"${state.revision}"`
            )
                return route.fulfill({
                    status: 409,
                    json: {
                        code: 'REVISION_CONFLICT',
                        message: 'local sample',
                        requestId: 'sample',
                    },
                });
            state.config = body!.config;
            state.revision++;
            state.nextRunAt =
                state.config.schedule.frequency === 'manual'
                    ? null
                    : state.config.schedule.frequency === 'weekly'
                      ? '2026-11-01T17:30:00Z'
                      : '2026-11-02T17:30:00Z';
        }
        if (path.endsWith('/runs')) return route.fulfill({ json: { items: [], nextCursor: null } });
        if (path === '/api/v1/tasks' && !writing)
            return route.fulfill({ json: { items: [detail().task], nextCursor: null } });
        return route.fulfill({
            status: request.method() === 'POST' ? 201 : 200,
            headers: { etag: `"${state.revision}"`, 'access-control-expose-headers': 'ETag' },
            json: detail(),
        });
    });
    return { calls, state };
}
const fields = (page: Page) => page.getByRole('group', { name: '执行计划', exact: true });
const preview = (page: Page) => fields(page).getByRole('region', { name: '计划预览', exact: true });
const saved = (page: Page) =>
    fields(page).getByRole('region', { name: '服务端已保存的计划', exact: true });
const frequency = (page: Page) => page.getByLabel('计划频率', { exact: true });
const timezone = (page: Page) => page.getByLabel('任务时区', { exact: true });
const localTime = (page: Page) => page.getByLabel('执行当地时间', { exact: true });
const weekday = (page: Page) => page.getByLabel('每周执行星期', { exact: true });
const save = (page: Page) => page.getByRole('button', { name: '确认保存修改', exact: true });
const patches = (calls: Awaited<ReturnType<typeof samples>>['calls']) =>
    calls.filter((call) => call.method === 'PATCH');
async function noOverflow(page: Page) {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
    );
    for (const target of await fields(page).locator('input,button[aria-haspopup],summary').all()) {
        if (!(await target.isVisible())) continue;
        const box = await target.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
        expect(box!.height).toBeGreaterThanOrEqual(44);
    }
}

for (const width of [320, 390, 768, 1024, 1440, 1920]) {
    test(`本地计划样本${width}：已保存时区与草稿分离、DST规则和200%时间编辑`, async ({
        page,
    }, info) => {
        const { calls, state } = await samples(page.context());
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.setViewportSize({ width, height: 1000 });
        await page.goto(`/tasks/${taskId}/edit`);
        await expect(localTime(page)).toHaveValue('01:30');
        await expect(weekday(page)).toContainText('周日');
        await expect(saved(page)).toContainText('2026-11-01 01:30:00（America/New_York，GMT-4）');
        await expect(saved(page)).toContainText('2026-11-01T05:30:00.000Z');
        await expect(preview(page)).not.toContainText('当前填写内容尚未安排执行');
        await expect(
            preview(page).getByText('保存后生效；下次执行时间以已保存计划为准。'),
        ).toHaveCount(0);
        const kind = [320, 768, 1440].includes(width) ? 'daily' : 'weekly';
        await chooseOption(page, '计划频率', kind === 'weekly' ? '每周' : '每日');
        if (kind === 'weekly') await chooseOption(page, '每周执行星期', '周一');
        await chooseTimezone(page, 'Asia/Tokyo', '任务时区');
        await localTime(page).fill('02:30');
        await expect(localTime(page)).toHaveAttribute('type', 'text');
        await expect(localTime(page)).toBeEditable();
        expect(await localTime(page).evaluate((element) => getComputedStyle(element).cursor)).toBe(
            'text',
        );
        await expect(preview(page)).toContainText('任务时区 Asia/Tokyo');
        await expect(saved(page)).toContainText('有未保存修改');
        await expect(saved(page)).not.toContainText('Asia/Tokyo');
        await expect(saved(page)).toContainText('2026-11-01T05:30:00.000Z');
        await preview(page).getByRole('button', { name: '计划说明' }).click();
        const dialog = page.getByRole('dialog');
        await expect(dialog).toContainText('夏令时');
        await expect(dialog).toContainText('定时执行会调用已配置的搜索与模型');
        await expect(dialog).toContainText('时刻重复时，只执行第一次');
        await page.keyboard.press('Escape');
        await expect(dialog).not.toBeVisible();
        await expect(preview(page).getByRole('button', { name: '计划说明' })).toBeFocused();
        for (const doubled of [false, true]) {
            if (doubled)
                await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
            await noOverflow(page);
            await localTime(page).fill('02:31');
            await expect(localTime(page)).toHaveValue('02:31');
            await localTime(page).fill('02:30');
            if (doubled && (width === 320 || width === 390)) {
                await localTime(page).focus();
                await localTime(page).fill('03:30');
                await expect(localTime(page)).toHaveValue('03:30');
                await localTime(page).fill('03:31');
                await expect(localTime(page)).toHaveValue('03:31');
                await localTime(page).fill('02:30');
                await localTime(page).scrollIntoViewIfNeeded();
                await info.attach(`${width}-native-time-text-200`, {
                    body: await page.screenshot({
                        path: info.outputPath('native-time-text-200.png'),
                    }),
                    contentType: 'image/png',
                });
            }
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
        await save(page).focus();
        await save(page).press('Enter');
        await expect(
            page
                .locator('.scova-notifications .n-notification')
                .filter({ hasText: '任务修改已保存' }),
        ).toContainText('修改已保存');
        await expect(
            page
                .locator('.scova-notifications .n-notification')
                .filter({ hasText: '任务修改已保存' }),
        ).not.toBeFocused();
        await expect(saved(page)).toContainText('Asia/Tokyo');
        await expect(saved(page)).not.toContainText('有未保存修改');
        await expect(preview(page)).not.toContainText('当前填写内容尚未安排执行');
        await expect(
            preview(page).getByText('保存后生效；下次执行时间以已保存计划为准。'),
        ).toHaveCount(0);
        await expect(saved(page).locator('time').first()).toHaveAttribute(
            'datetime',
            state.nextRunAt!,
        );
        if (width === 320 || width === 390 || width === 1440) {
            await saved(page).evaluate((element) => element.scrollIntoView({ block: 'start' }));
            await info.attach(`${width}-saved-plan-text-200`, {
                body: await page.screenshot({ path: info.outputPath('saved-plan-text-200.png') }),
                contentType: 'image/png',
            });
        }
        expect(patches(calls)).toHaveLength(1);
        expect(patches(calls)[0]!.etag).toBe('"1"');
        expect(patches(calls)[0]!.body?.config).toEqual({
            ...original,
            timezone: 'Asia/Tokyo',
            schedule:
                kind === 'daily'
                    ? { frequency: 'daily', localTime: '02:30' }
                    : { frequency: 'weekly', weekday: 1, localTime: '02:30' },
        });
        expect(calls.filter((call) => call.method === 'POST')).toEqual([]);
        expect(errors).toEqual([]);
    });
}

test('选每日后明确改为仅手动创建，只保存配置且不启动Run', async ({ page }) => {
    const { calls, state } = await samples(page.context());
    await page.goto('/tasks/new');
    await expect(frequency(page)).toContainText('仅手动');
    await expect(localTime(page)).toHaveCount(0);
    await expect(weekday(page)).toHaveCount(0);
    await expect(preview(page)).toContainText('保存后生效');
    await page.getByLabel('任务标题', { exact: true }).fill('新周期任务');
    await page.getByLabel('查阅主题', { exact: true }).fill('政策');
    await page.getByLabel('查阅目标', { exact: true }).fill('核验');
    await chooseOption(page, '计划频率', '每日');
    await localTime(page).fill('09:15');
    await chooseTimezone(page, 'America/New_York', '任务时区');
    await chooseOption(page, '计划频率', '仅手动');
    await expect(localTime(page)).toHaveCount(0);
    await page.getByRole('button', { name: '确认保存任务', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/tasks/${taskId}$`));
    expect(state.config.schedule).toEqual({ frequency: 'manual' });
    expect(calls.filter((call) => call.method === 'POST').map((call) => call.path)).toEqual([
        '/api/v1/tasks',
    ]);
});

test('ISO星期1到7映射，0或8没有选项；切换manual清除周期payload', async ({ page }) => {
    const { calls, state } = await samples(page.context());
    await page.goto(`/tasks/${taskId}/edit`);
    await weekday(page).click();
    const options = await page
        .getByRole('option')
        .evaluateAll((elements) =>
            elements.map((element) => ({ label: element.textContent?.trim() })),
        );
    expect(options.map((option) => option.label)).toEqual([
        '请选择星期',
        '周一',
        '周二',
        '周三',
        '周四',
        '周五',
        '周六',
        '周日',
    ]);
    await page.keyboard.press('Escape');
    for (let day = 1; day <= 7; day++) {
        await chooseOption(page, '每周执行星期', options[day]!.label!);
        await expect(preview(page)).toContainText(`每${options[day]!.label}`);
    }
    await chooseOption(page, '计划频率', '仅手动');
    await expect(localTime(page)).toHaveCount(0);
    await expect(weekday(page)).toHaveCount(0);
    await save(page).click();
    await expect(
        page.locator('.scova-notifications .n-notification').filter({ hasText: '任务修改已保存' }),
    ).toContainText('修改已保存');
    expect(state.config).toEqual({ ...original, schedule: { frequency: 'manual' } });
    await expect(saved(page)).toContainText('服务端已保存为仅手动执行');
    await expect(saved(page).locator('time')).toHaveCount(0);
    expect(patches(calls)[0]!.etag).toBe('"1"');
});

test('非法IANA、空当地时间与未选星期定位错误，完整配置不发出', async ({ page }, info) => {
    const { calls } = await samples(page.context());
    await page.setViewportSize({ width: 320, height: 1000 });
    await page.goto(`/tasks/${taskId}/edit`);
    await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
    await timezone(page).click();
    await page.getByRole('combobox', { name: '搜索任务时区' }).fill('Mars/Olympus');
    await expect(page.getByRole('option')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(timezone(page)).toContainText('America/New_York');
    await localTime(page).fill('');
    await save(page).click();
    await expect(localTime(page)).toHaveAttribute('aria-invalid', 'true');
    await expect(localTime(page)).toBeFocused();
    await localTime(page).fill('02:30');
    await chooseOption(page, '每周执行星期', '请选择星期');
    await save(page).click();
    await expect(weekday(page)).toHaveAttribute('aria-invalid', 'true');
    await expect(weekday(page)).toBeFocused();
    await noOverflow(page);
    await fields(page).scrollIntoViewIfNeeded();
    await info.attach('320-invalid-weekday-text-200', {
        body: await page.screenshot({ path: info.outputPath('invalid-weekday-text-200.png') }),
        contentType: 'image/png',
    });
    expect(patches(calls)).toHaveLength(0);
});

test('计划冲突保留字段与已保存时区，重新读取后使用新quoted修订', async ({ page }) => {
    const { calls, state } = await samples(page.context());
    let release!: () => void;
    state.wait = new Promise<void>((resolve) => {
        release = resolve;
    });
    await page.goto(`/tasks/${taskId}/edit`);
    await chooseTimezone(page, 'Asia/Tokyo', '任务时区');
    state.failure = 409;
    await save(page).click();
    await expect(localTime(page)).toBeDisabled();
    await expect(frequency(page)).toBeDisabled();
    expect(await localTime(page).evaluate((element) => getComputedStyle(element).cursor)).toBe(
        'not-allowed',
    );
    expect(patches(calls)).toHaveLength(1);
    release();
    await expect(page.getByRole('alert')).toContainText('当前草稿已保留');
    await expect(timezone(page)).toContainText('Asia/Tokyo');
    await expect(saved(page)).toContainText('America/New_York');
    await expect(saved(page)).not.toContainText('Asia/Tokyo');
    await expect(save(page)).toBeDisabled();
    state.failure = 0;
    state.wait = undefined;
    state.revision = 8;
    state.config = {
        ...original,
        timezone: 'UTC',
        schedule: { frequency: 'daily', localTime: '10:00' },
    };
    await page.getByRole('button', { name: '重新读取最新版本', exact: true }).click();
    await page.getByRole('button', { name: '确认丢弃草稿并重新读取', exact: true }).click();
    await expect(timezone(page)).toContainText('UTC');
    await expect(localTime(page)).toHaveValue('10:00');
    await localTime(page).fill('10:15');
    await save(page).click();
    await expect(
        page.locator('.scova-notifications .n-notification').filter({ hasText: '任务修改已保存' }),
    ).toContainText('修改已保存');
    expect(patches(calls).map((call) => call.etag)).toEqual(['"1"', '"8"']);
    expect(patches(calls)[1]!.body?.config).toEqual({
        ...state.config,
        schedule: { frequency: 'daily', localTime: '10:15' },
    });
});

for (const status of ['paused', 'archived'] as const) {
    test(`服务端${status}且next为空时说明实际状态，不伪造周期时刻`, async ({ page }) => {
        const { state, calls } = await samples(page.context());
        state.status = status;
        state.nextRunAt = null;
        await page.goto(`/tasks/${taskId}/edit`);
        await expect(saved(page)).toContainText(
            status === 'paused' ? '服务端任务已暂停' : '服务端任务已归档',
        );
        await expect(saved(page).locator('time')).toHaveCount(0);
        await expect(localTime(page)).toHaveValue('01:30');
        expect(patches(calls)).toHaveLength(0);
    });
}

test('未保存计划离开可取消，确认离开不触发Run或自动保存', async ({ page }) => {
    const { calls } = await samples(page.context());
    await page.goto(`/tasks/${taskId}/edit`);
    await localTime(page).fill('03:30');
    page.once('dialog', (dialog) => dialog.dismiss());
    await page.getByRole('link', { name: '返回任务摘要', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/tasks/${taskId}/edit$`));
    await expect(localTime(page)).toHaveValue('03:30');
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('link', { name: '返回任务摘要', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/tasks/${taskId}$`));
    expect(patches(calls)).toHaveLength(0);
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0);
});
