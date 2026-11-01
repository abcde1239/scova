import { randomUUID } from 'node:crypto';
import type { Run, TaskDetailResponse } from '@scova/models';
import { expect, test } from './support/environment.ts';
import type { BrowserEnvironment, Owner } from './support/environment.ts';
import { assertAtomicDelivery, attachProvenance, waitForDelivery } from './support/two-rounds.ts';

async function queued(environment: BrowserEnvironment, owner: Owner, taskId: string) {
    const result = await environment.request<{ run: Run }>(owner, `/api/v1/tasks/${taskId}/runs`, {
        method: 'POST',
        body: { mode: 'demo' },
        headers: { 'idempotency-key': randomUUID() },
    });
    expect(result.run.status).toBe('queued');
    return result.run;
}

test('关闭网页与Worker停止分开验证：暂停保留在途Run，重开同一Run/Report，真实A/B资源隔离', async ({
    environment,
    browser,
}, info) => {
    console.log(`Browser: Chromium ${browser.version()}`);
    const owner = await environment.owner();
    const other = await environment.owner();
    const config = environment.config();
    config.schedule = { frequency: 'weekly', weekday: 3, localTime: '09:15' };
    const task = await environment.task(owner, config);
    await environment.services.compose(['stop', '-t', '30', 'worker']);
    const run = await queued(environment, owner, task.id);
    await owner.page.goto(`/tasks/${task.id}`);
    await owner.page.getByRole('button', { name: '暂停未来计划', exact: true }).click();
    await expect(owner.page.locator('.task-lifecycle')).toContainText('当前状态：已暂停');
    const stillQueued = await environment.request<Run>(owner, `/api/v1/runs/${run.id}`);
    expect(stillQueued.status).toBe('queued');
    await owner.page.close();
    await environment.services.compose(['start', 'worker']);
    // Observe PostgreSQL independently while no page for this account exists.
    await expect
        .poll(
            () =>
                environment.services.sql(
                    `SELECT status FROM "${environment.services.schema}".runs WHERE id='${run.id}'`,
                ),
            { timeout: 100_000, intervals: [100, 250, 500] },
        )
        .toBe('partial');
    owner.page = await owner.context.newPage();
    await owner.page.goto(`/runs/${run.id}`);
    await expect(owner.page.locator('#execution-status')).toHaveText('部分完成');
    const delivered = await waitForDelivery(environment, owner, run);
    await expect(owner.page.getByRole('link', { name: '查看已发布报告' })).toHaveAttribute(
        'href',
        `/reports/${delivered.report.id}`,
    );
    const after = await environment.request<TaskDetailResponse>(owner, `/api/v1/tasks/${task.id}`);
    expect(after.task.status).toBe('paused');
    expect(after.task.nextRunAt).toBeNull();
    for (const path of [
        `/tasks/${task.id}`,
        `/runs/${run.id}`,
        `/reports/${delivered.report.id}`,
        `/runs/${run.id}/events`,
    ]) {
        expect((await environment.response(other, `/api/v1${path}`)).status).toBe(404);
        await other.page.goto(path.endsWith('/events') ? `/runs/${run.id}` : path);
        await expect(other.page.locator('.report-frame,.execution-detail,.task-card')).toHaveCount(
            0,
        );
        await expect(other.page.locator('body')).not.toContainText(delivered.report.summary);
    }
    await assertAtomicDelivery(environment, owner, task.id, [delivered.report]);
    await attachProvenance(info, environment, [delivered]);
});

