import { randomUUID } from "node:crypto";
import { Elysia } from "elysia";
import { ContractValidationError, type FieldError } from "@scova/contracts";

import { ApiError } from "@/utils/errors.ts";
function validationFields(error: unknown): FieldError[] {
  if (typeof error !== "object" || error === null || !("all" in error) || !Array.isArray(error.all))
    return [{ path: "/", message: "请求字段不符合接口约束" }];
  return error.all.map((entry: unknown) => ({
    path:
      typeof entry === "object" &&
      entry !== null &&
      "path" in entry &&
      typeof entry.path === "string"
        ? entry.path || "/"
        : "/",
    message: "请求字段不符合接口约束",
  }));
}

/** 在应用根注册；所有成功与错误响应均携带服务端生成的追踪 ID。 */
export function createApiErrorPlugin() {
  return new Elysia({ name: "scova-api-errors" })
    .onRequest(({ set }) => {
      set.headers["x-request-id"] = randomUUID();
    })
    .onError({ as: "global" }, ({ code, error, set }) => {
      const requestId =
        typeof set.headers["x-request-id"] === "string"
          ? set.headers["x-request-id"]
          : randomUUID();
      set.headers["x-request-id"] = requestId;
      set.headers["cache-control"] = "no-store";
      if (error instanceof ApiError) {
        set.status = error.status;
        if (error.retryAfterSeconds !== undefined)
          set.headers["retry-after"] = String(error.retryAfterSeconds);
        return {
          code: error.code,
          message: error.message,
          requestId,
          ...(error.fieldErrors ? { fieldErrors: error.fieldErrors } : {}),
        };
      }
      if (error instanceof ContractValidationError) {
        set.status = 422;
        return error.toResponse(requestId);
      }
      if (code === "VALIDATION") {
        set.status = 422;
        return {
          code: "VALIDATION_ERROR",
          message: "请求字段不符合接口契约",
          requestId,
          fieldErrors: validationFields(error),
        };
      }
      if (code === "NOT_FOUND") {
        set.status = 404;
        return { code: "NOT_FOUND", message: "资源不存在", requestId };
      }
      if (code === "PARSE") {
        set.status = 400;
        return { code: "MALFORMED_REQUEST", message: "无法解析请求内容", requestId };
      }
      set.status = 500;
      return { code: "INTERNAL_ERROR", message: "服务暂时无法完成请求", requestId };
    })
    .as("global");
}
