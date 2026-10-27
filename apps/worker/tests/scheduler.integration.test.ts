import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@scova/models';
import { dueSchedule, effectiveRunScopeHash, resolveScheduledDate } from '@scova/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vite-plus/test';
import { createSchedulerRepository } from '../src/repo/scheduler.ts';
import { SchedulerService } from '../src/service/scheduler.ts';
import { outboxDatabase } from './support/outbox-database.ts';
import { emptyUsage, runConfig } from './support/run-database.ts';
import { nodeScriptCommand } from '../../../scripts/process-runtime.mjs';

const fixture = outboxDatabase();
const db = fixture.db;
const repository = createSchedulerRepository(db);
const competitor = new PrismaClient({ datasources: { db: { url: fixture.databaseUrl } } });
const second = createSchedulerRepository(competitor);
beforeAll(async () => {
    await fixture.setup();
    await competitor.$connect();
}, 120_000);
afterEach(async () => {
    await db.task.updateMany({ data: { nextRunAt: null } });
});
afterAll(async () => {
    await competitor.$disconnect();
    await fixture.cleanup();
});

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}
async function databaseNow() {
    const [row] = await db.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
    return row!.now;
}
async function seed(daysAgo = 0) {
    const now = await databaseNow();
    const today = new Date(now);
    today.setUTCHours(0, 0, 0, 0);
    const firstDue = new Date(today.getTime() - daysAgo * 86_400_000);
    const config = {
        ...runConfig(),
        schedule: { frequency: 'daily' as const, localTime: '00:00' },
    };
    const email = `${randomUUID()}@example.test`;
    const user = await db.user.create({
        data: { email, normalizedEmail: email, passwordHash: 'test' },
    });
    const task = await db.task.create({
        data: { userId: user.id, title: config.title, nextRunAt: firstDue },
    });
    const version = await db.taskVersion.create({
        data: {
            userId: user.id,
            taskId: task.id,
            version: 1,
            configJson: config,
            comparisonScopeHash: 'a'.repeat(64),
        },
    });
    await db.task.update({ where: { id: task.id }, data: { currentVersionId: version.id } });
    return { user, task, version, config, today, firstDue };
}
async function activeRun(
    data: Awaited<ReturnType<typeof seed>>,
    status: 'queued' | 'running' | 'recovering' | 'cancel_requested' = 'queued',
) {
    return db.run.create({
        data: {
            userId: data.user.id,
            taskId: data.task.id,
            taskVersionId: data.version.id,
            comparisonScopeHash: effectiveRunScopeHash(data.version.comparisonScopeHash, 'demo'),
            mode: 'demo',
            trigger: 'manual',
            budgetJson: data.config.budget,
            usageJson: emptyUsage(),
            status,
        },
    });
}

