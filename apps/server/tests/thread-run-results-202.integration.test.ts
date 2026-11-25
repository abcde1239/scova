import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    and,
    eq,
    inboxItems,
    notifications,
    outbox,
    projectConversationTurns,
    projectResearchDrafts,
    projectTasks,
    projectThreadItems,
    projectThreadRunOrigins,
    projectThreads,
    projects,
    runEvents,
    runs,
    sql,
} from '@scova/db';
import { openSqliteRunQueue } from '@scova/db/sqlite-state';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import { createRunControl } from '@/app/run-control.ts';
import { readRunControlConfig } from '@/app/run-control-config.ts';
import { createDefaultServices } from '@/app/services.ts';
import { saveReport } from '@/repo/execution/delivery/reports.ts';
import { createRunRepository, withRunFence } from '@/repo/execution/runs.ts';
import { createOutboxQueue } from '@/repo/queue/outbox.ts';
import { createRedisConnection } from '@/repo/redis.ts';
import { createProjectThreadService } from '@/service/project-threads.ts';
import { createThreadRunResultBatch } from '@/service/thread-run-results.ts';
import { appendProjectThreadItems } from '@/repo/project-threads.ts';
import { outboxDatabase } from '../../worker/tests/support/outbox-database.ts';
import { emptyUsage, seedRun } from '../../worker/tests/support/run-database.ts';

const fixture = outboxDatabase();
const { db } = fixture;
const terminalType = 'project_thread.run_terminal';
const runRepo = createRunRepository(db);
const batch = createThreadRunResultBatch(db, 100);

beforeAll(() => fixture.setup(), 120_000);
afterAll(() => fixture.cleanup());

async function scenario(explicit = true) {
    const seeded = await seedRun(db);
    const userId = seeded.user.id;
    const projectId = randomUUID();
    const threadId = randomUUID();
    const otherThreadId = randomUUID();
    const draftId = randomUUID();
    await db.insert(projects).values({ id: projectId, userId, name: '终态交付项目' });
    await db.insert(projectThreads).values([
        { id: threadId, userId, projectId, title: '发起会话' },
        { id: otherThreadId, userId, projectId, title: '另一会话' },
    ]);
    await db.insert(projectTasks).values({ userId, projectId, taskId: seeded.task.id });
    await db.insert(projectResearchDrafts).values({
        id: draftId,
        userId,
        projectId,
        threadId,
        config: seeded.config,
        confirmedTaskId: seeded.task.id,
        confirmedRunId: seeded.run.id,
    });
    await db.insert(projectConversationTurns).values([
        {
            id: randomUUID(),
            userId,
            projectId,
            threadId,
            draftId,
            input: { kind: 'draft', message: '原始提议' },
            status: 'completed',
            createdAt: new Date(1000),
        },
        {
            id: randomUUID(),
            userId,
            projectId,
            threadId: otherThreadId,
            draftId,
            input: { kind: 'draft', message: '后续提及' },
            status: 'completed',
            createdAt: new Date(2000),
        },
    ]);
    if (explicit)
        await db.insert(projectThreadRunOrigins).values({
            userId,
            runId: seeded.run.id,
            projectId,
            threadId,
            draftId,
            draftRevision: 1,
        });
    return { ...seeded, userId, projectId, threadId, otherThreadId, draftId };
}

type Scenario = Awaited<ReturnType<typeof scenario>>;

function terminalEvents(runId: string) {
    return db
        .select()
        .from(outbox)
        .where(and(eq(outbox.aggregateId, runId), eq(outbox.eventType, terminalType)));
}

function timeline(threadId: string) {
    return db
        .select()
        .from(projectThreadItems)
        .where(eq(projectThreadItems.threadId, threadId))
        .orderBy(projectThreadItems.seq);
}

async function claim(runId: string) {
    const result = await runRepo.claim(runId, 'issue-202-test');
    if (result.kind !== 'claimed') throw new Error(`Unexpected claim: ${result.kind}`);
    return result.token;
}

async function publishReport({ run, config }: Scenario, complete = true) {
    return withRunFence(db, await claim(run.id), 'delivery', (tx, active, now) =>
        saveReport(tx, active, now, {
            config,
            context: {
                runId: active.id,
                userId: active.userId,
                taskVersionId: active.taskVersionId,
                mode: 'demo',
                config,
                budget: config.budget,
                usage: emptyUsage(),
                deadlineAt: active.deadlineAt!,
                signal: new AbortController().signal,
                assertActive: async () => undefined,
            },
            candidate: {
                schemaVersion: 1,
                runId: active.id,
                userId: active.userId,
                taskVersionId: active.taskVersionId,
                mode: 'demo',
                title: '终态报告',
                claims: [],
                pages: [],
                coverage: {
                    completeness: complete ? 'complete' : 'partial',
                    searchedQueries: [],
                    exhausted: [],
                    gaps: [],
                },
                comparison: 'not_performed',
            },
            pageRecords: new Map(),
            complete,
            outcome: complete ? 'baseline' : 'inconclusive',
            changes: [],
        }),
    );
}

