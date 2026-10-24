import { swagger } from "@elysiajs/swagger";
import { Elysia } from "elysia";
import { node } from "@elysiajs/node";

/** API 应用工厂。业务路由将在后续 Issue 中按 contracts 注册。 */
export const createApiApp = (runtime: "bun" | "node" = "bun") =>
  new Elysia({ name: "scova-api", ...(runtime === "node" ? { adapter: node() } : {}) })
    .use(
      swagger({
        documentation: {
          info: {
            title: "知巡 Scova API",
            version: "0.0.0",
            description: "知巡后端接口文档（中文说明）。业务接口由后续 Issue 按共享契约接入。",
          },
          tags: [{ name: "系统", description: "服务运行状态接口" }],
        },
      }),
    )
    .get(
      "/health",
      () => ({
        status: "ok" as const,
        runtime: typeof Bun === "undefined" ? "node" : "bun",
      }),
      {
        detail: {
          tags: ["系统"],
          summary: "健康检查",
          description: "返回 API 服务与当前运行时状态。",
        },
      },
    );

export const apiApp = createApiApp();
