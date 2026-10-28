import * as tables from '@scova/db';
import { and, eq, sql } from '@scova/db';
import { firstRow, requireRow } from '../src/utils/database.ts';
import { createDatabaseClient, connectDatabase, closeDatabase } from '@scova/db';
import { createObservedDatabase } from './support/query-observer.ts';
import { afterAll, beforeAll, expect, it } from 'vite-plus/test';
import { createDefaultServices } from '../src/app/context.ts';
import { createTaskService } from '../src/service/tasks.ts';
import { historyFixture, seedHistoryRows } from './support/history-fixture.ts';

const fixture = historyFixture();
const writer = createDatabaseClient({ connectionString: fixture.databaseUrl });
beforeAll(async () => {
    await fixture.setup();
    await connectDatabase(writer);
}, 120_000);
afterAll(async () => {
    try {
        await closeDatabase(writer);
    } finally {
        await fixture.cleanup();
    }
});
function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}
async function within<T>(promise: Promise<T>, description: string) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(description)), 5_000);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

it('Task游标核验后并发更新anchor，seek及hydrate仍用同一微秒快照，不重复上一页', async () => {
    const owner = await fixture.register();
    const data = await seedHistoryRows(fixture.db, owner, 4, 1);
    const ids = data.tasks.map((task) => task.id);
    for (const [index, id] of ids.entries()) {
        const timestamp = '2026-02-01T00:00:00.12345' + (6 - index) + 'Z';
        await fixture.db.execute(sql`
      UPDATE tasks SET updated_at=${timestamp}::timestamptz WHERE id=${id}::uuid
    `);
    }
    const entered = deferred(),
        release = deferred();
    let armed = false;
    // Gate the actual anchor query after its database read. Returning its original
    // result preserves the production RR transaction and all subsequent queries.
    const reader = createObservedDatabase(fixture.databaseUrl, {
        async after(query) {
            if (armed && /to_char\(updated_at/.test(query.text) && query.values.includes(ids[1])) {
                armed = false;
                entered.resolve();
                await release.promise;
            }
        },
    });
    const services = createDefaultServices({
        db: () => reader,
        close: async () => {},
    });
    const tasks = createTaskService(services);
    const first = await tasks.list(owner.id, { limit: 2 });
    expect(first.items.map((task) => task.id)).toEqual(ids.slice(0, 2));
    expect(first.nextCursor).toBeTruthy();
    armed = true;
    const pending = tasks.list(owner.id, { limit: 2, cursor: first.nextCursor! });
    void pending.catch(() => undefined);
    try {
        await within(entered.promise, 'Task list did not read its real cursor anchor');
        await writer.transaction(async (tx) => {
            await tx
                .update(tables.tasks)
                .set({ title: '并发修改后的任务', updatedAt: new Date('2026-02-02T00:00:00.000Z') })
                .where(and(eq(tables.tasks.id, ids[1]!)))
                .returning()
                .then(firstRow);
            await tx.execute(sql`
        UPDATE tasks SET title=${'并发更新后的待加载任务'} WHERE id=${ids[2]!}::uuid
      `);
        });
        release.resolve();
        const second = await within(pending, 'Task list did not finish after anchor gate release');
        expect(second.items.map((task) => task.id)).toEqual(ids.slice(2));
        expect(second.items[0]!.title).toBe(first.items[0]!.title);
        expect(second.nextCursor).toBeNull();
        const combined = [...first.items, ...second.items].map((task) => task.id);
        expect(combined).toEqual(ids);
        expect(new Set(combined).size).toBe(ids.length);
        const fresh = await tasks.list(owner.id, { limit: 4 });
        expect(fresh.items.slice(0, 2).map((task) => task.id)).toEqual([ids[1], ids[0]]);
        expect(fresh.items[0]!.title).toBe('并发修改后的任务');
        expect(fresh.items.find((task) => task.id === ids[2])!.title).toBe(
            '并发更新后的待加载任务',
        );
        await expect(
            tasks.list(owner.id, { limit: 2, cursor: first.nextCursor! }),
        ).rejects.toMatchObject({
            code: 'INVALID_CURSOR',
        });
    } finally {
        release.resolve();
        await pending.catch(() => undefined);
        await services.close();
        await closeDatabase(reader);
    }
}, 20_000);

it('Task anchor在请求间只改变同一毫秒内的微秒值，旧私有游标也必须失效', async () => {
    const owner = await fixture.register();
    const data = await seedHistoryRows(fixture.db, owner, 3, 1);
    const ids = data.tasks.map((task) => task.id);
    for (const [index, id] of ids.entries()) {
        const timestamp = '2026-02-01T00:00:00.12345' + (6 - index) + 'Z';
        await fixture.db.execute(sql`
      UPDATE tasks SET updated_at=${timestamp}::timestamptz WHERE id=${id}::uuid
    `);
    }
    const services = createDefaultServices({ db: () => fixture.db, close: async () => {} });
    const tasks = createTaskService(services);
    try {
        const first = await tasks.list(owner.id, { limit: 2 });
        expect(first.items.map((task) => task.id)).toEqual(ids.slice(0, 2));
        const cursor = JSON.parse(Buffer.from(first.nextCursor!, 'base64url').toString('utf8'));
        expect(cursor.updatedAt).toBe('2026-02-01T00:00:00.123455Z');
        expect(first.items[1]!.updatedAt).toBe('2026-02-01T00:00:00.123Z');
        const before = await fixture.db.query.tasks
            .findFirst({ where: and(eq(tables.tasks.id, ids[1]!)) })
            .then(requireRow);
        await writer.execute(sql`
      UPDATE tasks SET updated_at=${'2026-02-01T00:00:00.123459Z'}::timestamptz
      WHERE id=${ids[1]!}::uuid
    `);
        const after = await fixture.db.query.tasks
            .findFirst({ where: and(eq(tables.tasks.id, ids[1]!)) })
            .then(requireRow);
        expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
        await expect(
            tasks.list(owner.id, { limit: 2, cursor: first.nextCursor! }),
        ).rejects.toMatchObject({
            code: 'INVALID_CURSOR',
        });
        const fresh = await tasks.list(owner.id, { limit: 2 });
        expect(fresh.items.map((task) => task.id)).toEqual([ids[1], ids[0]]);
    } finally {
        await services.close();
    }
}, 20_000);
