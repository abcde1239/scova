import { expect, type Page, type TestInfo } from '@playwright/test';
import type { Report, Run, TaskConfig, TaskDetailResponse } from '@scova/models';
import type { BrowserEnvironment, Owner } from './environment.ts';
import type { Phase, Scenario } from './compose.ts';

export async function createTaskThroughUI(owner: Owner, config: TaskConfig) {
    const page = owner.page;
    await page.goto('/tasks/new');
    for (const [label, value] of [
        ['任务标题', config.title],
        ['查阅主题', config.topic],
        ['查阅目标', config.goal],
        ['任务时区（IANA）', config.timezone],
        ['执行时长上限（秒）', String(config.budget.maxDurationSeconds)],
    ])
        await page.getByLabel(label!, { exact: true }).fill(value!);
    await page.getByLabel('输出形式', { exact: true }).selectOption(config.outputFormat);
    await page.getByText('关注范围与来源偏好', { exact: true }).click();
    await page.getByLabel('重点关注（可选）', { exact: true }).fill(config.focusPoints.join('\n'));
    await page
        .getByLabel('排除主题或条件（可选）', { exact: true })
        .fill(config.exclusions.join('\n'));
    await page
        .getByLabel('优先来源网址（可选）', { exact: true })
        .fill(config.sourcePreferences.preferredUrls.join('\n'));
    await page
        .getByLabel('仅查阅官方来源', { exact: true })
        .setChecked(config.sourcePreferences.officialOnly);
    await page.getByLabel('计划频率', { exact: true }).selectOption(config.schedule.frequency);
    if (config.schedule.frequency !== 'manual') {
        await page.getByLabel('执行当地时间', { exact: true }).fill(config.schedule.localTime);
        if (config.schedule.frequency === 'weekly')
            await page
                .getByLabel('每周执行星期', { exact: true })
                .selectOption(String(config.schedule.weekday));
    }
    await page
        .getByLabel('结果提醒', { exact: true })
        .selectOption(config.notificationPreference.mode);
    const saved = page.waitForResponse(
        (response) =>
            new URL(response.url()).pathname === '/api/v1/tasks' &&
            response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: '确认保存任务', exact: true }).click();
    const response = await saved;
    expect(response.status()).toBe(201);
    const detail = (await response.json()) as TaskDetailResponse;
    await expect(page).toHaveURL(new RegExp(`/tasks/${detail.task.id}$`));
    return detail;
}

export async function waitForDelivery(environment: BrowserEnvironment, owner: Owner, created: Run) {
    let terminal: Run | undefined;
    await expect
        .poll(
            async () => {
                terminal = await environment.request<Run>(owner, `/api/v1/runs/${created.id}`);
                return terminal.status;
            },
            { timeout: 100_000, intervals: [100, 250, 500] },
        )
        .toMatch(/^(succeeded|partial|failed|canceled)$/);
    expect(terminal!.status, `Run failure ${terminal!.failureCode}`).toMatch(
        /^(succeeded|partial)$/,
    );
    let report: Report | undefined;
    await expect
        .poll(
            async () => {
                const result = await environment.request<{
                    items: { id: string; runId: string }[];
                }>(owner, `/api/v1/reports?taskId=${created.taskId}`);
                const item = result.items.find((entry) => entry.runId === created.id);
                if (item)
                    report = await environment.request<Report>(owner, `/api/v1/reports/${item.id}`);
                return report?.runId;
            },
            { timeout: 20_000 },
        )
        .toBe(created.id);
    return { run: terminal!, report: report! };
}

export async function executeThroughUI(
    environment: BrowserEnvironment,
    owner: Owner,
    taskId: string,
    options: { mode: 'demo' | 'live'; scenario?: Scenario; phase?: Phase },
) {
    if (options.scenario)
        await environment.services.useScenario(options.scenario, options.phase ?? 'A');
    const page = owner.page;
    await page.goto(`/tasks/${taskId}`);
    const actions = page.locator('.run-actions');
    await actions
        .getByLabel(options.mode === 'demo' ? '演示 demo' : '真实 live', { exact: true })
        .check();
    const submitted = page.waitForResponse(
        (response) =>
            new URL(response.url()).pathname === `/api/v1/tasks/${taskId}/runs` &&
            response.request().method() === 'POST',
    );
    await actions.getByRole('button', { name: '立即执行', exact: true }).click();
    const response = await submitted;
    expect(response.status()).toBe(202);
    const result = (await response.json()) as { run: Run; reused: boolean };
    expect(result.reused).toBe(false);
    expect(result.run.mode).toBe(options.mode);
    const key = response.request().headers()['idempotency-key'];
    expect(key).toBeTruthy();
    const delivered = await waitForDelivery(environment, owner, result.run);
    return { ...delivered, key: key!, mode: options.mode, remoteResearch: false as const };
}

