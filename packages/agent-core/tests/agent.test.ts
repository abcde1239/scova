import { createHash } from "node:crypto";
import { MemorySaver } from "@langchain/langgraph";
import type { RunnableConfig } from "@langchain/core/runnables";
import { describe, expect, it, vi } from "vite-plus/test";
import type { ReadPage, SearchResponse } from "@scova/connectors";
import { deterministicPartial, runResearchAgent } from "../src/index.ts";
import type { AgentContext, AgentDependencies, AgentTools } from "../src/index.ts";

const text = "The application deadline is 15 November 2026. Other claims require more evidence.";
const url = "https://official.example/notice";
const page: ReadPage = {
  kind: "read_page",
  mode: "live",
  originalUrl: url,
  fetchedUrl: url,
  url,
  title: "Application notice",
  text,
  contentHash: createHash("sha256").update(text).digest("hex"),
  extractionVersion: "test-fixture-v1",
  collectedAt: "2026-10-26T00:00:00Z",
  truncated: false,
  untrusted: true,
};
function fixture() {
  const controller = new AbortController();
  const budget = {
    maxSearches: 10,
    maxPages: 20,
    maxDurationSeconds: 300,
    maxInputTokens: 40_000,
    maxOutputTokens: 8000,
  };
  const context: AgentContext = {
    runId: "run-1",
    userId: "owner-1",
    taskVersionId: "version-1",
    mode: "live",
    budget,
    usage: { searches: 0, pages: 0, inputTokens: 0, outputTokens: 0, estimated: false },
    deadlineAt: new Date(Date.now() + 300_000),
    signal: controller.signal,
    assertActive: vi.fn(async () => {}),
    config: {
      title: "Applications",
      topic: "Application deadline",
      goal: "When is the deadline?",
      focusPoints: [],
      exclusions: [],
      sourcePreferences: { preferredUrls: [], excludedUrls: [], officialOnly: false },
      timeRange: { kind: "rolling", days: 30 },
      timezone: "UTC",
      schedule: { frequency: "manual" },
      outputFormat: "brief",
      budget,
      notificationPreference: { mode: "off", runIssues: false },
    },
  };
  const searchResponse: SearchResponse = {
    kind: "search_results",
    mode: "live",
    provider: "searxng",
    query: "deadline",
    searchedAt: new Date().toISOString(),
    results: [
      {
        kind: "search_snippet",
        originalUrl: url,
        url,
        title: "notice",
        snippet: "Unverified search snippet",
      },
    ],
    coverage: {
      complete: true,
      gaps: [],
      unresponsiveEngines: [],
      receivedResults: 1,
      returnedResults: 1,
      discardedResults: 0,
      totalResults: 1,
      truncated: false,
    },
  };
  const tools: AgentTools = {
    search: vi.fn(async () => structuredClone(searchResponse)),
    read: vi.fn(async () => structuredClone(page)),
    model: vi.fn<AgentTools["model"]>(async (key) => ({
      mode: "live",
      usage: { inputTokens: 100, outputTokens: 100, estimated: false },
      data: key.startsWith("plan")
        ? { queries: [{ query: "Application deadline", questionIds: ["q0"] }] }
        : {
            claims: [
              {
                kind: "fact",
                text: "The application deadline is 15 November 2026.",
                questionIds: ["q0"],
                citations: [
                  { pageId: "read-0", quote: "The application deadline is 15 November 2026." },
                ],
              },
            ],
          },
    })),
  };
  const saver = new MemorySaver();
  const promote = vi.fn(async (_config: RunnableConfig) => {});
  const deps: AgentDependencies = {
    tools,
    checkpointer: saver,
    config: { configurable: { thread_id: crypto.randomUUID() } },
    promote,
  };
  return { context, deps, tools, saver, promote, controller, searchResponse };
}

