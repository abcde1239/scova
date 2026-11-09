import { logoutFromAccount, expectAccountReady } from './support/account-menu.ts';
import { chooseOption } from './support/select.ts';
import { expect, test, type Page } from '@playwright/test';
type Status =
    | 'queued'
    | 'running'
    | 'recovering'
    | 'cancel_requested'
    | 'succeeded'
    | 'partial'
    | 'failed'
    | 'canceled';
type Mode = 'demo' | 'live';

const runId = '00000000-0000-4000-8000-000000000011';
const taskId = '00000000-0000-4000-8000-000000000012';
const reportId = '00000000-0000-4000-8000-000000000013';
const instant = '2026-10-31T00:00:00Z';
const account = {
    user: {
        id: taskId,
        email: 'browser-run@example.test',
        preferences: {
            defaultTimezone: 'UTC',
            notificationPreference: { mode: 'summary', runIssues: true },
        },
        createdAt: instant,
    },
    csrfToken: 'local-browser-only',
};
const failure = { code: 'LOCAL_SAMPLE', message: 'local sample', requestId: 'sample-only' };
const states: Record<Status, string> = {
    queued: '等待执行',
    running: '正在查阅',
    recovering: '系统恢复中',
    cancel_requested: '正在取消',
    succeeded: '已完成',
    partial: '已生成结果',
    failed: '执行失败',
    canceled: '已取消',
};
function snapshot(status: Status = 'partial', mode: Mode = 'live') {
    return {
        id: runId,
        taskId,
        taskVersionId: taskId,
        parentRunId: null,
        baselineRunId: null,
        mode,
        status,
        outcome:
            status === 'partial'
                ? 'inconclusive'
                : status === 'succeeded'
                  ? 'no_important_change'
                  : null,
        trigger: 'manual',
        budget: {
            maxSearches: 2,
            maxPages: 3,
            maxDurationSeconds: 60,
            maxInputTokens: 1000,
            maxOutputTokens: 500,
        },
        usage: { searches: 2, pages: 1, inputTokens: 700, outputTokens: 120, estimated: true },
        coverage: ['partial', 'succeeded'].includes(status)
            ? {
                  completeness: status === 'partial' ? 'partial' : 'complete',
                  searchedQueries: ['来源摘要'],
                  gaps: status === 'partial' ? ['部分来源读取失败，尚未核验冲突证据。'] : [],
                  exhausted: status === 'partial' ? ['searches', 'time'] : [],
              }
            : null,
        queuedAt: instant,
        startedAt: status === 'queued' ? null : instant,
        finishedAt: ['succeeded', 'partial', 'failed', 'canceled'].includes(status)
            ? instant
            : null,
        failureCode: status === 'failed' ? 'DEADLINE_EXCEEDED' : null,
    };
}
function event(seq: number, type: 'tool.started' | 'tool.completed' = 'tool.started') {
    const common = {
        schemaVersion: 1 as const,
        eventId: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
        runId,
        seq,
        occurredAt: instant,
    };
    return type === 'tool.started'
        ? {
              ...common,
              type,
              payload: {
                  toolCallId: taskId,
                  tool: 'search',
                  summary: 'DO_NOT_RENDER sk-secret raw prompt <script>alert(1)</script>',
              },
          }
        : {
              ...common,
              type,
              payload: {
                  toolCallId: taskId,
                  tool: 'search',
                  durationMs: 1250,
                  usage: snapshot().usage,
              },
          };
}