export async function openReport(page: Page, report: Report) {
    await page.goto(`/reports/${report.id}`);
    await expect(page.locator('#report-title')).toHaveText(report.title);
    await expect(page.locator('.metadata')).toContainText(report.taskVersionId);
    await expect(page.locator('.mode')).toHaveText(
        report.mode === 'demo' ? '演示报告：来自演示数据，不代表真实查阅成果。' : '真实查阅报告',
    );
}

export async function assertChangeCitations(
    page: Page,
    report: Report,
    predicate: (entry: Report['changes'][number]) => boolean,
) {
    const selected = report.changes.filter(predicate);
    expect(selected.length).toBeGreaterThan(0);
    for (const entry of selected) {
        const row = page.locator(`.change-record[aria-labelledby="change-${entry.id}"]`);
        await expect(row).toBeVisible();
        await expect(row).toContainText(entry.reason);
        for (const side of ['old', 'new'] as const) {
            const section = row.locator(`.${side}-side`);
            await expect(section.locator('.change-value')).toHaveText(
                entry[`${side}Value`] ?? `未提供${side === 'old' ? '旧' : '新'}值`,
            );
            const evidenceIds = entry[`${side}EvidenceIds`];
            await expect(section.locator('details.evidence')).toHaveCount(evidenceIds.length);
            for (const [index, evidenceId] of evidenceIds.entries()) {
                const citation = section.locator('details.evidence').nth(index);
                await citation.locator('summary').focus();
                await citation.locator('summary').press('Enter');
                await expect(citation.locator('blockquote')).toHaveText(
                    report.evidence.find((item) => item.id === evidenceId)!.quote,
                );
            }
        }
    }
}

export async function deliveryCounts(
    environment: BrowserEnvironment,
    owner: Owner,
    taskId: string,
) {
    // UUIDs and schema are generated by our own isolated environment, never free-form SQL input.
    if (![owner.id, taskId].every((value) => /^[a-f0-9-]{36}$/.test(value)))
        throw new Error('Invalid fixture identity');
    const schema = `"${environment.services.schema}"`;
    const sql = `SELECT json_build_object(
        'runs',(SELECT count(*) FROM ${schema}.runs WHERE user_id='${owner.id}' AND task_id='${taskId}'),
        'reports',(SELECT count(*) FROM ${schema}.reports WHERE user_id='${owner.id}' AND task_id='${taskId}'),
        'inbox',(SELECT count(*) FROM ${schema}.inbox_items WHERE user_id='${owner.id}'),
        'notifications',(SELECT count(*) FROM ${schema}.notifications WHERE user_id='${owner.id}'))`;
    return JSON.parse(await environment.services.sql(sql)) as {
        runs: number;
        reports: number;
        inbox: number;
        notifications: number;
    };
}

export async function assertAtomicDelivery(
    environment: BrowserEnvironment,
    owner: Owner,
    taskId: string,
    reports: Report[],
) {
    expect(await deliveryCounts(environment, owner, taskId)).toEqual({
        runs: reports.length,
        reports: reports.length,
        inbox: reports.length,
        notifications: reports.length,
    });
    const inbox = await environment.request<{ items: { reportId: string }[] }>(
        owner,
        '/api/v1/inbox',
    );
    expect(inbox.items.map((entry) => entry.reportId).sort()).toEqual(
        reports.map((entry) => entry.id).sort(),
    );
    const notifications = await environment.request<{
        items: { runId: string; reportId: string }[];
    }>(owner, '/api/v1/notifications');
    for (const report of reports)
        expect(
            notifications.items.filter(
                (entry) => entry.runId === report.runId && entry.reportId === report.id,
            ),
        ).toHaveLength(1);
}

export async function attachProvenance(
    info: TestInfo,
    environment: BrowserEnvironment,
    rounds: { run: Run; report: Report }[],
) {
    await info.attach('controlled-delivery-provenance', {
        body: JSON.stringify(
            {
                project: environment.services.project,
                remoteResearch: false,
                boundary:
                    'real browser/API/PostgreSQL/Redis/Worker/Agent/ledger/checkpoint/delivery; fixed suppliers',
                rounds: rounds.map(({ run, report }) => ({
                    runId: run.id,
                    reportId: report.id,
                    mode: run.mode,
                    outcome: report.outcome,
                    completeness: report.coverage.completeness,
                })),
            },
            null,
            2,
        ),
        contentType: 'application/json',
    });
}
