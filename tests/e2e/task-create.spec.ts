import { expect, test, type Page } from '@playwright/test';
import type { taskInput } from '../../apps/web/src/composables/useCreateTask.ts';
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
async function samples(page: Page) {
    const calls: { path: string; method: string; body?: CreateTaskInput; key?: string }[] = [];
    let saved: CreateTaskInput | undefined;
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
    await page.route('**/api/v1/tasks**', async (route) => {
        const request = route.request(),
            url = new URL(request.url());
        const body =
            request.method() === 'POST' ? (request.postDataJSON() as CreateTaskInput) : undefined;
        calls.push({
            path: url.pathname,
            method: request.method(),
            body,
            key: request.headers()['idempotency-key'],
        });
        if (request.method() === 'POST') {
            saved = body;
            return route.fulfill({ status: 201, json: detail() });
        }
        if (url.pathname.endsWith('/runs'))
            return route.fulfill({ json: { items: [], nextCursor: null } });
        if (url.pathname === '/api/v1/tasks')
            return route.fulfill({
                json: { items: saved ? [detail().task] : [], nextCursor: null },
            });
        return route.fulfill({ json: detail() });
    });
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
        await page.getByLabel('重点关注（可选）', { exact: true }).fill('资格\n费用');
        await page.getByLabel('排除主题或条件（可选）', { exact: true }).fill('商业广告');
        await page
            .getByLabel('优先来源网址（可选）', { exact: true })
            .fill('https://example.test/admission');
        await page
            .getByLabel('排除来源网址（可选）', { exact: true })
            .fill('https://example.test/ads');
        await page.getByLabel('仅查阅官方来源', { exact: true }).check();
        await page.getByLabel('输出形式', { exact: true }).selectOption('comparison');
        await page.getByLabel('搜索次数上限', { exact: true }).fill('3');
        await page.getByLabel('网页读取次数上限', { exact: true }).fill('4');
        await page.getByLabel('执行时长上限（秒）', { exact: true }).fill('60');
        await page.getByLabel('输入 token 上限', { exact: true }).fill('1000');
        await page.getByLabel('输出 token 上限', { exact: true }).fill('500');
        await page.getByLabel('任务时区（IANA）', { exact: true }).fill('Asia/Shanghai');
        await page.getByLabel('结果提醒', { exact: true }).selectOption('important_change');
        await page.getByLabel('提醒失败或不完整执行', { exact: true }).uncheck();
        await noOverflow(page);
        await page.getByLabel('查阅时间范围', { exact: true }).selectOption('fixed');
        await page.getByLabel('开始时间', { exact: true }).fill('2026-10-01T09:00');
        await page.getByLabel('结束时间', { exact: true }).fill('2026-10-30T17:00');
        for (const doubled of [false, true]) {
            if (doubled)
                await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
            await noOverflow(page);
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
        await page.getByRole('link', { name: '返回任务', exact: true }).click();
        await expect(page.getByRole('link', { name: title, exact: true })).toBeVisible();
        expect(errors).toEqual([]);
    });
}

test('字段错误聚焦、来源校验、固定日期与失败保留重试', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 1000 });
    const calls = await samples(page);
    await page.goto('/tasks/new');
    await page.getByRole('button', { name: '确认保存任务', exact: true }).click();
    await expect(page.getByLabel('任务标题', { exact: true })).toBeFocused();
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0);
    await fillMain(page);
    await page.getByText('关注范围与来源偏好', { exact: true }).click();
    await page.getByLabel('优先来源网址（可选）', { exact: true }).fill('ftp://bad.test');
    await page.getByRole('button', { name: '确认保存任务', exact: true }).click();
    await expect(page.getByLabel('优先来源网址（可选）', { exact: true })).toBeFocused();
    await noOverflow(page);
    await page.screenshot({ path: testInfo.outputPath('source-error-390.png'), fullPage: true });
    await page.getByLabel('优先来源网址（可选）', { exact: true }).fill('https://example.test');
    await page.getByLabel('查阅时间范围', { exact: true }).selectOption('fixed');
    await page.getByLabel('开始时间', { exact: true }).fill('2026-10-31T08:00');
    await page.getByLabel('结束时间', { exact: true }).fill('2026-10-30T08:00');
    await page.getByRole('button', { name: '确认保存任务', exact: true }).click();
    await expect(page.getByLabel('结束时间', { exact: true })).toBeFocused();
    await page.getByLabel('结束时间', { exact: true }).fill('2026-11-01T08:00');
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
    await expect(page.getByRole('alert')).toContainText('核对');
    await expect(page.getByRole('button', { name: '确认保存任务', exact: true })).toBeDisabled();
    await expect(page.getByLabel('任务标题', { exact: true })).toHaveValue(title);
    await expect(page.getByRole('alert')).toBeFocused();
    await noOverflow(page);
    await page.screenshot({ path: testInfo.outputPath('uncertain-320.png'), fullPage: true });
    expect(count).toBe(1);
});