for (const width of [390, 1440]) {
    test(`本次输出形式选择与warning/error显示 ${width}`, async ({ page }) => {
        await page.setViewportSize({ width, height: 1000 });
        await install(page, snapshot('failed'));
        const warnings = [
            { ...event(1), type: 'step.started', payload: { step: 'read' } },
            {
                ...event(2),
                type: 'tool.failed',
                payload: {
                    toolCallId: taskId,
                    tool: 'read',
                    code: 'TOOL_HTTP_NOT_FOUND',
                    message: 'DO_NOT_RENDER',
                    retryable: false,
                    severity: 'warning',
                },
            },
            {
                ...event(3),
                type: 'run.failed',
                payload: { status: 'failed', code: 'NO_EVIDENCE', message: 'DO_NOT_RENDER' },
            },
        ];
        await page.route(`**/api/v1/runs/${runId}/events?*`, (route) =>
            route.fulfill({
                contentType: 'text/event-stream',
                body: warnings
                    .map(
                        (entry) =>
                            `id: ${entry.eventId}\nevent: ${entry.type}\ndata: ${JSON.stringify(entry)}\n\n`,
                    )
                    .join(''),
            }),
        );
        const bodies: unknown[] = [];
        await page.route(`**/api/v1/runs/${runId}/retry`, async (route) => {
            bodies.push(route.request().postDataJSON());
            await route.fulfill({
                status: 202,
                json: {
                    run: {
                        ...snapshot('queued'),
                        id: reportId,
                        parentRunId: runId,
                        trigger: 'retry',
                    },
                    reused: false,
                },
            });
        });
        for (const [value, label] of [
            ['brief', '简报'],
            ['list', '主题清单'],
            ['comparison', '对比表'],
            ['research_report', '研究报告'],
        ]) {
            await page.goto(`/runs/${runId}`);
            const logs = page.getByRole('region', { name: '执行日志内容' });
            await expect(logs.locator('li.warning')).toContainText('warning');
            await expect(logs.locator('li.warning')).toContainText('检查链接');
            await expect(logs.locator('li.error')).toContainText('error');
            await expect(logs).not.toContainText('DO_NOT_RENDER');
            await chooseOption(page, '本次输出形式', label!);
            await page.getByRole('button', { name: '重试并创建新执行', exact: true }).click();
            await expect(page.getByRole('link', { name: '打开执行', exact: true })).toBeVisible();
            expect(bodies.at(-1)).toMatchObject({ mode: 'live', outputFormat: value });
            await noOverflow(page);
        }
    });
}

test('实时日志按阶段筛选、失败原因脱敏并跟随新事件', async ({ page }) => {
    let current = snapshot('running');
    await install(page, current);
    await page.route(`**/api/v1/runs/${runId}`, (route) => route.fulfill({ json: current }));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    let requests = 0;
    const started = { ...event(1), type: 'step.started', payload: { step: 'read' } };
    const failed = {
        ...event(2),
        type: 'tool.failed',
        payload: {
            toolCallId: taskId,
            tool: 'read',
            code: 'TOOL_UNSAFE_URL',
            message: 'DO_NOT_RENDER sk-secret',
            retryable: false,
        },
    };
    await page.route(`**/api/v1/runs/${runId}/events?*`, async (route) => {
        if (++requests === 1)
            return route.fulfill({
                contentType: 'text/event-stream',
                body: `id: ${started.eventId}\nevent: ${started.type}\ndata: ${JSON.stringify(started)}\n\n`,
            });
        await gate;
        current = snapshot('failed');
        await route.fulfill({
            contentType: 'text/event-stream',
            body: `id: ${failed.eventId}\nevent: ${failed.type}\ndata: ${JSON.stringify(failed)}\n\n`,
        });
    });
    await page.goto(`/runs/${runId}`);
    const logs = page.getByRole('region', { name: '执行日志内容' });
    await expect(logs).toContainText('读取网页 · 开始');
    await expect(page.getByLabel('跟随最新')).toBeChecked();
    await page.getByLabel('跟随最新').uncheck();
    await page.getByLabel('仅 warning / error').check();
    await expect(logs).toContainText('当前筛选下没有日志');
    release();
    await expect(logs).toContainText('TOOL_UNSAFE_URL');
    await expect(logs).toContainText('公网安全校验');
    await expect(logs).not.toContainText('sk-secret');
    await expect(page.getByRole('heading', { name: '执行失败', exact: true })).toBeVisible();
    await page.getByRole('button', { name: /读取网页.*0 次警告 · 1 次错误/ }).click();
    await expect(logs).toContainText('TOOL_UNSAFE_URL');
    await expect(page.getByLabel('跟随最新')).not.toBeChecked();
    await page.getByLabel('跟随最新').check();
});

