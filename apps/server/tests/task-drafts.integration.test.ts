import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@scova/models";
import {
  ConnectorError,
  type ModelProvider,
  type CallContext,
  type StructuredInput,
} from "@scova/connectors";
import { Redis as RedisClient } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { createApiApp } from "../src/app/index.ts";
import {
  createDefaultServices,
  type ApiServices,
  type ApiServiceOverrides,
} from "../src/app/context.ts";
import { draftConfig, draftExamples } from "./support/task-drafts.ts";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../../../", import.meta.url));
const baseUrl =
  process.env.SCOVA_TEST_DATABASE_URL ??
  process.env.RUNTIME_DATABASE_URL ??
  "postgresql://scova_test:scova_test@127.0.0.1:55432/scova_test";
const redisUrl =
  process.env.SCOVA_TEST_REDIS_URL ?? process.env.RUNTIME_REDIS_URL ?? "redis://127.0.0.1:56379";
const schema = "scova_drafts_" + randomUUID().replaceAll("-", "");
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
const now = new Date("2026-10-26T12:00:00Z");
let schemaCreated = false;
let services: ApiServices;
let app: ReturnType<typeof createApiApp>;
let model: ModelProvider | null = null;
let externalCalls = 0;

function configure(overrides: ApiServiceOverrides = {}) {
  services = createDefaultServices({
    origin,
    production: false,
    db: () => prisma,
    redis: () => redis,
    clock: () => now,
    taskDraftModel: () => model,
    rateLimit: {
      keyPrefix: "scova:drafts-auth:" + randomUUID() + ":",
      loginAttempts: 100,
      registerAttempts: 100,
      globalAttempts: 1000,
    },
    ...overrides,
    taskDraftPolicy: {
      keyPrefix: "scova:drafts-test:" + randomUUID() + ":",
      ...overrides.taskDraftPolicy,
    },
  });
  app = createApiApp("node", services);
}
const headers = (extra: Record<string, string> = {}) => ({
  origin,
  "content-type": "application/json",
  ...extra,
});
const json = async (response: Response) => (await response.json()) as Record<string, any>;
const request = (path: string, init: RequestInit = {}) =>
  app.handle(new Request(origin + path, init));
async function register(timezone = "Asia/Tokyo") {
  const response = await request("/api/v1/auth/register", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      email: randomUUID() + "@example.test",
      password: "correct horse battery staple",
      defaultTimezone: timezone,
    }),
  });
  expect(response.status).toBe(201);
  const body = await json(response);
  await prisma.user.update({
    where: { id: body.user.id },
    data: { notificationPreference: { mode: "off", runIssues: false } },
  });
  return {
    id: body.user.id as string,
    cookie: response.headers.get("set-cookie")!.split(";")[0]!,
    csrf: body.csrfToken as string,
  };
}
type Owner = Awaited<ReturnType<typeof register>>;
const authHeaders = (owner: Owner) => headers({ cookie: owner.cookie, "x-csrf-token": owner.csrf });
const draft = (
  owner: Owner,
  body: unknown = { inputText: "持续关注研究进展" },
  signal?: AbortSignal,
) =>
  request("/api/v1/task-drafts", {
    method: "POST",
    headers: authHeaders(owner),
    body: JSON.stringify(body),
    signal,
  });
function fixture(
  action: (index: number, input: StructuredInput, context: CallContext) => unknown,
): ModelProvider {
  return {
    async generateStructured<T>(input: StructuredInput, context: CallContext = {}) {
      await context.beforeAttempt?.("model");
      const data = await action(externalCalls++, input, context);
      return {
        data: data as T,
        mode: "live",
        usage: { inputTokens: 100, outputTokens: 100, estimated: false },
      };
    },
  };
}
async function businessCounts() {
  const [tasks, versions, runs, occurrences, outbox] = await Promise.all([
    prisma.task.count(),
    prisma.taskVersion.count(),
    prisma.run.count(),
    prisma.scheduleOccurrence.count(),
    prisma.outbox.count(),
  ]);
  return { tasks, versions, runs, occurrences, outbox };
}
async function counter() {
  const keys = await redis.keys(services.taskDraftPolicy.keyPrefix + "*:global");
  expect(keys).toHaveLength(1);
  return redis.hgetall(keys[0]!);
}

