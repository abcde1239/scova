import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import type {
    ProjectReportEvidence,
    ProjectScheduleActionReceipt,
    ProjectSettings,
    ProjectThread,
    ProjectThreadAttachment,
    ProjectThreadItem,
    Report,
    RunCommandResponse,
    SendProjectTurn,
} from '@scova/models';
import { mockFixtureSession } from './support/session-sample.ts';

const id = (serial: number) => `00000000-0000-4000-8000-${String(serial).padStart(12, '0')}`;
const projectId = id(91);
const firstThread = id(92);
const secondThread = id(93);
const reportId = id(94);
const taskId = id(95);
const runId = id(96);
const attachmentId = id(106);
const attachmentText = '本周数据待核对。\n';
const attachmentFile = '能源数据.txt';
const timestamp = '2026-11-24T10:00:00.000Z';
const projectPath = `/projects/${projectId}`;
const threadPath = (threadId: string) => `${projectPath}/threads/${threadId}`;

async function mockWorkbench(
    page: Page,
    options: { launchRun?: boolean; beforeCancel?: (attempt: number) => Promise<boolean> } = {},
) {
    await mockFixtureSession(page);
    const project = { id: projectId, name: '能源研究', createdAt: timestamp };
    const thread = (id: string, title: string, isDefault = false): ProjectThread => ({
        id,
        title,
        projectId,
        isDefault,
        archivedAt: null,
        createdAt: timestamp,
        lastActivityAt: timestamp,
    });
    const threads = [thread(firstThread, '季度能源市场', true), thread(secondThread, '政策追踪')];
    const turns: string[] = [];
    const submitted: SendProjectTurn[] = [];
    const settings: ProjectSettings = {
        projectId,
        goal: '',
        requirements: '',
        preferredSources: [],
        defaultAutonomy: 'ask',
        updatedAt: null,
    };
    const approved: string[] = [];
    const cursors: number[] = [];
    type Item = Omit<ProjectThreadItem, 'kind'> & { kind: string };
    const timeline = new Map<string, Item[]>();
    function item(
        threadId: string,
        turnId: string | null,
        kind: string,
        payload: Record<string, unknown>,
        status: string | null,
    ): Item {
        const seq = (timeline.get(threadId)?.length ?? 0) + 1;
        return {
            id: id(500 + seq),
            threadId,
            turnId,
            seq,
            kind,
            payload,
            status,
            refs: [],
            createdAt: timestamp,
        };
    }
    function append(
        threadId: string,
        turnId: string | null,
        kind: string,
        payload: Record<string, unknown>,
        status: string | null,
    ) {
        const next = item(threadId, turnId, kind, payload, status);
        timeline.set(threadId, [...(timeline.get(threadId) ?? []), next]);
        return next;
    }
    append(firstThread, null, 'message', { role: 'assistant', text: '上次研究已完成。' }, null);
    append(firstThread, null, 'run', { runId, status: 'succeeded' }, 'succeeded');
    append(firstThread, null, 'report', { runId, unavailable: true }, 'succeeded');
    let runCancellations = 0;
    await page.route(`**/api/v1/runs/${runId}/cancel`, async (route) => {
        expect(route.request().method()).toBe('POST');
        expect(route.request().headers()['x-csrf-token']).toBe('fixture-only');
        const attempt = ++runCancellations;
        if (options.beforeCancel && !(await options.beforeCancel(attempt)))
            return route.fulfill({
                status: 503,
                json: {
                    code: 'UNAVAILABLE',
                    message: '取消暂时失败，请重试。',
                    requestId: 'fixture',
                },
            });
        const result: RunCommandResponse = {
            reused: false,
            run: {
                id: runId,
                taskId,
                taskVersionId: id(101),
                parentRunId: null,
                baselineRunId: null,
                mode: 'live',
                status: 'cancel_requested',
                outcome: null,
                trigger: 'manual',
                budget: {
                    maxSearches: 2,
                    maxPages: 3,
                    maxDurationSeconds: 60,
                    maxInputTokens: 1000,
                    maxOutputTokens: 500,
                },
                usage: { searches: 0, pages: 0, inputTokens: 0, outputTokens: 0, estimated: false },
                coverage: null,
                queuedAt: timestamp,
                startedAt: timestamp,
                finishedAt: null,
                failureCode: null,
            },
        };
        return route.fulfill({ json: result });
    });
    let simulateLostResponse = true;
    const planTitle = '比较主要市场的能源补贴';
    const report: Report = {
        id: reportId,
        taskId,
        runId,
        title: '季度能源报告',
        taskVersionId: id(101),
        schemaVersion: 1,
        baselineRunId: null,
        summary: '供给仍受季节因素影响。\n\n预计第四季政策保持稳定。',
        format: 'brief',
        mode: 'demo',
        outcome: 'inconclusive',
        coverage: { completeness: 'partial', searchedQueries: [], gaps: [], exhausted: [] },
        claims: [
            {
                id: id(102),
                kind: 'fact',
                text: '市场审查按季度更新。',
                confidenceLabel: '样本',
                evidenceIds: [id(103)],
            },
        ],
        evidence: [
            {
                id: id(103),
                sourceId: id(104),
                snapshotId: id(105),
                title: '季度样本',
                url: 'https://example.test/quarter',
                quote: '市场审查按季度更新。',
                location: '摘要',
                observedAt: timestamp,
            },
        ],
        changes: [],
        limitations: ['本报告仅覆盖一个季度。'],
        publishedAt: timestamp,
    };
    await page.route(`**/api/v1/reports/${reportId}`, (route) => route.fulfill({ json: report }));
    await page.route(`**/api/v1/tasks/${taskId}/project`, (route) =>
        route.fulfill({ json: { project } }),
    );
    await page.route('**/api/v1/projects**', async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path.endsWith('/threads')) {
            if (route.request().method() === 'POST') {
                expect(route.request().headers()['x-csrf-token']).toBe('fixture-only');
                const created = thread(id(97), '新会话');
                threads.unshift(created);
                return route.fulfill({ status: 201, json: created });
            }
            return route.fulfill({ json: { items: threads } });
        }
        if (path.endsWith('/settings')) {
            const request = route.request();
            if (request.method() === 'PATCH') {
                expect(request.headers()['x-csrf-token']).toBe('fixture-only');
                Object.assign(settings, request.postDataJSON(), { updatedAt: timestamp });
            }
            return route.fulfill({ json: settings });
        }
        if (path.endsWith('/conversation'))
            return route.fulfill({ json: { turns: [], drafts: [] } });
        if (path.endsWith(projectId))
            return route.fulfill({
                json: {
                    project,
                    tasks: {
                        items: [
                            { id: taskId, title: '能源周报', status: 'active', nextRunAt: null },
                        ],
                        nextCursor: null,
                    },
                    recentRuns: [],
                    recentReports: [
                        {
                            id: reportId,
                            title: '季度能源报告',
                            taskId,
                            runId,
                            publishedAt: timestamp,
                        },
                    ],
                },
            });
        return route.fulfill({ json: { items: [project], nextCursor: null } });
    });
    await page.route('**/api/v1/threads/**', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const [, threadId = '', ...action] = url.pathname.split('/').slice(3);
        const found = threads.find((item) => item.id === threadId);
        if (!found) return route.fulfill({ status: 404, json: {} });
        const after = Number(url.searchParams.get('after') ?? 0);
        const items = (timeline.get(threadId) ?? []).filter((item) => item.seq > after);
        if (request.method() !== 'GET')
            expect(request.headers()['x-csrf-token']).toBe('fixture-only');
        if (action[0] === 'attachments') {
            const attachment: ProjectThreadAttachment = {
                id: attachmentId,
                threadId: secondThread,
                filename: attachmentFile,
                format: 'txt',
                byteLength: Buffer.byteLength(attachmentText),
                textAvailable: true,
                createdAt: timestamp,
            };
            if (!action[1] && request.method() === 'POST') {
                expect(url.searchParams.get('filename')).toBe(attachmentFile);
                expect(request.postData()).toBe(attachmentText);
                expect(request.headers()['content-type']).toMatch(/^text\/plain/);
                return route.fulfill({ status: 201, json: attachment });
            }
            if (threadId !== secondThread || action[1] !== attachmentId)
                return route.fulfill({ status: 404, json: {} });
            if (action[2] === 'download')
                return route.fulfill({
                    contentType: 'application/octet-stream',
                    body: attachmentText,
                });
            return route.fulfill({ json: attachment });
        }
        if (action[0] === 'events') {
            cursors.push(after);
            return route.fulfill({
                contentType: 'text/event-stream',
                body: items
                    .map(
                        (item) => `id: ${item.seq}\nevent: item\ndata: ${JSON.stringify(item)}\n\n`,
                    )
                    .join(''),
            });
        }
        if (action[0] === 'turns' && action[2] === 'cancel') {
            const turnId = action[1]!;
            append(
                threadId,
                turnId,
                'message',
                { role: 'assistant', text: '本轮已停止。' },
                'canceled',
            );
            return route.fulfill({ json: { turnId, status: 'canceled' } });
        }
        if (action[0] === 'turns') {
            const input = request.postDataJSON() as SendProjectTurn;
            turns.push(input.turnId);
            submitted.push(input);
            if (
                (input.message === '待重试的内容' || input.message === '这段摘要有哪些限制？') &&
                simulateLostResponse
            ) {
                simulateLostResponse = false;
                return route.abort('failed');
            }
            if (input.message === '生成研究提案')
                expect(input.refs).toEqual([{ kind: 'report', id: reportId }]);
            const userItem = append(
                threadId,
                input.turnId,
                'message',
                { role: 'user', text: input.message },
                'running',
            );
            userItem.refs = input.refs ?? [];
            if (input.message === '暂停能源周报') {
                append(
                    threadId,
                    input.turnId,
                    'message',
                    { role: 'assistant', text: '周期提案已生成。' },
                    'completed',
                );
                append(
                    threadId,
                    input.turnId,
                    'schedule',
                    { command: 'pause_task', taskId, revision: 1 },
                    'pending',
                );
                return route.fulfill({ json: { turnId: input.turnId, status: 'completed' } });
            }
            if (input.message === '生成研究提案') {
                append(
                    threadId,
                    input.turnId,
                    'message',
                    { role: 'assistant', text: '请确认以下提案。' },
                    'completed',
                );
                append(
                    threadId,
                    input.turnId,
                    'new_item_kind',
                    { text: '不应直接展示的未知数据' },
                    null,
                );
                append(
                    threadId,
                    input.turnId,
                    'plan',
                    {
                        command: 'start_run',
                        draftId: id(98),
                        revision: 1,
                        config: { title: planTitle },
                    },
                    'pending',
                );
                return route.fulfill({ json: { turnId: input.turnId, status: 'completed' } });
            }
            return route.fulfill({ json: { turnId: input.turnId, status: 'running' } });
        }
        const proposal = (timeline.get(threadId) ?? []).find(
            (item) => item.id === action[1] && item.kind === 'schedule',
        );
        if (
            action[0] === 'items' &&
            proposal &&
            (action[2] === 'approve' || action[2] === 'undo')
        ) {
            const applying = action[2] === 'approve';
            const receipt: ProjectScheduleActionReceipt = {
                actionId: proposal.id,
                command: 'pause_task',
                status: applying ? 'applied' : 'undone',
                taskId,
                taskRevision: applying ? 2 : 3,
                runId: null,
                undoable: applying,
            };
            append(threadId, proposal.turnId, 'schedule', receipt, receipt.status);
            return route.fulfill({ json: receipt });
        }
        if (action[0] === 'items' && action[2] === 'approve') {
            const actionId = action[1]!;
            approved.push(actionId);
            append(threadId, null, 'plan', { actionId, taskId, runId }, 'applied');
            if (options.launchRun)
                append(threadId, null, 'run', { runId, taskId, status: 'queued' }, 'queued');
            return route.fulfill({ json: { actionId, status: 'applied', taskId, runId } });
        }
        if (request.method() === 'PATCH') {
            const body = request.postDataJSON() as { title?: string; archived?: boolean };
            if (body.title) found.title = body.title;
            if (body.archived !== undefined) found.archivedAt = body.archived ? timestamp : null;
            return route.fulfill({ json: found });
        }
        return route.fulfill({
            json: { thread: found, items, lastSeq: items.at(-1)?.seq ?? after, hasMore: false },
        });
    });
    return {
        turns,
        approved,
        cursors,
        planTitle,
        submitted,
        finishRun(status: 'succeeded' | 'canceled') {
            return append(
                secondThread,
                null,
                'run',
                { runId, status, finishedAt: timestamp },
                status,
            );
        },
        get runCancellations() {
            return runCancellations;
        },
    };
}

