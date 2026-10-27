import type { Context } from 'elysia';
import type { RunCommandInput } from '@scova/contracts';
import type { ApiServices } from '@/app/context.ts';
import { requireCsrf, requireSession } from '@/handler/session.ts';
import { createRunService } from '@/service/runs.ts';
import { ApiError } from '@/utils/errors.ts';

type HttpContext = Pick<Context, 'request' | 'set'>;
type RunParams = { runId: string };

/** 只处理 HTTP 身份、命令头和 JSON/SSE 响应适配。 */
export function createRunHandlers(services: ApiServices) {
    const runs = createRunService(services);
    return {
        async create(
            this: void,
            {
                request,
                set,
                params,
                body,
            }: HttpContext & { params: { taskId: string }; body: RunCommandInput },
        ) {
            const session = await requireSession(request, services);
            requireCsrf(request, session, services);
            const key = request.headers.get('idempotency-key');
            if (!key)
                throw new ApiError(428, 'IDEMPOTENCY_REQUIRED', '启动执行必须携带 Idempotency-Key');
            const result = await runs.create(session.userId, params.taskId, body, key);
            set.status = 202;
            set.headers.location = `/api/v1/runs/${result.run.id}`;
            return result;
        },
        async get(this: void, { request, set, params }: HttpContext & { params: RunParams }) {
            const session = await requireSession(request, services);
            const run = await runs.get(session.userId, params.runId);
            set.headers.etag = `"${run.id}:${run.status}"`;
            return run;
        },
        async cancel(this: void, { request, params }: HttpContext & { params: RunParams }) {
            const session = await requireSession(request, services);
            requireCsrf(request, session, services);
            return runs.cancel(session.userId, params.runId);
        },
        async retry(
            this: void,
            {
                request,
                set,
                params,
                body,
            }: HttpContext & { params: RunParams; body: RunCommandInput },
        ) {
            const session = await requireSession(request, services);
            requireCsrf(request, session, services);
            const key = request.headers.get('idempotency-key');
            if (!key)
                throw new ApiError(428, 'IDEMPOTENCY_REQUIRED', '重试执行必须携带 Idempotency-Key');
            const result = await runs.retry(session.userId, params.runId, body, key);
            set.status = 202;
            return result;
        },
        async events(this: void, { request, params }: HttpContext & { params: RunParams }) {
            const session = await requireSession(request, services);
            const url = new URL(request.url);
            const events = await runs.events(
                session.userId,
                params.runId,
                Number(url.searchParams.get('after') ?? 0),
                request.headers.get('last-event-id'),
            );
            const body = events
                .map(
                    (event) =>
                        `id: ${event.eventId}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
                )
                .join('');
            return new Response(body, {
                headers: {
                    'content-type': 'text/event-stream; charset=utf-8',
                    'cache-control': 'no-store',
                    connection: 'keep-alive',
                },
            });
        },
    };
}
