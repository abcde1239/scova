import { createHash } from "node:crypto";
import { effectiveRunScopeHash } from "@scova/utils";
import type { Run as StoredRun, RunEvent as StoredRunEvent } from "@scova/models";
import {
  PageQuerySchema,
  RunListResponseSchema,
  RunCommandInputSchema,
  RunEventSchema,
  RunSchema,
  TaskConfigSchema,
  parseContract,
  type RunCommandInput,
  type TaskConfig,
} from "@scova/contracts";
import type { ApiServices } from "@/app/context.ts";
import { ApiError } from "@/utils/errors.ts";
import { createRunRepo } from "@/repo/runs.ts";
import { comparisonScopeHash } from "@/service/tasks.ts";
import { ownedTask } from "@/service/tasks.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const ACTIVE = ["queued", "running", "recovering", "cancel_requested"] as const;
const usage = { searches: 0, pages: 0, inputTokens: 0, outputTokens: 0, estimated: true };

export function toRun(run: StoredRun) {
  return parseContract(RunSchema, {
    id: run.id,
    taskId: run.taskId,
    taskVersionId: run.taskVersionId,
    parentRunId: run.parentRunId,
    baselineRunId: run.baselineRunId,
    mode: run.mode,
    status: run.status,
    outcome: run.outcome,
    trigger: run.trigger,
    budget: run.budgetJson,
    usage: run.usageJson,
    coverage: run.coverageJson,
    queuedAt: run.queuedAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
    failureCode: run.failureCode,
  });
}

function eventDto(event: StoredRunEvent) {
  return parseContract(RunEventSchema, {
    schemaVersion: event.schemaVersion,
    eventId: event.id,
    runId: event.runId,
    seq: event.seq,
    occurredAt: event.occurredAt.toISOString(),
    type: event.type,
    payload: event.payload,
  });
}

function commandBody(input: RunCommandInput | undefined) {
  const parsed = parseContract(RunCommandInputSchema, input ?? {});
  return { mode: parsed.mode ?? "demo" } as const;
}

