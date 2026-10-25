import { Elysia } from "elysia";
import { HealthResponseSchema } from "@/app/contracts.ts";
import { health } from "@/handler/system.ts";

export function createSystemPlugin() {
  return new Elysia({ name: "scova-system" })
    .model({ HealthResponse: HealthResponseSchema })
    .get("/health", health, {
      response: { 200: "HealthResponse" },
      detail: {
        operationId: "getHealth",
        tags: ["系统"],
        summary: "健康检查",
        description: "返回 API 服务与当前运行时状态。",
      },
    });
}
