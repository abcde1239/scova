import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import type { taskInput } from '../../apps/web/src/composable/useCreateTask.ts';

type TaskConfig = ReturnType<typeof taskInput>['config'];
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const taskId = id(11);
const instant = '2026-10-31T00:00:00Z';
const config: TaskConfig = {
    title: '持续跟踪招生政策与学术研究观点的变化',
    topic: '各地高校招生政策',
    goal: '比较变化并保留可核验来源证据',
    focusPoints: ['资格与费用', '申请步骤'],
    exclusions: [],
    sourcePreferences: { preferredUrls: [], excludedUrls: [], officialOnly: true },
    timeRange: { kind: 'rolling', days: 7 },
    timezone: 'America/New_York',
    schedule: { frequency: 'daily', localTime: '09:15' },
    outputFormat: 'comparison',
    budget: {
        maxSearches: 3,
        maxPages: 4,
        maxDurationSeconds: 60,
        maxInputTokens: 1000,
        maxOutputTokens: 500,
    },
    notificationPreference: { mode: 'important_change', runIssues: false },
};

// Local HTTP contract samples. Real authorization, scheduling and Run cancellation need backend QA.
async function samples(context: BrowserContext) {
    const calls: {
        method: string;
        path: string;
        etag?: string;
        csrf?: string;
        key?: string;
        body: string | null;
    }[] = [];
    const state = {
        status: 'active' as 'active' | 'paused' | 'archived',
        revision: 1,
        failure: 0,
        getFailure: false,
        getFailureStatus: 503,
        failReadAfterWrite: false,
        invalidRead: false,
        networkFailure: false,
        wait: undefined as Promise<void> | undefined,
        future: new Date(Date.now() + 86_400_000).toISOString(),
    };
    function detail() {
        return {
            task: {
                id: taskId,
                title: config.title,
                status: state.status,
                revision: state.revision,
                currentVersionId: id(101),
                nextRunAt: state.status === 'active' ? state.future : null,
                createdAt: instant,
                updatedAt: instant,
            },
            version: {
                id: id(101),
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
    await context.route('**/api/v1/me', (route) =>
        route.fulfill({
            json: {
                user: {
                    id: id(1),
                    email: 'task-lifecycle@example.test',
                    preferences: {
                        defaultTimezone: 'UTC',
                        notificationPreference: config.notificationPreference,
                    },
                    createdAt: instant,
                },
                csrfToken: 'sample-csrf',
            },
        }),
    );
    await context.route('**/api/v1/tasks**', async (route) => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        calls.push({
            method: request.method(),
            path,
            etag: request.headers()['if-match'],
            csrf: request.headers()['x-csrf-token'],
            key: request.headers()['idempotency-key'],
            body: request.postData(),
        });
        const failure = (status: number) =>
            route.fulfill({
                status,
                json: { code: 'LOCAL_FAILURE', message: 'local sample', requestId: 'sample' },
            });
        if (request.method() === 'POST') {
            if (state.wait) await state.wait;
            if (state.networkFailure) return route.abort('failed');
            if (state.failure) return failure(state.failure);
            if (request.headers()['if-match'] !== `"${state.revision}"`) return failure(409);
            state.status = path.endsWith('/pause')
                ? 'paused'
                : path.endsWith('/resume')
                  ? 'active'
                  : 'archived';
            state.revision++;
            if (state.failReadAfterWrite) state.getFailure = true;
        }
        if (path.endsWith('/runs')) return route.fulfill({ json: { items: [], nextCursor: null } });
        if (path === '/api/v1/tasks')
            return route.fulfill({ json: { items: [detail().task], nextCursor: null } });
        if (request.method() === 'GET' && state.getFailure) return failure(state.getFailureStatus);
        if (request.method() === 'GET' && state.invalidRead)
            return route.fulfill({ headers: { etag: '"99"' }, json: detail() });
        return route.fulfill({ headers: { etag: `"${state.revision}"` }, json: detail() });
    });
    return { state, calls };
}
const section = (page: Page) => page.getByRole('region', { name: '任务管理', exact: true });
const button = (page: Page, name: string) =>
    section(page).getByRole('button', { name, exact: true });
const pause = (page: Page) => button(page, '暂停未来计划');
const resume = (page: Page) => button(page, '恢复未来计划');
const archive = (page: Page) => button(page, '归档任务');
const refresh = (page: Page) => button(page, '刷新任务状态');
const feedback = (page: Page) => page.locator('.scova-notifications .n-notification').last();
const confirmation = (page: Page) => page.getByRole('dialog', { name: '归档任务？' });
const posts = (calls: Awaited<ReturnType<typeof samples>>['calls']) =>
    calls.filter((call) => call.method === 'POST');
const reads = (calls: Awaited<ReturnType<typeof samples>>['calls']) =>
    calls.filter((call) => call.method === 'GET' && call.path === `/api/v1/tasks/${taskId}`);

async function noOverflow(page: Page) {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
    );
    for (const target of await section(page).getByRole('button').all()) {
        if (!(await target.isVisible())) continue;
        const bounds = await target.boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
        expect(bounds!.height).toBeGreaterThanOrEqual(44);
    }
}

for (const width of [320, 390, 768, 1024, 1440, 1920]) {
    test(`本地生命周期样本${width}：暂停恢复、归档确认焦点与200%文字`, async ({ page }, info) => {
        const { state, calls } = await samples(page.context());
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.setViewportSize({ width, height: 1000 });
        await page.goto(`/tasks/${taskId}`);
        await expect(pause(page)).toBeEnabled();
        expect(reads(calls).length).toBeGreaterThanOrEqual(2);
        await expect(section(page)).toContainText('暂停只停止未来计划，在途执行继续');
        const leftEdges = await page
            .locator('#run-history-title, #run-actions-title, #task-lifecycle-title')
            .evaluateAll((elements) =>
                elements.map((element) => element.getBoundingClientRect().left),
            );
        expect(leftEdges).toHaveLength(3);
        expect(Math.max(...leftEdges) - Math.min(...leftEdges)).toBeLessThanOrEqual(1);
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
        await pause(page).focus();
        await pause(page).press('Enter');
        await expect(resume(page)).toBeEnabled();
        await expect(feedback(page)).toContainText('在途执行继续');
        await expect(feedback(page)).not.toBeFocused();
        await expect(section(page)).toContainText('当前状态：已暂停');
        await expect(section(page).locator('time')).toHaveCount(0);
        if (width === 320 || width === 1440) {
            await feedback(page).scrollIntoViewIfNeeded();
            await info.attach(`${width}-paused-text-200`, {
                body: await page.screenshot({ path: info.outputPath('paused-text-200.png') }),
                contentType: 'image/png',
            });
        }
        await resume(page).focus();
        await resume(page).press('Space');
        await expect(pause(page)).toBeEnabled();
        await expect(feedback(page)).toContainText('不补跑暂停期间的历史时点');
        await expect(section(page).locator('time')).toHaveAttribute('datetime', state.future);
        expect(Date.parse(state.future)).toBeGreaterThan(Date.now());
        await archive(page).focus();
        await archive(page).press('Enter');
        await expect(confirmation(page)).toBeVisible();
        const cancel = confirmation(page).getByRole('button', { name: '取消', exact: true });
        const confirm = confirmation(page).getByRole('button', { name: '确认归档', exact: true });
        await expect(cancel).toBeFocused();
        await expect(confirmation(page)).toContainText('取消完成前仍可能有在途工作');
        await expect(confirmation(page)).toContainText('归档后不能恢复任务');
        const consequence = confirmation(page).locator('#archive-consequence');
        for (const target of [
            confirmation(page).getByRole('heading', { name: '归档任务？', exact: true }),
            consequence,
            cancel,
            confirm,
        ]) {
            const box = await target.boundingBox();
            const dialogBox = await confirmation(page).boundingBox();
            expect(box).not.toBeNull();
            expect(dialogBox).not.toBeNull();
            expect(box!.x).toBeGreaterThanOrEqual(dialogBox!.x);
            expect(box!.x + box!.width).toBeLessThanOrEqual(dialogBox!.x + dialogBox!.width);
            expect(box!.y).toBeGreaterThanOrEqual(Math.max(0, dialogBox!.y));
            expect(box!.y + box!.height).toBeLessThanOrEqual(
                Math.min(1000, dialogBox!.y + dialogBox!.height),
            );
        }
        expect(await consequence.evaluate((element) => element.scrollTop)).toBe(0);
        await noOverflow(page);
        await info.attach(`${width}-archive-dialog-text-200`, {
            body: await page.screenshot({ path: info.outputPath('archive-dialog-text-200.png') }),
            contentType: 'image/png',
        });
        await cancel.press('Shift+Tab');
        await expect(consequence).toBeFocused();
        if (await consequence.evaluate((element) => element.scrollHeight > element.clientHeight)) {
            await consequence.press('End');
            await expect
                .poll(() => consequence.evaluate((element) => element.scrollTop))
                .toBeGreaterThan(0);
            await expect
                .poll(() =>
                    consequence.evaluate((element) =>
                        Math.abs(element.scrollTop + element.clientHeight - element.scrollHeight),
                    ),
                )
                .toBeLessThanOrEqual(1);
            await consequence.press('Home');
            await expect.poll(() => consequence.evaluate((element) => element.scrollTop)).toBe(0);
        }
        await consequence.press('Tab');
        await expect(cancel).toBeFocused();
        await cancel.press('Enter');
        await expect(confirmation(page)).not.toBeVisible();
        await expect(archive(page)).toBeFocused();
        expect(posts(calls)).toHaveLength(2);
        await archive(page).press('Space');
        await expect(cancel).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(confirmation(page)).not.toBeVisible();
        await expect(archive(page)).toBeFocused();
        expect(posts(calls)).toHaveLength(2);
        await archive(page).press('Enter');
        await confirm.focus();
        await confirm.press('Enter');
        await expect(section(page)).toContainText('当前状态：已归档');
        await expect(feedback(page)).toContainText('活动执行已请求取消');
        await expect(feedback(page)).not.toBeFocused();
        await expect(pause(page)).toHaveCount(0);
        await expect(resume(page)).toHaveCount(0);
        await expect(archive(page)).toHaveCount(0);
        await noOverflow(page);
        if (width === 320 || width === 1440) {
            await feedback(page).scrollIntoViewIfNeeded();
            await info.attach(`${width}-archived-text-200`, {
                body: await page.screenshot({ path: info.outputPath('archived-text-200.png') }),
                contentType: 'image/png',
            });
        }
        const commands = posts(calls);
        expect(commands.map((call) => call.path)).toEqual(
            ['pause', 'resume', 'archive'].map((action) => `/api/v1/tasks/${taskId}/${action}`),
        );
        expect(commands.map((call) => call.etag)).toEqual(['"1"', '"2"', '"3"']);
        for (const command of commands) {
            expect(command.csrf).toBe('sample-csrf');
            expect(command.key).toBeUndefined();
            expect(command.body).toBeNull();
        }
        const back = page
            .getByRole('navigation', { name: '面包屑导航' })
            .getByRole('link', { name: '任务', exact: true });
        await expect(back).toHaveAttribute('href', '/tasks');
        await back.click();
        await page.getByRole('radio', { name: '归档', exact: true }).check();
        await expect(page.getByRole('article')).toContainText('归档');
        await expect(page.getByRole('link', { name: config.title, exact: true })).toBeVisible();
        expect(errors).toEqual([]);
    });
}

for (const status of [409, 428, 503, 0]) {
    test(`${status || '网络失败'}锁定直到显式成功刷新，失败刷新不解锁或重发`, async ({
        page,
    }, info) => {
        const { calls, state } = await samples(page.context());
        state.failure = status;
        state.networkFailure = !status;
        await page.setViewportSize({ width: 320, height: 1000 });
        await page.goto(`/tasks/${taskId}`);
        await expect(pause(page)).toBeEnabled();
        await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
        await pause(page).click();
        await expect(feedback(page)).toContainText(
            status === 409 || status === 428 ? String(status) : '尚不能确认操作结果',
        );
        await expect(feedback(page)).not.toBeFocused();
        await expect(section(page)).toContainText('当前状态：已启用');
        await expect(pause(page)).toBeDisabled();
        await expect(archive(page)).toBeDisabled();
        await noOverflow(page);
        await feedback(page).scrollIntoViewIfNeeded();
        await info.attach(`${status || 'network'}-locked-text-200`, {
            body: await page.screenshot({ path: info.outputPath('locked-text-200.png') }),
            contentType: 'image/png',
        });
        state.getFailure = true;
        await refresh(page).click();
        await expect(feedback(page)).toContainText('操作保持锁定');
        await expect(pause(page)).toBeDisabled();
        expect(posts(calls)).toHaveLength(1);
        state.getFailure = false;
        state.failure = 0;
        state.networkFailure = false;
        state.revision = 8;
        const before = reads(calls).length;
        await refresh(page).focus();
        await refresh(page).press('Enter');
        await expect(pause(page)).toBeEnabled();
        expect(reads(calls).length).toBeGreaterThan(before);
        await expect(feedback(page)).toContainText('已重新读取任务状态');
        await expect(feedback(page)).not.toBeFocused();
        expect(posts(calls)).toHaveLength(1);
        await pause(page).click();
        await expect(resume(page)).toBeEnabled();
        expect(posts(calls).map((call) => call.etag)).toEqual(['"1"', '"8"']);
    });
}

test('在途重复点击、Enter和Space不产生重复写请求或刷新', async ({ page }) => {
    const { calls, state } = await samples(page.context());
    let release!: () => void;
    state.wait = new Promise<void>((resolve) => {
        release = resolve;
    });
    await page.goto(`/tasks/${taskId}`);
    await expect(pause(page)).toBeEnabled();
    const before = reads(calls).length;
    await pause(page).dblclick();
    await expect(pause(page)).toHaveAttribute('aria-busy', 'true');
    await expect(pause(page)).toBeDisabled();
    await expect(archive(page)).toBeDisabled();
    await expect(refresh(page)).toBeDisabled();
    await pause(page).press('Enter');
    await pause(page).press('Space');
    expect(posts(calls)).toHaveLength(1);
    expect(reads(calls)).toHaveLength(before);
    release();
    await expect(resume(page)).toBeEnabled();
    expect(posts(calls)).toHaveLength(1);
});

test('离开页面后迟到命令不把旧成功带回当前页面', async ({ page }) => {
    const { calls, state } = await samples(page.context());
    let release!: () => void;
    state.wait = new Promise<void>((resolve) => {
        release = resolve;
    });
    await page.goto(`/tasks/${taskId}`);
    await expect(pause(page)).toBeEnabled();
    await pause(page).click();
    await expect(pause(page)).toHaveAttribute('aria-busy', 'true');
    const back = page
        .getByRole('navigation', { name: '面包屑导航' })
        .getByRole('link', { name: '任务', exact: true });
    await expect(back).toHaveAttribute('href', '/tasks');
    await back.click();
    await expect(page).toHaveURL(/\/tasks$/);
    release();
    await expect(page.getByRole('link', { name: config.title, exact: true })).toBeVisible();
    await expect(page.getByText('未来计划已暂停；在途执行继续，仍可显式手动执行。')).toHaveCount(0);
    expect(posts(calls)).toHaveLength(1);
});

test('已归档初读仅保留历史说明，不暴露恢复或新生命周期动作', async ({ page }) => {
    const { calls, state } = await samples(page.context());
    state.status = 'archived';
    await page.goto(`/tasks/${taskId}`);
    await expect(section(page)).toContainText('当前状态：已归档');
    await expect(section(page)).toContainText('不能恢复或启动新执行');
    await expect(pause(page)).toHaveCount(0);
    await expect(resume(page)).toHaveCount(0);
    await expect(archive(page)).toHaveCount(0);
    await refresh(page).click();
    await expect(feedback(page)).toContainText('已重新读取任务状态');
    expect(posts(calls)).toHaveLength(0);
});

test('写成功后重读暂时失败保留上下文并锁定，显式刷新取得服务端已暂停状态', async ({
    page,
}, info) => {
    const { calls, state } = await samples(page.context());
    await page.setViewportSize({ width: 320, height: 1000 });
    await page.goto(`/tasks/${taskId}`);
    await expect(pause(page)).toBeEnabled();
    await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
    state.failReadAfterWrite = true;
    await pause(page).click();
    await expect(feedback(page)).toContainText('操作保持锁定');
    await expect(feedback(page)).not.toBeFocused();
    await expect(
        page.getByText('任务摘要刷新失败，当前显示上次读取的内容', { exact: false }),
    ).toBeVisible();
    await expect(section(page)).toContainText('当前状态：已启用');
    await expect(pause(page)).toBeDisabled();
    await noOverflow(page);
    await feedback(page).scrollIntoViewIfNeeded();
    await info.attach('write-success-read-failure-320-text-200', {
        body: await page.screenshot({
            path: info.outputPath('write-success-read-failure-text-200.png'),
        }),
        contentType: 'image/png',
    });
    expect(state.status).toBe('paused');
    expect(posts(calls)).toHaveLength(1);
    state.getFailure = false;
    await refresh(page).click();
    await expect(resume(page)).toBeEnabled();
    await expect(section(page)).toContainText('当前状态：已暂停');
    expect(posts(calls)).toHaveLength(1);
});

for (const failure of [403, 404, 'protocol'] as const) {
    test(`显式读取${failure}隐藏旧操作，不能沿用旧快照提交`, async ({ page }) => {
        const { calls, state } = await samples(page.context());
        await page.goto(`/tasks/${taskId}`);
        await expect(pause(page)).toBeEnabled();
        if (failure === 'protocol') state.invalidRead = true;
        else {
            state.getFailure = true;
            state.getFailureStatus = failure;
        }
        await refresh(page).click();
        await expect(section(page)).toContainText('任务状态暂不可用');
        await expect(pause(page)).toHaveCount(0);
        await expect(resume(page)).toHaveCount(0);
        await expect(archive(page)).toHaveCount(0);
        expect(posts(calls)).toHaveLength(0);
    });
}

test.describe('触屏生命周期', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    test('触摸暂停恢复及归档确认取消只产生明确选择的命令', async ({ page }) => {
        const { calls } = await samples(page.context());
        await page.goto(`/tasks/${taskId}`);
        await expect(pause(page)).toBeEnabled();
        await pause(page).tap();
        await expect(resume(page)).toBeEnabled();
        await resume(page).tap();
        await expect(pause(page)).toBeEnabled();
        await archive(page).tap();
        await confirmation(page).getByRole('button', { name: '取消', exact: true }).tap();
        await expect(confirmation(page)).not.toBeVisible();
        expect(posts(calls)).toHaveLength(2);
        await archive(page).tap();
        await confirmation(page).getByRole('button', { name: '确认归档', exact: true }).tap();
        await expect(section(page)).toContainText('当前状态：已归档');
        expect(posts(calls).map((call) => call.path.split('/').at(-1))).toEqual([
            'pause',
            'resume',
            'archive',
        ]);
    });
});