test('研究统计与固定诊断区分合法结论和请求成功', async ({ page }) => {
    const current = snapshot('partial');
    const enriched = {
        ...current,
        coverage: {
            ...current.coverage!,
            research: {
                candidates: 30,
                selected: 5,
                readAttempts: 5,
                readSuccess: 3,
                relatedPages: 2,
                supplementalSearches: 1,
                acceptedClaims: 4,
                rejectedClaims: 1,
                cacheHits: 1,
                networkAttempts: 2,
            },
        },
    };
    await install(page, current);
    await page.route(`**/api/v1/runs/${runId}`, (route) => route.fulfill({ json: enriched }));
    const diagnostic = {
        ...event(3),
        type: 'research.updated',
        payload: { state: 'claims_repair' },
    };
    await page.route(`**/api/v1/runs/${runId}/events?*`, (route) =>
        route.fulfill({
            contentType: 'text/event-stream',
            body: `id: ${diagnostic.eventId}\nevent: research.updated\ndata: ${JSON.stringify(diagnostic)}\n\n`,
        }),
    );
    await page.goto(`/runs/${runId}`);
    await expect(page.getByText('正文成功 3 / 5 次', { exact: false })).toBeVisible();
    await expect(page.getByText('保留结论 4 条', { exact: false })).toBeVisible();
    await expect(page.getByRole('region', { name: '执行日志内容' })).toContainText(
        '已保留合法结论',
    );
    await expect(page.getByText('本次使用启动时的预算快照', { exact: false })).toBeVisible();
    await noOverflow(page);
});
function frame(message: ReturnType<typeof event>) {
    return `id: ${message.eventId}\nevent: ${message.type}\ndata: ${JSON.stringify(message)}\n\n`;
}
function report(run: ReturnType<typeof snapshot>, id = reportId) {
    return {
        id,
        runId: run.id,
        taskId: run.taskId,
        taskVersionId: run.taskVersionId,
        title: '本地报告样本',
        summary: '报告入口匹配样本',
        format: 'brief',
        mode: run.mode,
        outcome: run.outcome,
        coverage: run.coverage,
        publishedAt: instant,
    };
}
async function install(page: Page, run: ReturnType<typeof snapshot>) {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/api/v1/me', (route) => route.fulfill({ json: account }));
    await page.route(`**/api/v1/runs/${runId}`, (route) => route.fulfill({ json: run }));
    await page.route('**/api/v1/reports?*', (route) =>
        route.fulfill({
            json: {
                items: ['succeeded', 'partial'].includes(run.status) ? [report(run)] : [],
                nextCursor: null,
            },
        }),
    );
    await page.route(`**/api/v1/runs/${runId}/events?*`, (route) =>
        route.fulfill({
            contentType: 'text/event-stream',
            body: frame(event(1)) + frame(event(2, 'tool.completed')),
        }),
    );
    return errors;
}
async function noOverflow(page: Page) {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
    );
    expect(
        await page.locator('#main-content').evaluate((element) => getComputedStyle(element).cursor),
    ).not.toBe('progress');
}

