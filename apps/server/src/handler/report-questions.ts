import type { Context } from "elysia";
import type { ApiServices } from "@/app/context.ts";
import { requireCsrf, requireSession } from "@/handler/session.ts";
import { createReportQuestionService } from "@/service/report-questions.ts";
import { ApiError } from "@/utils/errors.ts";
type Http = Pick<Context, "request" | "set"> & {
  params: { reportId: string; questionId?: string };
};
function key(request: Request) {
  const value = request.headers.get("idempotency-key");
  if (!value) throw new ApiError(428, "IDEMPOTENCY_REQUIRED", "必须携带稳定的Idempotency-Key");
  if (!/^[A-Za-z0-9._-]{16,128}$/.test(value))
    throw new ApiError(422, "INVALID_IDEMPOTENCY_KEY", "幂等键必须是16至128位安全字符");
  return value;
}
export function createReportQuestionHandlers(services: ApiServices) {
  const questions = createReportQuestionService(services);
  return {
    async create(this: void, { request, set, params, body }: Http & { body: unknown }) {
      const session = await requireSession(request, services);
      requireCsrf(request, session, services);
      set.headers["cache-control"] = "no-store";
      const result = await questions.create(
        session.userId,
        params.reportId,
        body,
        key(request),
        request.signal,
        () => requireSession(request, services),
      );
      set.status = 201;
      return result;
    },
    async get(this: void, { request, set, params }: Http) {
      const session = await requireSession(request, services);
      set.headers["cache-control"] = "no-store";
      return questions.get(session.userId, params.reportId, params.questionId!);
    },
    async followup(this: void, { request, set, params }: Http) {
      const session = await requireSession(request, services);
      requireCsrf(request, session, services);
      const result = await questions.followup(
        session.userId,
        params.reportId,
        params.questionId!,
        key(request),
      );
      set.status = 202;
      set.headers["cache-control"] = "no-store";
      return result;
    },
  };
}
