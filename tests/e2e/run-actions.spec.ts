import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import type { RunActionTarget } from '../../apps/web/src/api/runs.ts';

type Run = NonNullable<RunActionTarget['run']>;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const taskId = id(1);
const sourceId = id(21);
const instant = '2026-10-31T00:00:00Z';
const budget = {
    maxSearches: 2,
    maxPages: 3,
    maxDurationSeconds: 60,
    maxInputTokens: 1000,
    maxOutputTokens: 500,
};
function run(status: Run['status'] = 'failed', runId = sourceId): Run {
    return {
        id: runId,
        taskId,
        taskVersionId: id(201),
        parentRunId: null,
        baselineRunId: null,
        mode: 'live',
        status,
        outcome: status === 'succeeded' ? 'baseline' : status === 'partial' ? 'inconclusive' : null,
        trigger: 'manual',
        budget,
        usage: { searches: 0, pages: 0, inputTokens: 0, outputTokens: 0, estimated: false },
        coverage:
            status === 'succeeded' || status === 'partial'
                ? {
                      completeness: status === 'succeeded' ? 'complete' : 'partial',
                      searchedQueries: [],
                      gaps: [],
                      exhausted: [],
                  }
                : null,
        queuedAt: instant,
        startedAt: status === 'queued' ? null : instant,
        finishedAt: ['succeeded', 'partial', 'failed', 'canceled'].includes(status)
            ? instant
            : null,
        failureCode: status === 'failed' ? 'NO_EVIDENCE' : null,
    };
}

