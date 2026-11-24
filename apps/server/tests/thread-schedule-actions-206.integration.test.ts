import { randomUUID } from 'node:crypto';
import {
    and,
    eq,
    outbox,
    projectThreadItems,
    projectThreads,
    projects,
    runs,
    users,
} from '@scova/db';
import type { ProjectScheduleProposal, TaskConfig } from '@scova/models';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import { createDefaultServices } from '@/app/services.ts';
import { createProjectService } from '@/service/projects.ts';
import { createTaskService } from '@/service/tasks.ts';
import { createThreadScheduleActionService } from '@/service/thread-schedule-actions.ts';
import { outboxDatabase } from '../../worker/tests/support/outbox-database.ts';
import { runConfig } from '../../worker/tests/support/run-database.ts';

const fixture = outboxDatabase();
const { db } = fixture;
const services = createDefaultServices({ db: () => db });
const actions = createThreadScheduleActionService(services);
const tasks = createTaskService(services);
const membership = createProjectService(services);
const explicit = { autonomy: 'autonomous', target: 'explicit' } as const;
const config: TaskConfig = { ...runConfig(), schedule: { frequency: 'daily', localTime: '09:00' } };
const create = { command: 'create_schedule', task: { config } } satisfies ProjectScheduleProposal;

beforeAll(() => fixture.setup(), 120_000);
afterAll(() => fixture.cleanup());

async function scenario() {
    const userId = randomUUID();
    const email = `${userId}@example.test`;
    await db
        .insert(users)
        .values({ id: userId, email, normalizedEmail: email, passwordHash: 'fixture' });
    const first = await membership.create(userId, { name: '周期计划项目' });
    const other = await membership.create(userId, { name: '另一个项目' });
    const threadId = randomUUID();
    const siblingId = randomUUID();
    await db.insert(projectThreads).values([
        { id: threadId, userId, projectId: first.id, title: '对话' },
        { id: siblingId, userId, projectId: first.id, title: '另一会话' },
    ]);
    return { userId, threadId, siblingId, projectId: first.id, otherProjectId: other.id };
}

async function timeline(threadId: string) {
    return db
        .select()
        .from(projectThreadItems)
        .where(eq(projectThreadItems.threadId, threadId))
        .orderBy(projectThreadItems.seq);
}

async function plan() {
    const scope = await scenario();
    const { actionId } = await actions.propose(scope, create, explicit);
    const applied = await actions.decide(scope, actionId!, true);
    return {
        scope,
        actionId: actionId!,
        applied,
        taskId: applied.taskId!,
        revision: applied.taskRevision!,
    };
}

