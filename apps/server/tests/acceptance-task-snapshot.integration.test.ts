import { PrismaClient } from "@scova/models";
import { afterAll, beforeAll, expect, it } from "vite-plus/test";
import { createDefaultServices } from "../src/app/context.ts";
import { createTaskService } from "../src/service/tasks.ts";
import { historyFixture, seedHistoryRows } from "./support/history-fixture.ts";

const fixture = historyFixture();
const writer = new PrismaClient({ datasources: { db: { url: fixture.databaseUrl } } });
beforeAll(async () => {
  await fixture.setup();
  await writer.$connect();
}, 120_000);
afterAll(async () => {
  try {
    await writer.$disconnect();
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

it("Task游标核验后并发更新anchor，seek及hydrate仍用同一微秒快照，不重复上一页", async () => {
  const owner = await fixture.register();
  const data = await seedHistoryRows(fixture.db, owner, 4, 1);
  const ids = data.tasks.map((task) => task.id);
  for (const [index, id] of ids.entries()) {
    const timestamp = "2026-02-01T00:00:00.12345" + (6 - index) + "Z";
    await fixture.db.$executeRaw`
      UPDATE tasks SET updated_at=${timestamp}::timestamptz WHERE id=${id}::uuid
    `;
  }
  const entered = deferred(),
    release = deferred();
  let armed = false;
  // Gate the actual anchor query after its database read. Returning its original
  // result preserves the production RR transaction and all subsequent queries.
  const reader = fixture.db.$extends({
    query: {
      async $queryRaw({ args, query }) {
        const result = await query(args);
        if (armed && Array.isArray(result) && result.length === 1 && result[0]?.id === ids[1]) {
          armed = false;
          entered.resolve();
          await release.promise;
        }
        return result;
      },
    },
  });
  const services = createDefaultServices({
    db: () => reader as unknown as PrismaClient,
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
    await within(entered.promise, "Task list did not read its real cursor anchor");
    await writer.$transaction(async (tx) => {
      await tx.task.update({
        where: { id: ids[1]! },
        data: { title: "并发修改后的任务", updatedAt: new Date("2026-02-02T00:00:00.000Z") },
      });
      await tx.$executeRaw`
        UPDATE tasks SET title=${"并发更新后的待加载任务"} WHERE id=${ids[2]!}::uuid
      `;
    });
    release.resolve();
    const second = await within(pending, "Task list did not finish after anchor gate release");
    expect(second.items.map((task) => task.id)).toEqual(ids.slice(2));
    expect(second.items[0]!.title).toBe(first.items[0]!.title);
    expect(second.nextCursor).toBeNull();
    const combined = [...first.items, ...second.items].map((task) => task.id);
    expect(combined).toEqual(ids);
    expect(new Set(combined).size).toBe(ids.length);
    const fresh = await tasks.list(owner.id, { limit: 4 });
    expect(fresh.items.slice(0, 2).map((task) => task.id)).toEqual([ids[1], ids[0]]);
    expect(fresh.items[0]!.title).toBe("并发修改后的任务");
    expect(fresh.items.find((task) => task.id === ids[2])!.title).toBe("并发更新后的待加载任务");
    await expect(
      tasks.list(owner.id, { limit: 2, cursor: first.nextCursor! }),
    ).rejects.toMatchObject({
      code: "INVALID_CURSOR",
    });
  } finally {
    release.resolve();
    await pending.catch(() => undefined);
    await services.close();
  }
}, 20_000);

it("Task anchor在请求间只改变同一毫秒内的微秒值，旧私有游标也必须失效", async () => {
  const owner = await fixture.register();
  const data = await seedHistoryRows(fixture.db, owner, 3, 1);
  const ids = data.tasks.map((task) => task.id);
  for (const [index, id] of ids.entries()) {
    const timestamp = "2026-02-01T00:00:00.12345" + (6 - index) + "Z";
    await fixture.db.$executeRaw`
      UPDATE tasks SET updated_at=${timestamp}::timestamptz WHERE id=${id}::uuid
    `;
  }
  const services = createDefaultServices({ db: () => fixture.db, close: async () => {} });
  const tasks = createTaskService(services);
  try {
    const first = await tasks.list(owner.id, { limit: 2 });
    expect(first.items.map((task) => task.id)).toEqual(ids.slice(0, 2));
    const cursor = JSON.parse(Buffer.from(first.nextCursor!, "base64url").toString("utf8"));
    expect(cursor.updatedAt).toBe("2026-02-01T00:00:00.123455Z");
    expect(first.items[1]!.updatedAt).toBe("2026-02-01T00:00:00.123Z");
    const before = await fixture.db.task.findUniqueOrThrow({ where: { id: ids[1]! } });
    await writer.$executeRaw`
      UPDATE tasks SET updated_at=${"2026-02-01T00:00:00.123459Z"}::timestamptz
      WHERE id=${ids[1]!}::uuid
    `;
    const after = await fixture.db.task.findUniqueOrThrow({ where: { id: ids[1]! } });
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    await expect(
      tasks.list(owner.id, { limit: 2, cursor: first.nextCursor! }),
    ).rejects.toMatchObject({
      code: "INVALID_CURSOR",
    });
    const fresh = await tasks.list(owner.id, { limit: 2 });
    expect(fresh.items.map((task) => task.id)).toEqual([ids[1], ids[0]]);
  } finally {
    await services.close();
  }
}, 20_000);
