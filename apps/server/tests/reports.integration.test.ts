import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@scova/models";
import { Redis as RedisClient } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { createApiApp } from "../src/app/index.ts";
import { createDefaultServices } from "../src/app/context.ts";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../../../", import.meta.url));
const baseUrl =
  process.env.SCOVA_TEST_DATABASE_URL ??
  process.env.RUNTIME_DATABASE_URL ??
  "postgresql://scova_test:scova_test@127.0.0.1:55432/scova_test";
const redisUrl =
  process.env.SCOVA_TEST_REDIS_URL ?? process.env.RUNTIME_REDIS_URL ?? "redis://127.0.0.1:56379";
const schema = `scova_reports_${randomUUID().replaceAll("-", "")}`;
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
let app: ReturnType<typeof createApiApp>;
let now: Date;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const config = {
  title: "官方资讯",
  topic: "来源证据",
  goal: "查阅官方原文",
  focusPoints: ["原文"],
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
type Auth = { cookie: string; csrf: string; userId: string };
const json = async (response: Response) => (await response.json()) as Record<string, any>;
const headers = (auth?: Auth) => ({
  origin,
  "content-type": "application/json",
  ...(auth ? { cookie: auth.cookie, "x-csrf-token": auth.csrf } : {}),
});
const request = (path: string, init: RequestInit = {}) =>
  app.handle(new Request(`${origin}/api/v1${path}`, init));
async function register(): Promise<Auth> {
  const response = await request("/auth/register", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      email: `${randomUUID()}@example.test`,
      password: "correct horse battery staple",
      defaultTimezone: "UTC",
    }),
  });
  expect(response.status).toBe(201);
  const body = await json(response);
  return {
    cookie: response.headers.get("set-cookie")!.split(";")[0]!,
    csrf: body.csrfToken,
    userId: body.user.id,
  };
}
async function task(auth: Auth) {
  const response = await request("/tasks", {
    method: "POST",
    headers: headers(auth),
    body: JSON.stringify({ config }),
  });
  expect(response.status).toBe(201);
  return (await json(response)).task as { id: string; currentVersionId: string };
}
async function fixture(
  auth: Auth,
  existingTask?: { id: string; currentVersionId: string },
  index = 0,
) {
  const ownedTask = existingTask ?? (await task(auth));
  const coverage = {
    completeness: "partial",
    searchedQueries: ["官方资讯"],
    gaps: ["发布时间尚未核验"],
    exhausted: [],
  };
  const run = await prisma.run.create({
    data: {
      userId: auth.userId,
      taskId: ownedTask.id,
      taskVersionId: ownedTask.currentVersionId,
      comparisonScopeHash: sha("scope"),
      mode: "demo",
      trigger: "manual",
      status: "partial",
      budgetJson: config.budget,
      usageJson: {},
      outcome: "inconclusive",
      coverageJson: coverage,
    },
  });
  const url = `https://example.com/${randomUUID()}`;
  const text = "这是完整采集正文。活动日期尚需确认。";
  const quote = text.slice(0, 9);
  const source = await prisma.source.create({
    data: { userId: auth.userId, canonicalUrl: url, canonicalUrlHash: sha(url) },
  });
  const snapshot = await prisma.sourceSnapshot.create({
    data: {
      userId: auth.userId,
      sourceId: source.id,
      title: "来源页面",
      contentHash: sha(text),
      extractorVersion: "reader-v1",
      textBody: text,
      textExpiresAt: new Date("2026-10-27T00:00:00Z"),
      metadataJson: {
        mode: "demo",
        originalUrl: url,
        fetchedUrl: url,
        collectedAt: now.toISOString(),
        truncated: false,
        untrusted: true,
      },
    },
  });
  await prisma.runSource.create({
    data: {
      userId: auth.userId,
      runId: run.id,
      sourceId: source.id,
      snapshotId: snapshot.id,
      requestedUrl: `${url}?original=1`,
      fetchedUrl: url,
      observedAt: now,
      fetchStatus: "succeeded",
      metadataJson: { mode: "demo", truncated: false },
    },
  });
  const evidence = await prisma.evidence.create({
    data: {
      userId: auth.userId,
      runId: run.id,
      snapshotId: snapshot.id,
      quote,
      quoteHash: sha(quote),
      selectorJson: {
        type: "text_offset",
        start: 0,
        end: quote.length,
        extractorVersion: "reader-v1",
      },
    },
  });
  const report = await prisma.report.create({
    data: {
      userId: auth.userId,
      runId: run.id,
      taskId: ownedTask.id,
      taskVersionId: ownedTask.currentVersionId,
      title: "原文简报",
      summary: "已经采集来源，仍存在核验缺口",
      format: "brief",
      completeness: "partial",
      limitationsJson: ["演示资料", "发布时间尚未核验"],
      publishedAt: new Date(now.getTime() + index * 1000),
    },
  });
  const claim = await prisma.claim.create({
    data: {
      userId: auth.userId,
      taskId: ownedTask.id,
      reportId: report.id,
      kind: "fact",
      text: quote,
      confidenceLabel: "来自原文",
      order: 0,
    },
  });
  const citation = await prisma.claimEvidence.create({
    data: { userId: auth.userId, claimId: claim.id, evidenceId: evidence.id, relation: "supports" },
  });
  const inbox = await prisma.inboxItem.create({
    data: { userId: auth.userId, reportId: report.id, createdAt: report.publishedAt },
  });
  return {
    task: ownedTask,
    run,
    source,
    snapshot,
    evidence,
    report,
    claim,
    citation,
    inbox,
    quote,
    url,
  };
}

