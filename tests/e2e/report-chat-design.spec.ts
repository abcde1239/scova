import { expect, test, type Page } from '@playwright/test';
import type {
    Report,
    ReportQuestion,
    Run,
    ReportConversation,
} from '../../packages/models/src/index.ts';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const instant = '2026-11-12T00:00:00Z';
const budget = {
    maxSearches: 8,
    maxPages: 12,
    maxDurationSeconds: 300,
    maxInputTokens: 40000,
    maxOutputTokens: 8000,
};
const report: Report = {
    id: id(1),
    taskId: id(2),
    runId: id(3),
    taskVersionId: id(4),
    baselineRunId: null,
    schemaVersion: 1,
    title: 'Agent 架构与对话循环',
    summary: '固定流程、反馈循环与共享状态适用于不同的任务。',
    format: 'brief',
    mode: 'live',
    outcome: 'inconclusive',
    coverage: {
        completeness: 'partial',
        searchedQueries: ['Agent architecture'],
        gaps: ['中断恢复未覆盖'],
        exhausted: [],
    },
    limitations: ['中断恢复未覆盖'],
    claims: [
        {
            id: id(10),
            kind: 'fact',
            text: '状态图在节点之间传递共享状态。',
            confidenceLabel: '来自原文',
            evidenceIds: [id(20)],
        },
    ],
    evidence: [
        {
            id: id(20),
            sourceId: id(21),
            snapshotId: id(22),
            title: '状态图与执行状态',
            url: 'https://graphs.example.org/state',
            quote: '状态图在节点之间传递共享状态。人工确认会暂停执行。',
            location: '第 1 段',
            observedAt: instant,
        },
    ],
    changes: [],
    publishedAt: instant,
};
function turn(n: number, text: string): ReportQuestion & { round: number } {
    return {
        id: id(50 + n),
        reportId: report.id,
        question: text,
        followupRunId: null,
        revisionRunId: null,
        createdAt: new Date(Date.parse(instant) + n * 1000).toISOString(),
        round: n,
        answer: {
            status: 'answered',
            reason: 'evidence_answer',
            needsResearch: false,
            usage: { attempts: 1, inputTokens: 120, outputTokens: 80, estimated: false },
            statements: [
                {
                    kind: 'inference',
                    text: '已有资料说明了节点间如何传递状态。',
                    citations: [{ evidenceId: id(20), quote: '状态图在节点之间传递共享状态。' }],
                },
                {
                    kind: 'inference',
                    text: '人工确认可以暂停执行，恢复方式需要进一步查阅。',
                    citations: [{ evidenceId: id(20), quote: '人工确认会暂停执行。' }],
                },
            ],
        },
    };
}
function run(n: number, status: Run['status'] = 'queued'): Run {
    return {
        id: id(n),
        taskId: id(2),
        taskVersionId: id(4),
        parentRunId: n === 3 ? null : id(3),
        baselineRunId: null,
        mode: 'live',
        trigger: n === 3 ? 'manual' : 'followup',
        status,
        outcome: status === 'partial' ? 'inconclusive' : null,
        budget,
        usage: { searches: 0, pages: 0, inputTokens: 0, outputTokens: 0, estimated: false },
        coverage: status === 'partial' ? report.coverage : null,
        queuedAt: instant,
        startedAt: status === 'queued' ? null : instant,
        finishedAt: ['partial', 'failed', 'canceled'].includes(status) ? instant : null,
        failureCode: status === 'failed' ? 'NO_EVIDENCE' : null,
    };
}
async function fixture(page: Page, initial = true) {
    const state = {
        turns: initial ? [turn(1, '报告如何解释中断机制？')] : ([] as ReturnType<typeof turn>[]),
        artifacts: [] as NonNullable<ReportConversation['artifacts']>,
        mergeRuns: [] as NonNullable<ReportConversation['mergeRuns']>,
        continuations: [] as NonNullable<ReportConversation['continuations']>,
        posts: [] as { path: string; body: any; key?: string }[],
        reports: new Map([[report.id, report]]),
        runs: new Map([[id(3), run(3, 'partial')]]),
        lost: false,
        loseMerge: false,
        loseCancel: false,
        invalidArtifact: false,
        unexpected: [] as string[],
    };
    await page.route('**/api/v1/**', async (route) => {
        const req = route.request(),
            path = new URL(req.url()).pathname.replace('/api/v1', ''),
            method = req.method();
        const error = (status = 404, code = 'NOT_FOUND') =>
            route.fulfill({ status, json: { code, message: 'sample', requestId: 'chat-design' } });
        if (path === '/me')
            return route.fulfill({
                json: {
                    user: {
                        id: id(100),
                        email: 'reader@example.test',
                        createdAt: instant,
                        preferences: {
                            defaultTimezone: 'UTC',
                            notificationPreference: { mode: 'summary', runIssues: true },
                        },
                    },
                    csrfToken: 'chat-design',
                },
            });
        if (method === 'POST')
            state.posts.push({
                path,
                body: req.postDataJSON(),
                key: req.headers()['idempotency-key'],
            });
        if (path === `/reports/${report.id}/conversation`)
            return route.fulfill({
                json: {
                    reportId: report.id,
                    turns: state.turns,
                    hasEarlier: false,
                    artifacts: state.artifacts,
                    mergeRuns: state.mergeRuns,
                    continuations: state.continuations,
                    activeRun: [...state.runs.values()].some(
                        (run) =>
                            run.id !== id(3) &&
                            ['queued', 'running', 'cancel_requested'].includes(run.status),
                    ),
                },
            });
        if (path === `/reports/${report.id}/questions` && method === 'POST') {
            const text = req.postDataJSON().question;
            const value = turn(state.turns.length + 1, text);
            state.turns.push(value);
            const { round: _round, ...question } = value;
            return route.fulfill({ status: 201, json: question });
        }
        if (/\/questions\/[^/]+$/.test(path)) {
            const value = state.turns.find((turn) => path.endsWith(turn.id));
            if (!value) return error();
            const { round: _round, ...question } = value;
            return route.fulfill({ json: question });
        }
        if (path.endsWith('/followup') && method === 'POST') {
            const operation = req.postDataJSON().operation ?? 'research';
            const saved = state.turns.find((turn) => path.includes(turn.id))!;
            const target = operation === 'revise' ? 62 : 60;
            const value = state.runs.get(id(target)) ?? run(target);
            state.runs.set(value.id, value);
            if (operation === 'revise') saved.revisionRunId = value.id;
            else saved.followupRunId = value.id;
            if (state.lost) {
                state.lost = false;
                return route.abort('failed');
            }
            return route.fulfill({
                status: 202,
                json: {
                    run: value,
                    reused: state.posts.filter((post) => post.path === path).length > 1,
                },
            });
        }
        if (path === `/reports/${report.id}/merge` && method === 'POST') {
            const value = state.runs.get(id(70)) ?? run(70);
            state.runs.set(value.id, value);
            state.mergeRuns = [{ runId: value.id, questionId: state.turns[0]!.id, round: 1 }];
            if (state.loseMerge) {
                state.loseMerge = false;
                return route.abort('failed');
            }
            return route.fulfill({ status: 202, json: { run: value, reused: true } });
        }
        if (/^\/runs\/[^/]+\/cancel$/.test(path)) {
            const value = state.runs.get(path.split('/')[2]!)!;
            if (state.loseCancel) {
                state.loseCancel = false;
                return route.abort('failed');
            }
            value.status = 'canceled';
            value.finishedAt = instant;
            return route.fulfill({ status: 202, json: { run: value, reused: false } });
        }
        if (/^\/runs\/[^/]+\/retry$/.test(path)) {
            const parent = state.runs.get(path.split('/')[2]!)!;
            const value = { ...run(61), parentRunId: parent.id, trigger: 'retry' as const };
            state.runs.set(value.id, value);
            state.continuations = [
                {
                    runId: value.id,
                    rootRunId: id(60),
                    questionId: state.turns[0]!.id,
                    operation: 'research',
                },
            ];
            return route.fulfill({ status: 202, json: { run: value, reused: false } });
        }
        if (/^\/runs\/[^/]+$/.test(path)) {
            const value = state.runs.get(path.split('/').at(-1)!);
            return value ? route.fulfill({ json: value }) : error();
        }
        if (path.endsWith('/events'))
            return route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' });
        if (path === '/reports') {
            const runId = new URL(req.url()).searchParams.get('runId');
            return route.fulfill({
                json: {
                    items: [...state.reports.values()]
                        .filter((value) => !runId || value.runId === runId)
                        .map((value) => ({
                            id: value.id,
                            runId: value.runId,
                            taskId: value.taskId,
                            taskVersionId: value.taskVersionId,
                            title: value.title,
                            summary: value.summary,
                            format: value.format,
                            mode: value.mode,
                            outcome: value.outcome,
                            publishedAt: value.publishedAt,
                            coverage: value.coverage,
                        })),
                    nextCursor: null,
                },
            });
        }
        if (/^\/reports\/[^/]+$/.test(path)) {
            const value = state.reports.get(path.split('/').at(-1)!);
            return value
                ? route.fulfill({
                      json:
                          state.invalidArtifact && value.id !== report.id
                              ? {
                                    ...value,
                                    conversation: { ...value.conversation, reportId: id(999) },
                                }
                              : value,
                  })
                : error();
        }
        if (path === '/notes') return route.fulfill({ json: { items: [], nextCursor: null } });
        if (path.endsWith('/feedback')) return route.fulfill({ json: { items: [] } });
        if (path === '/me/avatar')
            return route.fulfill({ json: { available: false, version: null } });
        state.unexpected.push(`${method} ${path}`);
        return error();
    });
    function complete(n = 60, operation: 'research' | 'revise' | 'merge' = 'research') {
        const value = state.runs.get(id(n))!;
        value.status = 'partial';
        value.coverage = report.coverage;
        value.outcome = 'inconclusive';
        value.finishedAt = instant;
        const artifact: Report = {
            ...report,
            id: id(n + 100),
            runId: value.id,
            title:
                operation === 'merge' ? '合并：Agent 架构与对话循环' : '中断与状态恢复的补充研究',
            summary:
                operation === 'merge'
                    ? '合并原报告与续作，形成完整论述。'
                    : '补充资料解释了暂停后的状态恢复。',
            conversation: { reportId: report.id, questionId: state.turns[0]!.id, operation },
        };
        state.reports.set(artifact.id, artifact);
        state.artifacts.push({
            reportId: artifact.id,
            runId: artifact.runId,
            questionId: state.turns[0]!.id,
            operation,
            title: artifact.title,
            round: 1,
        });
        return artifact;
    }
    return { state, complete };
}
const input = (page: Page) => page.getByRole('textbox', { name: '问题', exact: true });
const chat = (page: Page) => page.getByRole('region', { name: '报告对话', exact: true });
async function open(page: Page) {
    await page.goto(`/reports/${report.id}`);
    await expect(input(page)).toBeEditable();
}