describe('project Thread schedule actions', () => {
    it('creates one task across concurrent approvals and appends sequenced immutable receipts', async () => {
        const scope = await scenario();
        const proposed = await actions.propose(scope, create, explicit);
        expect(proposed.decision).toEqual({ outcome: 'confirm', reason: 'budget_unavailable' });
        expect(proposed.receipt).toBeNull();
        const actionId = proposed.actionId!;
        const [applied, replay] = await Promise.all([
            actions.decide(scope, actionId, true),
            actions.decide(scope, actionId, true),
        ]);
        expect(applied).toEqual(replay);
        expect(applied).toMatchObject({
            actionId,
            status: 'applied',
            taskRevision: 1,
            runId: null,
            undoable: true,
        });
        expect((await tasks.get(scope.userId, applied.taskId!)).task.nextRunAt).toEqual(
            expect.any(String),
        );
        expect(await db.select().from(runs).where(eq(runs.userId, scope.userId))).toEqual([]);
        expect(await timeline(scope.threadId)).toMatchObject([
            { id: actionId, seq: 1, status: 'applied', payload: create },
            { seq: 2, status: 'applied', payload: applied },
        ]);
        const [undone, undoReplay] = await Promise.all([
            actions.undo(scope, actionId),
            actions.undo(scope, actionId),
        ]);
        expect(undone).toEqual(undoReplay);
        expect(undone).toMatchObject({ status: 'undone', taskRevision: 2, undoable: false });
        expect(await actions.decide(scope, actionId, true)).toEqual(applied);
        const detail = await tasks.get(scope.userId, applied.taskId!);
        expect(detail.version.config.schedule).toEqual({ frequency: 'manual' });
        expect(detail.task.nextRunAt).toBeNull();
        expect((await timeline(scope.threadId)).slice(1)).toMatchObject([
            { seq: 2, status: 'applied', payload: applied },
            { seq: 3, status: 'undone', payload: undone },
        ]);
    });

    it('requires actual caller-supplied admission and an explicit target for automatic execution', async () => {
        const scope = await scenario();
        const authorizeBudget = vi.fn(async () => 'authorized' as const);
        const inferred = await actions.propose(
            scope,
            create,
            { ...explicit, target: 'inferred' },
            { authorizeBudget },
        );
        expect(inferred).toMatchObject({
            decision: { outcome: 'confirm', reason: 'explicit_target_required' },
            receipt: null,
        });
        expect(authorizeBudget).not.toHaveBeenCalled();
        const denied = await actions.propose(scope, create, explicit, {
            authorizeBudget: async () => 'exceeded',
        });
        expect(denied).toMatchObject({
            decision: { outcome: 'confirm', reason: 'budget_exceeded' },
            receipt: null,
        });
        const authorized = await actions.propose(scope, create, explicit, { authorizeBudget });
        expect(authorized).toMatchObject({
            decision: { outcome: 'execute' },
            receipt: { status: 'applied' },
        });
        expect(authorizeBudget).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
                userId: scope.userId,
                projectId: scope.projectId,
                actionId: authorized.actionId,
                budget: config.budget,
            }),
            expect.anything(),
        );
        expect((await timeline(scope.threadId)).map(({ seq }) => seq)).toEqual([1, 2, 3, 4]);
    });

    it('keeps an over-limit plan pending and rejects attempts to bypass deployment limits', async () => {
        const scope = await scenario();
        const authorizeBudget = vi.fn(async () => 'authorized' as const);
        const oversized = {
            command: 'create_schedule',
            task: { config: { ...config, budget: { ...config.budget, maxSearches: 1_000 } } },
        };
        const proposed = await actions.propose(scope, oversized, explicit, { authorizeBudget });
        expect(proposed).toMatchObject({
            decision: { outcome: 'confirm', reason: 'budget_exceeded' },
            receipt: null,
        });
        expect(authorizeBudget).not.toHaveBeenCalled();
        await expect(actions.decide(scope, proposed.actionId!, true)).rejects.toMatchObject({
            code: 'BUDGET_EXCEEDED',
        });
        expect(await timeline(scope.threadId)).toMatchObject([{ seq: 1, status: 'pending' }]);
    });

    it('automatically pauses an explicit recurring task when admission is authorized', async () => {
        const { scope, taskId, revision } = await plan();
        const proposal = { command: 'pause_task', taskId, revision };
        const proposed = await actions.propose(scope, proposal, explicit, {
            authorizeBudget: async () => 'authorized',
        });
        expect(proposed).toMatchObject({
            decision: { outcome: 'execute' },
            receipt: { status: 'applied', taskId, taskRevision: revision + 1, undoable: true },
        });
        expect((await tasks.get(scope.userId, taskId)).task).toMatchObject({
            status: 'paused',
            nextRunAt: null,
        });
    });

    it('rejects conflicting decisions, missing ownership, and an ambiguous target', async () => {
        const scope = await scenario();
        const stranger = await scenario();
        const { actionId } = await actions.propose(scope, create, explicit);
        await expect(
            actions.decide({ ...scope, userId: stranger.userId }, actionId!, true),
        ).rejects.toMatchObject({ status: 404 });
        await expect(
            actions.decide({ ...scope, threadId: scope.siblingId }, actionId!, true),
        ).rejects.toMatchObject({ status: 404 });
        const rejected = await actions.decide(scope, actionId!, false);
        expect(rejected).toMatchObject({ status: 'rejected', taskId: null, undoable: false });
        expect(await actions.decide(scope, actionId!, false)).toEqual(rejected);
        await expect(actions.decide(scope, actionId!, true)).rejects.toMatchObject({
            code: 'ACTION_CONFLICT',
        });
        await expect(actions.undo(scope, actionId!)).rejects.toMatchObject({
            code: 'ACTION_CONFLICT',
        });
        const ambiguous = await actions.propose(scope, create, {
            ...explicit,
            target: 'ambiguous',
        });
        expect(ambiguous).toMatchObject({ decision: { outcome: 'clarify' }, actionId: null });
        expect((await timeline(scope.threadId)).map(({ kind }) => kind)).toEqual([
            'schedule',
            'schedule',
            'disambiguation',
        ]);
    });

    it('pauses and restores a recurring task with the existing scheduler semantics', async () => {
        const { scope, taskId, revision } = await plan();
        const { actionId } = await actions.propose(
            scope,
            { command: 'pause_task', taskId, revision },
            { ...explicit, autonomy: 'budgeted' },
        );
        const paused = await actions.decide(scope, actionId!, true);
        expect(paused).toMatchObject({ status: 'applied', taskRevision: revision + 1 });
        expect((await tasks.get(scope.userId, taskId)).task).toMatchObject({
            status: 'paused',
            nextRunAt: null,
        });
        await actions.undo(scope, actionId!);
        expect((await tasks.get(scope.userId, taskId)).task).toMatchObject({
            status: 'active',
            nextRunAt: expect.any(String),
            revision: revision + 2,
        });
    });

    it('requires confirmation to edit a schedule and restores the previous schedule and time zone', async () => {
        const { scope, taskId, revision } = await plan();
        const schedule = { frequency: 'weekly', localTime: '15:00', weekday: 4 } as const;
        const timezone = 'Asia/Tokyo';
        const proposed = await actions.propose(
            scope,
            { command: 'update_schedule', taskId, revision, schedule, timezone },
            explicit,
            { authorizeBudget: async () => 'authorized' },
        );
        expect(proposed).toMatchObject({
            decision: { outcome: 'confirm', reason: 'policy' },
            receipt: null,
        });
        await actions.decide(scope, proposed.actionId!, true);
        expect((await tasks.get(scope.userId, taskId)).version.config).toMatchObject({
            schedule,
            timezone,
        });
        await actions.undo(scope, proposed.actionId!);
        expect((await tasks.get(scope.userId, taskId)).version.config).toMatchObject({
            schedule: config.schedule,
            timezone: config.timezone,
        });
    });

    it('refuses to overwrite later edits or apply an action after the task moves', async () => {
        const { scope, taskId, revision, actionId } = await plan();
        await tasks.update(
            scope.userId,
            taskId,
            { config: { ...config, title: '用户后续编辑' } },
            revision,
        );
        await expect(actions.undo(scope, actionId)).rejects.toMatchObject({
            code: 'ACTION_CONFLICT',
        });
        const pending = await actions.propose(
            scope,
            { command: 'pause_task', taskId, revision: revision + 1 },
            explicit,
        );
        await membership.setMembership(scope.userId, scope.otherProjectId, taskId, true);
        await expect(actions.decide(scope, pending.actionId!, true)).rejects.toMatchObject({
            status: 404,
        });
        expect((await tasks.get(scope.userId, taskId)).task).toMatchObject({
            title: '用户后续编辑',
            status: 'active',
        });
        expect((await timeline(scope.threadId)).map(({ status }) => status)).toEqual([
            'applied',
            'applied',
            'pending',
        ]);
    });

    it('rolls back the task and timeline together when an outer turn transaction fails', async () => {
        const scope = await scenario();
        let taskId: string | null | undefined;
        await expect(
            db.transaction(async (tx) => {
                const proposed = await actions.propose(scope, create, explicit, {
                    tx,
                    authorizeBudget: async () => 'authorized',
                });
                taskId = proposed.receipt?.taskId;
                throw new Error('fixture turn persistence failure');
            }),
        ).rejects.toThrow('fixture turn persistence failure');
        expect(taskId).toEqual(expect.any(String));
        await expect(tasks.get(scope.userId, taskId!)).rejects.toMatchObject({ status: 404 });
        expect(await timeline(scope.threadId)).toEqual([]);
        expect(
            await db.select().from(projects).where(eq(projects.id, scope.projectId)),
        ).toHaveLength(1);
    });

    it('uses the existing idempotent Run cancellation and rejects a moved task', async () => {
        const scope = await scenario();
        const { detail, runId } = await tasks.createInProject(
            scope.userId,
            scope.projectId,
            { config: runConfig() },
            randomUUID(),
            true,
        );
        await membership.setMembership(scope.userId, scope.otherProjectId, detail.task.id, true);
        await expect(actions.cancelRun(scope, runId!)).rejects.toMatchObject({ status: 404 });
        await membership.setMembership(scope.userId, scope.projectId, detail.task.id, true);
        expect(await actions.cancelRun(scope, runId!)).toMatchObject({
            run: { id: runId, status: 'cancel_requested' },
            reused: false,
        });
        expect(await actions.cancelRun(scope, runId!)).toMatchObject({
            run: { id: runId, status: 'cancel_requested' },
            reused: true,
        });
        expect(
            await db
                .select()
                .from(outbox)
                .where(
                    and(
                        eq(outbox.aggregateId, runId!),
                        eq(outbox.eventType, 'run.cancel_requested'),
                    ),
                ),
        ).toHaveLength(1);
    });
});