// Explicit local HTTP samples, separate from real API/storage verification.
async function samples(context: BrowserContext) {
    const calls: {
        path: string;
        method: string;
        body?: { mode: 'demo' | 'live' };
        key?: string;
        csrf?: string;
    }[] = [];
    const runs = new Map<string, Run>([[sourceId, run()]]);
    const keys = new Map<string, string>();
    const state = {
        failure: 0,
        code: 'LOCAL_FAILURE',
        reuse: undefined as Run | undefined,
        commitThenFail: false,
        wait: undefined as Promise<void> | undefined,
        cancelResponse: undefined as Run | undefined,
    };
    const config = {
        title: '执行模式与命令安全样本',
        topic: '公开资料',
        goal: '核对变化与证据',
        focusPoints: [],
        exclusions: [],
        sourcePreferences: { preferredUrls: [], excludedUrls: [], officialOnly: false },
        timeRange: { kind: 'rolling', days: 7 },
        timezone: 'UTC',
        schedule: { frequency: 'weekly', weekday: 3, localTime: '09:15' },
        outputFormat: 'brief',
        budget: { ...budget, maxSearches: 9 },
        notificationPreference: { mode: 'summary', runIssues: true },
    };
    const detail = {
        task: {
            id: taskId,
            title: config.title,
            status: 'active',
            revision: 8,
            currentVersionId: id(208),
            nextRunAt: '2026-11-04T09:15:00Z',
            createdAt: instant,
            updatedAt: instant,
        },
        version: {
            id: id(208),
            taskId,
            version: 8,
            configSchemaVersion: 1,
            config,
            comparisonScopeHash: 'a'.repeat(64),
            createdAt: instant,
        },
        baselineResetRequired: false,
    };
    await context.route('**/api/v1/me', (route) =>
        route.fulfill({
            json: {
                user: {
                    id: id(100),
                    email: 'run-actions@example.test',
                    preferences: {
                        defaultTimezone: 'UTC',
                        notificationPreference: config.notificationPreference,
                    },
                    createdAt: instant,
                },
                csrfToken: 'local-actions-csrf',
            },
        }),
    );
    await context.route('**/api/v1/reports**', (route) =>
        route.fulfill({ json: { items: [], nextCursor: null } }),
    );
    await context.route('**/api/v1/{tasks,runs}**', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const path = url.pathname;
        const targetId = path.split('/')[4]!;
        const body = request.postData()
            ? (request.postDataJSON() as { mode: 'demo' | 'live' })
            : undefined;
        calls.push({
            path,
            method: request.method(),
            body,
            key: request.headers()['idempotency-key'],
            csrf: request.headers()['x-csrf-token'],
        });
        if (path.endsWith('/events'))
            return route.fulfill({ contentType: 'text/event-stream', body: ': local sample\n\n' });
        if (request.method() === 'POST') {
            if (state.wait) await state.wait;
            const reject = (status: number) =>
                route.fulfill({
                    status,
                    json: { code: state.code, message: 'local sample', requestId: 'sample' },
                });
            if (state.failure) return reject(state.failure);
            const cancel = path.endsWith('/cancel');
            let result: Run;
            let reused = false;
            if (cancel) {
                result = state.cancelResponse ?? {
                    ...runs.get(targetId)!,
                    status: 'cancel_requested',
                };
                if (!state.cancelResponse) runs.set(result.id, result);
            } else {
                const key = request.headers()['idempotency-key']!;
                if (keys.has(key)) {
                    result = runs.get(keys.get(key)!)!;
                    reused = true;
                } else if (state.reuse) {
                    result = state.reuse;
                    runs.set(result.id, result);
                    reused = true;
                } else {
                    const retry = path.endsWith('/retry');
                    const source = runs.get(targetId);
                    result = {
                        ...run('queued', id(1000 + keys.size)),
                        mode: body!.mode,
                        taskVersionId: retry ? source!.taskVersionId : detail.version.id,
                        budget: retry ? source!.budget : config.budget,
                        parentRunId: retry ? targetId : null,
                        trigger: retry ? 'retry' : 'manual',
                    };
                    runs.set(result.id, result);
                    keys.set(key, result.id);
                }
                if (state.commitThenFail) {
                    state.commitThenFail = false;
                    return reject(503);
                }
            }
            return route.fulfill({ status: cancel ? 200 : 202, json: { run: result, reused } });
        }
        if (path.startsWith('/api/v1/runs/')) return route.fulfill({ json: runs.get(targetId) });
        if (path.endsWith('/runs'))
            return route.fulfill({ json: { items: [...runs.values()], nextCursor: null } });
        if (path === '/api/v1/tasks')
            return route.fulfill({ json: { items: [detail.task], nextCursor: null } });
        return route.fulfill({ json: detail, headers: { etag: '"8"' } });
    });
    return { calls, state, runs, detail };
}
const actions = (page: Page) => page.locator('.run-actions');
const commandStatus = (page: Page) => actions(page).getByRole('status');
const posts = (calls: Awaited<ReturnType<typeof samples>>['calls']) =>
    calls.filter((call) => call.method === 'POST');
async function noOverflow(page: Page) {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
    );
    for (const control of await actions(page).locator('button, fieldset').all()) {
        expect(
            await control.evaluate((element) => {
                const rect = element.getBoundingClientRect();
                return rect.left >= 0 && rect.right <= innerWidth;
            }),
        ).toBe(true);
    }
}

