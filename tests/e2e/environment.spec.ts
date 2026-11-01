import { ComposeEnvironment, usingEnvironment } from './support/compose.ts';
import { BrowserEnvironment, expect, test } from './support/environment.ts';

test('隔离账号、真实 Run 与交付链可重复使用，三类两轮结果按来源标记', async ({
    environment,
    browser,
}, info) => {
    console.log(`Browser: Chromium ${browser.version()}`);
    const owner = await environment.owner();
    const other = await environment.owner();
    expect(owner.id).not.toBe(other.id);
    for (const account of [owner, other]) {
        const me = await environment.request<{ user: { id: string } }>(account, '/api/v1/me');
        expect(me.user.id).toBe(account.id);
        await expect(
            account.page.getByRole('heading', { name: '任务', exact: true }),
        ).toBeVisible();
    }
    const task = await environment.task(owner);
    const demo = await environment.execute(owner, task.id, 'demo');
    expect(demo.run.mode).toBe('demo');
    expect(demo.report.runId).toBe(demo.run.id);
    expect((await environment.response(other, `/api/v1/reports/${demo.report.id}`)).status).toBe(
        404,
    );
    const resources = await environment.services.resources();
    expect(resources.container.length).toBeGreaterThan(0);
    expect(resources.volume.length).toBeGreaterThan(0);
    const namespace = await environment.services.sql(
        `SELECT nspname FROM pg_namespace WHERE nspname='${environment.services.schema}'`,
    );
    expect(namespace).toBe(environment.services.schema);
    expect(
        await environment.services.sql(
            `SELECT nspname FROM pg_namespace WHERE nspname='${environment.services.checkpointSchema}'`,
        ),
    ).toBe(environment.services.checkpointSchema);
    expect(environment.services.checkpointSchema).not.toBe(environment.services.schema);
    expect(
        await environment.services.sql(
            `SELECT count(*) FROM "${environment.services.schema}".users`,
        ),
    ).toBe('2');
    expect(
        await environment.services.compose([
            'exec',
            '-T',
            'worker',
            'printenv',
            'WORKER_QUEUE_NAME',
        ]),
    ).toBe(environment.services.queue);
    const records = [];
    for (const scenario of ['english', 'admissions', 'research'] as const) {
        const prepared = await environment.prepareDisplay(owner, scenario);
        expect(prepared.purpose).toBe('prepared-display');
        expect(prepared.remoteResearch).toBe(false);
        expect(new Set(prepared.rounds.map((round) => round.run.id)).size).toBe(2);
        for (const round of prepared.rounds) {
            expect(round.provenance).toBe('executed-supplier-fixture');
            expect(round.run.mode).toBe('live');
            expect(round.report.runId).toBe(round.run.id);
        }
        records.push({
            scenario,
            purpose: prepared.purpose,
            taskId: prepared.task.id,
            reports: prepared.rounds.map((round) => ({
                id: round.report.id,
                runId: round.run.id,
                provenance: round.provenance,
                remoteResearch: round.remoteResearch,
            })),
        });
    }
    const foreign = await environment.request<{ items: unknown[] }>(other, '/api/v1/reports');
    expect(foreign.items).toEqual([]);
    await info.attach('delivery-provenance', {
        body: JSON.stringify(
            {
                project: environment.services.project,
                schema: environment.services.schema,
                checkpointSchema: environment.services.checkpointSchema,
                queue: environment.services.queue,
                demoRunId: demo.run.id,
                records,
            },
            null,
            2,
        ),
        contentType: 'application/json',
    });
});

test('依赖启动后注入失败仍有界清理，只删除自己的资源', async ({ images }, info) => {
    const services = new ComposeEnvironment(images);
    const started = Date.now();
    await expect(services.start({ failAt: 'dependencies' })).rejects.toThrow(
        'Injected E2E startup failure',
    );
    expect(Date.now() - started).toBeLessThan(180_000);
    expect(await services.resources()).toEqual({ container: [], volume: [], network: [] });
    await info.attach('startup-failure-cleanup', {
        body: JSON.stringify({
            project: services.project,
            elapsedMs: Date.now() - started,
            resources: await services.resources(),
        }),
        contentType: 'application/json',
    });
});

test('测试中途失败后账号、schema、队列和独立服务全部回收', async ({ images, browser }, info) => {
    let services: ComposeEnvironment | undefined;
    const started = Date.now();
    await expect(
        usingEnvironment(images, async (current) => {
            services = current;
            const environment = new BrowserEnvironment(current, browser);
            try {
                const owner = await environment.owner();
                const task = await environment.task(owner);
                await environment.execute(owner, task.id, 'demo');
                throw new Error('Injected E2E mid-test failure');
            } finally {
                await environment.close();
            }
        }),
    ).rejects.toThrow('Injected E2E mid-test failure');
    expect(services).toBeDefined();
    expect(Date.now() - started).toBeLessThan(240_000);
    expect(await services!.resources()).toEqual({ container: [], volume: [], network: [] });
    await info.attach('mid-test-failure-cleanup', {
        body: JSON.stringify({
            project: services!.project,
            schema: services!.schema,
            checkpointSchema: services!.checkpointSchema,
            queue: services!.queue,
            elapsedMs: Date.now() - started,
            resources: await services!.resources(),
        }),
        contentType: 'application/json',
    });
});
