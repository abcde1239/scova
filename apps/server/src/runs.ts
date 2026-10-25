import { createHash } from "node:crypto";
import { Prisma, type Run as StoredRun, type RunEvent as StoredRunEvent } from "@prisma/client";
import { Elysia, t } from "elysia";
import {
  ApiErrorSchema,
  EventCursorHeadersSchema,
  EventCursorQuerySchema,
  IdempotencyHeadersSchema,
  RunCommandInputSchema,
  RunCommandResponseSchema,
  RunEventSchema,
  RunSchema,
  TaskConfigSchema,
  parseContract,
  type RunCommandInput,
} from "@scova/contracts";
import type { ApiServices } from "./services.ts";
import { ApiError } from "./errors.ts";
import { requireCsrf, requireSession } from "./auth.ts";
import { ownedTask } from "./tasks.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const ACTIVE = ["queued", "running", "recovering", "cancel_requested"] as const;
const usage = { searches: 0, pages: 0, inputTokens: 0, outputTokens: 0, estimated: true };
const OptionalIdempotencyHeadersSchema = t.Object(
  {
    "idempotency-key": t.Optional(
      t.String({
        minLength: 16,
        maxLength: 128,
        pattern: "^[A-Za-z0-9._-]+$",
        description: "重试同一命令时保持稳定的幂等键",
      }),
    ),
  },
  { additionalProperties: true, description: "执行命令幂等请求头；缺失时返回 428" },
);

function jsonHash(value: unknown): string {
  return sha256(JSON.stringify(value));
}

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

