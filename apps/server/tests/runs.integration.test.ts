import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@scova/models";
import { Redis as RedisClient } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { createApiApp } from "../src/app/index.ts";
import { createDefaultServices, type ApiServices } from "../src/app/context.ts";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../../../", import.meta.url));
const baseUrl =
  process.env.SCOVA_TEST_DATABASE_URL ??
  process.env.RUNTIME_DATABASE_URL ??
  "postgresql://scova_test:scova_test@127.0.0.1:55432/scova_test";
const redisUrl =
  process.env.SCOVA_TEST_REDIS_URL ?? process.env.RUNTIME_REDIS_URL ?? "redis://127.0.0.1:56379";
const schema = `scova_runs_${randomUUID().replaceAll("-", "")}`;
const scopedUrl = new URL(baseUrl);
scopedUrl.searchParams.set("schema", schema);
const prisma = new PrismaClient({ datasources: { db: { url: scopedUrl.toString() } } });
const admin = new (require("pg").Client)({ connectionString: baseUrl });
const redis = new RedisClient(redisUrl, {
  lazyConnect: true,
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
});
const origin = "https://scova.test";
let schemaCreated = false;
let services: ApiServices;
let app: ReturnType<typeof createApiApp>;

const config = () => ({
  title: "英语听力",
  topic: "B1 英语材料",
  goal: "找到带字幕的免费材料",
  focusPoints: ["字幕"],
  exclusions: [],
  sourcePreferences: {
    preferredUrls: ["https://www.example.com"],
    excludedUrls: [],
    officialOnly: false,
  },
  timeRange: { kind: "rolling", days: 7 },
  timezone: "UTC",
  schedule: { frequency: "manual" },
  outputFormat: "brief",
  budget: {
    maxSearches: 10,
    maxPages: 20,
    maxDurationSeconds: 300,
    maxInputTokens: 40000,
    maxOutputTokens: 8000,
  },
  notificationPreference: { mode: "summary", runIssues: true },
});
const headers = (extra: Record<string, string> = {}) => ({
  origin,
  "content-type": "application/json",
  ...extra,
});
const cookie = (response: Response) => response.headers.get("set-cookie")?.split(";")[0] ?? "";
const json = async (response: Response) => (await response.json()) as Record<string, any>;
async function request(path: string, init: RequestInit = {}) {
  return app.handle(new Request(`${origin}${path}`, init));
}
async function register() {
  const response = await request("/api/v1/auth/register", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      email: `${randomUUID()}@example.test`,
      password: "correct horse battery staple",
      defaultTimezone: "UTC",
    }),
  });
  expect(response.status).toBe(201);
  return { cookie: cookie(response), csrf: (await json(response)).csrfToken as string };
}
const authHeaders = (auth: { cookie: string; csrf: string }, extra: Record<string, string> = {}) =>
  headers({ cookie: auth.cookie, "x-csrf-token": auth.csrf, ...extra });

