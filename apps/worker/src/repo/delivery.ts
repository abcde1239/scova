import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  candidateFromCheckpoint,
  deterministicPartial,
  type AgentCandidate,
  type AgentContext,
} from "@scova/agent-core";
import {
  BudgetSchema,
  CoverageSchema,
  TaskConfigSchema,
  UsageSchema,
  parseContract,
} from "@scova/contracts";
import { validatePublication, type ReadPage, type SearchResponse } from "@scova/connectors";
import type { PrismaClient, Run, ToolCall } from "@scova/models";
import { appendEvent, withRunFence } from "@/repo/runs.ts";
import { RunExecutionError, RunFenceError, type RunLeaseToken } from "@/utils/runs.ts";

const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const invalid = (): never => {
  throw new RunExecutionError("INVALID_DELIVERY_EVIDENCE");
};
export interface DeliveryProof {
  candidate: AgentCandidate;
  deadline: boolean;
  checkpointRef?: unknown;
  research?: unknown;
}
function output(call: ToolCall): unknown {
  const ref = call.outputRef as { schemaVersion?: number; result?: unknown } | null;
  if (ref?.schemaVersion !== 1 || !ref.result) return invalid();
  return ref.result;
}
function contextFor(run: Run, config: AgentContext["config"]): AgentContext {
  return {
    runId: run.id,
    userId: run.userId,
    taskVersionId: run.taskVersionId,
    mode: run.mode,
    config,
    budget: parseContract(BudgetSchema, run.budgetJson),
    usage: parseContract(UsageSchema, run.usageJson),
    startedAt: run.startedAt!,
    deadlineAt: run.deadlineAt!,
    signal: new AbortController().signal,
    assertActive: async () => undefined,
  };
}
function pageBody(page: AgentCandidate["pages"][number]) {
  const { id: _id, questionIds: _questions, ...body } = page;
  return body;
}
function deadlineCandidate(context: AgentContext, calls: ToolCall[]): AgentCandidate {
  const pages = calls
    .filter((call) => call.tool === "read" && call.status === "succeeded")
    .map((call) => output(call) as ReadPage);
  if (!pages.length) throw new RunExecutionError("NO_EVIDENCE");
  const unique = [
    ...new Map(pages.map((page) => [`${page.url}:${page.contentHash}`, page])).values(),
  ];
  return deterministicPartial(
    context,
    unique.map((page) => ({
      ...page,
      id: `page-${hash(`${page.url}:${page.contentHash}`)}`,
      questionIds: [],
    })),
  );
}