test('真实网络中断不猜测执行失败：恢复终态、N+1持久事件回放与reset快照一致', async ({
    environment,
}, info) => {
    const owner = await environment.owner();
    const task = await environment.task(owner);
    await environment.services.compose(['stop', '-t', '30', 'worker']);
    const run = await queued(environment, owner, task.id);
    await owner.page.goto(`/runs/${run.id}`);
    await expect(owner.page.locator('.connection')).toContainText('实时连接正常');
    const cursor = JSON.parse(
        await environment.services.sql(
            `SELECT json_build_object('id',id,'seq',seq) FROM "${environment.services.schema}".run_events WHERE run_id='${run.id}' ORDER BY seq DESC LIMIT 1`,
        ),
    ) as { id: string; seq: number };
    // A failed request while the browser is online is different from Vue Query pausing offline.
    const runEndpoint = `**/api/v1/runs/${run.id}`;
    await owner.page.route(runEndpoint, (route) => route.abort('internetdisconnected'), {
        times: 1,
    });
    await owner.page.getByRole('button', { name: '刷新快照', exact: true }).click();
    await expect(owner.page.locator('.connection')).toContainText('快照更新暂不可用');
    await expect(owner.page.locator('#execution-status')).toHaveText('等待执行');
    await owner.context.setOffline(true);
    try {
        await owner.page.getByRole('button', { name: '刷新快照', exact: true }).click();
        await expect(owner.page.locator('.connection')).toContainText(
            '浏览器网络已断开，实时更新暂停；后台执行状态需恢复连接后确认。',
        );
        await expect(owner.page.locator('.connection')).toContainText('快照更新已暂停');
        await expect(owner.page.locator('.connection')).not.toContainText('实时连接正常');
        await expect(owner.page.locator('#execution-status')).toHaveText('等待执行');
        await environment.services.compose(['start', 'worker']);
        await expect
            .poll(
                () =>
                    environment.services.sql(
                        `SELECT status FROM "${environment.services.schema}".runs WHERE id='${run.id}'`,
                    ),
                { timeout: 100_000 },
            )
            .toBe('partial');
        await expect(owner.page.locator('#execution-status')).not.toHaveText('执行失败');
    } finally {
        await owner.context.setOffline(false);
    }
    await owner.page.getByRole('button', { name: '刷新快照', exact: true }).click();
    await expect(owner.page.locator('#execution-status')).toHaveText('部分完成');
    const delivered = await waitForDelivery(environment, owner, run);
    const readEvents = async (lastEventId: string) =>
        owner.page.evaluate(
            async ({ runId, lastEventId }) => {
                const response = await fetch(`/api/v1/runs/${runId}/events`, {
                    headers: { 'Last-Event-ID': lastEventId },
                    signal: AbortSignal.timeout(15_000),
                });
                if (!response.ok) throw new Error(`SSE HTTP ${response.status}`);
                return (await response.text()).split(/\r?\n\r?\n/).flatMap((frame) => {
                    const data = frame
                        .split(/\r?\n/)
                        .filter((line) => line.startsWith('data:'))
                        .map((line) => line.slice(5).trimStart())
                        .join('\n');
                    return data
                        ? [
                              JSON.parse(data) as {
                                  type: string;
                                  seq?: number;
                                  eventId?: string;
                                  payload: { snapshot?: Run };
                              },
                          ]
                        : [];
                });
            },
            { runId: run.id, lastEventId },
        );
    const replay = await readEvents(cursor.id);
    const expected = JSON.parse(
        await environment.services.sql(
            `SELECT COALESCE(json_agg(json_build_object('id',id,'seq',seq,'type',type) ORDER BY seq),'[]') FROM "${environment.services.schema}".run_events WHERE run_id='${run.id}' AND seq>${cursor.seq}`,
        ),
    ) as { id: string; seq: number; type: string }[];
    expect(
        replay.map((entry) => ({ id: entry.eventId, seq: entry.seq, type: entry.type })),
    ).toEqual(expected);
    expect(new Set(replay.map((entry) => entry.eventId)).size).toBe(replay.length);
    expect(replay.filter((entry) => entry.type === 'run.completed')).toHaveLength(1);
    expect(replay[0]!.seq).toBe(cursor.seq + 1);
    const reset = await readEvents(randomUUID());
    expect(reset).toHaveLength(1);
    expect(reset[0]!.type).toBe('stream.reset');
    expect(reset[0]!.payload.snapshot).toEqual(delivered.run);
    await assertAtomicDelivery(environment, owner, task.id, [delivered.report]);
    await attachProvenance(info, environment, [delivered]);
});

