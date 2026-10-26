import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { nodeScriptCommand } from "../../../scripts/process-runtime.mjs";
import { createOutboxQueue } from "../src/queue/outbox.ts";
import { outboxDatabase } from "./support/outbox-database.ts";
import { seedRun } from "./support/run-database.ts";

const fixture = outboxDatabase();
const workerRoot = fileURLToPath(new URL("../", import.meta.url));
const bun =
  process.env.BUN_BIN ??
  join(homedir(), ".bun", "bin", process.platform === "win32" ? "bun.exe" : "bun");

function launch(runtime: "bun" | "node", env: NodeJS.ProcessEnv) {
  if (runtime === "bun" && !existsSync(bun)) throw new Error("需独立 Bun 或配置 BUN_BIN");
  const command =
    runtime === "bun"
      ? { executable: bun, args: ["run", "src/main.ts"] }
      : nodeScriptCommand("src/node.ts");
  const child = spawn(command.executable, command.args, {
    cwd: workerRoot,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  let output = "";
  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  child.stdout!.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr!.on("data", (chunk) => {
    output += String(chunk);
  });
  const ended = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      exit = { code, signal };
      resolve();
    });
  });
  return {
    child,
    ended,
    get output() {
      return output;
    },
    get exit() {
      return exit;
    },
  };
}

async function waitUntil(check: () => Promise<boolean>, process: ReturnType<typeof launch>) {
  const deadline = Date.now() + 15_000;
  while (!(await check())) {
    if (process.exit) throw new Error(`Worker 提前退出：${process.output}`);
    if (Date.now() > deadline) throw new Error(`Worker 未按期投递：${process.output}`);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

async function ended(process: ReturnType<typeof launch>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      process.ended,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Worker 未优雅退出：${process.output}`)), 10_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe("Worker Bun/Node 真实进程", () => {
  beforeAll(() => fixture.setup(), 120_000);
  afterAll(() => fixture.cleanup());
  beforeEach(() => fixture.db.outbox.deleteMany());

  it.each(["bun", "node"] as const)("%s 启动后实际投递，IPC 停止并释放连接", async (runtime) => {
    const { outbox: item } = await seedRun(fixture.db);
    const queueName = `scova-runtime-${runtime}-${randomUUID()}`;
    const connection = new Redis(fixture.redisUrl, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
    });
    connection.on("error", () => undefined);
    await connection.connect();
    const publisher = createOutboxQueue(connection, queueName);
    const process = launch(runtime, {
      DATABASE_URL: fixture.databaseUrl,
      AGENT_CHECKPOINT_SCHEMA: fixture.checkpointSchema,
      REDIS_URL: fixture.redisUrl,
      WORKER_QUEUE_NAME: queueName,
      WORKER_POLL_INTERVAL_MS: "20",
    });
    try {
      await waitUntil(
        async () =>
          (await fixture.db.outbox.findUniqueOrThrow({ where: { id: item.id } })).sentAt !== null,
        process,
      );
      expect(process.output).toContain("Outbox dispatcher running");
      expect((await publisher.queue.getJob(`run-${item.aggregateId}`))?.data).toEqual({
        runId: item.aggregateId,
      });
      await waitUntil(
        async () =>
          (await fixture.db.run.findUniqueOrThrow({ where: { id: item.aggregateId } })).status ===
          "failed",
        process,
      );
      expect(
        await fixture.db.run.findUniqueOrThrow({ where: { id: item.aggregateId } }),
      ).toMatchObject({
        status: "failed",
        failureCode: "AGENT_DELIVERY_NOT_CONFIGURED",
      });
      expect(await fixture.db.report.count({ where: { runId: item.aggregateId } })).toBe(0);
      process.child.send("scova:shutdown");
      await ended(process);
      expect(process.exit?.code).toBe(0);
    } finally {
      if (!process.exit) {
        if (process.child.connected) process.child.send("scova:shutdown");
        try {
          await ended(process);
        } catch {
          process.child.kill();
        }
      }
      await publisher.queue.obliterate({ force: true });
      await publisher.close();
      connection.disconnect();
    }
  });

  it.each(["bun", "node"] as const)("%s 缺少配置明确失败且不输出凭据", async (runtime) => {
    const process = launch(runtime, {
      DATABASE_URL: "credential-must-not-be-logged",
      REDIS_URL: fixture.redisUrl,
    });
    try {
      await ended(process);
      expect(process.exit?.code).toBe(1);
      expect(process.output).toContain("Worker 启动或运行失败");
      expect(process.output).not.toContain("credential-must-not-be-logged");
      expect(process.output).not.toContain("dispatcher running");
    } finally {
      if (!process.exit) process.child.kill();
    }
  });

  it("Redis 初始化失败时释放已建立的数据库连接并退出", async () => {
    const process = launch("node", {
      DATABASE_URL: fixture.databaseUrl,
      REDIS_URL: "redis://127.0.0.1:1",
    });
    try {
      await ended(process);
      expect(process.exit?.code).toBe(1);
      expect(process.output).toContain("Worker 启动或运行失败");
      expect(process.output).not.toContain("dispatcher running");
    } finally {
      if (!process.exit) process.child.kill();
    }
  });
});