test('retry follows the new run, survives refresh and replays uncertain stop with the same key', async ({
    page,
}) => {
    const { state } = await fixture(page);
    state.turns[0]!.followupRunId = id(60);
    state.runs.set(id(60), run(60, 'failed'));
    await open(page);
    const followup = page.getByRole('region', { name: '补充研究', exact: true });
    await followup.getByRole('button', { name: '重新执行', exact: true }).click();
    await expect(followup.getByRole('link', { name: '执行详情', exact: true })).toHaveAttribute(
        'href',
        `/runs/${id(61)}`,
    );
    await page.reload();
    await expect(followup.getByRole('link', { name: '执行详情', exact: true })).toHaveAttribute(
        'href',
        `/runs/${id(61)}`,
    );
    state.loseCancel = true;
    await followup.getByRole('button', { name: '停止执行', exact: true }).click();
    await expect(
        followup.getByRole('button', { name: '使用同一命令确认', exact: true }),
    ).toBeVisible();
    let dialogs = 0;
    page.on('dialog', async (dialog) => {
        dialogs++;
        await dialog.dismiss();
    });
    await page.getByRole('link', { name: '阅读外观', exact: true }).click();
    expect(dialogs).toBe(1);
    await followup.getByRole('button', { name: '使用同一命令确认', exact: true }).click();
    await expect(followup).toContainText('执行已停止');
    const commands = state.posts.filter((post) => post.path.endsWith('/cancel'));
    expect(commands).toHaveLength(2);
    expect(commands[0]!.path).toBe(`/runs/${id(61)}/cancel`);
    expect(commands[1]!.key).toBe(commands[0]!.key);
    expect(state.unexpected).toEqual([]);
});

