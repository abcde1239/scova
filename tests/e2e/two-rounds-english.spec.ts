import type { Run } from '@scova/models';
import { expect, test } from './support/environment.ts';
import {
    assertAtomicDelivery,
    assertChangeCitations,
    attachProvenance,
    createTaskThroughUI,
    deliveryCounts,
    executeThroughUI,
    openReport,
} from './support/two-rounds.ts';

test('英语两轮：默认演示真实交付、模式可见、同key重放不重复交付', async ({
    environment,
    browser,
}, info) => {
    console.log(`Browser: Chromium ${browser.version()}`);
    const owner = await environment.owner();
    const config = environment.config('english');
    config.title = '英语材料演示运行与幂等';
    const task = await createTaskThroughUI(owner, config);
    expect(await deliveryCounts(environment, owner, task.task.id)).toEqual({
        runs: 0,
        reports: 0,
        inbox: 0,
        notifications: 0,
    });
    const rounds = [];
    for (let index = 0; index < 2; index++) {
        const result = await executeThroughUI(environment, owner, task.task.id, { mode: 'demo' });
        expect(result.report.mode).toBe('demo');
        expect(result.report.coverage.completeness).toBe('partial');
        expect(result.report.outcome).toBe('inconclusive');
        await openReport(owner.page, result.report);
        await expect(owner.page.getByRole('note', { name: '部分交付警告' })).toBeVisible();
        rounds.push(result);
    }
    await assertAtomicDelivery(
        environment,
        owner,
        task.task.id,
        rounds.map((entry) => entry.report),
    );
    const before = await deliveryCounts(environment, owner, task.task.id);
    const second = rounds[1]!;
    const replay = await environment.request<{ run: Run; reused: boolean }>(
        owner,
        `/api/v1/tasks/${task.task.id}/runs`,
        { method: 'POST', body: { mode: 'demo' }, headers: { 'idempotency-key': second.key } },
    );
    expect(replay.reused).toBe(true);
    expect(replay.run.id).toBe(second.run.id);
    expect(await deliveryCounts(environment, owner, task.task.id)).toEqual(before);
    await owner.page.goto('/inbox');
    for (const result of rounds)
        await expect(owner.page.locator(`a[href="/reports/${result.report.id}"]`)).toBeVisible();
    await attachProvenance(info, environment, rounds);
});

test('英语领域两轮：固定live供应商验证免费变付费、跟踪重复、转载和排除（非远程烟测）', async ({
    environment,
}, info) => {
    const owner = await environment.owner();
    const config = environment.config('english');
    config.title = '英语B1材料费用与可用性变化';
    config.goal = 'Track free B1 audio with subtitles; exclude paid or C1 lessons';
    config.exclusions = ['paid subscription', 'C1 audio without subtitles'];
    const task = await createTaskThroughUI(owner, config);
    const first = await executeThroughUI(environment, owner, task.task.id, {
        mode: 'live',
        scenario: 'english',
        phase: 'A',
    });
    const second = await executeThroughUI(environment, owner, task.task.id, {
        mode: 'live',
        scenario: 'english',
        phase: 'B',
    });
    expect(first.report.outcome).toBe('baseline');
    expect(second.report.baselineRunId).toBe(first.run.id);
    const costs = second.report.changes.filter(
        (entry) =>
            entry.kind === 'changed' &&
            entry.oldValue === 'free access' &&
            entry.newValue === 'paid subscription',
    );
    expect(costs).toHaveLength(1);
    expect(costs[0]!.reason).toContain('现在不符合目标');
    expect(second.report.changes.filter((entry) => entry.kind === 'new')).toHaveLength(1);
    expect(second.report.changes.some((entry) => entry.kind === 'duplicate')).toBe(true);
    expect(second.report.changes.some((entry) => entry.kind === 'duplicate_candidate')).toBe(true);
    expect(
        second.report.changes.some(
            (entry) => entry.kind === 'non_material' && entry.newValue?.includes('C1'),
        ),
    ).toBe(true);
    expect(second.report.claims.some((entry) => entry.text.includes('C1 audio'))).toBe(false);
    await openReport(owner.page, second.report);
    await assertChangeCitations(owner.page, second.report, (entry) => entry.kind === 'changed');
    for (const label of ['重复资料', '疑似转载', '非实质变化', '新增资料'])
        await expect(
            owner.page.getByRole('heading', { name: new RegExp(`^${label} ·`) }),
        ).toBeVisible();
    await assertAtomicDelivery(environment, owner, task.task.id, [first.report, second.report]);
    await attachProvenance(info, environment, [first, second]);
});