/** All business writes share the Run fence; no provider/checkpointer I/O in this transaction. */
export function createDeliveryRepository(db: PrismaClient) {
  async function existing(token: RunLeaseToken) {
    const report = await db.report.findUnique({
      where: { userId_runId: { userId: token.userId, runId: token.runId } },
    });
    return report ? { reportId: report.id, reused: true } : null;
  }
  return {
    async deliver(
      token: RunLeaseToken,
      raw: DeliveryProof,
    ): Promise<{ reportId: string; reused: boolean }> {
      const already = await existing(token);
      if (already) return already;
      const proof = structuredClone(raw);
      try {
        return await withRunFence(
          db,
          token,
          proof.deadline ? "deadline_delivery" : "work",
          async (tx, run, now) => {
            if (proof.deadline && (!run.deadlineAt || run.deadlineAt > now)) invalid();
            const version = await tx.taskVersion.findFirst({
              where: { id: run.taskVersionId, userId: run.userId, taskId: run.taskId },
            });
            if (!version) return invalid();
            const config = parseContract(TaskConfigSchema, version.configJson);
            const context = contextFor(run, config);
            const calls = await tx.toolCall.findMany({
              where: { userId: run.userId, runId: run.id },
              orderBy: [{ operationKey: "asc" }, { attemptNo: "asc" }],
            });
            const successful = calls.filter(
              (call) =>
                call.status === "succeeded" &&
                call.finishedAt &&
                call.finishedAt <= run.deadlineAt!,
            );
            let candidate: AgentCandidate;
            try {
              if (proof.deadline) candidate = deadlineCandidate(context, successful);
              else {
                if (
                  !run.checkpointRef ||
                  !isDeepStrictEqual(run.checkpointRef, proof.checkpointRef)
                )
                  invalid();
                candidate = candidateFromCheckpoint(context, proof.research);
              }
            } catch (error) {
              if (error instanceof RunExecutionError) throw error;
              return invalid();
            }
            // A caller cannot replace claims, quotes, source metadata or coverage after validation.
            // demoReason belongs to the explicit runtime configuration rather than graph state.
            const supplied = structuredClone(proof.candidate);
            if (run.mode === "demo") {
              if (typeof supplied.demoReason !== "string" || !supplied.demoReason.trim()) invalid();
              candidate.demoReason = supplied.demoReason;
            }
            // Deadline coverage is rebuilt from committed usage/evidence; local counters can
            // lag a just-committed settlement while the graph is being interrupted.
            if (proof.deadline) supplied.coverage = candidate.coverage;
            if (!isDeepStrictEqual(supplied, candidate)) invalid();
            if (!candidate.pages.length || !candidate.claims.length)
              throw new RunExecutionError("NO_EVIDENCE");
            for (const page of candidate.pages) {
              if (
                typeof page.title !== "string" ||
                page.title.length > 2000 ||
                !Number.isFinite(Date.parse(page.collectedAt)) ||
                new Date(page.collectedAt) > run.deadlineAt! ||
                typeof page.extractionVersion !== "string" ||
                !page.extractionVersion ||
                typeof page.truncated !== "boolean" ||
                page.untrusted !== true
              )
                invalid();
              if (
                !successful.some(
                  (call) => call.tool === "read" && isDeepStrictEqual(output(call), pageBody(page)),
                )
              )
                invalid();
            }
            const gaps = [...candidate.coverage.gaps];
            // These checks are independent of a model/caller's completeness flag.
            if (candidate.pages.some((page) => page.truncated))
              gaps.push("存在已截断正文，无法保证完整查阅");
            if (calls.some((call) => call.status !== "succeeded"))
              gaps.push("存在失败或结果未确认的工具调用");
            if (!proof.deadline) {
              const state = proof.research as {
                queries: { query: string; questionIds: string[] }[];
                searches: { query: { query: string }; response: unknown }[];
                selections: { url: string; questionIds: string[] }[];
              };
              if (!state.queries.length || !state.searches.length) gaps.push("搜索计划未完成");
              for (const search of state.searches)
                if (
                  !successful.some(
                    (call) =>
                      call.tool === "search" && isDeepStrictEqual(output(call), search.response),
                  )
                )
                  invalid();
              for (const query of state.queries)
                if (!state.searches.some((entry) => entry.query.query === query.query))
                  gaps.push("部分计划查询未取得成功结果");
              for (const [index, selection] of state.selections.entries())
                if (
                  !candidate.pages.some(
                    (page) =>
                      page.id === `read-${index}` &&
                      page.originalUrl === selection.url &&
                      isDeepStrictEqual(page.questionIds, selection.questionIds),
                  )
                )
                  gaps.push("部分计划来源未完成正文采集");
              for (const page of candidate.pages) {
                const index = Number(page.id.replace(/^read-/, ""));
                const selection = state.selections[index];
                if (
                  !selection ||
                  page.originalUrl !== selection.url ||
                  !isDeepStrictEqual(page.questionIds, selection.questionIds)
                )
                  invalid();
              }
            }
            // Publication coverage is recomputed by candidateFromCheckpoint from page-authored facts.
            // The current source policy still cannot certify official identity.
            if (config.sourcePreferences.officialOnly)
              gaps.push("来源已按用户指定范围筛选，官方身份尚需独立核验");
            if (run.mode === "demo")
              gaps.push("本次执行为固定演示资料，未验证互联网事实", candidate.demoReason!);
            candidate.coverage = parseContract(CoverageSchema, {
              ...candidate.coverage,
              gaps: [...new Set(gaps)],
              completeness: gaps.length || proof.deadline ? "partial" : "complete",
            });
            // One observation per canonical source. Do not silently attach a quote to another version.
            const byUrl = new Map<string, string>();
            const pageRecords = new Map<
              string,
              { snapshotId: string; text: string; extractor: string }
            >();
            for (const page of candidate.pages) {
              const publication = validatePublication(page.publication);
              const priorHash = byUrl.get(page.url);
              const fingerprint = `${page.contentHash}:${page.extractionVersion}`;
              if (priorHash && priorHash !== fingerprint) invalid();
              byUrl.set(page.url, fingerprint);
              const source = await tx.source.upsert({
                where: {
                  userId_canonicalUrlHash: { userId: run.userId, canonicalUrlHash: hash(page.url) },
                },
                create: {
                  userId: run.userId,
                  canonicalUrl: page.url,
                  canonicalUrlHash: hash(page.url),
                },
                update: {},
              });
              if (source.canonicalUrl !== page.url) invalid();
              const snapshot = await tx.sourceSnapshot.upsert({
                where: {
                  userId_sourceId_extractorVersion_contentHash: {
                    userId: run.userId,
                    sourceId: source.id,
                    extractorVersion: page.extractionVersion,
                    contentHash: page.contentHash,
                  },
                },
                create: {
                  userId: run.userId,
                  sourceId: source.id,
                  contentHash: page.contentHash,
                  extractorVersion: page.extractionVersion,
                  title: page.title || page.url,
                  publishedAt:
                    publication.status === "known" ? new Date(publication.instant!) : null,
                  textBody: page.text,
                  textExpiresAt: new Date(now.getTime() + 30 * 86400_000),
                  metadataJson: {
                    mode: run.mode,
                    originalUrl: page.originalUrl,
                    fetchedUrl: page.fetchedUrl,
                    collectedAt: page.collectedAt,
                    truncated: page.truncated,
                    untrusted: true,
                  },
                },
                update: {},
              });
              if (snapshot.textBody !== null && snapshot.textBody !== page.text) invalid();
              if ((snapshot.metadataJson as { mode?: string }).mode !== run.mode) invalid();
              await tx.runSource.upsert({
                where: { runId_sourceId: { runId: run.id, sourceId: source.id } },
                create: {
                  userId: run.userId,
                  runId: run.id,
                  sourceId: source.id,
                  snapshotId: snapshot.id,
                  requestedUrl: page.originalUrl,
                  fetchedUrl: page.fetchedUrl,
                  observedAt: new Date(page.collectedAt),
                  fetchStatus: "succeeded",
                  metadataJson: {
                    truncated: page.truncated,
                    collectedAt: page.collectedAt,
                    mode: page.mode,
                    publication: page.publication ? { ...page.publication, ...publication } : null,
                    searchOrigins: successful
                      .filter((call) => call.tool === "search")
                      .flatMap((call) => {
                        const response = output(call) as SearchResponse;
                        return response.results
                          .filter(
                            (result) =>
                              result.originalUrl === page.originalUrl || result.url === page.url,
                          )
                          .map((result) => ({
                            kind: "search_snippet",
                            query: response.query,
                            originalUrl: result.originalUrl,
                            url: result.url,
                            engines: result.engines ?? [],
                          }));
                      }),
                  },
                },
                update: {},
              });
              pageRecords.set(page.id, {
                snapshotId: snapshot.id,
                text: page.text,
                extractor: page.extractionVersion,
              });
            }
            const baseline = await tx.baseline.findUnique({
              where: {
                userId_taskId_comparisonScopeHash: {
                  userId: run.userId,
                  taskId: run.taskId,
                  comparisonScopeHash: run.comparisonScopeHash,
                },
              },
            });
            if (baseline && candidate.comparison === "not_performed") {
              candidate.coverage = parseContract(CoverageSchema, {
                ...candidate.coverage,
                completeness: "partial",
                gaps: [
                  ...new Set([...candidate.coverage.gaps, "连续比较尚未执行，不能推进已有基线"]),
                ],
              });
            }
            const complete = candidate.coverage.completeness === "complete";
            const outcome = complete && !baseline ? "baseline" : "inconclusive";
            const report = await tx.report.create({
              data: {
                userId: run.userId,
                runId: run.id,
                taskId: run.taskId,
                taskVersionId: run.taskVersionId,
                baselineRunId: candidate.comparison === "not_performed" ? null : run.baselineRunId,
                title: candidate.title,
                summary: candidate.claims.map((claim) => claim.text).join("\n\n"),
                format: config.outputFormat,
                completeness: candidate.coverage.completeness,
                limitationsJson: candidate.coverage.gaps,
              },
            });
            const evidence = new Map<string, string>();
            for (const [order, item] of candidate.claims.entries()) {
              const claim = await tx.claim.create({
                data: {
                  userId: run.userId,
                  taskId: run.taskId,
                  reportId: report.id,
                  kind: item.kind,
                  text: item.text,
                  order,
                  confidenceLabel: {
                    fact: "采集原文事实",
                    inference: "基于来源的推断",
                    conflict: "来源存在冲突，待核验",
                    insufficient: "证据不足",
                  }[item.kind],
                },
              });
              for (const [index, citation] of item.citations.entries()) {
                const page = pageRecords.get(citation.pageId);
                if (!page) return invalid();
                const start = page.text.indexOf(citation.quote);
                if (
                  start < 0 ||
                  !citation.quote.trim() ||
                  hash(page.text.slice(start, start + citation.quote.length)) !==
                    hash(citation.quote)
                )
                  invalid();
                const key = `${page.snapshotId}:${hash(citation.quote)}`;
                let evidenceId = evidence.get(key);
                if (!evidenceId) {
                  const record = await tx.evidence.create({
                    data: {
                      userId: run.userId,
                      runId: run.id,
                      snapshotId: page.snapshotId,
                      quote: citation.quote,
                      quoteHash: hash(citation.quote),
                      selectorJson: {
                        type: "text_offset",
                        start,
                        end: start + citation.quote.length,
                        extractorVersion: page.extractor,
                      },
                      capturedAt: now,
                    },
                  });
                  evidenceId = record.id;
                  evidence.set(key, evidenceId);
                }
                await tx.claimEvidence.upsert({
                  where: { claimId_evidenceId: { claimId: claim.id, evidenceId } },
                  create: {
                    userId: run.userId,
                    claimId: claim.id,
                    evidenceId,
                    relation: item.kind === "conflict" && index > 0 ? "contradicts" : "supports",
                  },
                  update: {},
                });
              }
            }
            if (!evidence.size) throw new RunExecutionError("NO_EVIDENCE");
            await tx.inboxItem.create({ data: { userId: run.userId, reportId: report.id } });
            await tx.toolCall.updateMany({
              where: { userId: run.userId, runId: run.id, status: { in: ["reserved", "running"] } },
              data: { status: "unknown", finishedAt: now },
            });
            await tx.run.update({
              where: { id: run.id },
              data: {
                status: complete ? "succeeded" : "partial",
                outcome,
                coverageJson: candidate.coverage,
                finishedAt: now,
                failureCode: null,
                leaseOwner: null,
                leaseExpiresAt: null,
              },
            });
            if (complete)
              await tx.baseline.upsert({
                where: {
                  userId_taskId_comparisonScopeHash: {
                    userId: run.userId,
                    taskId: run.taskId,
                    comparisonScopeHash: run.comparisonScopeHash,
                  },
                },
                create: {
                  userId: run.userId,
                  taskId: run.taskId,
                  comparisonScopeHash: run.comparisonScopeHash,
                  completeRunId: run.id,
                },
                update: { completeRunId: run.id },
              });
            await appendEvent(tx, run, now, {
              type: "coverage.updated",
              payload: candidate.coverage,
            });
            await appendEvent(tx, run, now, {
              type: "report.published",
              payload: { reportId: report.id, completeness: candidate.coverage.completeness },
            });
            await appendEvent(tx, run, now, {
              type: "run.completed",
              payload: complete
                ? { status: "succeeded", outcome, reportId: report.id }
                : { status: "partial", outcome: "inconclusive", reportId: report.id },
            });
            return { reportId: report.id, reused: false };
          },
        );
      } catch (error) {
        if (error instanceof RunFenceError) {
          const committed = await existing(token);
          if (committed) return committed;
        }
        throw error;
      }
    },
  };
}