test('artifact provenance is checked before display and can recover by reading again', async ({
    page,
}) => {
    const { state, complete } = await fixture(page);
    state.turns[0]!.followupRunId = id(60);
    state.runs.set(id(60), run(60));
    const saved = complete();
    state.invalidArtifact = true;
    await open(page);
    await page.locator('#conversation-artifact-select').selectOption(saved.id);
    await expect(page.locator('#report-artifact')).toContainText('关联不一致');
    await expect(page.locator('#report-artifact')).not.toContainText(saved.summary);
    state.invalidArtifact = false;
    await page
        .locator('#report-artifact')
        .getByRole('button', { name: '重试', exact: true })
        .click();
    await expect(page.locator('#report-artifact')).toContainText(saved.summary);
    expect(state.unexpected).toEqual([]);
});

test('desktop follows the design in both themes and reading keeps keyboard focus inside', async ({
    page,
}) => {
    await fixture(page);
    await open(page);
    const followup = page.getByRole('region', { name: '补充研究', exact: true });
    await followup.getByRole('button', { name: '据此补查新资料', exact: true }).click();
    await expect(followup.locator('.plan-card')).toContainText('最多搜索 8 次');
    const timeline = page.locator('.conversation-history');
    const composer = page.locator('.question-form');
    expect(
        await composer.evaluate((element) => element.getBoundingClientRect().top),
    ).toBeGreaterThanOrEqual(
        await timeline.evaluate((element) => element.getBoundingClientRect().bottom),
    );
    for (const dark of [false, true]) {
        await page.emulateMedia({ colorScheme: dark ? 'dark' : 'light', reducedMotion: 'reduce' });
        await page.locator('img[src^="/favicon.ico?"]').evaluateAll(async (images) => {
            await Promise.all(images.map((image) => (image as HTMLImageElement).decode()));
        });
        await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
        await page.screenshot({
            path: `artifacts/report-chat-design/v2/implementation-desktop-${dark ? 'dark' : 'light'}.png`,
            fullPage: true,
        });
    }
    await page.getByRole('button', { name: '完整阅读', exact: true }).click();
    const panel = page.getByRole('dialog', { name: '报告交付物', exact: true });
    await expect(page.locator('#report-title')).toBeFocused();
    const first = panel.getByRole('button', { name: '返回对话', exact: true });
    await first.focus();
    await page.keyboard.press('Shift+Tab');
    expect(await panel.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Tab');
    await expect(first).toBeFocused();
    await page.locator('#report-title').press('Escape');
    await expect(input(page)).toBeFocused();
});

test('continuous answers retain order, sources group once, suggestions fill without sending and IME is respected', async ({
    page,
}) => {
    const { state } = await fixture(page, false);
    await open(page);
    await chat(page).locator('.question-starters button').first().click();
    expect(state.posts).toHaveLength(0);
    await expect(input(page)).not.toHaveValue('');
    await input(page).dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true });
    expect(state.posts).toHaveLength(0);
    await input(page).fill('解释状态图');
    await input(page).press('Enter');
    await expect(chat(page).locator('.conversation-turn')).toHaveCount(1);
    await expect(input(page)).toHaveValue('');
    await expect(chat(page).locator('.question-starters')).toHaveCount(0);
    await input(page).fill('继续解释人工确认');
    await input(page).press('Enter');
    await expect(chat(page).locator('.conversation-turn')).toHaveCount(2);
    expect(await chat(page).locator('.user-message p').allTextContents()).toEqual([
        '解释状态图',
        '继续解释人工确认',
    ]);
    await expect(
        chat(page).locator('.conversation-turn').first().locator('.source-group'),
    ).toHaveCount(1);
    await chat(page).locator('.source-group').first().locator('summary').first().click();
    await expect(chat(page).locator('.source-group').first()).toContainText('人工确认会暂停执行。');
    await page.reload();
    await expect(chat(page).locator('.conversation-turn')).toHaveCount(2);
    expect(state.posts.filter((post) => post.path.endsWith('/questions'))).toHaveLength(2);
    expect(state.unexpected).toEqual([]);
});

