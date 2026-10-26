import { createHash, randomUUID } from "node:crypto";
import { MemorySaver } from "@langchain/langgraph";
import type { RunnableConfig } from "@langchain/core/runnables";
import { describe, it, expect } from "vite-plus/test";
import type { FeedbackSnapshotItem } from "@scova/contracts";
import { readFeedbackSnapshot } from "@scova/contracts";
import type { AgentContext, AgentTools, AgentPage } from "../src/index.ts";
import { runResearchAgent, candidateFromCheckpoint } from "../src/index.ts";
import { explainFeedback } from "../src/feedback.ts";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const urls = [
  "https://example.com/ignored",
  "https://example.com/normal",
  "https://example.com/deeper",
];
function item(kind: FeedbackSnapshotItem["kind"], url: string): FeedbackSnapshotItem {
  return {
    id: randomUUID(),
    sourceId: randomUUID(),
    claimId: null,
    kind,
    updatedAt: new Date().toISOString(),
    text: null,
    sources: [{ url, contentHash: sha("原文未变"), quote: null }],
  };
}
function fixture(feedback: FeedbackSnapshotItem[], searchBudget = 4) {
  const userId = randomUUID(),
    taskId = randomUUID();
  const budget = {
    maxSearches: searchBudget,
    maxPages: 2,
    maxDurationSeconds: 300,
    maxInputTokens: 40000,
    maxOutputTokens: 8000,
  };
  const context: AgentContext = {
    runId: randomUUID(),
    userId,
    taskVersionId: randomUUID(),
    mode: "live",
    budget,
    config: {
      title: "公告",
      topic: "申请",
      goal: "截止日期",
      focusPoints: [],
      exclusions: [],
      sourcePreferences: { preferredUrls: [], excludedUrls: [], officialOnly: false },
      timeRange: { kind: "rolling", days: 7 },
      timezone: "UTC",
      schedule: { frequency: "manual" },
      outputFormat: "brief",
      budget,
      notificationPreference: { mode: "off", runIssues: false },
    },
    usage: { searches: 0, pages: 0, inputTokens: 0, outputTokens: 0, estimated: false },
    startedAt: new Date(),
    deadlineAt: new Date(Date.now() + 300000),
    signal: new AbortController().signal,
    assertActive: async () => {},
    feedback: { schemaVersion: 1, userId, taskId, items: feedback },
  };
  const searched: string[] = [],
    read: string[] = [];
  const tools: AgentTools = {
    async search(_key, query) {
      searched.push(query);
      return {
        kind: "search_results",
        mode: "live",
        provider: "searxng",
        query,
        searchedAt: new Date().toISOString(),
        results: urls.map((url) => ({
          kind: "search_snippet",
          originalUrl: url,
          url,
          title: "公告",
          snippet: "摘要",
        })),
        coverage: {
          complete: true,
          gaps: [],
          unresponsiveEngines: [],
          receivedResults: 3,
          returnedResults: 3,
          discardedResults: 0,
          totalResults: 3,
          truncated: false,
        },
      };
    },
    async read(_key, url) {
      read.push(url);
      const text = `${url} 截止日期为2026-11-16。`;
      return {
        kind: "read_page",
        mode: "live",
        originalUrl: url,
        fetchedUrl: url,
        url,
        title: "公告",
        text,
        contentHash: sha(text),
        extractionVersion: "fixture-v1",
        collectedAt: new Date().toISOString(),
        truncated: false,
        untrusted: true,
      };
    },
    async model(_key, input) {
      const sources = input.untrustedSources as { pageId: string; text: string }[] | undefined;
      return {
        mode: "live",
        usage: { inputTokens: 1, outputTokens: 1, estimated: false },
        data: sources
          ? {
              claims: sources.map((page) => ({
                kind: "fact",
                text: page.text,
                questionIds: ["q0"],
                citations: [{ pageId: page.pageId, quote: page.text }],
              })),
            }
          : { queries: [{ query: "基础问题", questionIds: ["q0"] }] },
      };
    },
  };
  const saver = new MemorySaver();
  let promoted: RunnableConfig | undefined;
  return {
    context,
    searched,
    read,
    saver,
    deps: {
      tools,
      checkpointer: saver,
      config: { configurable: { thread_id: randomUUID() } },
      promote: async (config: RunnableConfig) => {
        promoted = config;
      },
    },
    checkpoint: () => promoted!,
  };
}

