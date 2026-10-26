import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { parseContract, TaskDetailResponseSchema } from "@scova/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createApiApp } from "../src/app/index.ts";
import { createDefaultServices } from "../src/app/context.ts";
import { outboxDatabase } from "../../worker/tests/support/outbox-database.ts";
import { runConfig } from "../../worker/tests/support/run-database.ts";
import { createRunRepository } from "../../worker/src/repo/runs.ts";

const fixture = outboxDatabase();
const db = fixture.db;
const runs = createRunRepository(db);
const redis = new Redis(fixture.redisUrl, {
  lazyConnect: true,
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
});
redis.on("error", () => undefined);
const origin = "https://notifications.test";
let now = new Date();
const services = createDefaultServices({
  db: () => db,
  redis: () => redis,
  origin,
  clock: () => now,
  rateLimit: { keyPrefix: `scova:notifications-test:${randomUUID()}:`, globalAttempts: 1000 },
});
const app = createApiApp("node", services);
type Auth = { cookie: string; csrf: string; id: string };
const json = async (response: Response) => (await response.json()) as Record<string, any>;
const headers = (auth?: Auth, extra: Record<string, string> = {}) => ({
  origin,
  "content-type": "application/json",
  ...(auth ? { cookie: auth.cookie, "x-csrf-token": auth.csrf } : {}),
  ...extra,
});
const request = (path: string, init: RequestInit = {}) =>
  app.handle(new Request(`${origin}/api/v1${path}`, init));
beforeAll(async () => {
  await fixture.setup();
  await redis.connect();
}, 120_000);
afterAll(async () => {
  if (redis.status === "ready") await redis.quit();
  else redis.disconnect();
  await fixture.cleanup();
});
async function register(): Promise<Auth> {
  const result = await request("/auth/register", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      email: `${randomUUID()}@example.test`,
      password: "correct horse battery staple",
      defaultTimezone: "UTC",
    }),
  });
  expect(result.status).toBe(201);
  const body = await json(result);
  return {
    cookie: result.headers.get("set-cookie")!.split(";")[0]!,
    csrf: body.csrfToken,
    id: body.user.id,
  };
}
async function task(auth: Auth, preference = { mode: "summary", runIssues: true }) {
  const config = { ...runConfig(), notificationPreference: preference };
  const result = await request("/tasks", {
    method: "POST",
    headers: headers(auth),
    body: JSON.stringify({ config }),
  });
  expect(result.status).toBe(201);
  return { ...parseContract(TaskDetailResponseSchema, await result.json()), config };
}
async function start(auth: Auth, taskId: string) {
  const result = await request(`/tasks/${taskId}/runs`, {
    method: "POST",
    headers: headers(auth, { "idempotency-key": randomUUID() }),
    body: "{}",
  });
  expect(result.status).toBe(202);
  const run = (await json(result)).run;
  const claim = await runs.claim(run.id, "notifications-test", 60_000);
  if (claim.kind !== "claimed") throw new Error("Expected claim");
  return claim;
}
async function failed(auth: Auth, preference?: { mode: string; runIssues: boolean }) {
  const owned = await task(auth, preference);
  const claim = await start(auth, owned.task.id);
  expect(await runs.finish(claim.token, { code: "EXECUTOR_FAILED" })).toBe(true);
  return { owned, claim };
}

