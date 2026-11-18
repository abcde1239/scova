import { expect, test, type Page } from '@playwright/test';
import {
    RESEARCH_GRAPH_EDGES,
    RESEARCH_GRAPH_NODES,
    type Run,
    type RunGraphSnapshot,
    type SearchConfiguration,
    type SearchConfigurationInput,
} from '@scova/models';
import { chooseOption } from './support/select.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const instant = '2026-11-18T00:00:00Z';
const account = {
    user: {
        id: id(1),
        email: 'search-graph@example.test',
        preferences: {
            defaultTimezone: 'UTC',
            notificationPreference: { mode: 'summary', runIssues: true },
        },
        createdAt: instant,
    },
    csrfToken: 'fixture-csrf',
};

async function session(page: Page) {
    await page.route('**/api/v1/me', (route) => route.fulfill({ json: account }));
    await page.route('**/api/v1/me/agent-providers', (route) =>
        route.fulfill({ json: { items: [], systemConfigured: false, storageReady: true } }),
    );
}

for (const width of [1440, 320]) {
    test(`自定义搜索 ${width}：预设、保存与重新读取，不发起搜索`, async ({ page }, info) => {
        await session(page);
        await page.setViewportSize({ width, height: 1100 });
        await page.emulateMedia({
            reducedMotion: 'reduce',
            colorScheme: width === 320 ? 'dark' : 'light',
        });
        let configuration: SearchConfiguration | null = null;
        const writes: SearchConfigurationInput[] = [];
        let searches = 0;
        await page.route('https://api.search.brave.com/**', (route) => {
            searches++;
            return route.abort();
        });
        await page.route('**/api/v1/me/search-configuration', async (route) => {
            const request = route.request();
            if (request.method() === 'GET')
                return route.fulfill({ json: { configuration, storageReady: true } });
            const body = request.postDataJSON();
            expect((await request.allHeaders())['x-csrf-token']).toBe(account.csrfToken);
            writes.push(body);
            const { apiKey: _key, ...api } = body.api;
            configuration = {
                revision: (configuration?.revision ?? 0) + 1,
                defaultMode: body.defaultMode,
                api: { ...api, hasApiKey: true },
                updatedAt: instant,
            };
            return route.fulfill({ json: configuration });
        });
        await page.goto('/account/agent');
        const search = page.getByRole('region', { name: '搜索与正文提取', exact: true });
        await search.getByRole('button', { name: '配置搜索', exact: true }).click();
        await chooseOption(page, '账号搜索方式', 'Search API／自定义搜索');
        await chooseOption(page, '搜索 API 协议', '自定义 HTTP JSON＋本地网页读取');
        await search.getByRole('button', { name: '填入 Brave Search 预设', exact: true }).click();
        await expect(page.getByLabel('完整搜索接口地址（HTTPS）', { exact: true })).toHaveValue(
            'https://api.search.brave.com/res/v1/web/search',
        );
        await expect(page.getByLabel('密钥请求头名称', { exact: true })).toHaveValue(
            'X-Subscription-Token',
        );
        await page.getByLabel('搜索 API Key', { exact: true }).fill('fixture-custom-key');
        await search.getByRole('button', { name: '保存搜索配置', exact: true }).click();
        await expect.poll(() => writes.length).toBe(1);
        expect(writes[0]).toMatchObject({
            defaultMode: 'api',
            api: {
                protocol: 'custom_json',
                contentMode: 'reader',
                apiKey: 'fixture-custom-key',
                custom: {
                    method: 'GET',
                    auth: { type: 'header', headerName: 'X-Subscription-Token' },
                    request: { q: '{{query}}', count: '{{count}}' },
                    response: {
                        resultsPath: 'web.results',
                        urlPath: 'url',
                        titlePath: 'title',
                        snippetPath: 'description',
                    },
                },
            },
        });
        await expect(search).toContainText('本地工具读取网页');
        await page.reload();
        await search.getByRole('button', { name: '编辑搜索配置', exact: true }).click();
        await expect(page.getByLabel(/^搜索 API Key/)).toHaveValue('');
        await expect(page.getByLabel('结果数组路径', { exact: true })).toHaveValue('web.results');
        if (width === 320)
            await page.evaluate(() => {
                document.documentElement.style.fontSize = '200%';
            });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
            true,
        );
        await page.screenshot({ path: info.outputPath('custom-search.png'), fullPage: true });
        await search.getByRole('button', { name: '保存搜索配置', exact: true }).click();
        await expect.poll(() => writes.length).toBe(2);
        expect(writes[1]?.api).not.toHaveProperty('apiKey');
        expect(searches).toBe(0);
    });
}

const run: Run = {
    id: id(10),
    taskId: id(11),
    taskVersionId: id(12),
    parentRunId: null,
    baselineRunId: null,
    mode: 'live',
    status: 'running',
    outcome: null,
    trigger: 'manual',
    budget: {
        maxSearches: 5,
        maxPages: 5,
        maxDurationSeconds: 300,
        maxInputTokens: 12000,
        maxOutputTokens: 3000,
    },
    usage: { searches: 2, pages: 1, inputTokens: 1000, outputTokens: 200, estimated: true },
    coverage: null,
    queuedAt: instant,
    startedAt: instant,
    finishedAt: null,
    failureCode: null,
};

