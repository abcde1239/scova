import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// Opt-in acceptance owns fresh Compose projects and removes only their containers/volumes.
const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "scova-deployment-"));
const project = `scova-accept-${randomUUID().slice(0, 8)}`;
const restoreProject = `${project}-restore`;
const server = createServer().listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert(address && typeof address !== "string");
const port = address.port;
await new Promise((resolve, reject) =>
  server.close((error) => (error ? reject(error) : resolve())),
);
const origin = `http://127.0.0.1:${port}`;
const env = {
  ...process.env,
  POSTGRES_PASSWORD: randomBytes(24).toString("hex"),
  SCOVA_PORT: String(port),
  SCOVA_BIND: "127.0.0.1",
  APP_ORIGIN: origin,
  REGISTRATION_ENABLED: "true",
  WORKER_SCHEDULED_RUN_MODE: "demo",
  MODEL_API_KEY: "",
  TAVILY_API_KEY: "",
};
const overrides = new Map();
for (const name of [project, restoreProject]) {
  const path = join(directory, `${name}.json`);
  await writeFile(
    path,
    JSON.stringify({
      volumes: {
        backups: {
          name: `${project}-backups`,
          ...(name === restoreProject ? { external: true } : {}),
        },
      },
    }),
  );
  overrides.set(name, path);
}
async function compose(name, args) {
  console.log(`[${name}] ${args.join(" ")}`);
  await exec(
    "docker",
    [
      "compose",
      "--env-file",
      join(root, ".env.example"),
      "-p",
      name,
      "-f",
      join(root, "compose.yaml"),
      "-f",
      overrides.get(name),
      ...args,
    ],
    { cwd: root, env, timeout: 900_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
  );
}
let session;
async function request(path, method = "GET", body, headers = {}) {
  const response = await fetch(origin + path, {
    method,
    headers: {
      origin,
      "content-type": "application/json",
      ...(session ? { cookie: session.cookie, "x-csrf-token": session.csrf } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  });
  assert(response.ok, `${method} ${path}: HTTP ${response.status}`);
  return response;
}
const config = {
  title: "容器验收",
  topic: "公开信息研究",
  goal: "寻找可追溯资料",
  focusPoints: ["来源"],
  exclusions: [],
  sourcePreferences: { preferredUrls: [], excludedUrls: [], officialOnly: false },
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
};
try {
  console.log("构建隔离项目并等待迁移、API、Worker、代理健康。");
  await compose(project, ["build", "api"]);
  await compose(project, ["up", "-d", "--wait", "--wait-timeout", "180", "api", "worker", "proxy"]);
  await request("/health");
  const credentials = {
    email: `${randomUUID()}@example.test`,
    password: randomBytes(24).toString("hex"),
  };
  await request("/api/v1/auth/register", "POST", { ...credentials, defaultTimezone: "UTC" });
  const login = await request("/api/v1/auth/login", "POST", credentials);
  const cookie = login.headers.get("set-cookie");
  assert(cookie?.includes("HttpOnly") && cookie.includes("Secure"));
  session = { cookie: cookie.split(";")[0], csrf: (await login.json()).csrfToken };
  const task = (await (await request("/api/v1/tasks", "POST", { config })).json()).task;
  const key = randomUUID();
  const start = async () =>
    (
      await request(
        `/api/v1/tasks/${task.id}/runs`,
        "POST",
        { mode: "demo" },
        { "idempotency-key": key },
      )
    ).json();
  const run = (await start()).run;
  const deadline = Date.now() + 120_000;
  for (;;) {
    const state = await (await request(`/api/v1/runs/${run.id}`)).json();
    if (["succeeded", "partial"].includes(state.status)) break;
    assert(!["failed", "canceled"].includes(state.status), `Demo terminated: ${state.status}`);
    assert(Date.now() < deadline, "Demo delivery timed out");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const reportList = await (await request(`/api/v1/reports?taskId=${task.id}`)).json();
  assert.equal(reportList.items.length, 1);
  const report = await (await request(`/api/v1/reports/${reportList.items[0].id}`)).json();
  assert.equal(report.mode, "demo");
  assert.equal(report.runId, run.id);
  assert(report.evidence.length > 0);
  const inboxBefore = await (await request("/api/v1/inbox")).json();
  assert.equal(inboxBefore.items.filter((item) => item.reportId === report.id).length, 1);
  console.log("同源登录、演示交付和证据通过；验证重启不重复交付。");
  await compose(project, ["restart", "postgres", "redis", "api", "worker", "proxy"]);
  await compose(project, ["up", "-d", "--wait", "--wait-timeout", "180", "api", "worker", "proxy"]);
  assert.equal((await start()).run.id, run.id);
  assert.equal((await (await request(`/api/v1/reports?taskId=${task.id}`)).json()).items.length, 1);
  await compose(project, ["stop", "proxy", "api", "worker"]);
  await compose(project, [
    "--profile",
    "maintenance",
    "run",
    "--rm",
    "operations",
    "backup",
    "--name=acceptance.dump",
  ]);
  await compose(restoreProject, ["up", "-d", "--wait", "postgres", "redis"]);
  await compose(restoreProject, [
    "--profile",
    "maintenance",
    "run",
    "--rm",
    "operations",
    "restore",
    "--name=acceptance.dump",
    "--apply",
  ]);
  await compose(restoreProject, [
    "up",
    "-d",
    "--wait",
    "--wait-timeout",
    "180",
    "api",
    "worker",
    "proxy",
  ]);
  assert.deepEqual(await (await request(`/api/v1/reports/${report.id}`)).json(), report);
  assert.equal((await start()).run.id, run.id);
  const inboxRestored = await (await request("/api/v1/inbox")).json();
  assert.equal(inboxRestored.items.filter((item) => item.reportId === report.id).length, 1);
  console.log("通过：容器启动、代理、会话、演示报告、持久重启及空库恢复。");
} finally {
  // Names are generated above; neither command targets an existing user deployment.
  const results = await Promise.allSettled(
    [restoreProject, project].map((name) =>
      compose(name, ["--profile", "maintenance", "down", "-v", "--remove-orphans"]),
    ),
  );
  await rm(directory, { recursive: true, force: true });
  if (results.some((result) => result.status === "rejected"))
    console.error(`验收清理未完成，请检查 ${project} 和 ${restoreProject}。`);
}
