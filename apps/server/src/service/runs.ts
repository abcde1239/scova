import { createHash } from "node:crypto";
import type { Run as StoredRun, RunEvent as StoredRunEvent } from "@scova/models";
import {
  RunCommandInputSchema,
  RunEventSchema,
  RunSchema,
  TaskConfigSchema,
  parseContract,
  type RunCommandInput,
} from "@scova/contracts";
import type { ApiServices } from "@/app/context.ts";
import { ApiError } from "@/utils/errors.ts";
import { createRunRepo } from "@/repo/runs.ts";
import { ownedTask } from "@/service/tasks.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const ACTIVE = ["queued", "running", "recovering", "cancel_requested"] as const;
const usage = { searches: 0, pages: 0, inputTokens: 0, outputTokens: 0, estimated: true };

function toRun(run: StoredRun) {
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
  ) {
    if (!UUID.test(taskId)) throw new ApiError(404, "NOT_FOUND", "资源不存在");
    const command = commandBody(input);
    const scope = `run:${taskId}:${parentRunId ? "retry" : "create"}`;
    const keyHash = sha256(idempotencyKey);
    const payloadHash = sha256(JSON.stringify({ taskId, parentRunId, ...command }));
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
        const task = await ownedTask(taskId, userId, store);
        const version = await store.findVersion(
          taskVersionId ?? task.currentVersionId!,
          userId,
          task.id,
        );
        if (!version) throw new ApiError(409, "TASK_VERSION_MISSING", "任务配置版本不可用");
        const config = parseContract(TaskConfigSchema, version.configJson);
        const idempotency = await store.createIdempotency({
          userId,
          scope,
          keyHash,
          payloadHash,
          expiresAt: new Date(services.clock().getTime() + 24 * 60 * 60 * 1000),
        });
        const active = await store.findActiveRun(task.id, userId);
        if (active) {
          await store.completeIdempotency(idempotency.id, active.id);
          return { run: active, reused: true };
        }
        const run = await store.createRun({
          userId,
          taskId: task.id,
          taskVersionId: version.id,
          comparisonScopeHash: sha256(
            JSON.stringify(["run-scope-v1", version.comparisonScopeHash, command.mode]),
          ),
          mode: command.mode,
          trigger: parentRunId ? "retry" : "manual",
          parentRunId,
          budgetJson: config.budget,
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
    async create(userId: string, taskId: string, input: RunCommandInput | undefined, key: string) {
      const result = await createRun(taskId, userId, input, key);
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
      const result = await createRun(old.taskId, userId, input, key, old.id, old.taskVersionId);
      return { run: toRun(result.run), reused: result.reused };
    },
    async events(userId: string, runId: string, after: number, lastEventId: string | null) {
      const run = await requireRun(userId, runId);
      if (lastEventId) {
        const last = await repo.findEvent(lastEventId, run.id, userId);
        if (last) after = Math.max(after, last.seq);
      }
      if (!Number.isSafeInteger(after) || after < 0)
        throw new ApiError(400, "INVALID_EVENT_CURSOR", "事件游标无效");
      const events = await repo.listEvents(run.id, userId, after);
      return events.map(eventDto);
    },
  };
}