for (const status of ['succeeded', 'partial'] as const) {
    test(`正在查看的执行${status}后优先进入报告，返回执行详情不会再次跳转`, async ({ page }) => {
        let current = snapshot('running');
        let reportUnavailable = status === 'partial';
        await install(page, current);
        await page.route(`**/api/v1/runs/${runId}`, (route) => route.fulfill({ json: current }));
        await page.route('**/api/v1/reports?*', (route) =>
            reportUnavailable
                ? route.fulfill({ status: 503, json: failure })
                : route.fulfill({
                      json: {
                          items: current.status === 'running' ? [] : [report(current)],
                          nextCursor: null,
                      },
                  }),
        );
        await page.route(`**/api/v1/reports/${reportId}`, (route) =>
            route.fulfill({
                json: {
                    ...report(current),
                    baselineRunId: null,
                    schemaVersion: 1,
                    limitations: current.coverage?.gaps ?? [],
                    changes: [],
                    claims: [
                        {
                            id: taskId,
                            kind: 'fact',
                            text: '来源已公开课程价格。',
                            confidenceLabel: '来源陈述',
                            evidenceIds: [runId],
                        },
                    ],
                    evidence: [
                        {
                            id: runId,
                            sourceId: taskId,
                            snapshotId: reportId,
                            title: '课程价格',
                            url: 'https://example.test/course',
                            quote: '来源已公开课程价格。',
                            location: '第一段',
                            observedAt: instant,
                        },
                    ],
                },
            }),
        );
        await page.goto(`/runs/${runId}`);
        await expect(page.getByRole('heading', { name: '正在查阅', exact: true })).toBeVisible();
        current = snapshot(status);
        await page.getByRole('button', { name: '刷新快照', exact: true }).click();
        if (reportUnavailable) {
            await expect(
                page.getByRole('button', { name: '重试查找报告', exact: true }),
            ).toBeVisible();
            await expect(page).toHaveURL(new RegExp(`/runs/${runId}$`));
            reportUnavailable = false;
            await page.getByRole('button', { name: '重试查找报告', exact: true }).click();
        }
        await expect(page).toHaveURL(new RegExp(`/reports/${reportId}$`));
        await expect(page.getByRole('article', { name: '本地报告样本' })).toContainText(
            '来源已公开课程价格。',
        );
        await page.getByRole('link', { name: '执行详情', exact: true }).click();
        await expect(page).toHaveURL(new RegExp(`/runs/${runId}$`));
        const sections = page.locator('.execution-detail > section');
        await expect(sections.first()).toHaveAttribute('aria-labelledby', 'report-title');
        await expect(page.getByRole('link', { name: '查看已发布报告' })).toHaveAttribute(
            'href',
            `/reports/${reportId}`,
        );
    });
}