for (const width of [320, 390, 768, 1024, 1440, 1920]) {
    test(`本地命令样本${width}：明确live重试、固定旧版本、取消与200%文字`, async ({
        page,
    }, info) => {
        const { calls, runs, detail } = await samples(page.context());
        if (width === 390) runs.set(sourceId, run('canceled'));
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.setViewportSize({ width, height: 1000 });
        await page.goto(`/runs/${sourceId}`);
        await expect(actions(page).getByRole('radio')).toHaveCount(0);
        await expect(actions(page)).toContainText('原任务版本与预算');
        await expect(actions(page)).toContainText('服务费用');
        expect(posts(calls)).toHaveLength(0);
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
        const retry = actions(page).getByRole('button', { name: '重试并创建新执行', exact: true });
        await retry.focus();
        await retry.press('Enter');
        await expect(commandStatus(page)).toContainText('关联的新执行');
        await expect(commandStatus(page)).toContainText('真实 live');
        await expect(commandStatus(page)).toContainText('等待执行');
        await expect(commandStatus(page)).toBeFocused();
        await info.attach(`${width}-retry-result-text-200`, {
            body: await actions(page).screenshot({
                path: info.outputPath('retry-result-text-200.png'),
            }),
            contentType: 'image/png',
        });
        const created = [...runs.values()].find((item) => item.parentRunId === sourceId)!;
        expect(created.id).not.toBe(sourceId);
        expect(created.taskVersionId).toBe(id(201));
        expect(created.taskVersionId).not.toBe(detail.version.id);
        expect(created.budget).toEqual(budget);
        expect(posts(calls)[0]).toMatchObject({
            path: `/api/v1/runs/${sourceId}/retry`,
            body: { mode: 'live' },
            csrf: 'local-actions-csrf',
        });
        await actions(page).getByRole('link', { name: '打开执行', exact: true }).click();
        await expect(page).toHaveURL(new RegExp(`/runs/${created.id}$`));
        await page.getByText('执行标识与时间', { exact: true }).click();
        await expect(page.locator('.execution-overview')).toContainText(id(201));
        await expect(actions(page)).toContainText('不暂停任务的未来计划');
        await actions(page).getByRole('button', { name: '请求取消', exact: true }).click();
        await expect(
            page
                .locator('.execution-overview')
                .getByRole('heading', { name: '正在取消', exact: true }),
        ).toBeVisible();
        await expect(
            actions(page).getByRole('button', { name: '正在取消', exact: true }),
        ).toBeDisabled();
        await noOverflow(page);
        await info.attach(`${width}-cancel-requested-text-200`, {
            body: await actions(page).screenshot({
                path: info.outputPath('cancel-requested-text-200.png'),
            }),
            contentType: 'image/png',
        });
        runs.set(created.id, { ...created, status: 'canceled', finishedAt: instant });
        await page.getByRole('button', { name: '刷新快照', exact: true }).click();
        const retryCanceled = actions(page).getByRole('button', {
            name: '重试并创建新执行',
            exact: true,
        });
        await expect(retryCanceled).toBeEnabled();
        await expect(actions(page).getByRole('radio')).toHaveCount(0);
        await retryCanceled.click();
        await expect(commandStatus(page)).toContainText('关联的新执行');
        const afterCancel = [...runs.values()].find((item) => item.parentRunId === created.id)!;
        expect(afterCancel.taskVersionId).toBe(created.taskVersionId);
        expect(afterCancel.mode).toBe('live');
        expect(posts(calls).map((call) => call.path)).toEqual([
            `/api/v1/runs/${sourceId}/retry`,
            `/api/v1/runs/${created.id}/cancel`,
            `/api/v1/runs/${created.id}/retry`,
        ]);
        expect(detail.task.nextRunAt).toBe('2026-11-04T09:15:00Z');
        expect(errors).toEqual([]);
    });
}

for (const trigger of ['double', 'Enter', 'Space'] as const) {
    test(`统一真实研究、${trigger}重复激活仅一个在途命令`, async ({ page }) => {
        const { calls, state } = await samples(page.context());
        let release!: () => void;
        state.wait = new Promise<void>((resolve) => {
            release = resolve;
        });
        await page.goto(`/tasks/${taskId}`);
        const button = actions(page).getByRole('button', { name: '立即执行', exact: true });
        expect(posts(calls)).toHaveLength(0);
        if (trigger === 'double') await button.dblclick();
        else {
            await button.focus();
            await page.keyboard.press(trigger === 'Space' ? 'Space' : 'Enter');
            await page.keyboard.press(trigger === 'Space' ? 'Space' : 'Enter');
        }
        await expect(button).toHaveAttribute('aria-busy', 'true');
        expect(posts(calls)).toHaveLength(1);
        release();
        await expect(commandStatus(page)).toContainText('真实 live');
        await expect(commandStatus(page)).toContainText('等待执行');
        expect(posts(calls)[0]!.body).toEqual({ mode: 'live' });
        expect(posts(calls)[0]!.key).toMatch(/^[\da-f-]{36}$/);
    });
}