function graph(): RunGraphSnapshot {
    const attempt = (n: number, status: 'succeeded' | 'interrupted' | 'running', number = 1) => ({
        attemptId: id(n),
        number,
        status,
        startedAt: instant,
        finishedAt: status === 'running' ? null : instant,
        durationMs: status === 'succeeded' ? 1250 : null,
    });
    return {
        runId: run.id,
        graphVersion: 1,
        precision: 'instances',
        seq: 20,
        runStatus: 'running',
        nodes: RESEARCH_GRAPH_NODES.map((node) => ({ ...node })),
        edges: RESEARCH_GRAPH_EDGES.map((edge) => ({ ...edge })),
        instances: [
            {
                instanceId: id(20),
                step: 'search',
                ordinal: 1,
                attempts: [attempt(30, 'succeeded')],
            },
            {
                instanceId: id(21),
                step: 'search',
                ordinal: 2,
                attempts: [attempt(31, 'interrupted'), attempt(32, 'succeeded', 2)],
            },
            { instanceId: id(22), step: 'read', ordinal: 3, attempts: [attempt(33, 'running')] },
        ],
        legacySteps: [],
        historyComplete: true,
        truncated: false,
    };
}

async function installRun(page: Page) {
    await session(page);
    await page.route(`**/api/v1/runs/${run.id}`, (route) => route.fulfill({ json: run }));
    await page.route('**/api/v1/reports?*', (route) =>
        route.fulfill({ json: { items: [], nextCursor: null } }),
    );
    await page.route(`**/api/v1/runs/${run.id}/events?*`, (route) =>
        route.fulfill({ contentType: 'text/event-stream', body: ': heartbeat\n\n' }),
    );
}

for (const width of [1440, 320]) {
    test(`研究运行图 ${width}：重复节点、恢复尝试与刷新保留状态`, async ({ page }, info) => {
        await installRun(page);
        await page.setViewportSize({ width, height: 1100 });
        await page.emulateMedia({ reducedMotion: 'reduce' });
        let reads = 0;
        await page.route(`**/api/v1/runs/${run.id}/graph`, (route) => {
            reads++;
            return route.fulfill({ json: graph() });
        });
        await page.goto(`/runs/${run.id}`);
        const region = page.getByRole('region', { name: '研究运行图', exact: true });
        await expect(region).toBeVisible();
        await expect(region).toContainText('读取正文');
        await region.getByRole('button', { name: /^搜索来源/ }).click();
        await expect(region).toContainText('中断');
        await expect(region.getByRole('region', { name: '搜索来源执行记录' })).toContainText(
            '节点实例 #2 · 2 次尝试',
        );
        await expect(region).toContainText('已完成');
        if (width === 320)
            await page.evaluate(() => {
                document.documentElement.style.fontSize = '200%';
            });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
            true,
        );
        await page.screenshot({ path: info.outputPath('research-graph.png'), fullPage: true });
        const before = reads;
        const refresh = region.getByRole('button', { name: '刷新运行图', exact: true });
        await refresh.focus();
        await refresh.press('Enter');
        await expect.poll(() => reads).toBeGreaterThan(before);
        await expect(refresh).toBeFocused();
        await page.reload();
        await region.getByRole('button', { name: /^搜索来源/ }).click();
        await expect(region).toContainText('中断');
    });
}

test('运行图从SSE过期游标重新读取权威快照', async ({ page }) => {
    await installRun(page);
    let current = graph();
    let reads = 0;
    await page.route(`**/api/v1/runs/${run.id}/graph`, (route) => {
        reads++;
        return route.fulfill({ json: current });
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    let streams = 0;
    await page.route(`**/api/v1/runs/${run.id}/events?*`, async (route) => {
        if (++streams > 1)
            return route.fulfill({ contentType: 'text/event-stream', body: ': heartbeat\n\n' });
        await gate;
        return route.fulfill({
            contentType: 'text/event-stream',
            body: `event: stream.reset\ndata: ${JSON.stringify({
                schemaVersion: 1,
                type: 'stream.reset',
                runId: run.id,
                payload: { reason: 'cursor_expired', snapshot: run, resumeAfter: 30 },
            })}\n\n`,
        });
    });
    await page.goto(`/runs/${run.id}`);
    const region = page.getByRole('region', { name: '研究运行图', exact: true });
    await expect(region).toBeVisible();
    await expect.poll(() => reads).toBeGreaterThan(0);
    const before = reads;
    current = {
        ...graph(),
        seq: 30,
        instances: [
            ...graph().instances.map((instance) => ({
                ...instance,
                attempts: instance.attempts.map((attempt) =>
                    attempt.status === 'running'
                        ? {
                              ...attempt,
                              status: 'succeeded' as const,
                              finishedAt: instant,
                              durationMs: 500,
                          }
                        : attempt,
                ),
            })),
            {
                instanceId: id(23),
                step: 'synthesize',
                ordinal: 4,
                attempts: [
                    {
                        attemptId: id(34),
                        number: 1,
                        status: 'running',
                        startedAt: instant,
                        finishedAt: null,
                        durationMs: null,
                    },
                ],
            },
        ],
    };
    release();
    await expect.poll(() => reads).toBeGreaterThan(before);
    await expect(region.getByRole('status')).toContainText('当前：综合回答');
});