describe("反馈只作用于后续有界计划及已验证结果", () => {
  it("实际增加深入查询，排除新发现资料并优先读取深入目标", async () => {
    const ignored = item("irrelevant", urls[0]!),
      deeper = item("deeper", urls[2]!);
    const f = fixture([ignored, deeper]);
    const result = await runResearchAgent(f.context, f.deps);
    expect(f.searched).toHaveLength(2);
    expect(f.searched[1]).toContain("详细条件");
    expect(f.read).toEqual([urls[2], urls[1]]);
    expect(result.feedbackEffects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ feedbackId: ignored.id, effect: "excluded" }),
        expect.objectContaining({ feedbackId: deeper.id, effect: "expanded_query" }),
        expect.objectContaining({ feedbackId: deeper.id, effect: "promoted" }),
      ]),
    );
    const tuple = await f.saver.getTuple(f.checkpoint());
    f.context.feedback!.items[0]!.kind = "known";
    expect(() =>
      candidateFromCheckpoint(f.context, tuple!.checkpoint.channel_values.research),
    ).toThrow("checkpoint");
  });
  it("搜索预算不足明确记录未深入，仍只执行一条基础查询", async () => {
    const deeper = item("deeper", urls[2]!);
    const f = fixture([deeper], 1);
    const result = await runResearchAgent(f.context, f.deps);
    expect(f.searched).toEqual(["基础问题"]);
    expect(result.feedbackEffects).toContainEqual(
      expect.objectContaining({ feedbackId: deeper.id, effect: "not_applied_budget" }),
    );
  });
  it("已了解只重排指纹未变的结论，重要新值及引用保持优先", () => {
    const known = item("known", urls[0]!);
    const f = fixture([known]);
    const page = { id: "p0", url: urls[0], contentHash: sha("原文未变") } as AgentPage;
    const first = {
      kind: "fact" as const,
      text: "原文未变",
      questionIds: ["q0"],
      citations: [{ pageId: "p0", quote: "原文未变" }],
    };
    const second = { ...first, text: "新材料", citations: [{ pageId: "p1", quote: "新材料" }] };
    const state = {
      queries: [],
      searches: [],
      selections: [{ url: urls[0]!, questionIds: ["q0"] }],
      pages: [page],
    };
    const reordered = explainFeedback(f.context, state, [first, second], () => true);
    expect(reordered.claims).toEqual([second, first]);
    expect(reordered.effects[0]?.effect).toBe("deprioritized");
    const important = {
      kind: "changed" as const,
      pageId: "p0",
      url: urls[0]!,
      factKey: "截止日期",
      oldValue: "15",
      newValue: "16",
      oldEvidenceIds: [randomUUID()],
      newCitations: first.citations,
      important: true,
      reason: "日期变化",
    };
    const protectedResult = explainFeedback(f.context, state, [first, second], () => true, [
      important,
    ]);
    expect(protectedResult.claims).toEqual([first, second]);
    expect(protectedResult.effects.some((effect) => effect.effect === "deprioritized")).toBe(false);
  });
  it.each(["fact", "inference", "conflict"] as const)(
    "partial混合新引用的%s不能因一条旧来源已了解而降序",
    (kind) => {
      const f = fixture([item("known", urls[0]!)]);
      const mixed = {
        kind,
        text: "旧资料及新发现的综合结论",
        questionIds: ["q0"],
        citations: [
          { pageId: "p0", quote: "原文未变" },
          { pageId: "p1", quote: "重要新条件" },
        ],
      };
      const other = {
        kind: "fact" as const,
        text: "普通资料",
        questionIds: [],
        citations: [{ pageId: "p2", quote: "普通资料" }],
      };
      const state = {
        queries: [],
        searches: [],
        selections: [],
        pages: [
          { id: "p0", url: urls[0], contentHash: sha("原文未变") },
          { id: "p1", url: urls[1], contentHash: sha("重要新条件") },
        ] as AgentPage[],
      };
      const result = explainFeedback(f.context, state, [mixed, other], () => true, []);
      expect(result.claims).toEqual([mixed, other]);
      expect(result.effects.some((effect) => effect.effect === "deprioritized")).toBe(false);
    },
  );
  it("长合法自动解释文本完整进入快照，不截断目标身份", () => {
    const userId = randomUUID(),
      taskId = randomUUID();
    const target = {
      ...item("known", urls[0]!),
      sourceId: null,
      claimId: randomUUID(),
      text: "自动双来源解释" + "值".repeat(2040),
    };
    expect(
      readFeedbackSnapshot({ schemaVersion: 1, userId, taskId, items: [target] }, userId, taskId)
        .items[0]!.text,
    ).toBe(target.text);
  });
  it("空反馈也冻结，拒绝跨owner/task或畸形快照", () => {
    const userId = randomUUID(),
      taskId = randomUUID();
    const empty = { schemaVersion: 1, userId, taskId, items: [] };
    expect(readFeedbackSnapshot(empty, userId, taskId)).toEqual(empty);
    expect(() => readFeedbackSnapshot(empty, randomUUID(), taskId)).toThrow();
    expect(() => readFeedbackSnapshot(empty, userId, randomUUID())).toThrow();
    expect(() =>
      readFeedbackSnapshot(
        { ...empty, items: [{ ...item("known", urls[0]!), claimId: randomUUID() }] },
        userId,
        taskId,
      ),
    ).toThrow();
  });
});