describe('PostgreSQL 周期调度事务', () => {
    it('固定 DST 时点：缺失当地时分顺延首个有效时刻，重复只取较早一次', () => {
        const spring = {
            timezone: 'America/New_York',
            schedule: { frequency: 'daily' as const, localTime: '02:30' },
        };
        expect(resolveScheduledDate(spring, '2026-03-08')?.toISOString()).toBe(
            '2026-03-08T07:00:00.000Z',
        );
        expect(
            dueSchedule(spring, new Date('2026-03-08T07:00Z'), new Date('2026-03-08T07:10Z')),
        ).toEqual({
            scheduledAt: new Date('2026-03-08T07:00Z'),
            missedCount: 0,
            nextRunAt: new Date('2026-03-09T06:30Z'),
        });
        const fall = {
            timezone: 'America/New_York',
            schedule: { frequency: 'daily' as const, localTime: '01:30' },
        };
        expect(resolveScheduledDate(fall, '2026-11-01')?.toISOString()).toBe(
            '2026-11-01T05:30:00.000Z',
        );
        expect(
            dueSchedule(fall, new Date('2026-11-01T05:30Z'), new Date('2026-11-01T06:45Z')),
        ).toEqual({
            scheduledAt: new Date('2026-11-01T05:30Z'),
            missedCount: 0,
            nextRunAt: new Date('2026-11-02T06:30Z'),
        });
    });

    it('双调度器只创建一个 Occurrence/Run/首事件/Outbox，重复扫描为空', async () => {
        const s = await seed();
        const results = await Promise.all([
            repository.scheduleNext('demo', []),
            second.scheduleNext('demo', []),
        ]);
        expect(results.filter(Boolean)).toHaveLength(1);
        const occurrence = await db.scheduleOccurrence.findFirstOrThrow({
            where: { taskId: s.task.id },
        });
        const run = await db.run.findFirstOrThrow({ where: { taskId: s.task.id } });
        expect(occurrence).toMatchObject({
            scheduledAt: s.today,
            scheduleRevision: 1,
            missedCount: 0,
            status: 'created',
            runId: run.id,
        });
        expect(run).toMatchObject({
            occurrenceId: occurrence.id,
            trigger: 'scheduled',
            mode: 'demo',
            status: 'queued',
            taskVersionId: s.version.id,
            budgetJson: s.config.budget,
            comparisonScopeHash: effectiveRunScopeHash(s.version.comparisonScopeHash, 'demo'),
        });
        expect(
            await db.runEvent.count({ where: { runId: run.id, seq: 1, type: 'run.queued' } }),
        ).toBe(1);
        expect(await db.outbox.count({ where: { aggregateId: run.id } })).toBe(1);
        expect(await db.report.count({ where: { runId: run.id } })).toBe(0);
        expect(
            (await db.task.findUniqueOrThrow({ where: { id: s.task.id } })).nextRunAt!.getTime(),
        ).toBeGreaterThan((await databaseNow()).getTime());
        expect(await repository.scheduleNext('demo', [])).toBeNull();
    });

    it('真实 Server 手动命令与周期调度同时起跑，仅一个活动 Run 和入队事务', async () => {
        const s = await seed();
        const command = nodeScriptCommand('tests/support/create-scheduled-race-run.ts');
        const child = spawn(command.executable, command.args, {
            cwd: fileURLToPath(new URL('../../server/', import.meta.url)),
            env: {
                ...process.env,
                SCOVA_SCHEDULER_PROBE_DATABASE_URL: fixture.databaseUrl,
                SCOVA_SCHEDULER_PROBE_USER_ID: s.user.id,
                SCOVA_SCHEDULER_PROBE_TASK_ID: s.task.id,
            },
            stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
            windowsHide: true,
            timeout: 20_000,
        });
        let stdout = '';
        let stderr = '';
        let ready = false;
        child.stdout!.on('data', (chunk) => {
            stdout += String(chunk);
        });
        child.stderr!.on('data', (chunk) => {
            stderr += String(chunk);
        });
        const scheduled = new Promise<Awaited<ReturnType<typeof repository.scheduleNext>>>(
            (resolve, reject) => {
                child.once('message', () => {
                    ready = true;
                    child.send({ phase: 'go' });
                    void repository.scheduleNext('demo', []).then(resolve, reject);
                });
                child.once('error', reject);
                child.once('close', () => {
                    if (!ready) reject(new Error('手动命令进程未就绪'));
                });
            },
        );
        const completed = new Promise<void>((resolve, reject) => {
            child.once('error', reject);
            child.once('close', (code) => {
                if (code === 0) resolve();
                else reject(new Error(`手动命令进程失败 ${code}: ${stderr}`));
            });
        });
        try {
            const [first] = await Promise.all([scheduled, completed]);
            // 手动事务先拿锁时，本轮 SKIP LOCKED；完成后下一次扫描记录 overlap。
            const result = first ?? (await repository.scheduleNext('demo', []));
            expect(result?.status).toMatch(/^(created|skipped_overlap)$/);
            const manual = JSON.parse(stdout) as { run: { id: string }; reused: boolean };
            const run = await db.run.findFirstOrThrow({ where: { taskId: s.task.id } });
            expect(run.id).toBe(manual.run.id);
            expect(await db.run.count({ where: { taskId: s.task.id } })).toBe(1);
            expect(await db.runEvent.count({ where: { runId: run.id } })).toBe(1);
            expect(await db.outbox.count({ where: { aggregateId: run.id } })).toBe(1);
            expect(await db.scheduleOccurrence.count({ where: { taskId: s.task.id } })).toBe(1);
            expect(manual.reused).toBe(result?.status === 'created');
        } finally {
            if (child.connected) child.disconnect();
            if (child.exitCode === null) child.kill();
            await completed.catch(() => undefined);
        }
    });

    it('被锁任务 SKIP LOCKED，其他到期任务先执行；释放后原任务只执行一次', async () => {
        const locked = await seed();
        const available = await seed();
        const entered = deferred();
        const release = deferred();
        const holding = competitor.$transaction(
            async (tx) => {
                await tx.$queryRaw`SELECT id FROM tasks WHERE id = ${locked.task.id}::uuid FOR NO KEY UPDATE`;
                entered.resolve();
                await release.promise;
            },
            { timeout: 10_000 },
        );
        await entered.promise;
        try {
            expect(await repository.scheduleNext('demo', [])).toMatchObject({
                taskId: available.task.id,
                status: 'created',
            });
            expect(await repository.scheduleNext('demo', [])).toBeNull();
            expect(await db.run.count({ where: { taskId: locked.task.id } })).toBe(0);
        } finally {
            release.resolve();
            await holding;
        }
        await Promise.all([repository.scheduleNext('demo', []), second.scheduleNext('demo', [])]);
        expect(await db.scheduleOccurrence.count({ where: { taskId: locked.task.id } })).toBe(1);
    });

    it('多日停机只补最近一次，较早时点记录 missedCount，live 模式显式快照', async () => {
        const s = await seed(7);
        expect(await repository.scheduleNext('live', [])).toMatchObject({ status: 'created' });
        expect(
            await db.scheduleOccurrence.findFirstOrThrow({ where: { taskId: s.task.id } }),
        ).toMatchObject({ scheduledAt: s.today, missedCount: 7 });
        expect(await db.run.count({ where: { taskId: s.task.id } })).toBe(1);
        expect(await db.run.findFirstOrThrow({ where: { taskId: s.task.id } })).toMatchObject({
            mode: 'live',
            comparisonScopeHash: effectiveRunScopeHash(s.version.comparisonScopeHash, 'live'),
        });
    });

    it('同计划时点重放复用 Occurrence；新 scheduleRevision 拥有独立唯一键', async () => {
        const s = await seed();
        await repository.scheduleNext('demo', []);
        const first = await db.run.findFirstOrThrow({ where: { taskId: s.task.id } });
        await db.run.update({
            where: { id: first.id },
            data: { status: 'failed', failureCode: 'TEST_DONE' },
        });
        await db.task.update({ where: { id: s.task.id }, data: { nextRunAt: s.firstDue } });
        expect(await repository.scheduleNext('demo', [])).toMatchObject({ status: 'reused' });
        expect(await db.run.count({ where: { taskId: s.task.id } })).toBe(1);
        await db.task.update({
            where: { id: s.task.id },
            data: { nextRunAt: s.firstDue, scheduleRevision: { increment: 1 } },
        });
        expect(await repository.scheduleNext('demo', [])).toMatchObject({ status: 'created' });
        expect(await db.scheduleOccurrence.count({ where: { taskId: s.task.id } })).toBe(2);
        expect(await db.run.count({ where: { taskId: s.task.id } })).toBe(2);
    });

    it('未来计划与已取消 signal 不领取任务', async () => {
        const s = await seed();
        const controller = new AbortController();
        controller.abort();
        expect(await repository.scheduleNext('demo', [], controller.signal)).toBeNull();
        await db.task.update({
            where: { id: s.task.id },
            data: { nextRunAt: new Date(s.today.getTime() + 86_400_000) },
        });
        expect(await repository.scheduleNext('demo', [])).toBeNull();
        expect(await db.scheduleOccurrence.count({ where: { taskId: s.task.id } })).toBe(0);
    });

    it.each(['queued', 'running', 'recovering', 'cancel_requested'] as const)(
        '%s 活动执行记 skipped_overlap，不创建新 Run',
        async (status) => {
            const s = await seed(2);
            const run = await activeRun(s, status);
            expect(await repository.scheduleNext('demo', [])).toMatchObject({
                status: 'skipped_overlap',
            });
            expect(
                await db.scheduleOccurrence.findFirstOrThrow({ where: { taskId: s.task.id } }),
            ).toMatchObject({ status: 'skipped_overlap', runId: null, missedCount: 2 });
            expect(await db.run.count({ where: { taskId: s.task.id } })).toBe(1);
            expect((await db.run.findUniqueOrThrow({ where: { id: run.id } })).status).toBe(status);
        },
    );

    it.each(['paused', 'archived'] as const)('%s 不创建调度，也不终止当前执行', async (status) => {
        const s = await seed();
        const run = await activeRun(s, 'running');
        await db.task.update({ where: { id: s.task.id }, data: { status } });
        expect(await repository.scheduleNext('demo', [])).toBeNull();
        expect(await db.scheduleOccurrence.count({ where: { taskId: s.task.id } })).toBe(0);
        expect((await db.run.findUniqueOrThrow({ where: { id: run.id } })).status).toBe('running');
    });

    it('Outbox SQL 失败使 Occurrence/Run/事件和 nextRunAt 一起回滚', async () => {
        const s = await seed();
        await db.$executeRawUnsafe(
            `CREATE FUNCTION scheduler_fail_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.payload->>'taskId' = '${s.task.id}' THEN RAISE EXCEPTION 'scheduler rollback test'; END IF; RETURN NEW; END $$`,
        );
        await db.$executeRawUnsafe(
            'CREATE TRIGGER scheduler_fail_outbox BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION scheduler_fail_outbox()',
        );
        try {
            await expect(repository.scheduleNext('demo', [])).rejects.toThrow('调度任务事务失败');
            expect(await db.scheduleOccurrence.count({ where: { taskId: s.task.id } })).toBe(0);
            expect(await db.run.count({ where: { taskId: s.task.id } })).toBe(0);
            expect(
                (await db.task.findUniqueOrThrow({ where: { id: s.task.id } })).nextRunAt,
            ).toEqual(s.firstDue);
        } finally {
            await db.$executeRawUnsafe('DROP TRIGGER scheduler_fail_outbox ON outbox');
            await db.$executeRawUnsafe('DROP FUNCTION scheduler_fail_outbox()');
        }
        expect(await repository.scheduleNext('demo', [])).toMatchObject({ status: 'created' });
    });

    it('坏配置不堵住同批其他任务，并保留坏任务 nextRunAt 供后续修复', async () => {
        const bad = await seed(10);
        const good = await seed();
        await db.taskVersion.update({ where: { id: bad.version.id }, data: { configJson: {} } });
        const service = new SchedulerService({ repository, mode: 'demo', concurrency: 1 });
        await expect(service.scheduleOnce(5)).rejects.toThrow('调度批次部分任务失败');
        expect(await db.run.count({ where: { taskId: good.task.id } })).toBe(1);
        expect(await db.run.count({ where: { taskId: bad.task.id } })).toBe(0);
        expect((await db.task.findUniqueOrThrow({ where: { id: bad.task.id } })).nextRunAt).toEqual(
            bad.firstDue,
        );
    });

    it('Task NO KEY UPDATE 与 Run 锁内写 Baseline 外键兼容，避免归档交付锁环', async () => {
        const s = await seed();
        const run = await activeRun(s);
        const taskLocked = deferred();
        const runLocked = deferred();
        const archiveOrder = competitor.$transaction(
            async (tx) => {
                await tx.$queryRaw`SELECT id FROM tasks WHERE id = ${s.task.id}::uuid FOR NO KEY UPDATE`;
                taskLocked.resolve();
                await runLocked.promise;
                await tx.$queryRaw`SELECT id FROM runs WHERE id = ${run.id}::uuid FOR UPDATE`;
            },
            { timeout: 10_000 },
        );
        await taskLocked.promise;
        try {
            await db.$transaction(async (tx) => {
                await tx.$queryRaw`SELECT id FROM runs WHERE id = ${run.id}::uuid FOR UPDATE`;
                runLocked.resolve();
                await tx.baseline.create({
                    data: {
                        userId: s.user.id,
                        taskId: s.task.id,
                        comparisonScopeHash: run.comparisonScopeHash,
                        completeRunId: run.id,
                    },
                });
            });
            await archiveOrder;
            expect(await db.baseline.count({ where: { taskId: s.task.id } })).toBe(1);
        } finally {
            runLocked.resolve();
            await archiveOrder.catch(() => undefined);
        }
    });
});
