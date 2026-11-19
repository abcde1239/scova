import { askReportQuestion, expectReportEvidence, openReportTool } from './support/report-tools.ts';
import {
    DEFAULT_TASK_BUDGET,
    type Report,
    type ReportQuestion,
    type Run,
    type TaskDetailResponse,
} from '@scova/models';
import { expect, test } from './support/environment.ts';
import {
    assertChangeCitations,
    attachProvenance,
    deliveryCounts,
    executeThroughUI,
    openReport,
    waitForDelivery,
} from './support/two-rounds.ts';

test.use({ actionTimeout: 15_000, navigationTimeout: 30_000 });

test('完整工作台：反馈后的重要变化、收藏笔记真实冲突、中文隔离检索、保存成果及显式关联研究', async ({
    environment,
}, info) => {
    const owner = await environment.owner();
    const other = await environment.owner();
    const page = owner.page;
    const config = environment.config();
    const task = await environment.task(owner, {
        ...config,
        budget: { ...DEFAULT_TASK_BUDGET, maxDurationSeconds: config.budget.maxDurationSeconds },
    });
    const originalTask = await environment.request<TaskDetailResponse>(
        owner,
        `/api/v1/tasks/${task.id}`,
    );
    const first = await executeThroughUI(environment, owner, task.id, {
        mode: 'live',
        scenario: 'english',
        phase: 'A',
    });
    await info.attach('baseline-report', {
        body: JSON.stringify(first.report),
        contentType: 'application/json',
    });
    expect(first.report.coverage.completeness).toBe('complete');
    expect(first.report.outcome).toBe('baseline');
    await openReport(page, first.report);
    await openReportTool(page, 'feedback');
    const source = first.report.evidence.find((evidence) => evidence.quote.includes('free access'));
    expect(source).toBeTruthy();
    await page
        .getByLabel('选择反馈资料或结论', { exact: true })
        .selectOption(`source:${source!.sourceId}`);
    await page.getByRole('button', { name: '已了解', exact: true }).press('Enter');
    await expect(page.locator('.selected-target')).toContainText('当前反馈：已了解');
    await openReportTool(page, 'bookmarks');
    await page.getByLabel('选择收藏来源', { exact: true }).selectOption(source!.sourceId);
    await page.getByRole('button', { name: '收藏来源', exact: true }).press('Enter');
    await expect(page.getByRole('button', { name: '取消收藏', exact: true })).toBeVisible();

    const noteText = '联合旅程核验笔记：费用变化需要保留双方原文。';
    await openReportTool(page, 'notes');
    await page.getByRole('button', { name: '新建笔记', exact: true }).press('Enter');
    await page.getByLabel('本地笔记正文', { exact: true }).fill(noteText);
    const created = page.waitForResponse(
        (response) =>
            new URL(response.url()).pathname === '/api/v1/notes' &&
            response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: '创建笔记', exact: true }).press('Enter');
    const note = ((await (await created).json()) as { note: { id: string; revision: number } })
        .note;
    await expect(page.getByRole('heading', { name: '编辑纯文本笔记' })).toBeVisible();
    await expect(
        page.getByRole('button', { name: '重新读取服务端副本', exact: true }),
    ).toBeEnabled();
    const localDraft = `${noteText} 保留冲突后的本地修订。`;
    await page.getByLabel('本地笔记正文', { exact: true }).fill(localDraft);
    const concurrent = await environment.response(owner, `/api/v1/notes/${note.id}`, {
        method: 'PATCH',
        body: { body: '另一编辑器已经保存的服务端版本' },
        headers: { 'if-match': `"${note.revision}"` },
    });
    expect(concurrent.status).toBe(200);
    const conflict = page.waitForResponse(
        (response) =>
            new URL(response.url()).pathname === `/api/v1/notes/${note.id}` &&
            response.request().method() === 'PATCH',
    );
    await page.getByRole('button', { name: '保存笔记', exact: true }).press('Enter');
    expect((await conflict).status()).toBe(409);
    await expect(
        page
            .locator('.scova-notifications .n-notification')
            .filter({ hasText: '修订冲突：本地稿已保留' }),
    ).toBeVisible();
    await expect(page.getByLabel('本地笔记正文', { exact: true })).toHaveValue(localDraft);
    await page.getByRole('button', { name: '重新读取服务端副本', exact: true }).press('Enter');
    await expect(page.locator('.server-copy')).toContainText('另一编辑器已经保存的服务端版本');
    await expect(page.getByLabel('本地笔记正文', { exact: true })).toHaveValue(localDraft);
    await page
        .getByRole('button', { name: '保留本地稿，按此版本整理', exact: true })
        .press('Enter');
    await page.getByRole('button', { name: '保存笔记', exact: true }).press('Enter');
    await expect(
        page.locator('.scova-notifications .n-notification').filter({ hasText: '笔记已保存。' }),
    ).toBeVisible();
    await page.getByRole('button', { name: '取消编辑', exact: true }).press('Enter');

    await page.goto('/library');
    await expect(page.locator('.bookmark-entry')).toContainText(source!.title);
    await page.getByRole('button', { name: '笔记', exact: true }).press('Enter');
    await expect(page.locator('.note-entry')).toContainText(localDraft);
    await page.goto('/library/search');
    await page.getByLabel('搜索已保存资料', { exact: true }).fill('联合旅程核验笔记');
    await page.getByLabel(/^资料类型/).selectOption('note', { timeout: 10_000 });
    await page.getByRole('button', { name: '搜索已存资料', exact: true }).press('Enter');
    await expect(page.locator('.search-result')).toHaveCount(1);
    await expect(page.locator('.search-excerpt')).toContainText('联合旅程核验笔记');
    await page.getByRole('link', { name: '查看笔记关联报告', exact: true }).press('Enter');
    await expect(page).toHaveURL(new RegExp(`/reports/${first.report.id}$`));
    await page.goto(`/library/sources/${source!.sourceId}/snapshots/${source!.snapshotId}`);
    await expect(page.locator('.snapshot-detail')).toBeVisible();
    await page.getByText('查看保留期内正文', { exact: true }).press('Enter');
    await expect(page.locator('.snapshot-body')).toContainText(source!.quote);

    const second = await executeThroughUI(environment, owner, task.id, {
        mode: 'live',
        scenario: 'english',
        phase: 'B',
    });
    await info.attach('comparison-report', {
        body: JSON.stringify(second.report),
        contentType: 'application/json',
    });
    expect(second.report.outcome).toBe('important_change');
    expect(
        second.report.changes.some(
            (change) =>
                change.important &&
                change.oldValue === 'free access' &&
                change.newValue === 'paid subscription',
        ),
    ).toBe(true);
    expect(
        second.report.feedbackEffects?.some(
            (effect) => effect.kind === 'known' && effect.targetId === source!.sourceId,
        ),
    ).toBe(true);
    expect(await environment.request<Report>(owner, `/api/v1/reports/${first.report.id}`)).toEqual(
        first.report,
    );
    await openReport(page, second.report);
    await assertChangeCitations(page, second.report, (change) => change.kind === 'changed');
    await expect(page.locator('.feedback-effects')).toBeVisible();
    const writes: string[] = [];
    const onRequest = (request: import('@playwright/test').Request) => {
        if (!['GET', 'HEAD'].includes(request.method()))
            writes.push(new URL(request.url()).pathname);
    };
    page.on('request', onRequest);
    await expect(page.getByLabel('报告形式', { exact: true })).toHaveCount(0);
    for (const format of second.report.coverage.artifacts?.map((artifact) => artifact.format) ?? [
        second.report.format,
    ]) {
        if ((second.report.coverage.artifacts?.length ?? 0) > 1)
            await page
                .getByRole('navigation', { name: '已生成成果', exact: true })
                .getByRole('button', {
                    name: {
                        brief: '简报',
                        list: '主题清单',
                        comparison: '对比表',
                        research_report: '研究报告',
                    }[format],
                    exact: true,
                })
                .click();
        expect(new URL(page.url()).pathname).toBe(`/reports/${second.report.id}`);
        await expect(page.locator('.report-frame')).toContainText(second.report.summary);
        await expectReportEvidence(page, second.report.evidence);
    }
    page.off('request', onRequest);
    expect(writes).toEqual([]);
    const beforeQuestions = await deliveryCounts(environment, owner, task.id);
    const insufficientId = await askReportQuestion(
        page,
        second.report.id,
        '费用变化是否需要进一步查证？',
    );
    await expect(
        page
            .locator('.assistant-message')
            .getByText('未配置可用的问答模型，暂时无法提取回答。', { exact: true }),
    ).toBeVisible();
    expect(await deliveryCounts(environment, owner, task.id)).toEqual(beforeQuestions);
    const insufficient = await environment.request<ReportQuestion>(
        owner,
        `/api/v1/reports/${second.report.id}/questions/${insufficientId}`,
    );
    expect(insufficient.answer.reason).toBe('model_unavailable');

    // The API entry changes explicitly; no production feature flag or remote model.
    await environment.services.useQuestionModel(true);
    await page.goto(`/reports/${second.report.id}`);
    const questionId = await askReportQuestion(
        page,
        second.report.id,
        '请引用本报告原文说明第一课有哪些音频和字幕。',
    );
    await expect(
        page.locator('.conversation-turn').last().locator('.answer-paragraph').first(),
    ).toBeVisible();
    const questionPath = `/api/v1/reports/${second.report.id}/questions/${questionId}`;
    const answered = await environment.request<ReportQuestion>(owner, questionPath);
    expect(answered.answer.reason).toBe('evidence_answer');
    const turn = page.locator(`#turn-${questionId}`);
    const sources = turn.getByLabel('本轮来源', { exact: true });
    for (const summary of await sources.locator('.source-group > summary').all())
        await summary.press('Enter');
    for (const statement of answered.answer.statements) {
        for (const citation of statement.citations) {
            const evidence = second.report.evidence.find((item) => item.id === citation.evidenceId);
            expect(evidence?.quote).toContain(citation.quote);
            await expect(
                sources
                    .locator('.source-quotes > div > blockquote')
                    .filter({ hasText: citation.quote }),
            ).toBeVisible();
        }
    }
    expect(await deliveryCounts(environment, owner, task.id)).toEqual(beforeQuestions);
    const followupWrites: unknown[] = [];
    page.on('request', (request) => {
        if (request.method() === 'POST' && request.url().endsWith('/followup'))
            followupWrites.push(request.postDataJSON());
    });
    const open = turn.getByRole('button', { name: '据此补查新资料', exact: true });
    await open.press('Enter');
    const plan = turn.getByRole('region', { name: '补查新资料', exact: true });
    await expect(plan.getByRole('heading', { name: '补查新资料', exact: true })).toBeFocused();
    await plan.getByRole('button', { name: '收起执行计划', exact: true }).press('Enter');
    await expect(plan).toHaveCount(0);
    await expect(open).toBeFocused();
    expect(followupWrites).toEqual([]);
    expect(await deliveryCounts(environment, owner, task.id)).toEqual(beforeQuestions);
    const baselines = async () =>
        JSON.parse(
            await environment.services.sql(
                `SELECT COALESCE(json_agg(json_build_object('id',id,'scope',comparison_scope_hash,'run',complete_run_id) ORDER BY id),'[]') FROM "${environment.services.schema}".baselines WHERE task_id='${task.id}'`,
            ),
        ) as { id: string; scope: string; run: string }[];
    const runScope = (runId: string) =>
        environment.services.sql(
            `SELECT comparison_scope_hash FROM "${environment.services.schema}".runs WHERE id='${runId}'`,
        );
    const originalScope = await runScope(second.run.id);
    const beforeBaselines = await baselines();
    expect(beforeBaselines).toHaveLength(1);
    expect(beforeBaselines[0]).toMatchObject({ scope: originalScope, run: second.run.id });
    await open.press('Enter');
    const confirmation = page.waitForResponse(
        (response) =>
            response.url().endsWith('/followup') && response.request().method() === 'POST',
    );
    const start = plan.getByRole('button', { name: '开始执行', exact: true });
    await expect(start).toBeEnabled();
    await start.press('Enter');
    const response = await confirmation;
    expect(response.status()).toBe(202);
    const linked = ((await response.json()) as { run: Run }).run;
    expect(followupWrites).toEqual([{ confirm: true }]);
    expect((await environment.request<ReportQuestion>(owner, questionPath)).followupRunId).toBe(
        linked.id,
    );
    expect(linked.parentRunId).toBe(second.run.id);
    expect(linked.taskVersionId).toBe(second.run.taskVersionId);
    expect(linked.budget).toEqual(second.run.budget);
    expect(linked.mode).toBe(second.run.mode);
    expect(linked.trigger).toBe('followup');
    await expect(turn.getByRole('link', { name: '执行详情', exact: true })).toHaveAttribute(
        'href',
        `/runs/${linked.id}`,
    );
    const final = await waitForDelivery(environment, owner, linked);
    const linkedScope = await runScope(linked.id);
    expect(linkedScope).not.toBe(originalScope);
    await info.attach('followup-report', {
        body: JSON.stringify(final.report),
        contentType: 'application/json',
    });
    expect(final.run.status).toBe('succeeded');
    expect(
        final.report.evidence.some(({ quote }) => quote.includes('free B1 audio with subtitles')),
    ).toBe(true);
    const afterBaselines = await baselines();
    expect(afterBaselines.filter((row) => row.scope === originalScope)).toEqual(beforeBaselines);
    const followupBaselines = afterBaselines.filter((row) => row.scope !== originalScope);
    expect(followupBaselines).toHaveLength(1);
    expect(followupBaselines[0]).toMatchObject({ scope: linkedScope, run: linked.id });
    expect(followupBaselines[0]!.id).not.toBe(beforeBaselines[0]!.id);
    const finalTask = await environment.request<TaskDetailResponse>(
        owner,
        `/api/v1/tasks/${task.id}`,
    );
    expect(finalTask.version).toEqual(originalTask.version);
    expect(finalTask.task.revision).toBe(originalTask.task.revision);
    expect(finalTask.task.nextRunAt).toBe(originalTask.task.nextRunAt);
    expect(finalTask.task.status).toBe(originalTask.task.status);
    expect(await environment.request<Report>(owner, `/api/v1/reports/${second.report.id}`)).toEqual(
        second.report,
    );
    const after = await deliveryCounts(environment, owner, task.id);
    expect(after).toEqual(
        Object.fromEntries(Object.entries(beforeQuestions).map(([key, value]) => [key, value + 1])),
    );

    for (const path of [
        questionPath,
        `/api/v1/notes/${note.id}`,
        `/api/v1/reports/${second.report.id}`,
        `/api/v1/library/sources/${source!.sourceId}/snapshots/${source!.snapshotId}`,
    ])
        expect((await environment.response(other, path)).status).toBe(404);
    await other.page.goto('/library/search');
    await other.page.getByLabel('搜索已保存资料', { exact: true }).fill('联合旅程核验笔记');
    await other.page.getByRole('button', { name: '搜索已存资料', exact: true }).press('Enter');
    await expect(other.page.locator('.results-region')).toContainText('没有已存资料命中');
    await expect(other.page.locator('.search-result')).toHaveCount(0);
    await other.page.goto(`/reports/${second.report.id}?questionId=${questionId}`);
    await expect(other.page.locator('.report-frame,.conversation-turn,.notes-panel')).toHaveCount(
        0,
    );
    await expect(other.page.locator('body')).not.toContainText(localDraft);
    await attachProvenance(info, environment, [first, second, final]);
    await info.attach('question-supplier-boundary', {
        body: JSON.stringify({
            noModelReason: insufficient.answer.reason,
            supplier: 'acceptanceQuestionModel',
            remoteResearch: false,
            answeredQuestionId: questionId,
            followupRunId: linked.id,
        }),
        contentType: 'application/json',
    });
});
