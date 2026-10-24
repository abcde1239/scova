import { swagger } from "@elysiajs/swagger";
import { Elysia, t } from "elysia";
import { node } from "@elysiajs/node";
import {
  ApiErrorSchema,
  RegisterInputSchema,
  LoginInputSchema,
  SessionResponseSchema,
  UserSchema,
  PreferencesSchema,
  UpdatePreferencesInputSchema,
  TaskConfigSchema,
  CreateTaskInputSchema,
  UpdateTaskInputSchema,
  TaskSchema,
  TaskVersionSchema,
  RunSchema,
  RunCommandResponseSchema,
  RunCommandInputSchema,
  ReportSchema,
  RunEventSchema,
  TaskDetailResponseSchema,
  TaskListResponseSchema,
} from "@scova/contracts";
import { createAuthPlugin } from "./auth.ts";
import { createApiErrorPlugin } from "./errors.ts";
import { createDefaultServices, type ApiServices } from "./services.ts";
import { createTaskPlugin } from "./tasks.ts";
import { createRunPlugin } from "./runs.ts";

/** 系统健康检查返回值；只代表进程存活，不宣称数据库、队列或 Agent 已就绪。 */
export const HealthResponseSchema = t.Object(
  {
    status: t.Literal("ok", { description: "API 进程正常响应" }),
    runtime: t.Union([t.Literal("bun"), t.Literal("node")], {
      description: "当前主运行时或兼容运行时",
    }),
  },
  { additionalProperties: false, description: "进程健康状态" },
);

export const contractModels = {
  ApiError: ApiErrorSchema,
  RegisterInput: RegisterInputSchema,
  LoginInput: LoginInputSchema,
  SessionResponse: SessionResponseSchema,
  User: UserSchema,
  Preferences: PreferencesSchema,
  UpdatePreferencesInput: UpdatePreferencesInputSchema,
  TaskConfig: TaskConfigSchema,
  CreateTaskInput: CreateTaskInputSchema,
  UpdateTaskInput: UpdateTaskInputSchema,
  Task: TaskSchema,
  TaskVersion: TaskVersionSchema,
  TaskDetailResponse: TaskDetailResponseSchema,
  TaskListResponse: TaskListResponseSchema,
  Run: RunSchema,
  RunCommandResponse: RunCommandResponseSchema,
  RunCommandInput: RunCommandInputSchema,
  Report: ReportSchema,
  RunEvent: RunEventSchema,
};

/** API 应用工厂；服务依赖可注入，文档生成不会主动连接数据库或 Redis。 */
export const createApiApp = (
  runtime: "bun" | "node" = "bun",
  services: ApiServices = createDefaultServices(),
) =>
  new Elysia({
    name: "scova-api",
    normalize: false,
    ...(runtime === "node" ? { adapter: node() } : {}),
  })
    .use(createApiErrorPlugin())
    // contracts 与 apps/api 通过 workspace 依赖共享运行时 schema；这里的 unknown 边界只消除
    // TypeBox 在不同 package 解析路径下重复安装造成的 unique-symbol 类型差异。
    .model({ ...contractModels, HealthResponse: HealthResponseSchema } as unknown as Record<
      string,
      import("elysia").TSchema
    >)
    .use(
      swagger({
        documentation: {
          info: {
            title: "知巡 Scova API",
            version: "1.0.0",
            description:
              "知巡后端接口文档。成功返回领域 JSON；错误使用真实 HTTP 状态与 code/message/requestId/fieldErrors。",
          },
          openapi: "3.1.0",
          tags: [{ name: "系统", description: "服务运行状态接口" }],
        },
      }),
    )
    .get(
      "/health",
      () => ({
        status: "ok" as const,
        runtime: typeof Bun === "undefined" ? ("node" as const) : ("bun" as const),
      }),
      {
        response: { 200: "HealthResponse" },
        detail: {
          operationId: "getHealth",
          tags: ["系统"],
          summary: "健康检查",
          description: "返回 API 服务与当前运行时状态。",
        },
      },
    )
    .use(createAuthPlugin(services))
    .use(createTaskPlugin(services))
    .use(createRunPlugin(services));

export const apiApp = createApiApp();
