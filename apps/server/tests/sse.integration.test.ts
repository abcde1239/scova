import * as tables from '@scova/db';
import { and, eq, lt } from '@scova/db';
import { firstRow, requireRow } from '../src/utils/database.ts';
import { randomBytes, randomUUID } from 'node:crypto';
import { closeDatabase, type DatabaseClient } from '@scova/db';
import { createObservedDatabase } from './support/query-observer.ts';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { createApiApp } from '../src/app/index.ts';
import { createDefaultServices } from '../src/app/context.ts';
import { csrfForSession, tokenHash } from '../src/utils/security.ts';
import { outboxDatabase } from '../../worker/tests/support/outbox-database.ts';
import { seedRun } from '../../worker/tests/support/run-database.ts';

const fixture = outboxDatabase();
const db = fixture.db;
const origin = 'https://scova.test';
const resources: ReturnType<typeof createDefaultServices>[] = [];
const observedClients: DatabaseClient[] = [];
beforeAll(() => fixture.setup(), 120_000);
afterAll(async () => {
    await Promise.all(resources.map((services) => services.close()));
    await Promise.all(observedClients.map(closeDatabase));
    await fixture.cleanup();
});

async function seed(count = 1, terminal = false) {
    const s = await seedRun(db);
    const token = randomBytes(32).toString('base64url');
    const session = await db
        .insert(tables.sessions)
        .values({
            userId: s.user.id,
            tokenHash: tokenHash(token),
            csrfTokenHash: tokenHash(csrfForSession(token)),
            expiresAt: new Date(Date.now() + 60_000),
        })
        .returning()
        .then(firstRow);
    if (count > 1)
        await db
            .insert(tables.runEvents)
            .values(
                Array.from({ length: count - 1 }, (_, index) => ({
                    userId: s.user.id,
                    runId: s.run.id,
                    seq: index + 2,
                    type: 'step.started',
                    payload: { step: 'search' },
                })),
            )
            .returning({ id: tables.runEvents.id })
            .then((rows) => ({ count: rows.length }));
    if (terminal) await finish(s, count + 1);
    return { ...s, session, cookie: `scova_session=${token}` };
}
async function finish(s: Awaited<ReturnType<typeof seedRun>>, seq: number) {
    await db.transaction(async (tx) => {
        await tx
            .update(tables.runs)
            .set({ status: 'failed', failureCode: 'TEST_DONE', finishedAt: new Date() })
            .where(and(eq(tables.runs.id, s.run.id)))
            .returning()
            .then(firstRow);
        await tx
            .insert(tables.runEvents)
            .values({
                userId: s.user.id,
                runId: s.run.id,
                seq: seq,
                type: 'run.failed',
                payload: { status: 'failed', code: 'TEST_DONE', message: '测试执行已结束' },
            })
            .returning()
            .then(firstRow);
    });
}
function app(database: DatabaseClient = db, options: { expiryMs?: number } = {}) {
    const services = createDefaultServices({
        origin,
        db: () => database,
        sse: { pollIntervalMs: 10, heartbeatMs: 50, slowClientMs: 500 },
        ...(options.expiryMs ? { clock: () => new Date(Date.now() + options.expiryMs!) } : {}),
    });
    resources.push(services);
    return { api: createApiApp('node', services), services };
}
async function open(
    api: ReturnType<typeof createApiApp>,
    s: Awaited<ReturnType<typeof seed>>,
    suffix = '',
    headers: Record<string, string> = {},
) {
    return api.handle(
        new Request(`${origin}/api/v1/runs/${s.run.id}/events${suffix}`, {
            headers: { cookie: s.cookie, ...headers },
        }),
    );
}
const text = (value: Uint8Array | undefined) => new TextDecoder().decode(value);
function message(frame: string) {
    const data = frame.split('\n').find((line) => line.startsWith('data: '));
    return data
        ? (JSON.parse(data.slice(6)) as {
              seq?: number;
              eventId?: string;
              type: string;
              payload: { resumeAfter?: number; snapshot?: { id: string } };
          })
        : undefined;
}