test('project entry, keyboard send and stop, resend, approval, and SSE resume', async ({
    page,
}) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const fixture = await mockWorkbench(page);
    await page.goto(projectPath);
    await expect(page).toHaveURL(threadPath(firstThread));
    await expect(page.getByRole('heading', { name: '季度能源市场' })).toBeVisible();
    await expect(page.getByText('上次研究已完成。')).toBeVisible();
    await expect(page.getByText('原报告已移出项目。')).toBeVisible();
    await expect(page.getByRole('link', { name: '打开报告' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: '查看运行' })).toHaveAttribute(
        'href',
        `/runs/${runId}`,
    );
    await page.getByRole('link', { name: '政策追踪' }).click();
    await expect(page).toHaveURL(threadPath(secondThread));
    const composer = page.getByRole('textbox', { name: '给 Scova 发送消息' });
    await expect(composer).toHaveAttribute('maxlength', '2000');
    await composer.fill('待重试的内容');
    await composer.press('Enter');
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(composer).toHaveValue('待重试的内容');
    await composer.press('Enter');
    const stop = page.getByRole('button', { name: '停止', exact: true });
    await expect(stop).toBeVisible();
    await expect(page.getByText('待重试的内容', { exact: true })).toBeVisible();
    await stop.press('Enter');
    await expect(page.getByText('本轮已停止。')).toBeVisible();
    expect(fixture.turns[0]).toBe(fixture.turns[1]);
    await composer.fill('生成研究提案');
    await page.getByText('引用报告', { exact: true }).click();
    await page.getByRole('checkbox', { name: '季度能源报告' }).check();
    await composer.press('Enter');
    await expect(
        page.getByRole('region', { name: '会话记录' }).getByText(fixture.planTitle),
    ).toBeVisible();
    const button = page.getByRole('button', { name: '批准并开始研究' });
    await button.press('Enter');
    await expect(page.getByText('已批准', { exact: true })).toBeVisible();
    const approvedPlan = page.locator('article').filter({ hasText: fixture.planTitle });
    await expect(approvedPlan.getByRole('link', { name: '查看运行' })).toHaveAttribute(
        'href',
        `/runs/${runId}`,
    );
    await expect(page.getByText('会话记录', { exact: true })).toBeVisible();
    await expect(page.getByText('不应直接展示的未知数据')).toHaveCount(0);
    expect(fixture.approved).toHaveLength(1);
    expect(fixture.cursors.some((cursor) => cursor > 0)).toBe(true);
});