describe("Run API、事务 Outbox 与事件回放", () => {
  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    const migrate = () =>
      execFileSync(
        process.execPath,
        [
          require.resolve("prisma/build/index.js"),
          "migrate",
          "deploy",
          "--schema",
          "packages/models/prisma/schema.prisma",
        ],
        {
          cwd: root,
          env: { ...process.env, DATABASE_URL: scopedUrl.toString() },
          encoding: "utf8",
          windowsHide: true,
          timeout: 60000,
        },
      );
    migrate();
    await prisma.$connect();
    await redis.connect();
  }, 120000);
  beforeEach(async () => {
    services = createDefaultServices({
      origin,
      production: false,
      registrationEnabled: true,
      sessionTtlSeconds: 3600,
      clock: () => new Date("2026-10-24T12:00:00.000Z"),
      db: () => prisma,
      redis: () => redis,
      rateLimit: {
        windowSeconds: 60,
        loginAttempts: 50,
        registerAttempts: 50,
        globalAttempts: 100,
        keyPrefix: `scova:runs:${randomUUID()}:`,
      },
    });
    app = createApiApp("node", services);
    await redis.flushdb();
  });
  afterAll(async () => {
    await prisma.$disconnect();
    await redis.quit();
    if (schemaCreated) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  async function createTask(auth: { cookie: string; csrf: string }) {
    const response = await request("/api/v1/tasks", {
      method: "POST",
      headers: authHeaders(auth),
      body: JSON.stringify({ config: config() }),
    });
    expect(response.status).toBe(201);
    return (await json(response)).task as { id: string; currentVersionId: string };
  }

  it("创建执行固定任务版本，在同一事务写入事件与 Outbox，幂等重放复用", async () => {
    const auth = await register();
    const task = await createTask(auth);
    const key = "run-key-1234567890";
    const first = await request(`/api/v1/tasks/${task.id}/runs`, {
      method: "POST",
      headers: authHeaders(auth, { "idempotency-key": key }),
      body: JSON.stringify({ mode: "demo" }),
    });
    expect(first.status).toBe(202);
    const firstBody = await json(first);
    expect(firstBody.reused).toBe(false);
    expect(firstBody.run.taskVersionId).toBe(task.currentVersionId);
    const second = await request(`/api/v1/tasks/${task.id}/runs`, {
      method: "POST",
      headers: authHeaders(auth, { "idempotency-key": key }),
      body: JSON.stringify({ mode: "demo" }),
    });
    expect(second.status).toBe(202);
    expect((await json(second)).reused).toBe(true);
    expect(await prisma.run.count()).toBe(1);
    expect(await prisma.runEvent.count()).toBe(1);
    expect(await prisma.outbox.count()).toBe(1);
    expect(await prisma.idempotencyRecord.count()).toBe(1);
    const events = await request(`/api/v1/runs/${firstBody.run.id}/events`, {
      headers: { cookie: auth.cookie },
    });
    expect(events.status).toBe(200);
    expect(events.headers.get("content-type")).toContain("text/event-stream");
    expect(await events.text()).toContain("run.queued");
  });

  it("活动执行互斥、幂等 payload 冲突和跨账号访问隔离", async () => {
    const auth = await register();
    const other = await register();
    const task = await createTask(auth);
    const first = await request(`/api/v1/tasks/${task.id}/runs`, {
      method: "POST",
      headers: authHeaders(auth, { "idempotency-key": "run-key-abcdefghijk" }),
      body: JSON.stringify({ mode: "demo" }),
    });
    const run = await json(first);
    const mismatch = await request(`/api/v1/tasks/${task.id}/runs`, {
      method: "POST",
      headers: authHeaders(auth, { "idempotency-key": "run-key-abcdefghijk" }),
      body: JSON.stringify({ mode: "live" }),
    });
    expect(mismatch.status).toBe(409);
    const otherKey = await request(`/api/v1/tasks/${task.id}/runs`, {
      method: "POST",
      headers: authHeaders(auth, { "idempotency-key": "run-key-different1" }),
      body: JSON.stringify({ mode: "demo" }),
    });
    expect(otherKey.status).toBe(409);
    const denied = await request(`/api/v1/runs/${run.run.id}`, {
      headers: { cookie: other.cookie },
    });
    expect(denied.status).toBe(404);
    const missingKey = await request(`/api/v1/tasks/${task.id}/runs`, {
      method: "POST",
      headers: authHeaders(auth),
      body: JSON.stringify({}),
    });
    expect(missingKey.status).toBe(428);
  });

  it("取消活动执行并可从失败执行创建 parentRun 重试", async () => {
    const auth = await register();
    const task = await createTask(auth);
    const created = await request(`/api/v1/tasks/${task.id}/runs`, {
      method: "POST",
      headers: authHeaders(auth, { "idempotency-key": "run-key-cancel123" }),
      body: JSON.stringify({}),
    });
    const original = await json(created);
    const canceled = await request(`/api/v1/runs/${original.run.id}/cancel`, {
      method: "POST",
      headers: authHeaders(auth),
    });
    expect(canceled.status).toBe(200);
    expect((await json(canceled)).run.status).toBe("cancel_requested");
    await prisma.run.update({
      where: { id: original.run.id },
      data: { status: "failed", failureCode: "TEST_FAILURE" },
    });
    const retried = await request(`/api/v1/runs/${original.run.id}/retry`, {
      method: "POST",
      headers: authHeaders(auth, { "idempotency-key": "run-key-retry1234" }),
      body: JSON.stringify({}),
    });
    expect(retried.status).toBe(202);
    const body = await json(retried);
    expect(body.run.parentRunId).toBe(original.run.id);
    expect(
      await prisma.outbox.count({ where: { aggregateId: { in: [original.run.id, body.run.id] } } }),
    ).toBe(3);
  });
});