describe('SSE 真实 PostgreSQL 回放与连接清理', () => {
    it('未登录401、非owner404，错误在SSE响应开始前返回JSON', async () => {
        const s = await seed();
        const other = await seed();
        const { api } = app();
        const unauthenticated = await api.handle(
            new Request(`${origin}/api/v1/runs/${s.run.id}/events`),
        );
        expect(unauthenticated.status).toBe(401);
        const denied = await open(api, { ...s, cookie: other.cookie });
        expect(denied.status).toBe(404);
        expect(denied.headers.get('content-type')).toContain('application/json');
    });

    it('大于100条历史分页后读到终态，严格有序且无重复', async () => {
        const s = await seed(205, true);
        const { api } = app();
        const response = await open(api, s);
        expect(response.status).toBe(200);
        const reader = response.body!.getReader();
        const seqs: number[] = [];
        try {
            while (true) {
                const frame = await reader.read();
                if (frame.done) break;
                const event = message(text(frame.value));
                if (event?.seq) seqs.push(event.seq);
            }
        } finally {
            await reader.cancel();
        }
        expect(seqs).toEqual(Array.from({ length: 206 }, (_, index) => index + 1));
    });

    it('Last-Event-ID定位当前Run；双游标必须一致，after严格校验', async () => {
        const s = await seed(3, true);
        const { api } = app();
        const previous = await db.query.runEvents
            .findFirst({
                where: and(eq(tables.runEvents.runId, s.run.id), eq(tables.runEvents.seq, 2)),
            })
            .then(requireRow);
        for (const suffix of [
            '?after=',
            '?after=1.2',
            '?after=1e2',
            '?after=-1',
            '?after=9007199254740992',
            '?after=1&after=2',
            '?after=99',
        ])
            expect((await open(api, s, suffix)).status).toBe(400);
        expect((await open(api, s, '', { 'last-event-id': 'bad' })).status).toBe(400);
        expect((await open(api, s, '?after=1', { 'last-event-id': previous.id })).status).toBe(400);
        const response = await open(api, s, '?after=2', { 'last-event-id': previous.id });
        const reader = response.body!.getReader();
        expect(message(text((await reader.read()).value))?.seq).toBe(3);
        expect(message(text((await reader.read()).value))?.seq).toBe(4);
        expect((await reader.read()).done).toBe(true);
    });

    it('物理删除历史前缀后reset无id且关闭，按resumeAfter可续传新事件', async () => {
        const s = await seed(5);
        const removed = await db.query.runEvents
            .findFirst({
                where: and(eq(tables.runEvents.runId, s.run.id), eq(tables.runEvents.seq, 2)),
            })
            .then(requireRow);
        await db
            .delete(tables.runEvents)
            .where(and(eq(tables.runEvents.runId, s.run.id), lt(tables.runEvents.seq, 4)))
            .returning()
            .then((rows) => ({ count: rows.length }));
        const { api } = app();
        for (const [suffix, headers] of [
            ['?after=1', {}],
            ['', { 'last-event-id': removed.id }],
        ] as const) {
            const response = await open(api, s, suffix, headers);
            const reader = response.body!.getReader();
            const frame = text((await reader.read()).value);
            expect(frame).not.toMatch(/^id:/m);
            expect(message(frame)).toMatchObject({
                type: 'stream.reset',
                payload: { resumeAfter: 5, snapshot: { id: s.run.id } },
            });
            expect((await reader.read()).done).toBe(true);
        }
        const resumed = await open(api, s, '?after=5');
        const reader = resumed.body!.getReader();
        const next = reader.read();
        await finish(s, 6);
        expect(message(text((await next).value))?.seq).toBe(6);
        expect((await reader.read()).done).toBe(true);
    });

    it('其他Run事件ID与不存在ID仅reset当前owner快照，不泄漏其他事件', async () => {
        const s = await seed();
        const other = await seed();
        const foreign = await db.query.runEvents
            .findFirst({ where: and(eq(tables.runEvents.runId, other.run.id)) })
            .then(requireRow);
        const { api } = app();
        for (const id of [foreign.id, randomUUID()]) {
            const response = await open(api, s, '', { 'last-event-id': id });
            const payload = await response.text();
            expect(payload).toContain('"stream.reset"');
            expect(payload).toContain(s.run.id);
            expect(payload).not.toContain(other.run.id);
            expect(payload).not.toContain(foreign.id);
        }
    });

    it('序列内部缺口reset；已定位的双游标不一致不会被reset掩盖', async () => {
        const s = await seed(4);
        const first = await db.query.runEvents
            .findFirst({
                where: and(eq(tables.runEvents.runId, s.run.id), eq(tables.runEvents.seq, 1)),
            })
            .then(requireRow);
        await db
            .delete(tables.runEvents)
            .where(and(eq(tables.runEvents.runId, s.run.id), eq(tables.runEvents.seq, 3)))
            .returning()
            .then((rows) => ({ count: rows.length }));
        const { api } = app();
        expect((await open(api, s, '?after=2', { 'last-event-id': first.id })).status).toBe(400);
        const reset = await open(api, s, '?after=1');
        expect(await reset.text()).toContain('"resumeAfter":4');
    });

    it('回放N之后追加N+1并终结，无实时切换缺口', async () => {
        const s = await seed();
        const { api } = app();
        const reader = (await open(api, s)).body!.getReader();
        expect(message(text((await reader.read()).value))?.seq).toBe(1);
        const next = reader.read();
        await finish(s, 2);
        expect(message(text((await next).value))?.seq).toBe(2);
        expect((await reader.read()).done).toBe(true);
    });

    it('空页快照与终态并发提交，下一快照仍发送最后事件', async () => {
        const s = await seed();
        let armed = false;
        const database = createObservedDatabase(fixture.databaseUrl, {
            async after(query) {
                if (armed && /\bmax\(/i.test(query.text) && query.text.includes('"run_events"')) {
                    armed = false;
                    await finish(s, 2);
                }
            },
        });
        observedClients.push(database);
        const { api } = app(database);
        const reader = (await open(api, s)).body!.getReader();
        await reader.read();
        armed = true;
        let event = await reader.read();
        while (text(event.value).startsWith(':')) event = await reader.read();
        expect(message(text(event.value))?.seq).toBe(2);
        expect((await reader.read()).done).toBe(true);
    });

    it('revoke在下页停止；取消reader后不再发起查询，registry等待在途清理', async () => {
        const s = await seed();
        let reads = 0;
        const database = createObservedDatabase(fixture.databaseUrl, {
            before(query) {
                if (/\bfrom\s+"sessions"/i.test(query.text)) reads += 1;
            },
        });
        observedClients.push(database);
        const { api, services } = app(database);
        const reader = (await open(api, s)).body!.getReader();
        await reader.read();
        const reading = reader.read();
        await db
            .update(tables.sessions)
            .set({ revokedAt: new Date() })
            .where(and(eq(tables.sessions.id, s.session.id)))
            .returning()
            .then(firstRow);
        await expect(reading).rejects.toThrow('事件连接已结束');
        await services.streams.stop();
        const count = reads;
        await new Promise((resolve) => setTimeout(resolve, 40));
        expect(reads).toBe(count);
        const second = await seed();
        const active = app(database);
        const canceled = (await open(active.api, second)).body!.getReader();
        await canceled.read();
        await canceled.cancel();
        await active.services.streams.stop();
        const after = reads;
        await new Promise((resolve) => setTimeout(resolve, 40));
        expect(reads).toBe(after);
    });

    it('连接中会话到期独立结束，后续请求返回401', async () => {
        const s = await seed();
        await db
            .update(tables.sessions)
            .set({ expiresAt: new Date(Date.now() + 500) })
            .where(and(eq(tables.sessions.id, s.session.id)))
            .returning()
            .then(firstRow);
        const { api, services } = app();
        const reader = (await open(api, s)).body!.getReader();
        await reader.read();
        let ended = false;
        try {
            while (!(await reader.read()).done) {
                /* 心跳不延长会话。 */
            }
        } catch {
            ended = true;
        }
        expect(ended).toBe(true);
        await services.streams.stop();
        expect((await open(api, s)).status).toBe(401);
    });
});