test('desktop resize and persistence, mobile drawers, and thread lifecycle', async ({
    page,
}, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mockWorkbench(page);
    await page.goto(threadPath(firstThread));
    const left = page.getByRole('separator', { name: '项目导航宽度' });
    const right = page.getByRole('separator', { name: '项目概览宽度' });
    await expect(left).toHaveAttribute('aria-valuenow', '256');
    await left.press('Shift+ArrowRight');
    await expect(left).toHaveAttribute('aria-valuenow', '320');
    const rightBounds = await right.boundingBox();
    expect(rightBounds).not.toBeNull();
    const x = rightBounds!.x + rightBounds!.width / 2;
    await page.mouse.move(x, rightBounds!.y + 80);
    await page.mouse.down();
    await page.mouse.move(0, rightBounds!.y + 80, { steps: 4 });
    await page.mouse.up();
    expect(await right.getAttribute('aria-valuenow')).toBe(
        await right.getAttribute('aria-valuemax'),
    );
    expect(
        (await page.getByRole('region', { name: '会话记录' }).boundingBox())?.width,
    ).toBeGreaterThanOrEqual(384);
    await page.reload();
    await expect(left).toHaveAttribute('aria-valuenow', '320');
    await expect(right).toHaveAttribute('aria-valuenow', '736');
    await right.press('Enter');
    await expect(right).toHaveAttribute('aria-valuenow', '320');
    await page.screenshot({ path: testInfo.outputPath('project-thread-desktop.png') });

    await page.setViewportSize({ width: 375, height: 812 });
    await expect(left).toHaveCount(0);
    await expect(right).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);
    const overview = page.getByRole('button', { name: '项目概览', exact: true });
    await overview.press('Enter');
    await expect(page.getByRole('dialog', { name: '项目概览' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(overview).toBeFocused();
    await page.getByRole('button', { name: '打开个人侧栏' }).click();
    const sidebar = page.getByRole('dialog');
    await expect(sidebar.getByRole('link', { name: '新建任务' })).toHaveAttribute(
        'href',
        '/tasks/new',
    );
    await expect(sidebar.getByRole('link', { name: '报告历史' })).toHaveAttribute(
        'href',
        '/tasks/reports',
    );
    await sidebar.getByRole('button', { name: '新建会话' }).click();
    await expect(page).toHaveURL(threadPath(id(97)));
    await page.getByRole('button', { name: '重命名' }).click();
    const title = page.getByRole('textbox', { name: '会话标题' });
    await expect(title).toBeFocused();
    await title.fill('政策分析二期');
    await title.press('Enter');
    await expect(page.getByRole('heading', { name: '政策分析二期' })).toBeFocused();
    await page.getByRole('button', { name: '归档', exact: true }).click();
    await expect(page.getByText('此会话已归档。恢复会话后可以继续发送消息。')).toBeVisible();
    await page.getByRole('button', { name: '恢复会话' }).click();
    await expect(page.getByRole('textbox', { name: '给 Scova 发送消息' })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('project-thread-mobile.png') });
    await page.goto(`${projectPath}#project-conversation-heading`);
    await expect(page.getByRole('heading', { name: '项目对话' })).toBeVisible();
});

test('production report reader previews a paragraph and sends only its anchor with the user message', async ({
    page,
}) => {
    await page.setViewportSize({ width: 375, height: 812 });
    const fixture = await mockWorkbench(page);
    await page.goto(threadPath(secondThread));
    const textbox = page.getByRole('textbox', { name: '给 Scova 发送消息' });
    await expect(textbox).toBeVisible();
    await textbox.fill('这段摘要有哪些限制？');
    await page.getByRole('button', { name: '项目概览', exact: true }).click();
    await page.getByRole('tab', { name: '成果' }).click();
    await page.getByRole('button', { name: /侧栏阅读\s*：季度能源报告/ }).click();
    const reading = page.getByRole('dialog', { name: '报告阅读' });
    await expect(reading.getByRole('heading', { name: '季度能源报告' })).toBeVisible();
    await expect(reading.getByRole('link', { name: '打开全文' })).toHaveAttribute(
        'href',
        `/reports/${reportId}`,
    );
    await reading.getByRole('button', { name: /引用到对话\s*：报告摘要 第 2 段/ }).press('Enter');
    await expect(reading).toHaveCount(0);
    await expect(textbox).toBeFocused();
    await expect(textbox).toHaveValue('这段摘要有哪些限制？');
    await expect(page.getByText('季度能源报告 · 第 2 段', { exact: true })).toHaveAttribute(
        'title',
        '预计第四季政策保持稳定。',
    );
    await textbox.press('Enter');
    await expect(page.getByRole('alert')).toBeVisible();
    await textbox.press('Enter');
    await expect(page.getByRole('button', { name: '停止', exact: true })).toBeVisible();
    expect(fixture.submitted).toHaveLength(2);
    expect(fixture.submitted[0]).toEqual(fixture.submitted[1]);
    expect(fixture.submitted[1]?.message).toBe('这段摘要有哪些限制？');
    expect(fixture.submitted[1]?.refs).toEqual([
        { kind: 'report', id: reportId, anchor: { kind: 'summary', paragraphIndex: 1 } },
    ]);
    await page.getByRole('button', { name: '停止', exact: true }).press('Enter');
    await page.getByRole('button', { name: '编辑并重试' }).click();
    await expect(textbox).toHaveValue('这段摘要有哪些限制？');
    await expect(page.getByText('季度能源报告 · 第 2 段', { exact: true })).toHaveAttribute(
        'title',
        '预计第四季政策保持稳定。',
    );
    await expect(
        page.getByRole('button', { name: '移除引用：季度能源报告 · 第 2 段' }),
    ).toBeVisible();
    await page.reload();
    await page.getByRole('button', { name: '编辑并重试' }).click();
    await expect(textbox).toHaveValue('这段摘要有哪些限制？');
    await expect(page.getByText('季度能源报告 · 第 2 段', { exact: true })).toBeVisible();
    await textbox.press('Enter');
    await expect.poll(() => fixture.submitted.length).toBe(3);
    expect(fixture.submitted[2]?.message).toBe('这段摘要有哪些限制？');
    expect(fixture.submitted[2]?.refs).toEqual(fixture.submitted[1]?.refs);
});

test('report sources share the reference limit and survive reload retry', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    const fixture = await mockWorkbench(page);
    const firstRead = Promise.withResolvers<void>();
    const evidence: ProjectReportEvidence = {
        id: reportId,
        taskId,
        title: '季度能源报告',
        summary: '季度概况',
        publishedAt: timestamp,
        sources: [
            {
                sourceId: id(107),
                snapshotId: id(108),
                title: '能源监管公报',
                canonicalUrl: 'https://example.test/bulletin',
            },
            {
                sourceId: id(109),
                snapshotId: id(110),
                title: '季度数据集',
                canonicalUrl: 'https://example.test/data',
            },
        ],
    };
    let reads = 0;
    await page.route(
        `**/api/v1/projects/${projectId}/evidence/reports/${reportId}`,
        async (route) => {
            expect(route.request().method()).toBe('GET');
            if (++reads === 1) {
                await firstRead.promise;
                return route.fulfill({
                    status: 503,
                    json: { code: 'UNAVAILABLE', message: '试验', requestId: 'fixture' },
                });
            }
            return route.fulfill({ json: evidence });
        },
    );
    await page.goto(threadPath(secondThread));
    const composer = page.getByRole('textbox', { name: '给 Scova 发送消息' });
    await composer.fill('请核对这条来源。');
    await page.getByText('引用报告', { exact: true }).click();
    await page.getByRole('checkbox', { name: '季度能源报告' }).check();
    await page.getByText('本轮选项', { exact: true }).click();
    await page.getByRole('combobox', { name: '关联项目任务' }).selectOption(taskId);

    async function openSources() {
        const readingToggle = page.getByRole('button', { name: '报告阅读', exact: true });
        if (await readingToggle.isVisible()) {
            await readingToggle.click();
        } else {
            await page.getByRole('button', { name: '项目概览', exact: true }).click();
            await page.getByRole('tab', { name: '成果' }).click();
            await page.getByRole('button', { name: /侧栏阅读\s*：季度能源报告/ }).click();
        }
        const reader = page.getByRole('dialog', { name: '报告阅读' });
        const sources = reader.getByText('报告来源', { exact: true });
        await expect(sources).toBeVisible();
        const open = await sources.evaluate((element) => element.closest('details')?.open);
        if (!open) await sources.press('Enter');
        return reader;
    }
    const reader = await openSources();
    await expect(reader.getByText('正在读取报告来源…')).toBeVisible();
    firstRead.resolve();
    await expect(reader.getByRole('alert')).toHaveText('报告来源暂不可用。');
    await reader.getByRole('button', { name: '重试读取来源' }).click();
    await reader.getByRole('button', { name: /引用此来源\s*：能源监管公报/ }).press('Enter');
    await expect(composer).toBeFocused();
    await expect(composer).toHaveValue('请核对这条来源。');
    await expect(page.getByRole('button', { name: '移除来源：能源监管公报' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);

    await (await openSources()).getByRole('button', { name: /引用此来源\s*：季度数据集/ }).click();
    await expect(page.getByRole('alert')).toContainText('一条消息最多添加 3 条引用');
    await expect(page.getByRole('button', { name: '移除来源：季度数据集' })).toHaveCount(0);
    await composer.press('Enter');
    await page.getByRole('button', { name: '停止', exact: true }).click();
    const refs = [
        { kind: 'report', id: reportId },
        { kind: 'source', reportId, snapshotId: id(108) },
        { kind: 'task', id: taskId },
    ];
    expect(fixture.submitted[0]).toMatchObject({ message: '请核对这条来源。', refs });
    await page.reload();
    await page.getByRole('button', { name: '编辑并重试' }).click();
    await expect(page.getByRole('list', { name: '已引用来源' })).toBeVisible();
    await composer.press('Enter');
    await expect.poll(() => fixture.submitted.length).toBe(2);
    expect(fixture.submitted[1]).toMatchObject({ message: '请核对这条来源。', refs });
});

test('project settings update the composer and a schedule decision survives reload', async ({
    page,
}) => {
    await page.setViewportSize({ width: 375, height: 812 });
    const fixture = await mockWorkbench(page);
    await page.goto(threadPath(secondThread));
    const options = page.getByText('本轮选项', { exact: true });
    const autonomy = page.getByRole('combobox', { name: '本轮自主度' });
    await options.press('Enter');
    await expect(autonomy.getByRole('option', { name: '项目默认 · 每次询问' })).toBeAttached();
    await page.getByRole('button', { name: '项目概览', exact: true }).click();
    const overview = page.getByRole('dialog', { name: '项目概览' });
    await overview.getByRole('tab', { name: '设定' }).click();
    await overview.getByRole('combobox', { name: '默认自主度' }).selectOption('autonomous');
    await overview.getByRole('button', { name: '保存设定' }).click();
    await expect(overview.getByText('设定已保存。')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(autonomy.getByRole('option', { name: '项目默认 · 自主执行' })).toBeAttached();
    await autonomy.selectOption('ask');
    await page.getByRole('combobox', { name: '关联项目任务' }).selectOption(taskId);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);

    const textbox = page.getByRole('textbox', { name: '给 Scova 发送消息' });
    await textbox.fill('暂停能源周报');
    await textbox.press('Enter');
    const card = page
        .locator('article')
        .filter({ has: page.getByRole('heading', { name: '暂停周期任务' }) });
    await expect(card.getByText('待确认')).toBeVisible();
    expect(fixture.submitted[0]).toMatchObject({
        autonomy: 'ask',
        refs: [{ kind: 'task', id: taskId }],
    });
    await card.getByRole('button', { name: '批准计划' }).click();
    await expect(card.getByText('已应用')).toBeVisible();
    await page.reload();
    await expect(card.getByText('已应用')).toBeVisible();
    await card.getByRole('button', { name: '撤销' }).click();
    await expect(card.getByText('已撤销')).toBeVisible();
    await page.reload();
    await expect(card.getByText('已撤销')).toBeVisible();
    await expect(card.getByRole('button', { name: '撤销' })).toHaveCount(0);
});

async function launchResearch(page: Page) {
    await page.goto(threadPath(secondThread));
    const composer = page.getByRole('textbox', { name: '给 Scova 发送消息' });
    await composer.fill('生成研究提案');
    await page.getByText('引用报告', { exact: true }).click();
    await page.getByRole('checkbox', { name: '季度能源报告' }).check();
    await composer.press('Enter');
    await page.getByRole('button', { name: '批准并开始研究' }).click();
    return page.locator('article').filter({
        has: page.getByRole('heading', { name: '研究运行', exact: true }),
    });
}

test('queued Run can retry cancellation and its later terminal item replaces the card', async ({
    page,
}) => {
    await page.setViewportSize({ width: 375, height: 812 });
    const first = Promise.withResolvers<boolean>();
    const fixture = await mockWorkbench(page, {
        launchRun: true,
        beforeCancel: (attempt) => (attempt === 1 ? first.promise : Promise.resolve(true)),
    });
    const run = await launchResearch(page);
    await expect(run.getByText('排队中')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);
    const cancel = run.getByRole('button', { name: '取消运行' });
    await cancel.press('Enter');
    await expect(cancel).toHaveAttribute('aria-busy', 'true');
    await expect.poll(() => fixture.runCancellations).toBe(1);
    await cancel.press('Enter');
    await cancel.press('Space');
    expect(fixture.runCancellations).toBe(1);
    first.resolve(false);
    await expect(run.getByRole('alert')).toHaveText('取消暂时失败，请重试。');
    await expect(cancel).toBeFocused();
    await cancel.press('Enter');
    await expect(run.getByText('正在取消')).toBeVisible();
    await expect(run.getByText('已取消')).toHaveCount(0);
    await expect(cancel).toHaveCount(0);
    await expect(run.getByRole('link', { name: '查看运行' })).toBeFocused();
    expect(fixture.runCancellations).toBe(2);

    fixture.finishRun('canceled');
    await expect(run).toHaveCount(1);
    await expect(run.getByText('已取消')).toBeVisible();
    await expect(cancel).toHaveCount(0);
    await expect(run.getByText('正在取消')).toHaveCount(0);
    await page.reload();
    await expect(run).toHaveCount(1);
    await expect(run.getByText('已取消')).toBeVisible();
    await expect(cancel).toHaveCount(0);
});

test('a terminal Run from SSE takes precedence over an in-flight cancel response', async ({
    page,
}) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const command = Promise.withResolvers<boolean>();
    const fixture = await mockWorkbench(page, {
        launchRun: true,
        beforeCancel: () => command.promise,
    });
    const run = await launchResearch(page);
    const cancel = run.getByRole('button', { name: '取消运行' });
    await cancel.click();
    await expect(cancel).toHaveAttribute('aria-busy', 'true');
    await expect.poll(() => fixture.runCancellations).toBe(1);

    fixture.finishRun('succeeded');
    await expect(run).toHaveCount(1);
    await expect(run.getByText('已完成')).toBeVisible();
    await expect(cancel).toHaveCount(0);
    const response = page.waitForResponse((reply) => reply.url().endsWith(`/runs/${runId}/cancel`));
    command.resolve(true);
    await response;
    await expect(run.getByText('已完成')).toBeVisible();
    await expect(run.getByText('正在取消')).toHaveCount(0);
    await expect(cancel).toHaveCount(0);
    expect(fixture.runCancellations).toBe(1);
});

test('composer uploads a private attachment and timeline downloads the original bytes', async ({
    page,
}) => {
    await page.setViewportSize({ width: 375, height: 812 });
    const fixture = await mockWorkbench(page);
    await page.goto(threadPath(secondThread));
    await page.getByText('附件', { exact: true }).click();
    await page.getByLabel('添加附件', { exact: true }).setInputFiles({
        name: attachmentFile,
        mimeType: 'text/plain',
        buffer: Buffer.from(attachmentText),
    });
    await expect(page.getByRole('button', { name: '移除附件：能源数据.txt' })).toBeVisible();
    const composer = page.getByRole('textbox', { name: '给 Scova 发送消息' });
    await composer.fill('核对上传的数据');
    await composer.press('Enter');
    const attachment = page.getByRole('button', { name: '下载附件：能源数据.txt' });
    await expect(attachment).toBeVisible();
    expect(fixture.submitted[0]).toMatchObject({
        message: '核对上传的数据',
        refs: [{ kind: 'attachment', id: attachmentId }],
    });
    await page.getByRole('button', { name: '停止', exact: true }).click();
    await page.reload();
    const saving = page.waitForEvent('download');
    await attachment.click();
    const download = await saving;
    expect(download.suggestedFilename()).toBe(attachmentFile);
    expect(await readFile(await download.path(), 'utf8')).toBe(attachmentText);
    await page.getByRole('button', { name: '编辑并重试' }).click();
    await expect(composer).toHaveValue('核对上传的数据');
    await composer.press('Enter');
    await expect.poll(() => fixture.submitted.length).toBe(2);
    expect(fixture.submitted[1]?.refs).toEqual(fixture.submitted[0]?.refs);
});