test('未知结果显式重发冻结key/body，终态幂等命中按实际状态展示', async ({ page }, info) => {
    const { state, calls, runs } = await samples(page.context());
    state.commitThenFail = true;
    await page.setViewportSize({ width: 320, height: 1000 });
    await page.goto(`/tasks/${taskId}`);
    await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
    await actions(page).getByRole('button', { name: '立即执行', exact: true }).click();
    await expect(commandStatus(page)).toContainText('尚不能确认');
    await expect(commandStatus(page)).toBeFocused();
    await noOverflow(page);
    await info.attach('uncertain-live-320-text-200', {
        body: await actions(page).screenshot({
            path: info.outputPath('uncertain-live-320-text-200.png'),
        }),
        contentType: 'image/png',
    });
    await expect(actions(page).getByRole('radio')).toHaveCount(0);
    const created = [...runs.values()].find((item) => item.id !== sourceId)!;
    runs.set(created.id, {
        ...created,
        status: 'failed',
        failureCode: 'NO_EVIDENCE',
        finishedAt: instant,
    });
    const replay = actions(page).getByRole('button', { name: '使用同一命令重发', exact: true });
    await replay.focus();
    await replay.press('Space');
    await expect(commandStatus(page)).toContainText('执行失败');
    await expect(commandStatus(page)).toContainText('真实 live');
    await expect(commandStatus(page)).not.toContainText('已有活动执行');
    await expect(commandStatus(page)).toBeFocused();
    await noOverflow(page);
    await info.attach('terminal-replay-320-text-200', {
        body: await actions(page).screenshot({
            path: info.outputPath('terminal-replay-320-text-200.png'),
        }),
        contentType: 'image/png',
    });
    expect(posts(calls)).toHaveLength(2);
    expect(posts(calls)[1]!.key).toBe(posts(calls)[0]!.key);
    expect(posts(calls)[1]!.body).toEqual(posts(calls)[0]!.body);
    await expect(
        actions(page).getByRole('link', { name: '打开执行', exact: true }),
    ).toHaveAttribute('href', `/runs/${created.id}`);
});

test('IDEMPOTENCY_PENDING可同key重发，payload mismatch停止且不换key', async ({ page }) => {
    const { state, calls } = await samples(page.context());
    state.failure = 409;
    state.code = 'IDEMPOTENCY_PENDING';
    await page.goto(`/tasks/${taskId}`);
    await actions(page).getByRole('button', { name: '立即执行', exact: true }).click();
    await expect(commandStatus(page)).toContainText('仍在处理');
    state.code = 'IDEMPOTENCY_PAYLOAD_MISMATCH';
    await actions(page).getByRole('button', { name: '使用同一命令重发', exact: true }).click();
    await expect(commandStatus(page)).toContainText('不会更换');
    await expect(
        actions(page).getByRole('button', { name: '使用同一命令重发', exact: true }),
    ).toHaveCount(0);
    await expect(
        actions(page).getByRole('button', { name: '立即执行', exact: true }),
    ).toBeDisabled();
    expect(posts(calls)).toHaveLength(2);
    expect(posts(calls)[1]!.key).toBe(posts(calls)[0]!.key);
    expect(posts(calls)[1]!.body).toEqual(posts(calls)[0]!.body);
});

