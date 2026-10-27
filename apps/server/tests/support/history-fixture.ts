import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@scova/models";
import { Redis } from "ioredis";
import pg from "pg";
import { nodeScriptCommand } from "../../../../scripts/process-runtime.mjs";
import { draftConfig } from "./task-drafts.ts";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../../../../", import.meta.url));
export type HistoryOwner = { id: string; cookie: string; csrf: string };
export type HistoryPage = {
  items: { id: string; [key: string]: any }[];
  nextCursor: string | null;
};
export function historyFixture(options: { questionFixture?: boolean } = {}) {
  const baseUrl =
    process.env.SCOVA_TEST_DATABASE_URL ??
    process.env.RUNTIME_DATABASE_URL ??
    "postgresql://scova_test:scova_test@127.0.0.1:55432/scova_test";
  const redisUrl =
    process.env.SCOVA_TEST_REDIS_URL ?? process.env.RUNTIME_REDIS_URL ?? "redis://127.0.0.1:56379";
  const schema = "scova_acceptance_" + randomUUID().replaceAll("-", "");
  const databaseUrl = new URL(baseUrl);
  databaseUrl.searchParams.set("schema", schema);
  const db = new PrismaClient({ datasources: { db: { url: databaseUrl.toString() } } });
  const admin = new pg.Client({ connectionString: baseUrl });
  const redis = new Redis(redisUrl, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
  });
  redis.on("error", () => undefined);
  let child: ChildProcess | undefined, ended: Promise<number | null> | undefined;
  let origin = "",
    created = false,
    adminConnected = false,
    output = "";
  async function request(path: string, owner?: HistoryOwner, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set("origin", origin);
    headers.set("content-type", "application/json");
    if (owner) {
      headers.set("cookie", owner.cookie);
      headers.set("x-csrf-token", owner.csrf);
    }
    return fetch(origin + "/api/v1" + path, {
      ...init,
      headers,
      signal: init.signal ?? AbortSignal.timeout(10000),
      cache: "no-store",
    });
  }
  return {
    db,
    redis,
    schema,
    databaseUrl: databaseUrl.toString(),
    get origin() {
      return origin;
    },
    async setup() {
      await admin.connect();
      adminConnected = true;
      await admin.query('CREATE SCHEMA "' + schema + '"');
      created = true;
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
          env: { ...process.env, DATABASE_URL: databaseUrl.toString() },
          encoding: "utf8",
          windowsHide: true,
          timeout: 60000,
        },
      );
      await db.$connect();
      await redis.connect();
      const socket = createServer().listen(0, "127.0.0.1");
      await once(socket, "listening");
      const address = socket.address();
      if (!address || typeof address === "string") throw new Error("Socket probe has no port");
      const port = address.port;
      await new Promise<void>((resolve, reject) =>
        socket.close((error) => (error ? reject(error) : resolve())),
      );
      origin = "http://127.0.0.1:" + port;
      const command = nodeScriptCommand("tests/support/history-api-process.ts");
      child = spawn(command.executable, command.args, {
        cwd: fileURLToPath(new URL("../../", import.meta.url)),
        env: {
          ...process.env,
          PORT: String(port),
          APP_ORIGIN: origin,
          DATABASE_URL: databaseUrl.toString(),
          REDIS_URL: redisUrl,
          SCOVA_ACCEPTANCE_RATE_PREFIX: schema + ":auth:",
          SCOVA_ACCEPTANCE_QUESTION_FIXTURE: options.questionFixture ? "1" : "0",
        },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        windowsHide: true,
      });
      child.stdout!.on("data", (chunk) => {
        output += String(chunk);
      });
      child.stderr!.on("data", (chunk) => {
        output += String(chunk);
      });
      ended = new Promise((resolve) => child!.once("exit", (code) => resolve(code)));
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Socket probe startup timed out: " + output)),
          15000,
        );
        child!.once("message", (message) => {
          if ((message as { type?: string }).type === "ready") {
            clearTimeout(timer);
            resolve();
          }
        });
        child!.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child!.once("exit", (code) => {
          clearTimeout(timer);
          reject(new Error("Socket probe exited before ready: " + code + " " + output));
        });
      });
    },
    request,
    async register(): Promise<HistoryOwner> {
      const response = await request("/auth/register", undefined, {
        method: "POST",
        body: JSON.stringify({
          email: randomUUID() + "@example.test",
          password: "correct horse battery staple",
          defaultTimezone: "UTC",
        }),
      });
      if (response.status !== 201)
        throw new Error(
          "Socket registration failed: " + response.status + " " + (await response.text()),
        );
      const body = (await response.json()) as { user: { id: string }; csrfToken: string };
      return {
        id: body.user.id,
        csrf: body.csrfToken,
        cookie: response.headers.get("set-cookie")!.split(";")[0]!,
      };
    },
    async pages(path: string, owner: HistoryOwner) {
      const ids: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 100; page++) {
        const response = await request(
          path +
            (path.includes("?") ? "&" : "?") +
            "limit=1" +
            (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""),
          owner,
        );
        if (response.status !== 200)
          throw new Error("Pagination failed: " + response.status + " " + (await response.text()));
        const body = (await response.json()) as HistoryPage;
        ids.push(...body.items.map((item) => item.id));
        cursor = body.nextCursor;
        if (!cursor) return ids;
      }
      throw new Error("Pagination exceeded bounded page count");
    },
    async cleanup() {
      const errors: unknown[] = [];
      async function release(operation: () => Promise<unknown>) {
        try {
          await operation();
        } catch (error) {
          errors.push(error);
        }
      }
      async function waitForExit(timeout: number) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            ended,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error("Socket probe failed to stop: " + output)),
                timeout,
              );
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      }
      if (child && child.exitCode === null) {
        await release(async () => {
          if (child!.connected) child!.send("scova:shutdown");
          else child!.kill();
          await waitForExit(10000);
        });
        if (child.exitCode === null) {
          child.kill();
          await release(() => waitForExit(5000));
        }
      }
      await release(() => db.$disconnect());
      redis.disconnect();
      if (created && /^scova_acceptance_[a-f0-9]{32}$/.test(schema))
        await release(() => admin.query('DROP SCHEMA "' + schema + '" CASCADE'));
      if (adminConnected) await release(() => admin.end());
      if (errors.length) throw new AggregateError(errors, "Acceptance fixture cleanup failed");
    },
  };
}
export async function seedHistoryRows(
  db: PrismaClient,
  owner: HistoryOwner,
  taskCount = 3,
  runsPerTask = 3,
) {
  const tasks = Array.from({ length: taskCount }, (_, i) => ({
    id: randomUUID(),
    versionId: randomUUID(),
    time: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
  }));
  const runs = tasks.flatMap((task) =>
    Array.from({ length: runsPerTask }, (_, i) => ({
      id: randomUUID(),
      taskId: task.id,
      taskVersionId: task.versionId,
      time: new Date(task.time.getTime() + i * 1000),
    })),
  );
  const reports = runs.map((run) => ({
    id: randomUUID(),
    runId: run.id,
    taskId: run.taskId,
    taskVersionId: run.taskVersionId,
    time: run.time,
  }));
  const inbox = reports.map((report) => ({
    id: randomUUID(),
    reportId: report.id,
    time: report.time,
  }));
  const config = draftConfig();
  const coverage = {
    completeness: "partial" as const,
    searchedQueries: ["acceptance fixture"],
    gaps: ["固定验收样例"],
    exhausted: [],
  };
  await db.$transaction(
    async (tx) => {
      await tx.task.createMany({
        data: tasks.map((task) => ({
          id: task.id,
          userId: owner.id,
          title: config.title,
          updatedAt: task.time,
        })),
      });
      await tx.taskVersion.createMany({
        data: tasks.map((task) => ({
          id: task.versionId,
          userId: owner.id,
          taskId: task.id,
          version: 1,
          configJson: config,
          comparisonScopeHash: "a".repeat(64),
        })),
      });
      for (const task of tasks)
        await tx.task.update({
          where: { id: task.id },
          data: { currentVersionId: task.versionId, updatedAt: task.time },
        });
      await tx.run.createMany({
        data: runs.map((run) => ({
          id: run.id,
          userId: owner.id,
          taskId: run.taskId,
          taskVersionId: run.taskVersionId,
          comparisonScopeHash: "b".repeat(64),
          mode: "demo",
          trigger: "manual",
          status: "partial",
          outcome: "inconclusive",
          queuedAt: run.time,
          startedAt: run.time,
          finishedAt: run.time,
          budgetJson: config.budget,
          usageJson: { searches: 1, pages: 1, inputTokens: 1, outputTokens: 1, estimated: true },
          coverageJson: coverage,
          checkpointRef: { privateMarker: "private-checkpoint-do-not-expose" },
          feedbackSnapshotJson: {
            schemaVersion: 1,
            userId: owner.id,
            taskId: run.taskId,
            items: [],
          },
          leaseOwner: "private-lease-do-not-expose",
        })),
      });
      await tx.report.createMany({
        data: reports.map((report) => ({
          id: report.id,
          userId: owner.id,
          runId: report.runId,
          taskId: report.taskId,
          taskVersionId: report.taskVersionId,
          title: "验收样例报告",
          summary: "仅用于列表与传输验证",
          format: "brief",
          completeness: "partial",
          limitationsJson: coverage.gaps,
          publishedAt: report.time,
        })),
      });
      await tx.inboxItem.createMany({
        data: inbox.map((item) => ({
          id: item.id,
          userId: owner.id,
          reportId: item.reportId,
          createdAt: item.time,
        })),
      });
    },
    { timeout: 30000 },
  );
  return { tasks, runs, reports, inbox };
}