test('取消只作用于本次Run，未来周期计划保持；晚到真实401不退出新账号', async ({
    environment,
}, info) => {
    const owner = await environment.owner();
    const config = environment.config();
    config.schedule = { frequency: 'weekly', weekday: 3, localTime: '09:15' };
    const task = await environment.task(owner, config);
    const original = await environment.request<TaskDetailResponse>(
        owner,
        `/api/v1/tasks/${task.id}`,
    );
    await environment.services.compose(['stop', '-t', '30', 'worker']);
    const run = await queued(environment, owner, task.id);
    await owner.page.goto(`/runs/${run.id}`);
    await owner.page.getByRole('button', { name: '请求取消', exact: true }).click();
    await expect(owner.page.locator('#execution-status')).toHaveText('正在取消');
    await environment.services.compose(['start', 'worker']);
    await expect(owner.page.locator('#execution-status')).toHaveText('已取消', {
        timeout: 100_000,
    });
    const current = await environment.request<TaskDetailResponse>(
        owner,
        `/api/v1/tasks/${task.id}`,
    );
    expect(current.task.status).toBe('active');
    expect(current.task.nextRunAt).toBe(original.task.nextRunAt);
    let releaseFetch!: () => void;
    let releaseReply!: () => void;
    const fetchGate = new Promise<void>((resolve) => (releaseFetch = resolve));
    const replyGate = new Promise<void>((resolve) => (releaseReply = resolve));
    let actualStatus = 0;
    let intercepted = false;
    await owner.page.route(`**/api/v1/runs/${run.id}`, async (route) => {
        if (intercepted) return route.continue();
        intercepted = true;
        await fetchGate;
        const response = await route.fetch();
        actualStatus = response.status();
        await replyGate;
        try {
            await route.fulfill({ response });
        } catch {
            /* Old scope correctly aborted. */
        }
    });
    try {
        await owner.page.reload({ waitUntil: 'domcontentloaded' });
        await expect.poll(() => intercepted).toBe(true);
        await owner.page.getByRole('button', { name: '退出登录', exact: true }).click();
        releaseFetch();
        await expect.poll(() => actualStatus).toBe(401);
        await owner.page.getByRole('link', { name: '注册账号', exact: true }).click();
        await owner.page.getByLabel('邮箱', { exact: true }).fill(`${randomUUID()}@example.test`);
        await owner.page.getByLabel('密码', { exact: true }).fill(`Fixture-${randomUUID()}`);
        await owner.page.getByLabel('默认时区', { exact: true }).fill('UTC');
        await owner.page.getByRole('button', { name: '注册', exact: true }).click();
        await expect(owner.page).toHaveURL(/\/tasks$/);
        releaseReply();
        await expect(
            owner.page.getByRole('button', { name: '退出登录', exact: true }),
        ).toBeVisible();
        await expect(owner.page.locator('.task-card')).toHaveCount(0);
        await owner.page.goto(`/runs/${run.id}`);
        await expect(owner.page.getByRole('status')).toContainText('执行不存在或无权访问');
        await expect(owner.page.locator('.execution-detail')).toHaveCount(0);
        await expect(
            owner.page.getByRole('button', { name: '退出登录', exact: true }),
        ).toBeVisible();
    } finally {
        releaseFetch();
        releaseReply();
        await owner.page.unroute(`**/api/v1/runs/${run.id}`);
    }
    await info.attach('late-response-boundary', {
        body: JSON.stringify({
            actualOldSessionStatus: actualStatus,
            newOwnerResourceStatus: 404,
            taskPlanUnchanged: true,
        }),
        contentType: 'application/json',
    });
});