describe("HTTP任务草稿、真实Redis解析预算与手工回退", () => {
  beforeAll(async () => {
    await admin.connect();
    await admin.query('CREATE SCHEMA "' + schema + '"');
    schemaCreated = true;
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
        timeout: 60_000,
      },
    );
    await prisma.$connect();
    await redis.connect();
  }, 120_000);
  beforeEach(() => {
    model = null;
    externalCalls = 0;
    configure();
  });
  afterAll(async () => {
    await prisma.$disconnect();
    if (redis.status === "wait" || redis.status === "end") redis.disconnect();
    else await redis.quit();
    if (schemaCreated && /^scova_drafts_[0-9a-f]{32}$/.test(schema))
      await admin.query('DROP SCHEMA "' + schema + '" CASCADE');
    await admin.end();
  });
  it("会话、CSRF、来源及入参不合法时不访问模型与解析限流", async () => {
    model = fixture(() => draftConfig());
    const owner = await register();
    const valid = JSON.stringify({ inputText: "查招生信息" });
    expect(
      (await request("/api/v1/task-drafts", { method: "POST", headers: headers(), body: valid }))
        .status,
    ).toBe(401);
    expect(
      (
        await request("/api/v1/task-drafts", {
          method: "POST",
          headers: headers({ cookie: owner.cookie }),
          body: valid,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request("/api/v1/task-drafts", {
          method: "POST",
          headers: { ...authHeaders(owner), origin: "https://evil.test" },
          body: valid,
        })
      ).status,
    ).toBe(403);
    for (const body of [
      { inputText: " " },
      { inputText: "x", userId: owner.id },
      { inputText: "x".repeat(2001) },
      { inputText: "x", timezone: "Mars/Base" },
    ])
      expect((await draft(owner, body)).status).toBe(422);
    expect(externalCalls).toBe(0);
    expect(await redis.keys(services.taskDraftPolicy.keyPrefix + "*")).toHaveLength(0);
  });
  it.each(draftExamples)(
    "三典型需求返回完整可编辑草稿且无任务执行副作用 $input.inputText",
    async ({ input, config }) => {
      model = fixture(() => config);
      const owner = await register();
      const before = await businessCounts();
      const response = await draft(owner, input);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = await json(response);
      expect(body).toMatchObject({
        inputText: input.inputText,
        config,
        mode: "model",
        requiresConfirmation: true,
        manualReason: null,
        parsingUsage: { attempts: 1, inputTokens: 100, outputTokens: 100 },
      });
      expect(body.config.timeRange).toEqual(config.timeRange);
      expect(body.config.outputFormat).toBe(config.outputFormat);
      expect(body.config.focusPoints).toEqual(config.focusPoints);
      expect(body.config.exclusions).toEqual(config.exclusions);
      expect(body.config.sourcePreferences).toEqual(config.sourcePreferences);
      expect(body.config.schedule).toEqual(config.schedule);
      expect(await businessCounts()).toEqual(before);
      expect(await counter()).toMatchObject({
        requests: "1",
        attempts: "1",
        inputTokens: "100",
        outputTokens: "100",
      });
    },
  );
  it("原文明说多个时区时不猜，显式请求可消歧；模型时区不同则不能保留周期", async () => {
    const owner = await register();
    const before = await businessCounts();
    model = fixture(() => draftConfig({ schedule: { frequency: "daily", localTime: "09:00" } }));
    const ambiguous = await json(
      await draft(owner, { inputText: "每天09:00日本时间或纽约时间查资料" }),
    );
    expect(ambiguous).toMatchObject({
      mode: "manual",
      manualReason: "ambiguous_timezone",
      config: { schedule: { frequency: "manual" } },
      parsingUsage: { attempts: 0 },
    });
    expect(externalCalls).toBe(0);
    model = fixture(() =>
      draftConfig({
        timezone: "Asia/Shanghai",
        schedule: { frequency: "daily", localTime: "09:00" },
      }),
    );
    const explicit = await json(
      await draft(owner, {
        inputText: "每天09:00日本时间或纽约时间查资料",
        timezone: "Asia/Shanghai",
      }),
    );
    expect(explicit.config).toMatchObject({
      timezone: "Asia/Shanghai",
      schedule: { frequency: "daily" },
    });
    model = fixture(() =>
      draftConfig({
        timezone: "Asia/Tokyo",
        schedule: { frequency: "weekly", weekday: 5, localTime: "18:00" },
      }),
    );
    const mismatch = await json(await draft(owner, { inputText: "每周五18点纽约时间查招生" }));
    expect(mismatch.config).toMatchObject({
      timezone: "America/New_York",
      schedule: { frequency: "manual" },
    });
    expect(mismatch.warnings).toContainEqual({
      path: "/config/schedule",
      message: expect.stringContaining("时区不一致"),
    });
    expect(await businessCounts()).toEqual(before);
  });
  it("否定或冲突的周期请求不能因出现daily词就升级成每日计划", async () => {
    const owner = await register();
    const before = await businessCounts();
    model = fixture(() => draftConfig({ schedule: { frequency: "daily", localTime: "09:00" } }));
    for (const inputText of [
      "不要每天09:00，改为每周一09:00查资料",
      "不需要每天09:00运行",
      "每天09:00或每周一09:00查资料",
    ]) {
      const response = await draft(owner, { inputText });
      expect(response.status).toBe(200);
      const body = await json(response);
      expect(body.config.schedule.frequency).toBe("manual");
      expect(body.warnings).toContainEqual({
        path: "/config/schedule",
        message: expect.stringContaining("手动计划"),
      });
    }
    expect(await businessCounts()).toEqual(before);
  });
  it("模型缺失时保留原文；显式POST tasks后才能保存手工任务", async () => {
    const owner = await register("America/New_York");
    const before = await businessCounts();
    const inputText = "  持续关注招生信息，周期待定  ";
    const response = await draft(owner, { inputText });
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body).toMatchObject({
      inputText,
      mode: "manual",
      manualReason: "model_unavailable",
      config: {
        timezone: "America/New_York",
        schedule: { frequency: "manual" },
        notificationPreference: { mode: "off", runIssues: false },
      },
    });
    expect(await businessCounts()).toEqual(before);
    const saved = await request("/api/v1/tasks", {
      method: "POST",
      headers: authHeaders(owner),
      body: JSON.stringify({
        inputText: body.inputText,
        config: { ...body.config, title: "我手工确认的招生跟踪" },
      }),
    });
    expect(saved.status).toBe(201);
    const task = await json(saved);
    expect(task.task.nextRunAt).toBeNull();
    const version = await prisma.taskVersion.findUniqueOrThrow({ where: { id: task.version.id } });
    expect(version.inputText).toBe(inputText);
    expect((await businessCounts()).runs).toBe(before.runs);
    expect((await businessCounts()).outbox).toBe(before.outbox);
  });
  it("无效核心结构仅修复一次；周期或预算不能被模型静默升级", async () => {
    model = fixture((index) =>
      index === 0
        ? { title: "", topic: [] }
        : {
            ...draftConfig(),
            schedule: { frequency: "daily", localTime: "09:00" },
            budget: { maxSearches: 99999 },
            notificationPreference: { mode: "summary", runIssues: true },
          },
    );
    const owner = await register();
    const before = await businessCounts();
    const response = await draft(owner);
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.mode).toBe("model");
    expect(body.config).toMatchObject({
      schedule: { frequency: "manual" },
      budget: draftConfig().budget,
      notificationPreference: { mode: "off", runIssues: false },
    });
    expect(body.parsingUsage.attempts).toBe(2);
    expect(externalCalls).toBe(2);
    expect(await businessCounts()).toEqual(before);
    expect(await counter()).toMatchObject({
      requests: "1",
      attempts: "2",
      inputTokens: "200",
      outputTokens: "200",
    });
  });
  it("两次结构错误回退后仍可显式保存手工配置，失败预留不退还", async () => {
    model = fixture(() => {
      throw new ConnectorError("invalid_response", "secret-supplier-message");
    });
    const owner = await register();
    const response = await draft(owner, { inputText: "原始招生需求" });
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body).toMatchObject({
      mode: "manual",
      manualReason: "invalid_output",
      parsingUsage: { attempts: 2, outputTokens: 4000, estimated: true },
    });
    expect(JSON.stringify(body)).not.toContain("secret-supplier-message");
    expect(await counter()).toMatchObject({ attempts: "2", outputTokens: "4000" });
    const saved = await request("/api/v1/tasks", {
      method: "POST",
      headers: authHeaders(owner),
      body: JSON.stringify({ inputText: body.inputText, config: body.config }),
    });
    expect(saved.status).toBe(201);
  });
  it("单用户与全局请求额度彼此独立，429附带Retry-After", async () => {
    configure({ taskDraftPolicy: { userRequests: 1, globalRequests: 2 } });
    model = fixture(() => draftConfig());
    const owner = await register(),
      other = await register(),
      third = await register();
    expect((await draft(owner)).status).toBe(200);
    const limited = await draft(owner);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await json(limited)).code).toBe("DRAFT_RATE_LIMITED");
    expect((await draft(other)).status).toBe(200);
    expect((await draft(third)).status).toBe(429);
    expect(externalCalls).toBe(2);
  });
  it("并发请求原子预留全局和用户attempt配额，超额不调用模型", async () => {
    configure({ taskDraftPolicy: { userAttempts: 1, globalAttempts: 1 } });
    model = fixture(() => draftConfig());
    const owner = await register();
    const responses = await Promise.all([draft(owner), draft(owner), draft(owner)]);
    expect(responses.map((response) => response.status).sort((a, b) => a - b)).toEqual([
      200, 429, 429,
    ]);
    expect(externalCalls).toBe(1);
    expect(await counter()).toMatchObject({
      requests: "3",
      attempts: "1",
      inputTokens: "100",
      outputTokens: "100",
    });
  });
  it("输入token配额在外调前原子拒绝，输出token未知预留不会被失败清零", async () => {
    configure({ taskDraftPolicy: { userInputTokens: 1 } });
    model = fixture(() => draftConfig());
    const owner = await register();
    expect((await draft(owner)).status).toBe(429);
    expect(externalCalls).toBe(0);
    expect(await counter()).toMatchObject({
      requests: "1",
      attempts: "0",
      inputTokens: "0",
      outputTokens: "0",
    });
    configure({ taskDraftPolicy: { userOutputTokens: 2000 } });
    model = fixture(() => {
      throw new ConnectorError("network", "secret-network", true);
    });
    expect((await draft(owner)).status).toBe(200);
    expect((await draft(owner)).status).toBe(429);
    expect(externalCalls).toBe(1);
    expect(await counter()).toMatchObject({ attempts: "1", outputTokens: "2000" });
  });
  it("成功结算真实用量可释放未消费预留，但不能突破累计窗口输出配额", async () => {
    configure({ taskDraftPolicy: { outputTokensPerAttempt: 200, userOutputTokens: 300 } });
    model = fixture(() => draftConfig());
    const owner = await register();
    expect((await draft(owner)).status).toBe(200);
    expect((await draft(owner)).status).toBe(200);
    expect((await draft(owner)).status).toBe(429);
    expect(externalCalls).toBe(2);
    expect(await counter()).toMatchObject({ attempts: "2", outputTokens: "200" });
  });
  it("Redis故障保持脱敏503，不调用模型或创建任务", async () => {
    model = fixture(() => draftConfig());
    const owner = await register();
    const before = await businessCounts();
    services.redis = () => {
      throw new Error("redis://private-credential@host");
    };
    const response = await draft(owner);
    expect(response.status).toBe(503);
    const body = await json(response);
    expect(body.code).toBe("DRAFT_SERVICE_UNAVAILABLE");
    expect(JSON.stringify(body)).not.toContain("private-credential");
    expect(externalCalls).toBe(0);
    expect(await businessCounts()).toEqual(before);
  });
  it("超时不会repair或产生任务，独立预算仍保留未知预留", async () => {
    configure({ taskDraftPolicy: { timeoutMs: 25 } });
    model = fixture(() => new Promise(() => undefined));
    const owner = await register();
    const before = await businessCounts();
    const response = await draft(owner);
    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({
      mode: "manual",
      manualReason: "timeout",
      parsingUsage: { attempts: 1, estimated: true },
    });
    expect(externalCalls).toBe(1);
    expect(await businessCounts()).toEqual(before);
    expect(await counter()).toMatchObject({ attempts: "1", outputTokens: "2000" });
  });
});
