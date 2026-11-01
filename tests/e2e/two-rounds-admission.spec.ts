import type { TaskDetailResponse } from '@scova/models';
import { expect, test } from './support/environment.ts';
import {
    assertAtomicDelivery,
    assertChangeCitations,
    attachProvenance,
    createTaskThroughUI,
    executeThroughUI,
    openReport,
} from './support/two-rounds.ts';

test('招生A/B/C：两组变化双方引用、每周时区计划、partial不推进完整基线', async ({
    environment,
    browser,
}, info) => {
    console.log(`Browser: Chromium ${browser.version()}`);
    const owner = await environment.owner();
    const config = environment.config('admissions');
    config.title = '招生通知与每周时区计划';
    config.goal = 'Track programme deadline and language requirement changes';
    config.timezone = 'Asia/Shanghai';
    config.schedule = { frequency: 'weekly', weekday: 3, localTime: '09:15' };
    // URL preference is not official identity certification; no unapproved registry is installed.
    expect(config.sourcePreferences.officialOnly).toBe(false);
    const task = await createTaskThroughUI(owner, config);
    expect(task.task.nextRunAt).not.toBeNull();
    const next = new Date(task.task.nextRunAt!);
    const local = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Shanghai',
        weekday: 'long',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
    }).format(next);
    expect(local).toContain('Wednesday');
    expect(local).toContain('09:15');
    await expect(owner.page.locator('.task-summary')).toContainText('Asia/Shanghai');
    await owner.page.getByRole('link', { name: '编辑任务配置', exact: true }).click();
    await expect(owner.page.getByLabel('每周执行星期', { exact: true })).toHaveValue('3');
    await expect(
        owner.page.getByLabel('每周执行星期', { exact: true }).locator('option:checked'),
    ).toHaveText(/周三/);
    await owner.page.getByText('关注范围与来源偏好', { exact: true }).click();
    await expect(
        owner.page.getByText('网址和条目每行一项；来源偏好不代表安全审核或官方身份认证。', {
            exact: true,
        }),
    ).toBeVisible();
    const first = await executeThroughUI(environment, owner, task.task.id, {
        mode: 'live',
        scenario: 'admissions',
        phase: 'A',
    });
    const second = await executeThroughUI(environment, owner, task.task.id, {
        mode: 'live',
        scenario: 'admissions',
        phase: 'B',
    });
    expect(first.report.coverage.completeness).toBe('complete');
    expect(second.report.baselineRunId).toBe(first.run.id);
    const changed = second.report.changes.filter((entry) => entry.kind === 'changed');
    expect(changed.map((entry) => [entry.oldValue, entry.newValue])).toEqual(
        expect.arrayContaining([
            ['15 November', '22 November'],
            ['B1', 'B2'],
        ]),
    );
    expect(changed).toHaveLength(2);
    await openReport(owner.page, second.report);
    await assertChangeCitations(owner.page, second.report, (entry) => entry.kind === 'changed');
    const third = await executeThroughUI(environment, owner, task.task.id, {
        mode: 'live',
        scenario: 'admissions',
        phase: 'C',
    });
    expect(third.run.status).toBe('partial');
    expect(third.report.outcome).toBe('inconclusive');
    expect(third.report.baselineRunId).toBe(second.run.id);
    expect(third.report.coverage.gaps.length + third.report.limitations.length).toBeGreaterThan(0);
    const baseline = await environment.services.sql(
        `SELECT complete_run_id FROM "${environment.services.schema}".baselines WHERE task_id='${task.task.id}'`,
    );
    expect(baseline).toBe(second.run.id);
    await openReport(owner.page, third.report);
    await expect(owner.page.getByRole('note', { name: '部分交付警告' })).toContainText(
        '不能据此认定没有重要变化',
    );
    await expect(owner.page.locator('.comparison-summary')).toContainText('变化结论仍不确定');
    await expect(owner.page.locator('.comparison-summary')).toContainText('本次查阅不完整');
    await expect(owner.page.locator('.report-changes')).toContainText(
        '本次未观察到旧资料不等于资料已撤回',
    );
    const after = await environment.request<TaskDetailResponse>(
        owner,
        `/api/v1/tasks/${task.task.id}`,
    );
    expect(after.task.nextRunAt).toBe(task.task.nextRunAt);
    await assertAtomicDelivery(environment, owner, task.task.id, [
        first.report,
        second.report,
        third.report,
    ]);
    await attachProvenance(info, environment, [first, second, third]);
});