describe("站内通知真实API与失败终结", () => {
  it("failed 无报告通知可读、持久已读且跨账号404，写入需CSRF", async () => {
    const auth = await register(),
      other = await register();
    const { claim } = await failed(auth);
    const list = await json(await request("/notifications", { headers: headers(auth) }));
    expect(list.items).toHaveLength(1);
    const item = list.items[0];
    expect(item).toMatchObject({
      runId: claim.run.id,
      reportId: null,
      kind: "run_issue",
      runStatus: "failed",
      failureCode: "EXECUTOR_FAILED",
      readAt: null,
    });
    expect(await db.report.count({ where: { runId: claim.run.id } })).toBe(0);
    expect(await db.inboxItem.count({ where: { userId: auth.id } })).toBe(0);
    expect((await request("/notifications")).status).toBe(401);
    expect(
      (await json(await request("/notifications", { headers: headers(other) }))).items,
    ).toEqual([]);
    const path = `/notifications/${item.id}`;
    expect(
      (await request(path, { method: "PATCH", headers: headers(other), body: '{"read":true}' }))
        .status,
    ).toBe(404);
    expect(
      (
        await request(path, {
          method: "PATCH",
          headers: { cookie: auth.cookie, origin, "content-type": "application/json" },
          body: '{"read":true}',
        })
      ).status,
    ).toBe(403);
    const marked = await json(
      await request(path, { method: "PATCH", headers: headers(auth), body: '{"read":true}' }),
    );
    now = new Date(now.getTime() + 1000);
    expect(
      (
        await json(
          await request(path, { method: "PATCH", headers: headers(auth), body: '{"read":true}' }),
        )
      ).readAt,
    ).toBe(marked.readAt);
    expect(await runs.finish(claim.token, { code: "EXECUTOR_FAILED" })).toBe(false);
    expect(
      (await json(await request("/notifications?unread=false", { headers: headers(auth) })))
        .items[0].readAt,
    ).toBe(marked.readAt);
    expect(
      (await json(await request("/notifications?unread=true", { headers: headers(auth) }))).items,
    ).toEqual([]);
    await request(path, { method: "PATCH", headers: headers(auth), body: '{"read":false}' });
    expect((await db.notification.findUniqueOrThrow({ where: { id: item.id } })).readAt).toBeNull();
  });

  it("关闭通知不改变已交付报告或Inbox，通知已读与Inbox独立", async () => {
    const auth = await register();
    const owned = await task(auth);
    const run = await db.run.create({
      data: {
        userId: auth.id,
        taskId: owned.task.id,
        taskVersionId: owned.task.currentVersionId,
        comparisonScopeHash: "a".repeat(64),
        trigger: "manual",
        mode: "demo",
        status: "partial",
        outcome: "inconclusive",
        finishedAt: new Date(),
        coverageJson: {
          completeness: "partial",
          searchedQueries: [],
          gaps: ["来源不完整"],
          exhausted: [],
        },
        budgetJson: owned.config.budget,
        usageJson: {},
      },
    });
    const report = await db.report.create({
      data: {
        userId: auth.id,
        runId: run.id,
        taskId: owned.task.id,
        taskVersionId: run.taskVersionId,
        title: "保留成果",
        summary: "摘要",
        format: "brief",
        completeness: "partial",
      },
    });
    const inbox = await db.inboxItem.create({ data: { userId: auth.id, reportId: report.id } });
    const notification = await db.notification.create({
      data: { userId: auth.id, runId: run.id, reportId: report.id, kind: "run_issue" },
    });
    await request(`/notifications/${notification.id}`, {
      method: "PATCH",
      headers: headers(auth),
      body: '{"read":true}',
    });
    expect((await db.inboxItem.findUniqueOrThrow({ where: { id: inbox.id } })).readAt).toBeNull();
    const off = await failed(auth, { mode: "off", runIssues: false });
    expect(await db.notification.count({ where: { runId: off.claim.run.id } })).toBe(0);
    expect(await db.report.count({ where: { id: report.id } })).toBe(1);
    expect(await db.inboxItem.count({ where: { id: inbox.id } })).toBe(1);
  });

  it("分页同毫秒的不同微秒及相同时点无漏重、游标绑定owner和过滤范围", async () => {
    const auth = await register(),
      other = await register();
    for (let i = 0; i < 3; i++) await failed(auth);
    const notifications = await db.notification.findMany({ where: { userId: auth.id } });
    for (const [index, item] of notifications.entries()) {
      const time = index === 0 ? "2026-01-01T00:00:00.123900Z" : "2026-01-01T00:00:00.123800Z";
      await db.$executeRaw`UPDATE notifications SET created_at = ${time}::timestamptz WHERE id = ${item.id}::uuid`;
    }
    const unread = await json(
      await request("/notifications?unread=true&limit=1", { headers: headers(auth) }),
    );
    await request(`/notifications/${unread.items[0].id}`, {
      method: "PATCH",
      headers: headers(auth),
      body: '{"read":true}',
    });
    const remaining = await json(
      await request(`/notifications?unread=true&cursor=${encodeURIComponent(unread.nextCursor)}`, {
        headers: headers(auth),
      }),
    );
    expect(remaining.items).toHaveLength(2);
    await request(`/notifications/${unread.items[0].id}`, {
      method: "PATCH",
      headers: headers(auth),
      body: '{"read":false}',
    });
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const response = await request(
        `/notifications?kind=run_issue&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        { headers: headers(auth) },
      );
      expect(response.status).toBe(200);
      const body = await json(response);
      seen.push(...body.items.map((item: { id: string }) => item.id));
      cursor = body.nextCursor;
      if (seen.length === 1) {
        expect(
          (
            await request(`/notifications?kind=summary&cursor=${encodeURIComponent(cursor!)}`, {
              headers: headers(auth),
            })
          ).status,
        ).toBe(400);
        expect(
          (
            await request(`/notifications?kind=run_issue&cursor=${encodeURIComponent(cursor!)}`, {
              headers: headers(other),
            })
          ).status,
        ).toBe(400);
      }
    } while (cursor);
    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(3);
  });

  it("新Task版本采用新偏好，已启动和retry固定原版本，账号设置不追溯修改", async () => {
    const auth = await register();
    const owned = await task(auth);
    const first = await start(auth, owned.task.id);
    await request("/me/preferences", {
      method: "PATCH",
      headers: headers(auth),
      body: JSON.stringify({ notificationPreference: { mode: "off", runIssues: false } }),
    });
    const changed = await request(`/tasks/${owned.task.id}`, {
      method: "PATCH",
      headers: headers(auth, { "if-match": '"1"' }),
      body: JSON.stringify({
        config: { ...owned.config, notificationPreference: { mode: "off", runIssues: false } },
      }),
    });
    expect(changed.status).toBe(200);
    expect((await json(changed)).baselineResetRequired).toBe(false);
    await runs.finish(first.token, { code: "EXECUTOR_FAILED" });
    expect(await db.notification.count({ where: { runId: first.run.id } })).toBe(1);
    const next = await start(auth, owned.task.id);
    await runs.finish(next.token, { code: "EXECUTOR_FAILED" });
    expect(await db.notification.count({ where: { runId: next.run.id } })).toBe(0);
    const retried = await request(`/runs/${first.run.id}/retry`, {
      method: "POST",
      headers: headers(auth, { "idempotency-key": randomUUID() }),
      body: "{}",
    });
    expect(retried.status).toBe(202);
    const run = (await json(retried)).run;
    expect(run.taskVersionId).toBe(first.run.taskVersionId);
    const claim = await runs.claim(run.id, "retry-notification", 60_000);
    if (claim.kind !== "claimed") throw new Error("Expected retry claim");
    await runs.finish(claim.token, { code: "EXECUTOR_FAILED" });
    expect(await db.notification.count({ where: { runId: run.id } })).toBe(1);
  });

  it("失败通知SQL错误使终结和事件回滚，可重试；用户取消不发问题通知", async () => {
    const auth = await register();
    const owned = await task(auth);
    const claim = await start(auth, owned.task.id);
    await db.$executeRawUnsafe(
      "CREATE FUNCTION fail_notice() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected notification failure'; END $$",
    );
    await db.$executeRawUnsafe(
      "CREATE TRIGGER fail_notice BEFORE INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION fail_notice()",
    );
    try {
      await expect(runs.finish(claim.token, { code: "EXECUTOR_FAILED" })).rejects.toThrow();
      expect((await db.run.findUniqueOrThrow({ where: { id: claim.run.id } })).status).toBe(
        "running",
      );
      expect(await db.runEvent.count({ where: { runId: claim.run.id, type: "run.failed" } })).toBe(
        0,
      );
    } finally {
      await db.$executeRawUnsafe("DROP TRIGGER fail_notice ON notifications");
      await db.$executeRawUnsafe("DROP FUNCTION fail_notice()");
    }
    expect(await runs.finish(claim.token, { code: "EXECUTOR_FAILED" })).toBe(true);
    const canceled = await start(auth, owned.task.id);
    await request(`/runs/${canceled.run.id}/cancel`, { method: "POST", headers: headers(auth) });
    await runs.finish(canceled.token, { code: "EXECUTOR_FAILED" });
    expect((await db.run.findUniqueOrThrow({ where: { id: canceled.run.id } })).status).toBe(
      "canceled",
    );
    expect(await db.notification.count({ where: { runId: canceled.run.id } })).toBe(0);
  });
});