test('取消结果未知时重发不提交mode或key，也不暗示选择执行模式', async ({ page }) => {
    const { state, calls, runs } = await samples(page.context());
    runs.set(sourceId, run('running'));
    state.failure = 503;
    await page.goto(`/runs/${sourceId}`);
    await actions(page).getByRole('button', { name: '请求取消', exact: true }).click();
    await expect(commandStatus(page)).toContainText('尚不能确认取消结果');
    await expect(commandStatus(page)).not.toContainText('模式');
    await expect(commandStatus(page)).not.toContainText('key');
    await expect(commandStatus(page)).toBeFocused();
    state.failure = 0;
    await actions(page).getByRole('button', { name: '使用同一命令重发', exact: true }).click();
    await expect(
        actions(page).getByRole('button', { name: '正在取消', exact: true }),
    ).toBeDisabled();
    expect(posts(calls)).toHaveLength(2);
    for (const call of posts(calls)) {
        expect(call.path).toBe(`/api/v1/runs/${sourceId}/cancel`);
        expect(call.body).toBeUndefined();
        expect(call.key).toBeUndefined();
    }
});

test('重试复用不同mode/version/parent的活动执行，按返回事实打开', async ({ page }) => {
    const { state } = await samples(page.context());
    state.reuse = {
        ...run('cancel_requested', id(99)),
        mode: 'demo',
        taskVersionId: id(999),
        parentRunId: id(77),
    };
    await page.goto(`/runs/${sourceId}`);
    await actions(page).getByRole('button', { name: '重试并创建新执行', exact: true }).click();
    await expect(commandStatus(page)).toContainText('已有活动执行');
    await expect(commandStatus(page)).toContainText('演示 demo');
    await expect(commandStatus(page)).toContainText('正在取消');
    await expect(commandStatus(page)).not.toContainText('已创建关联');
    await actions(page).getByRole('link', { name: '打开执行', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/runs/${id(99)}$`));
    await expect(page.locator('.execution-overview')).toContainText(id(999));
});

test('取消迟到响应不能回退已读取终态，也不暂停未来计划', async ({ page }) => {
    const { state, calls, runs } = await samples(page.context());
    runs.set(sourceId, run('running'));
    state.cancelResponse = run('cancel_requested');
    let release!: () => void;
    state.wait = new Promise<void>((resolve) => {
        release = resolve;
    });
    await page.goto(`/runs/${sourceId}`);
    await actions(page).getByRole('button', { name: '请求取消', exact: true }).click();
    await expect.poll(() => posts(calls).length).toBe(1);
    runs.set(sourceId, run('succeeded'));
    await page.getByRole('button', { name: '刷新快照', exact: true }).click();
    await expect(
        page.locator('.execution-overview').getByRole('heading', { name: '已完成', exact: true }),
    ).toBeVisible();
    const beforeResponse = calls.filter(
        (call) => call.method === 'GET' && call.path === `/api/v1/runs/${sourceId}`,
    ).length;
    release();
    await expect
        .poll(
            () =>
                calls.filter(
                    (call) => call.method === 'GET' && call.path === `/api/v1/runs/${sourceId}`,
                ).length,
        )
        .toBeGreaterThan(beforeResponse);
    await expect(
        page.locator('.execution-overview').getByRole('heading', { name: '已完成', exact: true }),
    ).toBeVisible();
    expect(posts(calls).map((call) => call.path)).toEqual([`/api/v1/runs/${sourceId}/cancel`]);
    expect(posts(calls)[0]!.body).toBeUndefined();
    expect(posts(calls)[0]!.key).toBeUndefined();
});

for (const status of ['succeeded', 'partial'] as const) {
    test(`${status}不提供失败重试或resume`, async ({ page }) => {
        const { runs, calls } = await samples(page.context());
        runs.set(sourceId, run(status));
        await page.goto(`/runs/${sourceId}`);
        await expect(actions(page)).toContainText('不提供失败重试');
        await expect(actions(page).getByRole('button')).toHaveCount(0);
        expect(posts(calls)).toHaveLength(0);
    });
}
