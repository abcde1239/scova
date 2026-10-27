import { performance } from "node:perf_hooks";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import {
  historyFixture,
  seedHistoryRows,
  type HistoryOwner,
  type HistoryPage,
} from "./support/history-fixture.ts";

const fixture = historyFixture();
beforeAll(() => fixture.setup(), 120000);
afterAll(() => fixture.cleanup());
const page = async (path: string, owner: HistoryOwner) => {
  const response = await fixture.request(path, owner);
  expect(response.status).toBe(200);
  return (await response.json()) as HistoryPage;
};
function tampered(cursor: string) {
  const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  if ("updatedAt" in parsed) parsed.updatedAt = "2099-01-01T00:00:00.000Z";
  else parsed.time = "2099-01-01T00:00:00.000Z";
  return Buffer.from(JSON.stringify(parsed)).toString("base64url");
}
const nextPath = (path: string, cursor: string) =>
  path + (path.includes("?") ? "&" : "?") + "cursor=" + encodeURIComponent(cursor);

describe("真实socket执行历史、微秒分页及会话隔离", () => {
  it("历史限制owner/task并公开版本/模式/预算/覆盖，不泄露租约/checkpoint/feedback", async () => {
    const owner = await fixture.register(),
      other = await fixture.register();
    const data = await seedHistoryRows(fixture.db, owner),
      theirs = await seedHistoryRows(fixture.db, other);
    const task = data.tasks[0]!;
    const response = await fixture.request(`/tasks/${task.id}/runs?limit=2`, owner);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const result = (await response.json()) as HistoryPage;
    expect(result.items).toHaveLength(2);
    expect(result.nextCursor).toBeTruthy();
    for (const row of result.items) {
      expect(row).toMatchObject({
        taskId: task.id,
        taskVersionId: task.versionId,
        mode: "demo",
        status: "partial",
        outcome: "inconclusive",
        coverage: { completeness: "partial" },
        budget: { maxSearches: 10 },
      });
      for (const key of [
        "userId",
        "leaseOwner",
        "leaseEpoch",
        "leaseExpiresAt",
        "checkpointRef",
        "feedbackSnapshotJson",
        "comparisonScopeHash",
        "configJson",
        "toolCalls",
      ])
        expect(row).not.toHaveProperty(key);
    }
    expect(JSON.stringify(result)).not.toContain("private-");
    expect((await fixture.request(`/tasks/${task.id}/runs`)).status).toBe(401);
    expect((await fixture.request(`/tasks/${task.id}/runs`, other)).status).toBe(404);
    expect((await fixture.request(`/tasks/${theirs.tasks[0]!.id}/runs`, owner)).status).toBe(404);
    expect((await fixture.request(`/tasks/not-a-uuid/runs`, owner)).status).toBe(404);
    expect(
      (
        await fixture.request(
          nextPath(`/tasks/${data.tasks[1]!.id}/runs`, result.nextCursor!),
          owner,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await fixture.request(
          nextPath(`/tasks/${task.id}/runs`, tampered(result.nextCursor!)),
          owner,
        )
      ).status,
    ).toBe(400);
    expect((await fixture.request(`/tasks/${task.id}/runs?limit=0`, owner)).status).toBe(422);
  });
  it("Task/Report/Inbox/Run seek使用数据库anchor微秒精度，同毫秒limit=1不漏项不重复", async () => {
    const owner = await fixture.register(),
      data = await seedHistoryRows(fixture.db, owner, 3, 3);
    const runs = data.runs.filter((run) => run.taskId === data.tasks[0]!.id);
    const reports = data.reports.filter((report) => report.taskId === data.tasks[0]!.id);
    const inbox = reports.map((report) => data.inbox.find((item) => item.reportId === report.id)!);
    for (let i = 0; i < 3; i++) {
      const time = `2026-02-01T00:00:00.12345${6 - i}Z`;
      await fixture.db
        .$executeRaw`UPDATE tasks SET updated_at=${time}::timestamptz WHERE id=${data.tasks[i]!.id}::uuid`;
      await fixture.db
        .$executeRaw`UPDATE runs SET queued_at=${time}::timestamptz WHERE id=${runs[i]!.id}::uuid`;
      await fixture.db
        .$executeRaw`UPDATE reports SET published_at=${time}::timestamptz WHERE id=${reports[i]!.id}::uuid`;
      await fixture.db
        .$executeRaw`UPDATE inbox_items SET created_at=${time}::timestamptz WHERE id=${inbox[i]!.id}::uuid`;
    }
    expect(await fixture.pages("/tasks", owner)).toEqual(data.tasks.map((task) => task.id));
    expect(await fixture.pages(`/tasks/${data.tasks[0]!.id}/runs`, owner)).toEqual(
      runs.map((run) => run.id),
    );
    expect(await fixture.pages(`/reports?taskId=${data.tasks[0]!.id}`, owner)).toEqual(
      reports.map((report) => report.id),
    );
    const allInbox = await fixture.pages("/inbox", owner);
    expect(allInbox.slice(0, 3)).toEqual(inbox.map((item) => item.id));
    expect(new Set(allInbox).size).toBe(data.inbox.length);
    expect(allInbox).toHaveLength(data.inbox.length);
  });
  it("已读unread anchor仍可继续到剩余项，筛选/scope/owner/时间篡改拒绝", async () => {
    const owner = await fixture.register(),
      other = await fixture.register();
    const data = await seedHistoryRows(fixture.db, owner, 2, 3);
    const unread = await page("/inbox?unread=true&limit=1", owner);
    expect(unread.nextCursor).toBeTruthy();
    expect(
      (
        await fixture.request(`/inbox/${unread.items[0]!.id}`, owner, {
          method: "PATCH",
          body: JSON.stringify({ read: true }),
        })
      ).status,
    ).toBe(200);
    const remaining = await fixture.request(
      nextPath("/inbox?unread=true", unread.nextCursor!),
      owner,
    );
    expect(remaining.status).toBe(200);
    const body = (await remaining.json()) as HistoryPage;
    expect(body.items).toHaveLength(data.inbox.length - 1);
    expect(body.items.some((item) => item.id === unread.items[0]!.id)).toBe(false);
    expect(body.items.every((item) => item.readAt === null)).toBe(true);
    expect(
      (await fixture.request(nextPath("/inbox?unread=false", unread.nextCursor!), owner)).status,
    ).toBe(400);
    for (const path of ["/tasks", "/reports", "/inbox", `/tasks/${data.tasks[0]!.id}/runs`]) {
      const result = await page(path + (path.includes("?") ? "&" : "?") + "limit=1", owner);
      expect(result.nextCursor).toBeTruthy();
      expect(
        (await fixture.request(nextPath(path, tampered(result.nextCursor!)), owner)).status,
      ).toBe(400);
      const foreign = await fixture.request(nextPath(path, result.nextCursor!), other);
      expect(foreign.status).toBe(path.includes("/runs") ? 404 : 400);
    }
    const reports = await page(`/reports?taskId=${data.tasks[0]!.id}&limit=1`, owner);
    expect(
      (
        await fixture.request(
          nextPath(`/reports?taskId=${data.tasks[1]!.id}`, reports.nextCursor!),
          owner,
        )
      ).status,
    ).toBe(400);
    expect((await fixture.request("/tasks?cursor=not-json", owner)).status).toBe(400);
  });
});

it("10真实会话并发四类列表：固定规模、warmup后完整HTTP响应p95小于500ms", async () => {
  const users: { owner: HistoryOwner; taskId: string }[] = [];
  for (let i = 0; i < 10; i++) {
    const owner = await fixture.register(),
      data = await seedHistoryRows(fixture.db, owner, 20, 20);
    users.push({ owner, taskId: data.tasks[0]!.id });
  }
  const routes = {
    tasks: () => "/tasks?limit=20",
    reports: () => "/reports?limit=20",
    inbox: () => "/inbox?limit=20",
    runs: (taskId: string) => `/tasks/${taskId}/runs?limit=20`,
  };
  const measurements: Record<string, number[]> = {};
  for (const [name, route] of Object.entries(routes)) {
    const samples: number[] = [];
    async function batch(record: boolean) {
      await Promise.all(
        users.map(async (user) => {
          const started = performance.now();
          const response = await fixture.request(route(user.taskId), user.owner);
          const body = (await response.json()) as HistoryPage;
          const duration = performance.now() - started;
          expect(response.status).toBe(200);
          expect(body.items).toHaveLength(20);
          if (record) samples.push(duration);
        }),
      );
    }
    for (let round = 0; round < 3; round++) await batch(false);
    for (let round = 0; round < 20; round++) await batch(true);
    measurements[name] = samples;
  }
  const p95Ms = Object.fromEntries(
    Object.entries(measurements).map(([name, samples]) => {
      const sorted = [...samples].sort((a, b) => a - b);
      return [name, Number(sorted[Math.ceil(sorted.length * 0.95) - 1]!.toFixed(3))];
    }),
  );
  console.log(
    JSON.stringify({
      benchmark: "authenticated-list-socket",
      transport: "Node HTTP loopback; fetch through full body JSON parse",
      runtime: process.version,
      platform: process.platform,
      sessions: 10,
      concurrency: 10,
      datasetPerOwner: { tasks: 20, runs: 400, reports: 400, inbox: 400 },
      limit: 20,
      warmupRoundsPerEndpoint: 3,
      sampleRoundsPerEndpoint: 20,
      samplesPerEndpoint: 200,
      p95Ms,
    }),
  );
  for (const [name, value] of Object.entries(p95Ms))
    expect(value, `${name} p95完整HTTP响应`).toBeLessThan(500);
}, 120000);
