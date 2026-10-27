import { randomBytes, randomUUID } from 'node:crypto';
import type { PrismaClient } from '@scova/models';
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
beforeAll(() => fixture.setup(), 120_000);
afterAll(async () => {
    await Promise.all(resources.map((services) => services.close()));
    await fixture.cleanup();
});

async function seed(count = 1, terminal = false) {
    const s = await seedRun(db);
    const token = randomBytes(32).toString('base64url');
    const session = await db.session.create({
        data: {
            userId: s.user.id,
            tokenHash: tokenHash(token),
            csrfTokenHash: tokenHash(csrfForSession(token)),
            expiresAt: new Date(Date.now() + 60_000),
        },
    });
    if (count > 1)
        await db.runEvent.createMany({
            data: Array.from({ length: count - 1 }, (_, index) => ({
                userId: s.user.id,
                runId: s.run.id,
                seq: index + 2,
                type: 'step.started',
                payload: { step: 'search' },
            })),
        });
    if (terminal) await finish(s, count + 1);
    return { ...s, session, cookie: `scova_session=${token}` };
}
async function finish(s: Awaited<ReturnType<typeof seedRun>>, seq: number) {
    await db.$transaction(async (tx) => {
        await tx.run.update({
            where: { id: s.run.id },
            data: { status: 'failed', failureCode: 'TEST_DONE', finishedAt: new Date() },
        });
        await tx.runEvent.create({
            data: {
                userId: s.user.id,
                runId: s.run.id,
                seq,
                type: 'run.failed',
                payload: { status: 'failed', code: 'TEST_DONE', message: '测试执行已结束' },
            },
        });
    });
}
function app(database: PrismaClient = db, options: { expiryMs?: number } = {}) {
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
        const previous = await db.runEvent.findFirstOrThrow({ where: { runId: s.run.id, seq: 2 } });
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
        const removed = await db.runEvent.findFirstOrThrow({ where: { runId: s.run.id, seq: 2 } });
        await db.runEvent.deleteMany({ where: { runId: s.run.id, seq: { lt: 4 } } });
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
        const foreign = await db.runEvent.findFirstOrThrow({ where: { runId: other.run.id } });
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
        const first = await db.runEvent.findFirstOrThrow({ where: { runId: s.run.id, seq: 1 } });
        await db.runEvent.deleteMany({ where: { runId: s.run.id, seq: 3 } });
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
        const database = db.$extends({
            query: {
                runEvent: {
                    async aggregate({ args, query }) {
                        const result = await query(args);
                        if (armed) {
                            armed = false;
                            await finish(s, 2);
                        }
                        return result;
                    },
                },
            },
        }) as unknown as PrismaClient;
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
        const database = db.$extends({
            query: {
                session: {
                    async findFirst({ args, query }) {
                        reads += 1;
                        return query(args);
                    },
                },
            },
        }) as unknown as PrismaClient;
        const { api, services } = app(database);
        const reader = (await open(api, s)).body!.getReader();
        await reader.read();
        const reading = reader.read();
        await db.session.update({ where: { id: s.session.id }, data: { revokedAt: new Date() } });
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
        await db.session.update({
            where: { id: s.session.id },
            data: { expiresAt: new Date(Date.now() + 500) },
        });
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
