import { requiredDatabaseValue } from '@/utils/database.ts';
import {
    createDatabaseClient,
    connectDatabase,
    tasks as dbTasks,
    closeDatabase,
    sql,
    queryRows,
    users as dbUsers,
    taskVersions as dbTaskVersions,
    eq,
    runs as dbRuns,
    scheduleOccurrences as dbScheduleOccurrences,
    runEvents as dbRunEvents,
    and,
    count as dbCount,
    outbox as dbOutbox,
    reports as dbReports,
    baselines as dbBaselines,
} from '@scova/db';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
const competitor = createDatabaseClient({ connectionString: fixture.databaseUrl });
const second = createSchedulerRepository(competitor);
beforeAll(async () => {
    await fixture.setup();
    await connectDatabase(competitor);
}, 120_000);
afterEach(async () => {
    await db
        .update(dbTasks)
        .set({ nextRunAt: null })
        .returning({ id: dbTasks.id })
        .then((rows) => ({ count: rows.length }));
});
afterAll(async () => {
    await closeDatabase(competitor);
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
    const [row] = await queryRows<{ now: Date }>(db, sql`SELECT clock_timestamp() AS now`);
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
    const user = await db
        .insert(dbUsers)
        .values({ email: email, normalizedEmail: email, passwordHash: 'test' })
        .returning()
        .then((rows) => requiredDatabaseValue(rows[0]));
    const task = await db
        .insert(dbTasks)
        .values({ userId: user.id, title: config.title, nextRunAt: firstDue })
        .returning()
        .then((rows) => requiredDatabaseValue(rows[0]));
    const version = await db
        .insert(dbTaskVersions)
        .values({
            userId: user.id,
            taskId: task.id,
            version: 1,
            configJson: config,
            comparisonScopeHash: 'a'.repeat(64),
        })
        .returning()
        .then((rows) => requiredDatabaseValue(rows[0]));
    await db
        .update(dbTasks)
        .set({ currentVersionId: version.id })
        .where(eq(dbTasks.id, task.id))
        .returning()
        .then((rows) => requiredDatabaseValue(rows[0]));
    return { user, task, version, config, today, firstDue };
}
async function activeRun(
    data: Awaited<ReturnType<typeof seed>>,
    status: 'queued' | 'running' | 'recovering' | 'cancel_requested' = 'queued',
) {
    return db
        .insert(dbRuns)
        .values({
            userId: data.user.id,
            taskId: data.task.id,
            taskVersionId: data.version.id,
            comparisonScopeHash: effectiveRunScopeHash(data.version.comparisonScopeHash, 'demo'),
            mode: 'demo',
            trigger: 'manual',
            budgetJson: data.config.budget,
            usageJson: emptyUsage(),
            status: status,
        })
        .returning()
        .then((rows) => requiredDatabaseValue(rows[0]));
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
        const occurrence = await db.query.scheduleOccurrences
            .findFirst({ where: eq(dbScheduleOccurrences.taskId, s.task.id) })
            .then((row) => requiredDatabaseValue(row));
        const run = await db.query.runs
            .findFirst({ where: eq(dbRuns.taskId, s.task.id) })
            .then((row) => requiredDatabaseValue(row));
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
            await db
                .select({ count: dbCount() })
                .from(dbRunEvents)
                .where(
                    and(
                        eq(dbRunEvents.runId, run.id),
                        eq(dbRunEvents.seq, 1),
                        eq(dbRunEvents.type, 'run.queued'),
                    ),
                )
                .then((rows) => rows[0]!.count),
        ).toBe(1);
        expect(
            await db
                .select({ count: dbCount() })
                .from(dbOutbox)
                .where(eq(dbOutbox.aggregateId, run.id))
                .then((rows) => rows[0]!.count),
        ).toBe(1);
        expect(
            await db
                .select({ count: dbCount() })
                .from(dbReports)
                .where(eq(dbReports.runId, run.id))
                .then((rows) => rows[0]!.count),
        ).toBe(0);
        expect(
            (
                await db.query.tasks
                    .findFirst({ where: eq(dbTasks.id, s.task.id) })
                    .then((row) => requiredDatabaseValue(row))
            ).nextRunAt!.getTime(),
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
            const run = await db.query.runs
                .findFirst({ where: eq(dbRuns.taskId, s.task.id) })
                .then((row) => requiredDatabaseValue(row));
            expect(run.id).toBe(manual.run.id);
            expect(
                await db
                    .select({ count: dbCount() })
                    .from(dbRuns)
                    .where(eq(dbRuns.taskId, s.task.id))
                    .then((rows) => rows[0]!.count),
            ).toBe(1);
            expect(
                await db
                    .select({ count: dbCount() })
                    .from(dbRunEvents)
                    .where(eq(dbRunEvents.runId, run.id))
                    .then((rows) => rows[0]!.count),
            ).toBe(1);
            expect(
                await db
                    .select({ count: dbCount() })
                    .from(dbOutbox)
                    .where(eq(dbOutbox.aggregateId, run.id))
                    .then((rows) => rows[0]!.count),
            ).toBe(1);
            expect(
                await db
                    .select({ count: dbCount() })
                    .from(dbScheduleOccurrences)
                    .where(eq(dbScheduleOccurrences.taskId, s.task.id))
                    .then((rows) => rows[0]!.count),
            ).toBe(1);
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
        const holding = competitor.transaction(async (tx) => {
            await queryRows<Record<string, unknown>>(
                tx,
                sql`SELECT id FROM tasks WHERE id = ${locked.task.id}::uuid FOR NO KEY UPDATE`,
            );
            entered.resolve();
            await release.promise;
        });
        await entered.promise;
        try {
            expect(await repository.scheduleNext('demo', [])).toMatchObject({
                taskId: available.task.id,
                status: 'created',
            });
            expect(await repository.scheduleNext('demo', [])).toBeNull();
            expect(
                await db
                    .select({ count: dbCount() })
                    .from(dbRuns)
                    .where(eq(dbRuns.taskId, locked.task.id))
                    .then((rows) => rows[0]!.count),
            ).toBe(0);
        } finally {
            release.resolve();
            await holding;
        }
        await Promise.all([repository.scheduleNext('demo', []), second.scheduleNext('demo', [])]);
        expect(
            await db
                .select({ count: dbCount() })
                .from(dbScheduleOccurrences)
                .where(eq(dbScheduleOccurrences.taskId, locked.task.id))
                .then((rows) => rows[0]!.count),
        ).toBe(1);
    });

    it('多日停机只补最近一次，较早时点记录 missedCount，live 模式显式快照', async () => {
        const s = await seed(7);
        expect(await repository.scheduleNext('live', [])).toMatchObject({ status: 'created' });
        expect(
            await db.query.scheduleOccurrences
                .findFirst({ where: eq(dbScheduleOccurrences.taskId, s.task.id) })
                .then((row) => requiredDatabaseValue(row)),
        ).toMatchObject({ scheduledAt: s.today, missedCount: 7 });
        expect(
            await db
                .select({ count: dbCount() })
                .from(dbRuns)
                .where(eq(dbRuns.taskId, s.task.id))
                .then((rows) => rows[0]!.count),
        ).toBe(1);
        expect(
            await db.query.runs
                .findFirst({ where: eq(dbRuns.taskId, s.task.id) })
                .then((row) => requiredDatabaseValue(row)),
        ).toMatchObject({
            mode: 'live',
            comparisonScopeHash: effectiveRunScopeHash(s.version.comparisonScopeHash, 'live'),
        });
    });

    it('同计划时点重放复用 Occurrence；新 scheduleRevision 拥有独立唯一键', async () => {
        const s = await seed();
        await repository.scheduleNext('demo', []);
        const first = await db.query.runs
            .findFirst({ where: eq(dbRuns.taskId, s.task.id) })
            .then((row) => requiredDatabaseValue(row));
        await db
            .update(dbRuns)
            .set({ status: 'failed', failureCode: 'TEST_DONE' })
            .where(eq(dbRuns.id, first.id))
            .returning()
            .then((rows) => requiredDatabaseValue(rows[0]));
        await db
            .update(dbTasks)
            .set({ nextRunAt: s.firstDue })
            .where(eq(dbTasks.id, s.task.id))
            .returning()
            .then((rows) => requiredDatabaseValue(rows[0]));
        expect(await repository.scheduleNext('demo', [])).toMatchObject({ status: 'reused' });
        expect(
            await db
                .select({ count: dbCount() })
                .from(dbRuns)
                .where(eq(dbRuns.taskId, s.task.id))
                .then((rows) => rows[0]!.count),
        ).toBe(1);
        await db
            .update(dbTasks)
            .set({
                nextRunAt: s.firstDue,
                scheduleRevision: sql`${dbTasks.scheduleRevision} + ${1}`,
            })
            .where(eq(dbTasks.id, s.task.id))
            .returning()
            .then((rows) => requiredDatabaseValue(rows[0]));
        expect(await repository.scheduleNext('demo', [])).toMatchObject({ status: 'created' });
        expect(
            await db
                .select({ count: dbCount() })
                .from(dbScheduleOccurrences)
                .where(eq(dbScheduleOccurrences.taskId, s.task.id))
                .then((rows) => rows[0]!.count),
        ).toBe(2);
        expect(
            await db
                .select({ count: dbCount() })
                .from(dbRuns)
                .where(eq(dbRuns.taskId, s.task.id))
                .then((rows) => rows[0]!.count),
        ).toBe(2);
    });

    it('未来计划与已取消 signal 不领取任务', async () => {
        const s = await seed();
        const controller = new AbortController();
        controller.abort();
        expect(await repository.scheduleNext('demo', [], controller.signal)).toBeNull();
        await db
            .update(dbTasks)
            .set({ nextRunAt: new Date(s.today.getTime() + 86_400_000) })
            .where(eq(dbTasks.id, s.task.id))
            .returning()
            .then((rows) => requiredDatabaseValue(rows[0]));
        expect(await repository.scheduleNext('demo', [])).toBeNull();
        expect(
            await db
                .select({ count: dbCount() })
                .from(dbScheduleOccurrences)
                .where(eq(dbScheduleOccurrences.taskId, s.task.id))
                .then((rows) => rows[0]!.count),
        ).toBe(0);
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
                await db.query.scheduleOccurrences
                    .findFirst({ where: eq(dbScheduleOccurrences.taskId, s.task.id) })
                    .then((row) => requiredDatabaseValue(row)),
            ).toMatchObject({ status: 'skipped_overlap', runId: null, missedCount: 2 });
            expect(
                await db
                    .select({ count: dbCount() })
                    .from(dbRuns)
                    .where(eq(dbRuns.taskId, s.task.id))
                    .then((rows) => rows[0]!.count),
            ).toBe(1);
            expect(
                (
                    await db.query.runs
                        .findFirst({ where: eq(dbRuns.id, run.id) })
                        .then((row) => requiredDatabaseValue(row))
                ).status,
            ).toBe(status);
        },
    );

    it.each(['paused', 'archived'] as const)('%s 不创建调度，也不终止当前执行', async (status) => {
        const s = await seed();
        const run = await activeRun(s, 'running');
        await db
            .update(dbTasks)
            .set({ status: status })
            .where(eq(dbTasks.id, s.task.id))
            .returning()
            .then((rows) => requiredDatabaseValue(rows[0]));
        expect(await repository.scheduleNext('demo', [])).toBeNull();
        expect(
            await db
                .select({ count: dbCount() })
                .from(dbScheduleOccurrences)
                .where(eq(dbScheduleOccurrences.taskId, s.task.id))
                .then((rows) => rows[0]!.count),
        ).toBe(0);
        expect(
            (
                await db.query.runs
                    .findFirst({ where: eq(dbRuns.id, run.id) })
                    .then((row) => requiredDatabaseValue(row))
            ).status,
        ).toBe('running');
    });

    it('Outbox SQL 失败使 Occurrence/Run/事件和 nextRunAt 一起回滚', async () => {
        const s = await seed();
        await db.execute(
            sql.raw(
                `CREATE FUNCTION scheduler_fail_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.payload->>'taskId' = '${s.task.id}' THEN RAISE EXCEPTION 'scheduler rollback test'; END IF; RETURN NEW; END $$`,
            ),
        );
        await db.execute(
            sql.raw(
                'CREATE TRIGGER scheduler_fail_outbox BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION scheduler_fail_outbox()',
            ),
        );
        try {
            await expect(repository.scheduleNext('demo', [])).rejects.toThrow('调度任务事务失败');
            expect(
                await db
                    .select({ count: dbCount() })
                    .from(dbScheduleOccurrences)
                    .where(eq(dbScheduleOccurrences.taskId, s.task.id))
                    .then((rows) => rows[0]!.count),
            ).toBe(0);
            expect(
                await db
                    .select({ count: dbCount() })
                    .from(dbRuns)
                    .where(eq(dbRuns.taskId, s.task.id))
                    .then((rows) => rows[0]!.count),
            ).toBe(0);
            expect(
                (
                    await db.query.tasks
                        .findFirst({ where: eq(dbTasks.id, s.task.id) })
                        .then((row) => requiredDatabaseValue(row))
                ).nextRunAt,
            ).toEqual(s.firstDue);
        } finally {
            await db.execute(sql.raw('DROP TRIGGER scheduler_fail_outbox ON outbox'));
            await db.execute(sql.raw('DROP FUNCTION scheduler_fail_outbox()'));
        }
        expect(await repository.scheduleNext('demo', [])).toMatchObject({ status: 'created' });
    });

    it('坏配置不堵住同批其他任务，并保留坏任务 nextRunAt 供后续修复', async () => {
        const bad = await seed(10);
        const good = await seed();
        await db
            .update(dbTaskVersions)
            .set({ configJson: {} })
            .where(eq(dbTaskVersions.id, bad.version.id))
            .returning()
            .then((rows) => requiredDatabaseValue(rows[0]));
        const service = new SchedulerService({ repository, mode: 'demo', concurrency: 1 });
        await expect(service.scheduleOnce(5)).rejects.toThrow('调度批次部分任务失败');
        expect(
            await db
                .select({ count: dbCount() })
                .from(dbRuns)
                .where(eq(dbRuns.taskId, good.task.id))
                .then((rows) => rows[0]!.count),
        ).toBe(1);
        expect(
            await db
                .select({ count: dbCount() })
                .from(dbRuns)
                .where(eq(dbRuns.taskId, bad.task.id))
                .then((rows) => rows[0]!.count),
        ).toBe(0);
        expect(
            (
                await db.query.tasks
                    .findFirst({ where: eq(dbTasks.id, bad.task.id) })
                    .then((row) => requiredDatabaseValue(row))
            ).nextRunAt,
        ).toEqual(bad.firstDue);
    });

    it('Task NO KEY UPDATE 与 Run 锁内写 Baseline 外键兼容，避免归档交付锁环', async () => {
        const s = await seed();
        const run = await activeRun(s);
        const taskLocked = deferred();
        const runLocked = deferred();
        const archiveOrder = competitor.transaction(async (tx) => {
            await queryRows<Record<string, unknown>>(
                tx,
                sql`SELECT id FROM tasks WHERE id = ${s.task.id}::uuid FOR NO KEY UPDATE`,
            );
            taskLocked.resolve();
            await runLocked.promise;
            await queryRows<Record<string, unknown>>(
                tx,
                sql`SELECT id FROM runs WHERE id = ${run.id}::uuid FOR UPDATE`,
            );
        });
        await taskLocked.promise;
        try {
            await db.transaction(async (tx) => {
                await queryRows<Record<string, unknown>>(
                    tx,
                    sql`SELECT id FROM runs WHERE id = ${run.id}::uuid FOR UPDATE`,
                );
                runLocked.resolve();
                await tx
                    .insert(dbBaselines)
                    .values({
                        userId: s.user.id,
                        taskId: s.task.id,
                        comparisonScopeHash: run.comparisonScopeHash,
                        completeRunId: run.id,
                    })
                    .returning()
                    .then((rows) => requiredDatabaseValue(rows[0]));
            });
            await archiveOrder;
            expect(
                await db
                    .select({ count: dbCount() })
                    .from(dbBaselines)
                    .where(eq(dbBaselines.taskId, s.task.id))
                    .then((rows) => rows[0]!.count),
            ).toBe(1);
        } finally {
            runLocked.resolve();
            await archiveOrder.catch(() => undefined);
        }
    });
});