describe("persistent bounded research Agent", () => {
  it.each([
    ["2026-10-25T00:00:00Z", "complete"],
    ["2026-09-01T00:00:00Z", "partial"],
    ["2026-10-27T00:00:00Z", "partial"],
    ["2026-10-25", "partial"],
  ] as const)(
    "validates source-declared publication %s against the fixed Run window",
    async (rawValue, completeness) => {
      const { context, deps, tools } = fixture();
      context.startedAt = new Date("2026-10-26T00:00:00Z");
      tools.read = vi.fn(async (): Promise<ReadPage> => ({
        ...structuredClone(page),
        publication: {
          parserVersion: "scova-publication-v1",
          status: "known",
          instant: "2026-10-25T00:00:00Z",
          observations: [{ field: "article:published_time", rawValue, locator: "meta[0]" }],
        },
      }));
      const result = await runResearchAgent(context, deps);
      expect(result.coverage.completeness).toBe(completeness);
      if (completeness === "complete") expect(result.coverage.gaps).toEqual([]);
      else expect(result.coverage.gaps.join(" ")).toMatch(/时间范围/);
    },
  );

  it("uses configured fixed time bounds and retains official-source uncertainty", async () => {
    const { context, deps, tools } = fixture();
    context.config.timeRange = {
      kind: "fixed",
      start: "2026-10-01T00:00:00Z",
      end: "2026-10-26T00:00:00Z",
    };
    context.config.sourcePreferences = {
      preferredUrls: [url],
      excludedUrls: [],
      officialOnly: true,
    };
    tools.read = vi.fn(async (): Promise<ReadPage> => ({
      ...structuredClone(page),
      publication: {
        parserVersion: "scova-publication-v1",
        status: "known",
        instant: null,
        observations: [
          {
            field: "datePublished",
            rawValue: "2026-10-25T00:00:00Z",
            locator: "jsonld[0]$.datePublished",
          },
        ],
      },
    }));
    const result = await runResearchAgent(context, deps);
    expect(result.coverage.completeness).toBe("partial");
    expect(result.coverage.gaps.join(" ")).toContain("官方身份");
    expect(result.coverage.gaps.join(" ")).not.toContain("时间范围未核验");
  });

  it("checkpoints every graph node and returns only quoted body evidence", async () => {
    const { context, deps, promote } = fixture();
    const output = await runResearchAgent(context, deps);
    expect(output.mode).toBe("live");
    expect(output.pages[0].text).toBe(text);
    expect(output.claims[0].citations[0]).toEqual({
      pageId: "read-0",
      quote: "The application deadline is 15 November 2026.",
    });
    expect(output.coverage.completeness).toBe("partial");
    expect(output.coverage.gaps.join(" ")).toContain("时间窗口尚未固定");
    expect(output.comparison).toBe("not_performed");
    expect(promote).toHaveBeenCalledTimes(9);
    expect(
      promote.mock.calls.every(([config]) => Boolean(config.configurable?.checkpoint_id)),
    ).toBe(true);
  });

  it("rejects search snippets as evidence when body retrieval fails", async () => {
    const { context, deps, tools } = fixture();
    vi.mocked(tools.read).mockRejectedValue(new Error("page not reachable"));
    await expect(runResearchAgent(context, deps)).rejects.toMatchObject({ code: "NO_EVIDENCE" });
    expect(tools.model).toHaveBeenCalledTimes(1);
  });

  it("bounds repair of fabricated page IDs or quotes, then returns labelled partial excerpts", async () => {
    const { context, deps, tools } = fixture();
    vi.mocked(tools.model).mockImplementation(async (key) => ({
      mode: "live",
      usage: { inputTokens: 1, outputTokens: 1, estimated: false },
      data:
        key === "plan-0"
          ? { queries: [{ query: "deadline", questionIds: ["q0"] }] }
          : {
              claims: [
                {
                  kind: "fact",
                  text: "invented",
                  questionIds: ["q0"],
                  citations: [{ pageId: "foreign-run", quote: "invented" }],
                },
              ],
            },
    }));
    const output = await runResearchAgent(context, deps);
    expect(tools.model).toHaveBeenCalledTimes(3);
    expect(output.coverage.completeness).toBe("partial");
    expect(output.coverage.gaps.join(" ")).toContain("引用校验失败");
    expect(output.claims[0].text).toBe(text);
  });

  it("requires paraphrased conclusions to be marked inference", async () => {
    const { context, deps, tools } = fixture();
    vi.mocked(tools.model).mockImplementation(async (key) => ({
      mode: "live",
      usage: { inputTokens: 1, outputTokens: 1, estimated: false },
      data:
        key === "plan-0"
          ? { queries: [{ query: "deadline", questionIds: ["q0"] }] }
          : {
              claims: [
                {
                  kind: "inference",
                  text: "Applying early may be prudent.",
                  questionIds: ["q0"],
                  citations: [
                    { pageId: "read-0", quote: "The application deadline is 15 November 2026." },
                  ],
                },
              ],
            },
    }));
    const output = await runResearchAgent(context, deps);
    expect(output.claims[0].kind).toBe("inference");
    expect(output.coverage.completeness).toBe("partial");
  });

  it("keeps provider failures and truncated body as coverage gaps", async () => {
    const { context, deps, tools, searchResponse } = fixture();
    searchResponse.coverage.complete = false;
    searchResponse.coverage.gaps = ["bing timeout"];
    vi.mocked(tools.read).mockResolvedValue({ ...page, truncated: true });
    const output = await runResearchAgent(context, deps);
    expect(output.coverage.completeness).toBe("partial");
    expect(output.coverage.gaps.join(" ")).toContain("bing timeout");
    expect(output.coverage.gaps.join(" ")).toContain("截断");
  });

  it("never accepts a redirected source excluded by the owner", async () => {
    const { context, deps, tools } = fixture();
    context.config.sourcePreferences.excludedUrls = ["https://excluded.example/"];
    vi.mocked(tools.read).mockResolvedValue({
      ...page,
      url: "https://excluded.example/story",
      fetchedUrl: "https://excluded.example/story",
    });
    await expect(runResearchAgent(context, deps)).rejects.toMatchObject({ code: "NO_EVIDENCE" });
  });

  it("does not let a model or ranking declare arbitrary sources official", async () => {
    const { context, deps, tools } = fixture();
    context.config.sourcePreferences.officialOnly = true;
    await expect(runResearchAgent(context, deps)).rejects.toMatchObject({ code: "NO_EVIDENCE" });
    expect(tools.read).not.toHaveBeenCalled();
  });

  it("reuses explicitly promoted graph state after a simulated restart", async () => {
    const { context, deps, tools, saver } = fixture();
    let authorized: RunnableConfig | undefined;
    let interrupted = false;
    deps.promote = async (config) => {
      authorized = config;
      const tuple = await saver.getTuple(config);
      const saved = tuple?.checkpoint.channel_values.research as { pages?: unknown[] } | undefined;
      if (!interrupted && saved?.pages?.length) {
        interrupted = true;
        throw new Error("worker exit after persistence");
      }
    };
    await expect(runResearchAgent(context, deps)).rejects.toThrow("worker exit");
    const readCalls = vi.mocked(tools.read).mock.calls.length;
    const output = await runResearchAgent(context, {
      ...deps,
      config: authorized!,
      resume: true,
      promote: async () => {},
    });
    expect(output.pages).toHaveLength(1);
    expect(tools.read).toHaveBeenCalledTimes(readCalls);
    expect(tools.search).toHaveBeenCalledTimes(1);
  });

  it("deadline resume reads only explicit checkpoint body and makes no external calls", async () => {
    const { context, deps, tools, saver } = fixture();
    let authorized: RunnableConfig | undefined;
    deps.promote = async (config) => {
      authorized = config;
      const tuple = await saver.getTuple(config);
      if ((tuple?.checkpoint.channel_values.research as { pages?: unknown[] })?.pages?.length)
        throw new Error("restart");
    };
    await expect(runResearchAgent(context, deps)).rejects.toThrow("restart");
    vi.mocked(tools.search).mockClear();
    vi.mocked(tools.read).mockClear();
    vi.mocked(tools.model).mockClear();
    context.deadlineAt = new Date(0);
    const output = await runResearchAgent(context, { ...deps, config: authorized!, resume: true });
    expect(output.coverage.exhausted).toContain("time");
    expect(output.coverage.completeness).toBe("partial");
    expect(tools.search).not.toHaveBeenCalled();
    expect(tools.read).not.toHaveBeenCalled();
    expect(tools.model).not.toHaveBeenCalled();
  });

  it("requires explicit checkpoint IDs and matching owner/run/version identity", async () => {
    const { context, deps } = fixture();
    await expect(runResearchAgent(context, { ...deps, resume: true })).rejects.toMatchObject({
      code: "INVALID_STATE",
    });
    await runResearchAgent(context, deps);
    const config = vi.mocked(deps.promote).mock.calls.at(-1)![0];
    await expect(
      runResearchAgent({ ...context, userId: "attacker" }, { ...deps, config, resume: true }),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("rejects late promotion and does not advance to the next tool", async () => {
    const { context, deps, tools } = fixture();
    deps.promote = async () => {
      throw new Error("stale epoch");
    };
    await expect(runResearchAgent(context, deps)).rejects.toThrow("stale epoch");
    expect(tools.search).not.toHaveBeenCalled();
    expect(tools.model).not.toHaveBeenCalled();
  });

  it("cancellation or lost lease never yields a candidate", async () => {
    const { context, deps, controller, tools } = fixture();
    controller.abort();
    await expect(runResearchAgent(context, deps)).rejects.toMatchObject({ code: "ABORTED" });
    expect(tools.search).not.toHaveBeenCalled();
    const second = fixture();
    second.context.assertActive = async () => {
      throw new Error("lost epoch");
    };
    await expect(runResearchAgent(second.context, second.deps)).rejects.toThrow("lost epoch");
  });

  it("delegates exhausted or unknown reservation decisions to the durable ledger", async () => {
    const { context, deps, tools } = fixture();
    context.usage.searches = context.budget.maxSearches;
    context.usage.inputTokens = context.budget.maxInputTokens;
    vi.mocked(tools.model).mockRejectedValue(new Error("durable ledger budget exceeded"));
    vi.mocked(tools.search).mockRejectedValue(new Error("durable ledger budget exceeded"));
    await expect(runResearchAgent(context, deps)).rejects.toMatchObject({ code: "NO_EVIDENCE" });
    expect(tools.model).toHaveBeenCalledTimes(1);
    expect(tools.search).toHaveBeenCalledTimes(1);
  });

  it("uses fixed demo flow without sending the demo model a live plan schema", async () => {
    const { context, deps, tools, searchResponse } = fixture();
    context.mode = "demo";
    searchResponse.mode = "demo";
    searchResponse.provider = "demo";
    vi.mocked(tools.read).mockResolvedValue({ ...page, mode: "demo" });
    const output = await runResearchAgent(context, deps);
    expect(output.mode).toBe("demo");
    expect(output.demoReason).toBeTruthy();
    expect(output.coverage.completeness).toBe("partial");
    expect(tools.model).not.toHaveBeenCalled();
  });

  it("deterministic deadline projection rejects fabricated hashes and mode mixing", () => {
    const { context } = fixture();
    expect(() =>
      deterministicPartial(context, [
        { ...page, id: "read-0", questionIds: ["q0"], contentHash: "forged" },
      ]),
    ).toThrow();
    expect(() =>
      deterministicPartial(context, [{ ...page, id: "read-0", questionIds: ["q0"], mode: "demo" }]),
    ).toThrow();
    expect(
      deterministicPartial(context, [{ ...page, id: "read-0", questionIds: ["q0"] }]).coverage
        .completeness,
    ).toBe("partial");
  });

  it("caps hostile plans and never executes suggested tools, URLs or scripts", async () => {
    const { context, deps, tools } = fixture();
    vi.mocked(tools.model).mockImplementation(async () => ({
      mode: "live",
      usage: { inputTokens: 1, outputTokens: 1, estimated: false },
      data: {
        queries: Array.from({ length: 11 }, () => ({
          query: "http://169.254.169.254/metadata",
          questionIds: ["q0"],
          tool: "execute_script",
        })),
      },
    }));
    const output = await runResearchAgent(context, deps);
    expect(tools.search).toHaveBeenCalledTimes(1);
    expect(vi.mocked(tools.search).mock.calls[0][1]).toContain(context.config.topic);
    expect(output.coverage.gaps.join(" ")).toContain("模型规划失败");
    expect(tools.model).toHaveBeenCalledTimes(3);
    expect(output.coverage.completeness).toBe("partial");
  });

  it("cannot declare all subquestions covered when the fixed search budget omits one", async () => {
    const { context, deps, tools } = fixture();
    context.config.focusPoints = ["What are the requirements?", "What documents are needed?"];
    context.budget.maxSearches = 1;
    const output = await runResearchAgent(context, deps);
    expect(tools.search).toHaveBeenCalledTimes(1);
    expect(output.coverage.gaps.join(" ")).toContain("子问题");
    expect(output.coverage.completeness).toBe("partial");
  });

  it("cancellation while a body result returns cannot promote it or create a candidate", async () => {
    const { context, deps, tools, controller } = fixture();
    vi.mocked(tools.read).mockImplementation(async () => {
      controller.abort();
      return page;
    });
    await expect(runResearchAgent(context, deps)).rejects.toMatchObject({ code: "ABORTED" });
    expect(tools.model).toHaveBeenCalledTimes(1);
  });

  it("rejects mixed demo data during live execution", async () => {
    const { context, deps, tools, searchResponse } = fixture();
    vi.mocked(tools.search).mockResolvedValue({ ...searchResponse, mode: "demo" });
    await expect(runResearchAgent(context, deps)).rejects.toMatchObject({ code: "NO_EVIDENCE" });
    expect(tools.read).not.toHaveBeenCalled();
  });

  it("revalidates saved claims rather than trusting a corrupt ready checkpoint", async () => {
    const { context, deps, saver, promote } = fixture();
    await runResearchAgent(context, deps);
    const config = promote.mock.calls.at(-1)![0];
    const tuple = (await saver.getTuple(config))!;
    const research = tuple.checkpoint.channel_values.research as {
      claims: { citations: { quote: string }[] }[];
    };
    research.claims[0].citations[0].quote = "not present in source";
    const corrupted = await saver.put(
      config,
      { ...tuple.checkpoint, id: crypto.randomUUID() },
      tuple.metadata!,
    );
    await expect(
      runResearchAgent(context, { ...deps, config: corrupted, resume: true }),
    ).rejects.toMatchObject({ code: "INVALID_OUTPUT" });
  });

  it("emits completed step events only after authorized checkpoint promotion", async () => {
    const { context, deps } = fixture();
    const calls: string[] = [];
    deps.promote = async () => {
      calls.push("promoted");
    };
    deps.onStep = async (step, phase) => {
      calls.push(`${step}:${phase}`);
    };
    await runResearchAgent(context, deps);
    expect(calls.slice(0, 3)).toEqual([
      "load_context:started",
      "promoted",
      "load_context:completed",
    ]);
    expect(calls.at(-1)).toBe("validate:completed");
  });

  it("allows the ledger to reuse last-budget search/read/model results after checkpoint loss", async () => {
    const { context, deps, tools, saver, promote } = fixture();
    context.budget.maxSearches = 1;
    context.budget.maxPages = 1;
    await runResearchAgent(context, deps);
    // Restore an earlier authorized graph checkpoint; ToolCall results may already be committed.
    const earlier = promote.mock.calls[0][0];
    context.usage = {
      searches: 1,
      pages: 1,
      inputTokens: 40_000,
      outputTokens: 8000,
      estimated: true,
    };
    const originalCaps = vi.mocked(tools.model).mock.calls[0][1];
    vi.mocked(tools.search).mockClear();
    vi.mocked(tools.read).mockClear();
    vi.mocked(tools.model).mockClear();
    const candidate = await runResearchAgent(context, {
      ...deps,
      checkpointer: saver,
      config: earlier,
      resume: true,
    });
    expect(candidate.pages).toHaveLength(1);
    expect(tools.search).toHaveBeenCalledTimes(1);
    expect(tools.read).toHaveBeenCalledTimes(1);
    expect(tools.model).toHaveBeenCalledTimes(2);
    expect(vi.mocked(tools.model).mock.calls[0][1]).toEqual(originalCaps);
  });
});