test('inline plan exposes costs before start, uses stable key after lost response and cancels the real run', async ({
    page,
}) => {
    const { state } = await fixture(page);
    state.lost = true;
    await open(page);
    await page.getByRole('button', { name: '据此补查新资料', exact: true }).click();
    const plan = page.locator('.plan-card');
    await expect(plan).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(plan).toContainText('最多搜索 8 次');
    await expect(plan).toContainText('搜索方式：沿用任务');
    await plan.locator('input[value="list"]').check();
    expect(state.posts).toHaveLength(0);
    await plan.getByRole('button', { name: '开始执行', exact: true }).click();
    await expect(page.locator('.recovery-card')).toBeVisible();
    await page.getByRole('button', { name: '使用同一请求重发', exact: true }).click();
    await expect(page.locator('.run-card')).toContainText('等待执行');
    const commands = state.posts.filter((post) => post.path.endsWith('/followup'));
    expect(commands).toHaveLength(2);
    expect(commands[0]!.key).toBe(commands[1]!.key);
    expect(commands[0]!.body.outputFormats).toEqual(['list']);
    await page.getByRole('button', { name: '停止执行', exact: true }).click();
    await expect(page.locator('.run-card')).toContainText('执行已停止');
    expect(state.posts.some((post) => post.path.endsWith('/cancel'))).toBe(true);
    expect(state.unexpected).toEqual([]);
});

