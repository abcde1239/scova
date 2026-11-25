import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import {
    and,
    eq,
    asc,
    queryRows,
    sql,
    runs,
    runEvents,
    sessions,
    runGraphSnapshots,
    persistRunGraphEvent,
} from '@scova/db';
import {
    RunEventSchema,
    RunGraphSnapshotSchema,
    parseContract,
    type RunGraphSnapshot,
} from '@scova/models';
import { createApiApp } from '../src/app/index.ts';
import { createDefaultServices } from '../src/app/services.ts';
import { csrfForSession, tokenHash } from '../src/utils/security.ts';
import { outboxDatabase } from '../../worker/tests/support/outbox-database.ts';
import { seedRun } from '../../worker/tests/support/run-database.ts';
import { appendEvent } from '../src/repo/execution/runs.ts';
import type { RunEventInput } from '@scova/execution/runs';

const fixture = outboxDatabase();
const db = fixture.db;
const origin = 'https://scova.test';
const services = createDefaultServices({ origin, db: () => db, sse: { pollIntervalMs: 10 } });
const api = createApiApp('node', services);
beforeAll(() => fixture.setup(), 120_000);
afterAll(async () => {
    await services.close();
    await fixture.cleanup();
});

async function seed(projectQueued = true) {
    const data = await seedRun(db);
    const token = randomBytes(32).toString('base64url');
    await db.insert(sessions).values({
        userId: data.user.id,
        tokenHash: tokenHash(token),
        csrfTokenHash: tokenHash(csrfForSession(token)),
        expiresAt: new Date(Date.now() + 120_000),
    });
    if (projectQueued) {
        const event = (
            await db.select().from(runEvents).where(eq(runEvents.runId, data.run.id))
        )[0]!;
        await db.transaction((tx) =>
            persistRunGraphEvent(
                tx,
                data.user.id,
                parseContract(RunEventSchema, {
                    schemaVersion: event.schemaVersion,
                    eventId: event.id,
                    runId: event.runId,
                    seq: event.seq,
                    occurredAt: event.occurredAt.toISOString(),
                    type: event.type,
                    payload: event.payload,
                }),
            ),
        );
    }
    return { ...data, cookie: `scova_session=${token}` };
}
async function append(data: Awaited<ReturnType<typeof seed>>, event: RunEventInput) {
    await db.transaction(async (tx) => {
        await queryRows(tx, sql`SELECT id FROM runs WHERE id=${data.run.id}::uuid FOR UPDATE`);
        if (event.type.startsWith('run.') && 'status' in event.payload) {
            await tx
                .update(runs)
                .set({ status: event.payload.status })
                .where(eq(runs.id, data.run.id));
        }
        await appendEvent(tx, data.run, new Date(), event);
    });
}
async function graph(data: Awaited<ReturnType<typeof seed>>, cookie = data.cookie) {
    return api.handle(
        new Request(`${origin}/api/v1/runs/${data.run.id}/graph`, { headers: { cookie } }),
    );
}
async function snapshot(data: Awaited<ReturnType<typeof seed>>): Promise<RunGraphSnapshot> {
    const response = await graph(data);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    return parseContract(RunGraphSnapshotSchema, await response.json());
}
const execution = () => ({
    graphVersion: 1 as const,
    instanceId: randomUUID(),
    attemptId: randomUUID(),
});