/** Run 业务规则与事务编排；不包含请求对象、Elysia 或 Prisma 查询。 */
export function createRunService(services: ApiServices) {
  const repo = createRunRepo(services);

  async function requireRun(userId: string, runId: string) {
    if (!UUID.test(runId)) throw new ApiError(404, "NOT_FOUND", "资源不存在");
    const run = await repo.findRun(runId, userId);
    if (!run) throw new ApiError(404, "NOT_FOUND", "资源不存在");
    return run;
  }

  async function createRun(
    taskId: string,
    userId: string,
    input: RunCommandInput | undefined,
    idempotencyKey: string,
    parentRunId: string | null = null,
    taskVersionId?: string,
    followup?: { questionId: string; reportRunId: string },
    inheritedConfig?: TaskConfig,
    inheritedScope?: string,
  ) {
    if (!UUID.test(taskId)) throw new ApiError(404, "NOT_FOUND", "资源不存在");
    const command = commandBody(input);
    const scope = followup
      ? `question:${followup.questionId}:followup`
      : `run:${taskId}:${parentRunId ? "retry" : "create"}`;
    const keyHash = sha256(idempotencyKey);
    const payloadHash = sha256(
      JSON.stringify({
        taskId,
        parentRunId,
        ...command,
        ...(followup ? { questionId: followup.questionId } : {}),
      }),
    );
    try {
      return await repo.transaction(async (store) => {
        // 所有启动命令先锁定同一任务，串行决定幂等重放、活动复用及配置快照。
        if (!(await store.lockTask(taskId, userId)).length)
          throw new ApiError(404, "NOT_FOUND", "资源不存在");
        const existing = await store.findIdempotency(userId, scope, keyHash);
        if (existing) {
          if (existing.payloadHash !== payloadHash)
            throw new ApiError(
              409,
              "IDEMPOTENCY_PAYLOAD_MISMATCH",
              "同一幂等键不能提交不同执行参数",
            );
          if (!existing.resourceId)
            throw new ApiError(409, "IDEMPOTENCY_PENDING", "相同执行命令仍在处理中，请稍后重试");
          const reused = await store.findRun(existing.resourceId, userId);
          if (!reused)
            throw new ApiError(409, "IDEMPOTENCY_PENDING", "执行命令记录正在恢复，请稍后重试");
          return { run: reused, reused: true };
        }
        const question = followup
          ? await store.findQuestion(followup.questionId, userId, followup.reportRunId)
          : null;
        if (followup && (!question || !question.answerJson))
          throw new ApiError(404, "NOT_FOUND", "问题不存在或尚未完成");
        if (question?.followupRunId) {
          const linked = await store.findRun(question.followupRunId, userId);
          if (!linked) throw new ApiError(409, "FOLLOWUP_UNAVAILABLE", "后续执行不可用");
          return { run: linked, reused: true };
        }
        const task = await ownedTask(taskId, userId, store);
        if (task.status === "archived")
          throw new ApiError(409, "TASK_ARCHIVED", "已归档任务不能启动新执行");
        const version = await store.findVersion(
          taskVersionId ?? task.currentVersionId!,
          userId,
          task.id,
        );
        if (!version) throw new ApiError(409, "TASK_VERSION_MISSING", "任务配置版本不可用");
        const baseConfig = parseContract(TaskConfigSchema, inheritedConfig ?? version.configJson);
        const config = question
          ? parseContract(TaskConfigSchema, {
              ...baseConfig,
              goal: question.question,
              focusPoints: [],
              schedule: { frequency: "manual" },
            })
          : baseConfig;
        const idempotency = await store.createIdempotency({
          userId,
          scope,
          keyHash,
          payloadHash,
          expiresAt: new Date(services.clock().getTime() + 24 * 60 * 60 * 1000),
        });
        const active = await store.findActiveRun(task.id, userId);
        if (active) {
          if (followup)
            throw new ApiError(
              409,
              "RUN_ALREADY_ACTIVE",
              "该任务已有活动执行，请结束后再确认后续研究",
            );
          await store.completeIdempotency(idempotency.id, active.id);
          return { run: active, reused: true };
        }
        const run = await store.createRun({
          userId,
          taskId: task.id,
          taskVersionId: version.id,
          comparisonScopeHash:
            inheritedScope ??
            effectiveRunScopeHash(
              question
                ? sha256(
                    JSON.stringify({
                      namespace: "question-followup-v1",
                      questionId: question.id,
                      scope: comparisonScopeHash(config),
                    }),
                  )
                : version.comparisonScopeHash,
              command.mode,
            ),
          mode: command.mode,
          trigger: followup ? "followup" : parentRunId ? "retry" : "manual",
          ...(question || inheritedConfig ? { followupConfigJson: config } : {}),
          parentRunId,
          budgetJson: config.budget,
          feedbackSnapshotJson: await store.feedbackSnapshot(userId, task.id),
          usageJson: usage,
        });
        const queued = eventDto(
          await store.createEvent({
            userId,
            runId: run.id,
            seq: 1,
            type: "run.queued",
            payload: { status: "queued", taskVersionId: version.id },
          }),
        );
        await store.createOutbox({
          userId,
          aggregateId: run.id,
          eventType: "run.enqueue",
          dedupeKey: `run-${run.id}-enqueue`,
          payload: {
            runId: run.id,
            taskId: task.id,
            taskVersionId: version.id,
            mode: command.mode,
          },
        });
        if (question) {
          const linked = await store.linkQuestion(question.id, userId, run.id);
          if (linked.count !== 1)
            throw new ApiError(409, "FOLLOWUP_ALREADY_LINKED", "问题已有关联执行");
        }
        await store.completeIdempotency(idempotency.id, run.id);
        return { run, reused: false, queued };
      });
    } catch (error) {
      if (!repo.isUniqueConflict(error)) throw error;
      const existing = await repo.findIdempotency(userId, scope, keyHash);
      if (existing?.payloadHash === payloadHash && existing.resourceId) {
        const reused = await repo.requireRun(existing.resourceId, userId);
        return { run: reused, reused: true };
      }
      throw new ApiError(409, "RUN_ALREADY_ACTIVE", "该任务已有未终结执行，请等待完成后再试");
    }
  }

  return {
    async list(userId: string, taskId: string, input: unknown) {
      await ownedTask(taskId, userId, repo);
      const query = parseContract(PageQuerySchema, input),
        scope = `runs:${taskId}`;
      let cursorId: string | undefined;
      if (query.cursor) {
        try {
          const cursor = JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8"));
          if (!UUID.test(cursor.id) || cursor.scope !== scope || typeof cursor.time !== "string")
            throw new Error();
          const anchor = await repo.findRun(cursor.id, userId);
          if (!anchor || anchor.taskId !== taskId || anchor.queuedAt.toISOString() !== cursor.time)
            throw new Error();
          cursorId = cursor.id;
        } catch {
          throw new ApiError(400, "INVALID_CURSOR", "执行历史游标无效或与任务不一致");
        }
      }
      const limit = Math.min(query.limit ?? 50, 100),
        rows = await repo.listRuns(userId, taskId, limit + 1, cursorId),
        page = rows.slice(0, limit),
        last = page.at(-1);
      return parseContract(RunListResponseSchema, {
        items: page.map(toRun),
        nextCursor:
          rows.length > limit && last
            ? Buffer.from(
                JSON.stringify({ id: last.id, time: last.queuedAt.toISOString(), scope }),
              ).toString("base64url")
            : null,
      });
    },
    async create(userId: string, taskId: string, input: RunCommandInput | undefined, key: string) {
      const result = await createRun(taskId, userId, input, key);
      return { run: toRun(result.run), reused: result.reused };
    },
    async followup(userId: string, reportRunId: string, questionId: string, key: string) {
      const parent = await requireRun(userId, reportRunId);
      const result = await createRun(
        parent.taskId,
        userId,
        { mode: parent.mode },
        key,
        parent.id,
        parent.taskVersionId,
        { questionId, reportRunId },
      );
      return { run: toRun(result.run), reused: result.reused };
    },
    async get(userId: string, runId: string) {
      return toRun(await requireRun(userId, runId));
    },
    async cancel(userId: string, runId: string) {
      if (!UUID.test(runId)) throw new ApiError(404, "NOT_FOUND", "资源不存在");
      const result = await repo.transaction(async (store) => {
        await store.lockRun(runId, userId);
        const run = await store.findRun(runId, userId);
        if (!run) throw new ApiError(404, "NOT_FOUND", "资源不存在");
        if (
          run.status === "cancel_requested" ||
          !ACTIVE.includes(run.status as (typeof ACTIVE)[number])
        )
          return { run, reused: true };
        const updated = await store.requestCancel(run.id, services.clock());
        await store.createOutbox({
          userId,
          aggregateId: run.id,
          eventType: "run.cancel_requested",
          dedupeKey: `run-${run.id}-cancel`,
          payload: { runId: run.id },
        });
        return { run: updated, reused: false };
      });
      return { run: toRun(result.run), reused: result.reused };
    },
    async retry(userId: string, runId: string, input: RunCommandInput | undefined, key: string) {
      const old = await requireRun(userId, runId);
      if (!(old.status === "failed" || old.status === "canceled"))
        throw new ApiError(409, "RUN_NOT_RETRYABLE", "当前执行状态不允许重试");
      const result = await createRun(
        old.taskId,
        userId,
        input,
        key,
        old.id,
        old.taskVersionId,
        undefined,
        old.followupConfigJson
          ? parseContract(TaskConfigSchema, old.followupConfigJson)
          : undefined,
        old.followupConfigJson
          ? old.mode === commandBody(input).mode
            ? old.comparisonScopeHash
            : sha256(
                JSON.stringify({
                  namespace: "question-followup-mode-v1",
                  previous: old.comparisonScopeHash,
                  mode: commandBody(input).mode,
                }),
              )
          : undefined,
      );
      return { run: toRun(result.run), reused: result.reused };
    },
  };
}