export function createRunPlugin(services: ApiServices) {
  const errors = {
    400: ApiErrorSchema,
    401: ApiErrorSchema,
    403: ApiErrorSchema,
    404: ApiErrorSchema,
    409: ApiErrorSchema,
    422: ApiErrorSchema,
    428: ApiErrorSchema,
  } as const;
  const models = {
    Run: RunSchema,
    RunCommandInput: RunCommandInputSchema,
    RunCommandResponse: RunCommandResponseSchema,
    IdempotencyHeaders: IdempotencyHeadersSchema,
    EventCursorQuery: EventCursorQuerySchema,
    EventCursorHeaders: EventCursorHeadersSchema,
  };

  async function createRun(
    taskId: string,
    userId: string,
    input: RunCommandInput | undefined,
    idempotencyKey: string,
    servicesForTransaction: ApiServices,
    parentRunId: string | null = null,
  ) {
    const command = commandBody(input);
    const scope = `run:${taskId}:${parentRunId ? "retry" : "create"}`;
    const keyHash = sha256(idempotencyKey);
    const payloadHash = jsonHash({ taskId, parentRunId, ...command });
    try {
      return await servicesForTransaction.db().$transaction(async (database) => {
        const existing = await database.idempotencyRecord.findUnique({
          where: { userId_scope_keyHash: { userId, scope, keyHash } },
        });
        if (existing) {
          if (existing.payloadHash !== payloadHash)
            throw new ApiError(
              409,
              "IDEMPOTENCY_PAYLOAD_MISMATCH",
              "同一幂等键不能提交不同执行参数",
            );
          if (!existing.resourceId)
            throw new ApiError(409, "IDEMPOTENCY_PENDING", "相同执行命令仍在处理中，请稍后重试");
          const reused = await database.run.findFirst({
            where: { id: existing.resourceId, userId },
          });
          if (!reused)
            throw new ApiError(409, "IDEMPOTENCY_PENDING", "执行命令记录正在恢复，请稍后重试");
          return { run: reused, reused: true };
        }
        const task = await ownedTask(taskId, { userId }, servicesForTransaction, database);
        const version = await database.taskVersion.findFirst({
          where: { id: task.currentVersionId!, userId, taskId: task.id },
        });
        if (!version) throw new ApiError(409, "TASK_VERSION_MISSING", "任务配置版本不可用");
        const config = parseContract(TaskConfigSchema, version.configJson);
        const idempotency = await database.idempotencyRecord.create({
          data: {
            userId,
            scope,
            keyHash,
            payloadHash,
            expiresAt: new Date(servicesForTransaction.clock().getTime() + 24 * 60 * 60 * 1000),
          },
        });
        void idempotency;
        const run = await database.run.create({
          data: {
            userId,
            taskId: task.id,
            taskVersionId: version.id,
            comparisonScopeHash: version.comparisonScopeHash,
            mode: command.mode,
            trigger: parentRunId ? "retry" : "manual",
            parentRunId,
            budgetJson: config.budget,
            usageJson: usage,
          },
        });
        const queued = eventDto(
          await database.runEvent.create({
            data: {
              userId,
              runId: run.id,
              seq: 1,
              type: "run.queued",
              payload: { status: "queued", taskVersionId: version.id },
            },
          }),
        );
        await database.outbox.create({
          data: {
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
          },
        });
        await database.idempotencyRecord.update({
          where: { id: idempotency.id },
          data: { status: "completed", responseCode: 202, resourceId: run.id },
        });
        return { run, reused: false, queued };
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002")
        throw error;
      const existing = await servicesForTransaction.db().idempotencyRecord.findUnique({
        where: { userId_scope_keyHash: { userId, scope, keyHash } },
      });
      if (existing?.payloadHash === payloadHash && existing.resourceId) {
        const reused = await servicesForTransaction
          .db()
          .run.findFirstOrThrow({ where: { id: existing.resourceId, userId } });
        return { run: reused, reused: true };
      }
      throw new ApiError(409, "RUN_ALREADY_ACTIVE", "该任务已有未终结执行，请等待完成后再试");
    }
  }

  return new Elysia({ name: "scova-runs", prefix: "/api/v1", normalize: false })
    .model(models)
    .post(
      "/tasks/:taskId/runs",
      async ({ params, body, request, set }) => {
        const session = await requireSession(request, services);
        requireCsrf(request, session, services);
        const key = request.headers.get("idempotency-key");
        if (!key)
          throw new ApiError(428, "IDEMPOTENCY_REQUIRED", "启动执行必须携带 Idempotency-Key");
        const result = await createRun(params.taskId, session.userId, body, key, services);
        set.status = 202;
        set.headers.location = `/api/v1/runs/${result.run.id}`;
        return { run: toRun(result.run), reused: result.reused };
      },
      {
        body: "RunCommandInput",
        headers: OptionalIdempotencyHeadersSchema,
        response: { 202: RunCommandResponseSchema, ...errors },
        detail: {
          operationId: "createRun",
          tags: ["执行"],
          summary: "启动查阅执行",
          description:
            "固定当前任务配置版本，在同一事务写入执行、首个事件和 Outbox；重复幂等命令返回原执行。",
        },
      },
    )
    .get(
      "/runs/:runId",
      async ({ params, request, set }) => {
        const session = await requireSession(request, services);
        if (!UUID.test(params.runId)) throw new ApiError(404, "NOT_FOUND", "资源不存在");
        const run = await services
          .db()
          .run.findFirst({ where: { id: params.runId, userId: session.userId } });
        if (!run) throw new ApiError(404, "NOT_FOUND", "资源不存在");
        set.headers.etag = `"${run.id}:${run.status}"`;
        return toRun(run);
      },
      {
        response: { 200: RunSchema, ...errors },
        detail: {
          operationId: "getRun",
          tags: ["执行"],
          summary: "查看执行详情",
          description: "返回当前账号拥有的执行公共快照，不暴露租约、checkpoint 或数据库内部字段。",
        },
      },
    )
    .post(
      "/runs/:runId/cancel",
      async ({ params, request }) => {
        const session = await requireSession(request, services);
        requireCsrf(request, session, services);
        if (!UUID.test(params.runId)) throw new ApiError(404, "NOT_FOUND", "资源不存在");
        const result = await services.db().$transaction(async (database) => {
          const run = await database.run.findFirst({
            where: { id: params.runId, userId: session.userId },
          });
          if (!run) throw new ApiError(404, "NOT_FOUND", "资源不存在");
          if (!ACTIVE.includes(run.status as (typeof ACTIVE)[number])) return { run, reused: true };
          const updated = await database.run.update({
            where: { id: run.id },
            data: { status: "cancel_requested", cancelRequestedAt: services.clock() },
          });
          await database.outbox.create({
            data: {
              userId: session.userId,
              aggregateId: run.id,
              eventType: "run.cancel_requested",
              dedupeKey: `run-${run.id}-cancel-${run.cancelRequestedAt?.getTime() ?? services.clock().getTime()}`,
              payload: { runId: run.id },
            },
          });
          return { run: updated, reused: false };
        });
        return { run: toRun(result.run), reused: result.reused };
      },
      {
        response: { 200: RunCommandResponseSchema, ...errors },
        detail: {
          operationId: "cancelRun",
          tags: ["执行"],
          summary: "请求取消执行",
          description: "将活动执行标记为取消请求，由 worker 在租约边界停止后续工作。",
        },
      },
    )
    .post(
      "/runs/:runId/retry",
      async ({ params, body, request, set }) => {
        const session = await requireSession(request, services);
        requireCsrf(request, session, services);
        const key = request.headers.get("idempotency-key");
        if (!key)
          throw new ApiError(428, "IDEMPOTENCY_REQUIRED", "重试执行必须携带 Idempotency-Key");
        if (!UUID.test(params.runId)) throw new ApiError(404, "NOT_FOUND", "资源不存在");
        const old = await services
          .db()
          .run.findFirst({ where: { id: params.runId, userId: session.userId } });
        if (!old) throw new ApiError(404, "NOT_FOUND", "资源不存在");
        if (!(old.status === "failed" || old.status === "canceled"))
          throw new ApiError(409, "RUN_NOT_RETRYABLE", "当前执行状态不允许重试");
        const result = await createRun(old.taskId, session.userId, body, key, services, old.id);
        set.status = 202;
        return { run: toRun(result.run), reused: result.reused };
      },
      {
        body: "RunCommandInput",
        headers: OptionalIdempotencyHeadersSchema,
        response: { 202: RunCommandResponseSchema, ...errors },
        detail: {
          operationId: "retryRun",
          tags: ["执行"],
          summary: "重试失败执行",
          description:
            "以原执行为 parentRun 创建新执行，固定同一任务配置版本并通过事务 Outbox 入队。",
        },
      },
    )
    .get(
      "/runs/:runId/events",
      async ({ params, request }) => {
        const session = await requireSession(request, services);
        if (!UUID.test(params.runId)) throw new ApiError(404, "NOT_FOUND", "资源不存在");
        const run = await services
          .db()
          .run.findFirst({ where: { id: params.runId, userId: session.userId } });
        if (!run) throw new ApiError(404, "NOT_FOUND", "资源不存在");
        const url = new URL(request.url);
        let after = Number(url.searchParams.get("after") ?? 0);
        const lastEventId = request.headers.get("last-event-id");
        if (lastEventId) {
          const last = await services.db().runEvent.findFirst({
            where: { id: lastEventId, runId: run.id, userId: session.userId },
          });
          if (last) after = Math.max(after, last.seq);
        }
        if (!Number.isSafeInteger(after) || after < 0)
          throw new ApiError(400, "INVALID_EVENT_CURSOR", "事件游标无效");
        const events = await services.db().runEvent.findMany({
          where: { runId: run.id, userId: session.userId, seq: { gt: after } },
          orderBy: { seq: "asc" },
        });
        const body = events
          .map((event) => {
            const dto = eventDto(event);
            return `id: ${dto.eventId}\nevent: ${dto.type}\ndata: ${JSON.stringify(dto)}\n\n`;
          })
          .join("");
        return new Response(body, {
          headers: {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-store",
            connection: "keep-alive",
          },
        });
      },
      {
        detail: {
          operationId: "streamRunEvents",
          tags: ["执行"],
          summary: "读取执行事件",
          description:
            "按 seq 回放当前账号执行的持久化事件，支持 Last-Event-ID 续传；本轮 API 返回已有事件后结束连接。",
        },
      },
    );
}