describe('研究节点图真实PostgreSQL投影、回放与鉴权', () => {
    it('拒绝匿名与非owner，不在只读快照中暴露执行内部字段', async () => {
        const a = await seed(),
            b = await seed();
        const anonymous = await api.handle(new Request(`${origin}/api/v1/runs/${a.run.id}/graph`));
        expect(anonymous.status).toBe(401);
        expect((await graph(a, b.cookie)).status).toBe(404);
        const state = await snapshot(a);
        expect(state).toMatchObject({
            runId: a.run.id,
            seq: 1,
            historyComplete: true,
            instances: [],
        });
        expect(JSON.stringify(state)).not.toMatch(/leaseOwner|checkpoint|encryptedApiKey|prompt/);
    });

    it('事件与投影同事务提交；清空事件后保留节点并继续单调分配seq', async () => {
        const data = await seed();
        const first = execution();
        await append(data, { type: 'step.started', payload: { step: 'search', execution: first } });
        await append(data, {
            type: 'step.completed',
            payload: { step: 'search', execution: first, durationMs: 7 },
        });
        await db.delete(runEvents).where(eq(runEvents.runId, data.run.id));
        const retained = await snapshot(data);
        expect(retained).toMatchObject({ seq: 3, precision: 'instances', historyComplete: true });
        expect(retained.instances[0]!.attempts[0]!.status).toBe('succeeded');
        const second = execution();
        await append(data, {
            type: 'step.started',
            payload: { step: 'search', execution: second },
        });
        expect((await snapshot(data)).seq).toBe(4);
        const [event] = await db.select().from(runEvents).where(eq(runEvents.runId, data.run.id));
        expect(event!.seq).toBe(4);
        const response = await api.handle(
            new Request(`${origin}/api/v1/runs/${data.run.id}/events?after=0`, {
                headers: { cookie: data.cookie },
            }),
        );
        const text = await response.text();
        expect(text).toContain('event: stream.reset');
        expect(text).toContain('"resumeAfter":4');
        const refreshed = await snapshot(data);
        expect(refreshed.instances).toHaveLength(2);
    });

    it('全部事件已清理时SSE reset仍使用投影高水位', async () => {
        const data = await seed();
        await append(data, {
            type: 'step.started',
            payload: { step: 'read', execution: execution() },
        });
        await db.delete(runEvents).where(eq(runEvents.runId, data.run.id));
        const response = await api.handle(
            new Request(`${origin}/api/v1/runs/${data.run.id}/events?after=0`, {
                headers: { cookie: data.cookie },
            }),
        );
        expect(await response.text()).toContain('"resumeAfter":2');
        expect((await snapshot(data)).seq).toBe(2);
    });

    it('仅尾部事件已清理时短页触发reset，不无限等待已知高水位', async () => {
        const data = await seed();
        await append(data, {
            type: 'step.started',
            payload: { step: 'read', execution: execution() },
        });
        await db
            .delete(runEvents)
            .where(and(eq(runEvents.runId, data.run.id), eq(runEvents.seq, 2)));
        const response = await api.handle(
            new Request(`${origin}/api/v1/runs/${data.run.id}/events?after=0`, {
                headers: { cookie: data.cookie },
            }),
        );
        expect(await response.text()).toContain('"resumeAfter":2');
        expect((await snapshot(data)).instances[0]!.step).toBe('read');
    });

    it('恢复重试保留旧尝试并复用逻辑节点身份，终态不把未完成步骤标成功', async () => {
        const data = await seed();
        const first = execution(),
            retry = { ...first, attemptId: randomUUID() };
        await append(data, { type: 'step.started', payload: { step: 'read', execution: first } });
        await append(data, {
            type: 'run.recovering',
            payload: { status: 'recovering', recoveryCount: 1 },
        });
        await append(data, {
            type: 'run.started',
            payload: { status: 'running', startedAt: new Date().toISOString() },
        });
        await append(data, { type: 'step.started', payload: { step: 'read', execution: retry } });
        await append(data, {
            type: 'run.failed',
            payload: { status: 'failed', code: 'TEST_FAILURE', message: '执行未完成' },
        });
        const state = await snapshot(data);
        expect(state.runStatus).toBe('failed');
        expect(state.instances[0]!.attempts.map((attempt) => attempt.status)).toEqual([
            'interrupted',
            'unknown',
        ]);
    });

    it('取消请求从Run行立即可见，取消终态更新在途尝试', async () => {
        const data = await seed();
        await append(data, {
            type: 'step.started',
            payload: { step: 'plan', execution: execution() },
        });
        await db
            .update(runs)
            .set({ status: 'cancel_requested', cancelRequestedAt: new Date() })
            .where(eq(runs.id, data.run.id));
        expect(await snapshot(data)).toMatchObject({ seq: 2, runStatus: 'cancel_requested' });
        await append(data, {
            type: 'run.canceled',
            payload: { status: 'canceled', message: '取消' },
        });
        expect((await snapshot(data)).instances[0]!.attempts[0]!.status).toBe('canceled');
    });

    it('事务回滚不会留下领先事件的节点快照', async () => {
        const data = await seed();
        await expect(
            db.transaction(async (tx) => {
                await appendEvent(tx, data.run, new Date(), {
                    type: 'step.started',
                    payload: { step: 'search', execution: execution() },
                });
                throw new Error('rollback-test');
            }),
        ).rejects.toThrow('rollback-test');
        expect(await snapshot(data)).toMatchObject({ seq: 1, instances: [] });
        expect(
            await db
                .select()
                .from(runEvents)
                .where(eq(runEvents.runId, data.run.id))
                .orderBy(asc(runEvents.seq)),
        ).toHaveLength(1);
    });

    it('旧事件只有阶段计数，清理历史后显式标记不完整且不生成虚构实例', async () => {
        const data = await seed(false);
        await db.insert(runEvents).values([
            {
                runId: data.run.id,
                userId: data.user.id,
                seq: 2,
                type: 'step.started',
                payload: { step: 'search' },
            },
            {
                runId: data.run.id,
                userId: data.user.id,
                seq: 3,
                type: 'step.completed',
                payload: { step: 'search', durationMs: 2 },
            },
        ]);
        expect(await snapshot(data)).toMatchObject({
            precision: 'legacy',
            graphVersion: null,
            historyComplete: true,
            instances: [],
            legacySteps: [{ step: 'search', started: 1, completed: 1 }],
        });
        await db
            .delete(runEvents)
            .where(and(eq(runEvents.runId, data.run.id), eq(runEvents.seq, 1)));
        expect(await snapshot(data)).toMatchObject({
            precision: 'legacy',
            historyComplete: false,
            instances: [],
        });
        expect(
            await db
                .select()
                .from(runGraphSnapshots)
                .where(eq(runGraphSnapshots.runId, data.run.id)),
        ).toHaveLength(0);
    });
});