describe("报告证据与收件箱 API", () => {
  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
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
        timeout: 60000,
      },
    );
    await prisma.$connect();
    await redis.connect();
  }, 120000);
  beforeEach(() => {
    now = new Date("2026-10-26T00:00:00.000Z");
    app = createApiApp(
      "node",
      createDefaultServices({
        origin,
        production: false,
        registrationEnabled: true,
        sessionTtlSeconds: 3600,
        clock: () => now,
        db: () => prisma,
        redis: () => redis,
        rateLimit: {
          windowSeconds: 60,
          loginAttempts: 50,
          registerAttempts: 50,
          globalAttempts: 100,
          keyPrefix: `scova:reports:${randomUUID()}:`,
        },
      }),
    );
  });
  afterAll(async () => {
    await prisma.$disconnect();
    if (redis.status === "ready") await redis.quit();
    else redis.disconnect();
    if (schemaCreated) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  it("返回真实片段和快照元数据，正文清理后仍可引用且不泄漏内部字段", async () => {
    const auth = await register();
    const data = await fixture(auth);
    const read = () => request(`/reports/${data.report.id}`, { headers: headers(auth) });
    const response = await read();
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body).toMatchObject({
      mode: "demo",
      outcome: "inconclusive",
      coverage: { completeness: "partial" },
      evidence: [
        {
          quote: data.quote,
          url: `${data.url}?original=1`,
          snapshot: {
            originalUrl: `${data.url}?original=1`,
            fetchedUrl: data.url,
            canonicalUrl: data.url,
            contentHash: data.snapshot.contentHash,
            publishedAt: null,
            truncated: false,
            selector: { start: 0, end: data.quote.length },
          },
        },
      ],
    });
    expect(body.claims[0].evidenceIds).toEqual([data.evidence.id]);
    const encoded = JSON.stringify(body);
    for (const forbidden of [
      "textBody",
      "metadataJson",
      "leaseOwner",
      "checkpointRef",
      "userId",
      "passwordHash",
    ])
      expect(encoded).not.toContain(forbidden);
    await prisma.sourceSnapshot.update({
      where: { id: data.snapshot.id },
      data: { textBody: null, textExpiresAt: now },
    });
    expect(await json(await read())).toEqual(body);
  });

  it("报告历史稳定分页、按任务筛选并拒绝跨用户或篡改的游标", async () => {
    const auth = await register();
    const other = await register();
    const first = await fixture(auth);
    const second = await fixture(auth, first.task, 1);
    const separate = await fixture(auth, undefined, 2);
    const outsider = await fixture(other);
    const page = await json(
      await request(`/reports?taskId=${first.task.id}&limit=1`, { headers: headers(auth) }),
    );
    expect(page.items.map((entry: any) => entry.id)).toEqual([second.report.id]);
    expect(page.items[0]).not.toHaveProperty("evidence");
    const next = await json(
      await request(`/reports?taskId=${first.task.id}&limit=1&cursor=${page.nextCursor}`, {
        headers: headers(auth),
      }),
    );
    expect(next.items.map((entry: any) => entry.id)).toEqual([first.report.id]);
    expect(next.nextCursor).toBeNull();
    expect(
      (
        await request(`/reports?taskId=${separate.task.id}&cursor=${page.nextCursor}`, {
          headers: headers(auth),
        })
      ).status,
    ).toBe(400);
    expect(
      (await request(`/reports?taskId=${first.task.id}`, { headers: headers(other) })).status,
    ).toBe(404);
    const forged = (id: string, time: string) =>
      Buffer.from(JSON.stringify({ id, time, scope: "reports:all" })).toString("base64url");
    expect(
      (
        await request(
          `/reports?cursor=${forged(outsider.report.id, outsider.report.publishedAt.toISOString())}`,
          { headers: headers(auth) },
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await request(`/reports?cursor=${forged(first.report.id, "2020-01-01T00:00:00.000Z")}`, {
          headers: headers(auth),
        })
      ).status,
    ).toBe(400);
    expect((await request("/reports?limit=1.5", { headers: headers(auth) })).status).toBe(422);
  });

  it("引用显示本轮观测的截断与声明日期，不沿用首次快照元数据", async () => {
    const auth = await register();
    const data = await fixture(auth);
    await prisma.runSource.update({
      where: { runId_sourceId: { runId: data.run.id, sourceId: data.source.id } },
      data: {
        metadataJson: {
          mode: "demo",
          truncated: true,
          publication: {
            parserVersion: "scova-publication-v1",
            status: "known",
            instant: "2000-01-01T00:00:00Z",
            observations: [
              {
                field: "article:published_time",
                rawValue: "2026-10-25T09:00:00+09:00",
                locator: "meta[0]",
              },
            ],
          },
        },
      },
    });
    const response = await request(`/reports/${data.report.id}`, { headers: headers(auth) });
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.evidence[0].snapshot).toMatchObject({
      truncated: true,
      publishedAt: "2026-10-25T00:00:00.000Z",
    });
    expect(
      (await prisma.sourceSnapshot.findUniqueOrThrow({ where: { id: data.snapshot.id } }))
        .metadataJson,
    ).toMatchObject({ truncated: false });
  });

  it.each(["partial", "mode", "scope"])("拒绝不合法 %s 基线的旧侧引用", async (reason) => {
    const auth = await register();
    const current = await fixture(auth);
    const previous = await fixture(auth, current.task, 1);
    await prisma.run.update({
      where: { id: previous.run.id },
      data: {
        status: reason === "partial" ? "partial" : "succeeded",
        mode: reason === "mode" ? "live" : "demo",
        comparisonScopeHash:
          reason === "scope" ? sha("different-scope") : current.run.comparisonScopeHash,
        coverageJson: {
          completeness: reason === "partial" ? "partial" : "complete",
          searchedQueries: ["query"],
          gaps: [],
          exhausted: [],
        },
      },
    });
    if (reason === "scope") {
      // Effective scope is enforced by a composite database foreign key before API mapping.
      await expect(
        prisma.run.update({
          where: { id: current.run.id },
          data: { baselineRunId: previous.run.id },
        }),
      ).rejects.toMatchObject({ code: "P2003" });
      return;
    }
    await prisma.run.update({
      where: { id: current.run.id },
      data: { baselineRunId: previous.run.id },
    });
    await prisma.report.update({
      where: { id: current.report.id },
      data: { baselineRunId: previous.run.id },
    });
    const change = await prisma.changeRecord.create({
      data: {
        userId: auth.userId,
        reportId: current.report.id,
        sourceId: current.source.id,
        kind: "changed",
        oldSourceId: previous.source.id,
        oldSnapshotId: previous.snapshot.id,
        newSnapshotId: current.snapshot.id,
        factKey: "test",
        oldValue: "old",
        newValue: "new",
        importance: "important",
        reason: "测试非法基线引用",
      },
    });
    await prisma.changeEvidence.create({
      data: {
        userId: auth.userId,
        changeRecordId: change.id,
        evidenceId: previous.evidence.id,
        side: "old",
      },
    });
    await prisma.changeEvidence.create({
      data: {
        userId: auth.userId,
        changeRecordId: change.id,
        evidenceId: current.evidence.id,
        side: "new",
      },
    });
    const response = await request(`/reports/${current.report.id}`, { headers: headers(auth) });
    expect(response.status).toBe(409);
    expect((await json(response)).code).toBe("INVALID_REPORT_EVIDENCE");
  });

  it.each(["valid", "old_source", "old_snapshot", "new_source", "new_snapshot", "reversed"])(
    "逐项校验变化的双方来源与快照：%s",
    async (variant) => {
      const auth = await register();
      const previous = await fixture(auth);
      const current = await fixture(auth, previous.task, 1);
      await prisma.run.update({
        where: { id: previous.run.id },
        data: {
          status: "succeeded",
          outcome: "baseline",
          coverageJson: {
            completeness: "complete",
            searchedQueries: ["query"],
            gaps: [],
            exhausted: [],
          },
        },
      });
      await prisma.report.update({
        where: { id: previous.report.id },
        data: { completeness: "complete", limitationsJson: [] },
      });
      await prisma.run.update({
        where: { id: current.run.id },
        data: { baselineRunId: previous.run.id },
      });
      await prisma.report.update({
        where: { id: current.report.id },
        data: { baselineRunId: previous.run.id },
      });
      async function alternateSnapshot(sourceId: string) {
        return prisma.sourceSnapshot.create({
          data: {
            userId: auth.userId,
            sourceId,
            title: "另一次正文版本",
            contentHash: sha(randomUUID()),
            extractorVersion: "reader-v1",
            metadataJson: {},
          },
        });
      }
      const oldSnapshot =
        variant === "old_snapshot"
          ? await alternateSnapshot(previous.source.id)
          : previous.snapshot;
      const newSnapshot =
        variant === "new_snapshot" ? await alternateSnapshot(current.source.id) : current.snapshot;
      const change = await prisma.changeRecord.create({
        data: {
          userId: auth.userId,
          reportId: current.report.id,
          sourceId: variant === "new_source" ? previous.source.id : current.source.id,
          kind: "changed",
          oldSourceId: variant === "old_source" ? current.source.id : previous.source.id,
          oldSnapshotId: variant === "old_source" ? current.snapshot.id : oldSnapshot.id,
          newSnapshotId: variant === "new_source" ? previous.snapshot.id : newSnapshot.id,
          factKey: "deadline",
          oldValue: previous.quote,
          newValue: current.quote,
          importance: "important",
          reason: "基线与本次事实对比",
        },
      });
      await prisma.changeEvidence.createMany({
        data: [
          {
            userId: auth.userId,
            changeRecordId: change.id,
            evidenceId: previous.evidence.id,
            side: variant === "reversed" ? "new" : "old",
          },
          {
            userId: auth.userId,
            changeRecordId: change.id,
            evidenceId: current.evidence.id,
            side: variant === "reversed" ? "old" : "new",
          },
        ],
      });
      const response = await request(`/reports/${current.report.id}`, { headers: headers(auth) });
      expect(response.status).toBe(variant === "valid" ? 200 : 409);
      const body = await json(response);
      if (variant === "valid") {
        expect(body.baselineRunId).toBe(previous.run.id);
        expect(body.changes[0]).toMatchObject({
          oldEvidenceIds: [previous.evidence.id],
          newEvidenceIds: [current.evidence.id],
        });
      } else {
        expect(body.code).toBe("INVALID_REPORT_EVIDENCE");
        expect(body).not.toHaveProperty("evidence");
      }
    },
  );

  it("同账号其他 Run 的证据不能被报告引用，拒绝整个详情", async () => {
    const auth = await register();
    const first = await fixture(auth);
    const second = await fixture(auth, first.task, 1);
    await prisma.claimEvidence.update({
      where: { id: first.citation.id },
      data: { evidenceId: second.evidence.id },
    });
    const response = await request(`/reports/${first.report.id}`, { headers: headers(auth) });
    expect(response.status).toBe(409);
    const body = await json(response);
    expect(body.code).toBe("INVALID_REPORT_EVIDENCE");
    expect(body).not.toHaveProperty("claims");
    expect(body).not.toHaveProperty("evidence");
  });

  it("损坏的原文指纹与定位不得作为有效引用返回", async () => {
    const auth = await register();
    const data = await fixture(auth);
    await prisma.evidence.update({
      where: { id: data.evidence.id },
      data: { quoteHash: "0".repeat(64) },
    });
    expect((await request(`/reports/${data.report.id}`, { headers: headers(auth) })).status).toBe(
      409,
    );
    await prisma.evidence.update({
      where: { id: data.evidence.id },
      data: {
        quoteHash: sha(data.quote),
        selectorJson: { type: "text_offset", start: 0, end: 100, extractorVersion: "reader-v1" },
      },
    });
    expect((await request(`/reports/${data.report.id}`, { headers: headers(auth) })).status).toBe(
      409,
    );
  });

  it("收件箱已读状态持久化、幂等并校验 CSRF 与 owner", async () => {
    const auth = await register();
    const other = await register();
    const data = await fixture(auth);
    const patch = (read: boolean, actor = auth) =>
      request(`/inbox/${data.inbox.id}`, {
        method: "PATCH",
        headers: headers(actor),
        body: JSON.stringify({ read }),
      });
    expect((await request(`/reports/${data.report.id}`, { headers: headers(other) })).status).toBe(
      404,
    );
    expect((await request(`/reports/${randomUUID()}`, { headers: headers(auth) })).status).toBe(
      404,
    );
    expect((await request("/reports")).status).toBe(401);
    expect((await patch(true, other)).status).toBe(404);
    expect(
      (
        await request(`/inbox/${data.inbox.id}`, {
          method: "PATCH",
          headers: { origin, cookie: auth.cookie, "content-type": "application/json" },
          body: JSON.stringify({ read: true }),
        })
      ).status,
    ).toBe(403);
    const unread = await json(await request("/inbox?unread=true", { headers: headers(auth) }));
    expect(unread.items).toHaveLength(1);
    expect(unread.items[0]).toMatchObject({
      id: data.inbox.id,
      readAt: null,
      report: { id: data.report.id, mode: "demo" },
    });
    const first = await json(await patch(true));
    now = new Date(now.getTime() + 1000);
    expect((await json(await patch(true))).readAt).toBe(first.readAt);
    expect(
      (
        await prisma.inboxItem.findUniqueOrThrow({ where: { id: data.inbox.id } })
      ).readAt?.toISOString(),
    ).toBe(first.readAt);
    expect(
      (await json(await request("/inbox?unread=true", { headers: headers(auth) }))).items,
    ).toEqual([]);
    expect(
      (await json(await request("/inbox?unread=false", { headers: headers(auth) }))).items,
    ).toHaveLength(1);
    expect((await json(await patch(false))).readAt).toBeNull();
  });

  it("收件箱分页的范围绑定不受上一条标记已读影响", async () => {
    const auth = await register();
    const first = await fixture(auth);
    const second = await fixture(auth, first.task, 1);
    const page = await json(
      await request("/inbox?unread=true&limit=1", { headers: headers(auth) }),
    );
    expect(page.items.map((entry: any) => entry.id)).toEqual([second.inbox.id]);
    await request(`/inbox/${second.inbox.id}`, {
      method: "PATCH",
      headers: headers(auth),
      body: JSON.stringify({ read: true }),
    });
    const next = await json(
      await request(`/inbox?unread=true&limit=1&cursor=${page.nextCursor}`, {
        headers: headers(auth),
      }),
    );
    expect(next.items.map((entry: any) => entry.id)).toEqual([first.inbox.id]);
    expect(next.nextCursor).toBeNull();
    expect(
      (await request(`/inbox?unread=false&cursor=${page.nextCursor}`, { headers: headers(auth) }))
        .status,
    ).toBe(400);
  });
});
