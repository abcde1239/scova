import { swagger } from "@elysiajs/swagger";
import { node } from "@elysiajs/node";
import { Elysia } from "elysia";
import { contractModels, HealthResponseSchema } from "@/app/contracts.ts";
import { createApiErrorPlugin } from "@/app/errors.ts";
import { createDefaultServices, type ApiServices } from "@/app/context.ts";
import { createAuthPlugin } from "@/router/auth.ts";
import { createTaskPlugin } from "@/router/tasks.ts";
import { createTaskDraftPlugin } from "@/router/task-drafts.ts";
import { createRunPlugin } from "@/router/runs.ts";
import { createReportQuestionPlugin } from "@/router/report-questions.ts";
import { createReportPlugin } from "@/router/reports.ts";
import { createSystemPlugin } from "@/router/system.ts";

export { contractModels, HealthResponseSchema } from "@/app/contracts.ts";

/** 统一装配 Elysia 与 Node 适配器；依赖保持惰性，生成文档无需外部服务。 */
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
    .use(createSystemPlugin())
    .use(createAuthPlugin(services))
    .use(createTaskPlugin(services))
    .use(createTaskDraftPlugin(services))
    .use(createRunPlugin(services))
    .use(createReportPlugin(services))
    .use(createReportQuestionPlugin(services));

export const apiApp = createApiApp();
