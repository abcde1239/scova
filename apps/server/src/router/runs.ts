import { Elysia, t } from "elysia";
import {
  PageQuerySchema,
  RunListResponseSchema,
  ApiErrorSchema,
  EventCursorHeadersSchema,
  EventCursorQuerySchema,
  IdempotencyHeadersSchema,
  RunCommandInputSchema,
  RunCommandResponseSchema,
  RunSchema,
} from "@scova/contracts";
import type { ApiServices } from "@/app/context.ts";
import { createRunHandlers } from "@/handler/runs.ts";

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

export function createRunPlugin(services: ApiServices) {
  const handlers = createRunHandlers(services);
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

  return new Elysia({ name: "scova-runs", prefix: "/api/v1", normalize: false })
    .model(models)
    .get("/tasks/:taskId/runs", handlers.list, {
      query: t.Object(
        {
          ...PageQuerySchema.properties,
          limit: t.Optional(
            t.Numeric({
              minimum: 1,
              maximum: Number.MAX_SAFE_INTEGER,
              description: "每页数量，默认50上限100",
            }),
          ),
        },
        { additionalProperties: false },
      ),
      response: { 200: RunListResponseSchema, ...errors },
      detail: {
        operationId: "listTaskRuns",
        tags: ["执行"],
        summary: "读取任务执行历史",
        description:
          "仅返回当前账号指定任务的执行历史，按排队时间与ID倒序分页；包含版本、模式、预算、覆盖范围和状态，不返回提示词、工具正文或租约。",
      },
    })
    .post("/tasks/:taskId/runs", handlers.create, {
      body: "RunCommandInput",
      headers: OptionalIdempotencyHeadersSchema,
      response: { 202: RunCommandResponseSchema, ...errors },
      detail: {
        operationId: "createRun",
        tags: ["执行"],
        summary: "启动查阅执行",
        description:
          "固定当前任务配置版本，在同一事务写入执行、首个事件和 Outbox；重复幂等命令或同任务已有活动执行时返回原执行。",
      },
    })
    .get("/runs/:runId", handlers.get, {
      response: { 200: RunSchema, ...errors },
      detail: {
        operationId: "getRun",
        tags: ["执行"],
        summary: "查看执行详情",
        description: "返回当前账号拥有的执行公共快照，不暴露租约、checkpoint 或数据库内部字段。",
      },
    })
    .post("/runs/:runId/cancel", handlers.cancel, {
      response: { 200: RunCommandResponseSchema, ...errors },
      detail: {
        operationId: "cancelRun",
        tags: ["执行"],
        summary: "请求取消执行",
        description:
          "将活动执行标记为取消请求；重复取消复用原命令，终态不回退。Worker 消费取消请求的执行闭环仍待实现。",
      },
    })
    .post("/runs/:runId/retry", handlers.retry, {
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
    })
    .get("/runs/:runId/events", handlers.events, {
      detail: {
        operationId: "streamRunEvents",
        tags: ["执行"],
        summary: "读取执行事件",
        description:
          "按 seq 有界回放当前账号执行的持久化事件并持续查询后续事件；支持 after 与 Last-Event-ID 一致续传、15 秒心跳和过期游标 reset。终态回放完成后关闭；慢客户端需重连。",
        parameters: [
          {
            in: "query",
            name: "after",
            description: "最后已处理的非负安全整数 seq；与 Last-Event-ID 同时提供时必须一致",
            required: false,
            schema: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
          },
          {
            in: "header",
            name: "Last-Event-ID",
            description: "当前执行最后已处理事件的 UUID；事件不可用时返回无 id 的 reset 后关闭",
            required: false,
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: {
          200: {
            description: "有界历史回放和持续事件流；心跳为注释帧",
            content: { "text/event-stream": { schema: { type: "string" } } },
          },
        },
      },
    });
}