test('completed artifacts open in the same panel and merge replays safely to a separate saved report', async ({
    page,
}) => {
    const { state, complete } = await fixture(page);
    const first = state.turns[0]!;
    first.followupRunId = id(60);
    state.runs.set(id(60), run(60));
    const artifact = complete();
    await open(page);
    const card = page.locator('.run-card').first();
    await expect(card).toContainText(artifact.summary);
    await input(page).fill('保留这个问题草稿');
    await card.getByRole('button', { name: /打开成果/ }).click();
    await expect(page.locator('#report-artifact')).toContainText(artifact.summary);
    await expect(input(page)).toHaveValue('保留这个问题草稿');
    await expect(chat(page)).toContainText('讨论上下文：原报告');
    expect(page.url()).toContain(`/reports/${report.id}`);
    await page
        .locator('#report-artifact')
        .getByRole('button', { name: '合并到原报告', exact: true })
        .click();
    const merge = page.getByRole('region', { name: '合并报告', exact: true });
    await expect(merge).toBeVisible();
    state.loseMerge = true;
    await merge.getByRole('button', { name: '开始合并', exact: true }).click();
    await expect(
        merge.getByRole('button', { name: '使用同一请求确认', exact: true }),
    ).toBeVisible();
    await merge.getByRole('button', { name: '使用同一请求确认', exact: true }).click();
    await expect(merge.locator('.run-card')).toContainText('等待执行');
    const commands = state.posts.filter((post) => post.path.endsWith('/merge'));
    expect(commands).toHaveLength(2);
    expect(commands[0]!.key).toBe(commands[1]!.key);
    expect(commands[0]!.body.reportIds).toEqual([artifact.id]);
    await input(page).fill('');
    const merged = complete(70, 'merge');
    await page.reload();
    await expect(page.locator('#conversation-artifact-select')).toContainText(merged.title);
    await page.locator('#conversation-artifact-select').selectOption(merged.id);
    await expect(page.locator('#report-artifact')).toContainText(merged.summary);
    await page.locator('#conversation-artifact-select').selectOption(report.id);
    await expect(page.locator('#report-artifact')).toContainText(report.summary);
    expect(state.reports.get(report.id)).toEqual(report);
    expect(state.unexpected).toEqual([]);
});

for (const width of [320, 390])
    test(`mobile ${width}: fullscreen reading returns to conversation with draft at 200% text and no overflow`, async ({
        page,
    }) => {
        await page.setViewportSize({ width, height: 844 });
        await fixture(page);
        await open(page);
        await input(page).fill('尚未提交的草稿');
        await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
        await page.getByRole('button', { name: '成果', exact: true }).click();
        const artifact = page.locator('#report-artifact');
        await expect(artifact).toBeVisible();
        await expect(artifact).toHaveCSS('position', 'fixed');
        await page.screenshot({
            path: `artifacts/report-chat-design/v2/implementation-mobile-${width}.png`,
            fullPage: true,
        });
        expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
        await artifact.getByRole('button', { name: '返回对话', exact: true }).click();
        await expect(input(page)).toHaveValue('尚未提交的草稿');
        expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
    });