describe('issue #202 project thread Run outcomes', () => {
    it('keeps existing report delivery and appends exactly one terminal pair after concurrent replay', async () => {
        const current = await scenario();
        // An explicit origin overrides a historic turn in a different thread.
        await db
            .update(projectConversationTurns)
            .set({ createdAt: new Date(0) })
            .where(eq(projectConversationTurns.threadId, current.otherThreadId));
        const { reportId } = await publishReport(current);
        const [event] = await terminalEvents(current.run.id);
        expect(event).toMatchObject({ sentAt: null });
        expect(await timeline(current.threadId)).toEqual([]);
        expect(
            await db.select().from(inboxItems).where(eq(inboxItems.reportId, reportId)),
        ).toHaveLength(1);
        expect(
            await db.select().from(notifications).where(eq(notifications.runId, current.run.id)),
        ).toEqual([expect.objectContaining({ kind: 'summary', reportId })]);
        expect(await batch()).toBe(1);
        await db.update(outbox).set({ sentAt: null }).where(eq(outbox.id, event!.id));
        await db.insert(outbox).values({
            userId: current.userId,
            aggregateId: current.run.id,
            eventType: terminalType,
            dedupeKey: `issue-202-replay-${event!.id}`,
            payload: event!.payload,
        });
        const parallelAppend = db.transaction((tx) =>
            appendProjectThreadItems(
                tx,
                current.userId,
                current.threadId,
                [{ kind: 'message', payload: { role: 'user', text: '继续研究' } }],
                new Date(),
            ),
        );
        expect(await Promise.all([batch(), batch(), parallelAppend]).then(([a, b]) => a + b)).toBe(
            2,
        );
        const items = await timeline(current.threadId);
        expect(items.map((item) => item.seq)).toEqual([1, 2, 3]);
        expect(items.filter((item) => item.kind !== 'message')).toMatchObject([
            {
                kind: 'run',
                status: 'succeeded',
                refs: [],
                payload: { runId: current.run.id, status: 'succeeded', outcome: 'baseline' },
            },
            {
                kind: 'report',
                refs: [{ kind: 'report', id: reportId }],
                payload: {
                    runId: current.run.id,
                    reportId,
                    title: '终态报告',
                    completeness: 'complete',
                },
            },
        ]);
        expect(await timeline(current.otherThreadId)).toEqual([]);
        const eventRows = await db
            .select()
            .from(runEvents)
            .where(eq(runEvents.runId, current.run.id));
        expect(eventRows.filter((event) => event.type === 'run.completed')).toHaveLength(1);
        const service = createProjectThreadService(createDefaultServices({ db: () => db }));
        const visible = await service.snapshot(current.userId, current.threadId);
        expect(visible.items.find((item) => item.kind === 'report')?.payload).toMatchObject({
            reportId,
        });
        await db.delete(projectTasks).where(eq(projectTasks.taskId, current.task.id));
        const hidden = await service.snapshot(current.userId, current.threadId);
        expect(hidden.items.find((item) => item.kind === 'run')).toMatchObject({
            status: 'succeeded',
            payload: { runId: current.run.id },
        });
        expect(JSON.stringify(hidden.items)).not.toContain(reportId);
        await expect(service.snapshot(randomUUID(), current.threadId)).rejects.toMatchObject({
            status: 404,
        });
    });

    it('routes a partial Run to its archived origin and keeps report content out after task reassignment', async () => {
        const current = await scenario();
        const projectId = randomUUID();
        await db
            .insert(projects)
            .values({ id: projectId, userId: current.userId, name: '接收项目' });
        await db
            .update(projectTasks)
            .set({ projectId })
            .where(eq(projectTasks.taskId, current.task.id));
        await db
            .update(projectThreads)
            .set({ archivedAt: new Date() })
            .where(eq(projectThreads.id, current.threadId));
        const { reportId } = await publishReport(current, false);
        expect(await batch()).toBe(1);
        expect(await timeline(current.threadId)).toMatchObject([
            {
                kind: 'run',
                status: 'partial',
                refs: [],
                payload: { runId: current.run.id, outcome: 'inconclusive' },
            },
        ]);
        expect(JSON.stringify(await timeline(current.threadId))).not.toContain(reportId);
        expect(await timeline(current.otherThreadId)).toEqual([]);
        expect(
            await db.select().from(notifications).where(eq(notifications.runId, current.run.id)),
        ).toEqual([expect.objectContaining({ kind: 'run_issue', reportId })]);
    });

    it('uses the earliest historical proposing turn and preserves existing failure and cancellation events', async () => {
        const current = await scenario(false);
        const failToken = await claim(current.run.id);
        expect(await runRepo.finish(failToken, { code: 'EXECUTOR_FAILED' })).toBe(true);
        expect(await runRepo.finish(failToken, { code: 'EXECUTOR_FAILED' })).toBe(false);
        const canceled = await scenario();
        await db
            .update(runs)
            .set({ status: 'cancel_requested', cancelRequestedAt: new Date() })
            .where(eq(runs.id, canceled.run.id));
        expect(await runRepo.claim(canceled.run.id, 'issue-202-test')).toEqual({ kind: 'ignored' });
        expect(await batch()).toBe(2);
        expect(await timeline(current.threadId)).toMatchObject([
            {
                kind: 'run',
                status: 'failed',
                payload: { runId: current.run.id, failureCode: 'EXECUTOR_FAILED' },
            },
        ]);
        expect(await timeline(current.otherThreadId)).toEqual([]);
        expect(await timeline(canceled.threadId)).toMatchObject([
            { kind: 'run', status: 'canceled', payload: { runId: canceled.run.id } },
        ]);
        expect(
            await db.select().from(notifications).where(eq(notifications.runId, current.run.id)),
        ).toEqual([expect.objectContaining({ kind: 'run_issue' })]);
        expect(
            await db.select().from(notifications).where(eq(notifications.runId, canceled.run.id)),
        ).toEqual([]);
        const events = await db
            .select()
            .from(runEvents)
            .where(eq(runEvents.runId, canceled.run.id));
        expect(events.filter((event) => event.type === 'run.canceled')).toHaveLength(1);
    });

    it('drops delivery to an origin deleted before publication and skips independent tasks', async () => {
        const current = await scenario();
        expect(await runRepo.finish(await claim(current.run.id), { code: 'EXECUTOR_FAILED' })).toBe(
            true,
        );
        await db.delete(projectThreads).where(eq(projectThreads.id, current.threadId));
        expect(await batch()).toBe(1);
        expect(await terminalEvents(current.run.id)).toMatchObject([{ sentAt: expect.any(Date) }]);
        expect(await timeline(current.otherThreadId)).toEqual([]);
        const deletedBeforeFinish = await scenario();
        await db.delete(projectThreads).where(eq(projectThreads.id, deletedBeforeFinish.threadId));
        expect(
            await runRepo.finish(await claim(deletedBeforeFinish.run.id), {
                code: 'EXECUTOR_FAILED',
            }),
        ).toBe(true);
        expect(await terminalEvents(deletedBeforeFinish.run.id)).toEqual([]);
        expect(await timeline(deletedBeforeFinish.otherThreadId)).toEqual([]);
        const independent = await seedRun(db);
        expect(
            await runRepo.finish(await claim(independent.run.id), { code: 'EXECUTOR_FAILED' }),
        ).toBe(true);
        expect(await terminalEvents(independent.run.id)).toEqual([]);
    });

    it('rolls back timeline writes on delivery failure and retries after the event backoff', async () => {
        const current = await scenario();
        expect(await runRepo.finish(await claim(current.run.id), { code: 'EXECUTOR_FAILED' })).toBe(
            true,
        );
        const [before] = await terminalEvents(current.run.id);
        // Reject the activity update after the timeline INSERT has already run.
        await db.execute(
            sql`ALTER TABLE project_threads ADD CONSTRAINT issue_202_block_activity CHECK (last_activity_at <= created_at) NOT VALID`,
        );
        const now = new Date(Date.now() + 1000);
        try {
            await expect(createThreadRunResultBatch(db, 10, () => now)()).rejects.toThrow();
            const [event] = await terminalEvents(current.run.id);
            expect(event).toMatchObject({
                attempts: 1,
                sentAt: null,
                availableAt: new Date(now.getTime() + 2000),
            });
            expect(event!.availableAt.getTime()).toBeGreaterThan(before!.availableAt.getTime());
            expect(await timeline(current.threadId)).toEqual([]);
            expect(await createThreadRunResultBatch(db, 10, () => now)()).toBe(0);
        } finally {
            await db.execute(
                sql`ALTER TABLE project_threads DROP CONSTRAINT issue_202_block_activity`,
            );
        }
        expect(
            await createThreadRunResultBatch(db, 10, () => new Date(now.getTime() + 2000))(),
        ).toBe(1);
        expect(await timeline(current.threadId)).toHaveLength(1);
    });

    it.each(['redis', 'sqlite', 'redis-unconfigured'])(
        'processes terminal delivery through Server run control with %s coordination',
        async (mode) => {
            const current = await scenario();
            expect(
                await runRepo.finish(await claim(current.run.id), { code: 'EXECUTOR_FAILED' }),
            ).toBe(true);
            const cancelId = randomUUID();
            await db.insert(outbox).values({
                id: cancelId,
                userId: current.userId,
                aggregateId: current.run.id,
                eventType: 'run.cancel_requested',
                dedupeKey: `issue-202-cancel-${cancelId}`,
                payload: { runId: current.run.id },
            });
            const expiredTurnId = randomUUID();
            await db.insert(projectConversationTurns).values({
                id: expiredTurnId,
                userId: current.userId,
                projectId: current.projectId,
                threadId: current.otherThreadId,
                input: { kind: 'ask', message: '过期待处理轮次' },
                status: 'running',
                createdAt: new Date(1000),
                executionDeadlineAt: new Date(2000),
            });
            const queueName = `issue-202-${randomUUID()}`;
            const dir =
                mode === 'sqlite' ? await mkdtemp(join(tmpdir(), 'scova-issue-202-')) : undefined;
            const sqlitePath = dir && join(dir, 'queue.sqlite');
            const control = createRunControl(
                readRunControlConfig({
                    DATABASE_URL: fixture.databaseUrl,
                    REDIS_URL: mode === 'redis' ? fixture.redisUrl : undefined,
                    SCOVA_SQLITE_STATE_PATH: sqlitePath,
                    WORKER_QUEUE_NAME: queueName,
                    WORKER_POLL_INTERVAL_MS: '20',
                    WORKER_FAILURE_DELAY_MS: '100',
                }),
            );
            const redis = mode === 'redis' ? createRedisConnection(fixture.redisUrl) : undefined;
            let observer: ReturnType<typeof createOutboxQueue> | undefined;
            const local = sqlitePath && openSqliteRunQueue(sqlitePath, queueName);
            const log =
                mode === 'redis-unconfigured'
                    ? vi.spyOn(console, 'error').mockImplementation(() => undefined)
                    : undefined;
            try {
                if (redis) {
                    await redis.connect();
                    observer = createOutboxQueue(redis, queueName);
                }
                control.start();
                await vi.waitFor(
                    async () => {
                        expect(await timeline(current.threadId)).toHaveLength(1);
                        const [expired] = await db
                            .select({ status: projectConversationTurns.status })
                            .from(projectConversationTurns)
                            .where(eq(projectConversationTurns.id, expiredTurnId));
                        expect(expired?.status).toBe('failed');
                        if (mode !== 'redis-unconfigured') {
                            const enqueue = await db.query.outbox.findFirst({
                                where: eq(outbox.id, current.outbox.id),
                            });
                            expect(enqueue?.sentAt).toBeInstanceOf(Date);
                            const cancel = await db.query.outbox.findFirst({
                                where: eq(outbox.id, cancelId),
                            });
                            expect(cancel?.sentAt).toBeInstanceOf(Date);
                        }
                    },
                    { timeout: 5000 },
                );
                if (observer) {
                    const jobs = await observer.queue.getJobs([
                        'waiting',
                        'delayed',
                        'active',
                        'completed',
                        'failed',
                    ]);
                    expect(
                        jobs.some((job) => job.id === `outbox-run.cancel_requested-${cancelId}`),
                    ).toBe(true);
                    expect(jobs.some((job) => job.name === terminalType)).toBe(false);
                    expect(jobs.some((job) => job.id === `run-${current.run.id}`)).toBe(true);
                }
                if (local) {
                    const jobs: { id: string; name: string }[] = [];
                    let job = local.claim(1000);
                    while (job) {
                        jobs.push({ id: job.id, name: job.name });
                        job.settle();
                        job = local.claim(1000);
                    }
                    expect(jobs).toContainEqual({
                        id: `run-${current.run.id}`,
                        name: 'run.enqueue',
                    });
                    expect(jobs).toContainEqual({
                        id: `outbox-run.cancel_requested-${cancelId}`,
                        name: 'run.cancel_requested',
                    });
                    expect(jobs.some((job) => job.name === terminalType)).toBe(false);
                }
            } finally {
                await control.stop();
                await observer?.close();
                redis?.disconnect();
                if (local) local.close();
                if (dir && sqlitePath) {
                    for (const suffix of ['', '-wal', '-shm']) {
                        await rm(sqlitePath + suffix, { force: true });
                    }
                    await rmdir(dir);
                }
                log?.mockRestore();
            }
        },
    );
});