for (const width of [320, 390, 768, 1024, 1440, 1920]) {
    for (const mode of ['demo', 'live'] as const) {
        for (const status of ['partial', 'failed'] as const) {
            test(`本地HTTP样本 ${width}/${mode}/${status} 布局与事实`, async ({
                page,
            }, testInfo) => {
                await page.setViewportSize({ width, height: 1000 });
                const errors = await install(page, snapshot(status, mode));
                await page.goto(`/runs/${runId}`);
                await expect(
                    page.getByRole('heading', { name: states[status], exact: true }),
                ).toBeVisible();
                await expect(
                    page.getByText(mode === 'demo' ? '演示模式 · Demo' : '真实查阅 · Live', {
                        exact: true,
                    }),
                ).toBeVisible();
                await page.getByText('执行标识与时间', { exact: true }).click();
                await expect(page.getByText('固定任务版本', { exact: true })).toBeVisible();
                await expect(page.getByText('已读取终态快照，实时连接结束。')).toBeVisible();
                await expect(page.getByRole('region', { name: '执行日志内容' })).toContainText(
                    '搜索来源 · 调用已完成',
                );
                expect(await page.locator('.execution-detail').innerText()).not.toMatch(
                    /DO_NOT_RENDER|sk-secret|raw prompt|100%/,
                );
                if (status === 'partial') {
                    await expect(
                        page.getByText('部分来源读取失败，尚未核验冲突证据。', { exact: true }),
                    ).toBeVisible();
                    await expect(
                        page.getByText('已耗尽预算：搜索、执行时间', { exact: true }),
                    ).toBeVisible();
                    await expect(
                        page.getByRole('link', { name: '查看已发布报告' }),
                    ).toHaveAttribute('href', `/reports/${reportId}`);
                } else {
                    await expect(
                        page.getByText('执行时间预算已耗尽，未完成交付。', { exact: true }),
                    ).toBeVisible();
                    await expect(
                        page.getByText('本次执行未完成报告交付。', { exact: true }),
                    ).toBeVisible();
                    await expect(page.getByRole('link', { name: '查看已发布报告' })).toHaveCount(0);
                }
                await noOverflow(page);
                await page.evaluate(async () => {
                    await document.fonts.ready;
                });
                await page.screenshot({
                    path: testInfo.outputPath('run-detail.png'),
                    fullPage: true,
                });
                expect(errors).toEqual([]);
            });
        }
    }
}
test('本地HTTP样本：全部持久状态，完整无变化与失败/不完整分开', async ({ page }) => {
    for (const status of Object.keys(states) as Status[]) {
        await install(page, snapshot(status));
        await page.goto(`/runs/${runId}`);
        await expect(
            page.getByRole('heading', { name: states[status], exact: true }),
        ).toBeVisible();
        if (status === 'succeeded')
            await expect(page.getByText('本次范围内未发现重要变化', { exact: true })).toBeVisible();
        else
            await expect(page.getByText('本次范围内未发现重要变化', { exact: true })).toHaveCount(
                0,
            );
        if (status === 'recovering')
            await expect(
                page.getByText('系统正在恢复上次执行，不需要手动继续。', { exact: true }),
            ).toBeVisible();
        await expect(page.getByRole('button', { name: /取消执行|恢复执行|重试执行/ })).toHaveCount(
            0,
        );
    }
});
for (const [status, label, answeredQuestions, answeredCoreQuestions] of [
    ['answered', '核心问题已回答', 1, 1],
    ['partial', '已生成部分答案', 1, 0],
    ['sources_only', '已保存来源资料', 0, 0],
] as const) {
    test(`交付情况独立于严格完整度：执行页 ${status}`, async ({ page }) => {
        const run = snapshot('partial');
        await install(page, {
            ...run,
            coverage: {
                ...run.coverage!,
                delivery: {
                    status,
                    answeredQuestions,
                    answeredCoreQuestions,
                    questionCount: 2,
                    coreQuestionCount: 1,
                },
            },
        } as ReturnType<typeof snapshot>);
        await page.goto(`/runs/${runId}`);
        await expect(page.getByRole('heading', { name: label, exact: true })).toBeVisible();
        await expect(page.getByRole('link', { name: '查看已发布报告' })).toBeVisible();
        await expect(page.getByText('本次范围内未发现重要变化', { exact: true })).toHaveCount(0);
        await expect(
            page.getByText('部分来源读取失败，尚未核验冲突证据。', { exact: true }),
        ).toBeVisible();
    });
}
for (const width of [390, 768, 1440]) {
    test(`本地HTTP样本：${width} 文字200%与键盘刷新`, async ({ page }, testInfo) => {
        await page.setViewportSize({ width, height: 1000 });
        await install(page, snapshot());
        await page.goto(`/runs/${runId}`);
        await expect(page.getByRole('heading', { name: '已生成结果', exact: true })).toBeVisible();
        await page.evaluate(() => {
            document.documentElement.style.fontSize = '200%';
        });
        const refresh = page.getByRole('button', { name: '刷新快照' });
        await refresh.focus();
        await refresh.press('Enter');
        await expect(refresh).not.toHaveAttribute('aria-busy', 'true');
        await expect(refresh).toBeFocused();
        await expect(
            page.getByText('部分来源读取失败，尚未核验冲突证据。', { exact: true }),
        ).toBeVisible();
        await noOverflow(page);
        await page.screenshot({ path: testInfo.outputPath('text-200.png'), fullPage: true });
    });
}
test('本地HTTP样本：读取失败可重试、404不误判Run失败、非法ID不发请求', async ({ page }) => {
    await install(page, snapshot('running'));
    let attempts = 0;
    await page.route(`**/api/v1/runs/${runId}`, (route) =>
        route.fulfill(
            ++attempts === 1 ? { status: 503, json: failure } : { json: snapshot('running') },
        ),
    );
    await page.goto(`/runs/${runId}`);
    await expect(page.getByRole('status')).toContainText('暂时无法读取执行');
    const retry = page.getByRole('button', { name: '重试', exact: true });
    await retry.focus();
    await retry.press('Enter');
    await expect(page.getByRole('heading', { name: '正在查阅', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '正在查阅', exact: true })).toBeFocused();
    await page.route(`**/api/v1/runs/${runId}`, (route) =>
        route.fulfill({ status: 404, json: failure }),
    );
    await page.reload();
    await expect(page.getByRole('status')).toContainText('执行不存在或无权访问');
    await expect(page.getByRole('heading', { name: '执行失败', exact: true })).toHaveCount(0);
    await page.goto('/runs/invalid');
    await expect(page.getByRole('status')).toContainText('执行地址无效');
});
test('本地HTTP样本：截断后提示重连，终态仍由快照决定；刷新在途Run恢复', async ({ page }) => {
    await install(page, snapshot('running'));
    let current = snapshot('running');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    let attempts = 0;
    await page.route(`**/api/v1/runs/${runId}`, (route) => route.fulfill({ json: current }));
    await page.route(`**/api/v1/runs/${runId}/events?*`, async (route) => {
        if (++attempts === 1)
            return route.fulfill({
                contentType: 'text/event-stream',
                body: frame(event(1)) + 'event: run.failed\ndata: {',
            });
        await gate;
        current = snapshot();
        await route.fulfill({
            contentType: 'text/event-stream',
            body: frame(event(2, 'tool.completed')),
        });
    });
    await page.goto(`/runs/${runId}`);
    await expect(
        page.getByText('实时连接中断，正在有限重连；后台执行不会因此判为失败。'),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: '正在查阅', exact: true })).toBeVisible();
    release();
    await expect(page.getByRole('heading', { name: '已生成结果', exact: true })).toBeVisible();
    await expect(page.getByText('已读取终态快照，实时连接结束。')).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: '已生成结果', exact: true })).toBeVisible();
});
test('本地HTTP样本：报告分页只匹配当前执行，报告查找失败可恢复', async ({ page }) => {
    const run = snapshot();
    await install(page, run);
    let failed = true;
    await page.route('**/api/v1/reports?*', (route) => {
        if (failed) return route.fulfill({ status: 503, json: failure });
        return route.fulfill({
            json: route.request().url().includes('cursor=next')
                ? { items: [report(run)], nextCursor: null }
                : { items: [{ ...report(run), runId: taskId }], nextCursor: 'next' },
        });
    });
    await page.goto(`/runs/${runId}`);
    await expect(page.getByText('报告入口暂时无法读取，请重试查找。')).toBeVisible();
    failed = false;
    await page.getByRole('button', { name: '重试查找报告' }).click();
    await expect(page.getByRole('link', { name: '查看已发布报告' })).toHaveCount(0);
    await page.getByRole('button', { name: '继续查找报告' }).click();
    await expect(page.getByRole('link', { name: '查看已发布报告' })).toHaveAttribute(
        'href',
        `/reports/${reportId}`,
    );
});
test('本地HTTP样本：卸载取消等待请求，退出换号不展示旧流事实', async ({ page }) => {
    await install(page, snapshot('running'));
    let nextAccount = false;
    const canceled: string[] = [];
    page.on('requestfailed', (request) => {
        if (request.url().includes('/events?')) canceled.push(request.failure()?.errorText ?? '');
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    await page.route('**/api/v1/auth/logout', (route) => route.fulfill({ status: 204 }));
    await page.route('**/api/v1/auth/login', (route) => {
        nextAccount = true;
        return route.fulfill({
            json: {
                ...account,
                user: { ...account.user, id: runId, email: 'second@example.test' },
            },
        });
    });
    await page.route(`**/api/v1/runs/${runId}`, (route) =>
        route.fulfill({ json: snapshot(nextAccount ? 'failed' : 'running') }),
    );
    await page.route(`**/api/v1/runs/${runId}/events?*`, async (route) => {
        if (nextAccount) return route.fulfill({ contentType: 'text/event-stream', body: '' });
        await gate;
        await route
            .fulfill({ contentType: 'text/event-stream', body: frame(event(1)) })
            .catch(() => {});
    });
    await page.goto(`/runs/${runId}`);
    await expect(page.getByRole('heading', { name: '正在查阅', exact: true })).toBeVisible();
    await logoutFromAccount(page);
    await expect.poll(() => canceled.some((reason) => reason.includes('ERR_ABORTED'))).toBe(true);
    await page.getByLabel('邮箱', { exact: true }).fill('second@example.test');
    await page.getByLabel('密码', { exact: true }).fill('local-only-password');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('heading', { name: '执行失败', exact: true })).toBeVisible();
    release();
    await expect(page.getByRole('region', { name: '执行日志内容' })).not.toContainText('调用开始');
    await expect(page.getByRole('link', { name: '查看已发布报告' })).toHaveCount(0);
    await page
        .getByRole('navigation', { name: '主导航', exact: true })
        .getByRole('link', { name: '任务', exact: true })
        .click();
    await expect(page.locator('.execution-detail')).toHaveCount(0);
});
test('本地HTTP样本：离开页面取消在途快照，不显示迟到旧执行', async ({ page }) => {
    await install(page, snapshot());
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const canceled: string[] = [];
    page.on('requestfailed', (request) => {
        if (request.url().endsWith(`/runs/${runId}`))
            canceled.push(request.failure()?.errorText ?? '');
    });
    await page.route(`**/api/v1/runs/${runId}`, async (route) => {
        await gate;
        await route.fulfill({ json: snapshot() }).catch(() => {});
    });
    await page.goto(`/runs/${runId}`);
    await expect(page.getByRole('status')).toContainText('正在读取执行快照');
    await page
        .getByRole('navigation', { name: '主导航', exact: true })
        .getByRole('link', { name: '任务', exact: true })
        .click();
    await expect.poll(() => canceled.some((reason) => reason.includes('ERR_ABORTED'))).toBe(true);
    release();
    await expect(page.locator('.execution-detail')).toHaveCount(0);
});
test('本地HTTP样本：连接403只停止实时更新，不退出或改变运行状态', async ({ page }) => {
    await install(page, snapshot('running'));
    await page.route(`**/api/v1/runs/${runId}/events?*`, (route) =>
        route.fulfill({ status: 403, json: failure }),
    );
    await page.goto(`/runs/${runId}`);
    await expect(page.getByText('实时连接已停止，执行结果尚需读取快照确认。')).toBeVisible();
    await expect(page.getByRole('heading', { name: '正在查阅', exact: true })).toBeVisible();
    await expectAccountReady(page);
});
test('本地HTTP样本：深色主题和减少透明度保持内容可读', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.addInitScript(() => {
        localStorage.setItem(
            'scova.appearance.v1',
            JSON.stringify({ version: 1, mode: 'dark', accent: 'iris' }),
        );
    });
    await install(page, snapshot());
    await page.goto(`/runs/${runId}`);
    await expect(page.locator('.scova-theme--dark')).toBeVisible();
    await expect(page.getByText('已读取终态快照，实时连接结束。')).toBeVisible();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }],
    });
    expect(
        await page
            .locator('.connection')
            .evaluate((element) => getComputedStyle(element).backdropFilter),
    ).toBe('none');
    await page.screenshot({ path: testInfo.outputPath('dark-reduced.png'), fullPage: true });
    await cdp.detach();
    await noOverflow(page);
});
