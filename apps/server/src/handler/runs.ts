import type { Context } from 'elysia';
import type { RunCommandInput } from '@scova/models';
import type { ApiServices } from '@/app/services';
import { requireCsrf, requireSession } from '@/http/session.ts';
import { createRunService } from '@/service/runs.ts';
import { ApiError } from '@/utils/errors.ts';
import { createRunEventService } from '@/service/run-events.ts';
import { createSseBody } from '@/http/sse.ts';
import { createRunGraphService } from '@/service/run-graph.ts';

type HttpContext = Pick<Context, 'request' | 'set'>;
type RunParams = { runId: string };

/** 只处理 HTTP 身份、命令头和 JSON/SSE 响应适配。 */
export function createRunHandlers(services: ApiServices) {
    const runs = createRunService(services);
    const events = createRunEventService(services);
    const graph = createRunGraphService(services);
    return {
        async list(
            this: void,
            {
                request,
                set,
                params,
                query,
            }: HttpContext & { params: { taskId: string }; query: unknown },
        ) {
            const session = await requireSession(request, services);
            set.headers['cache-control'] = 'no-store';
            return runs.list(session.userId, params.taskId, query);
        },
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
        async graph(this: void, { request, set, params }: HttpContext & { params: RunParams }) {
            const session = await requireSession(request, services);
            set.headers['cache-control'] = 'no-store';
            return graph.get(session.userId, params.runId);
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
            if (
                url.searchParams.getAll('after').length > 1 ||
                [...url.searchParams.keys()].some((key) => key !== 'after')
            )
                throw new ApiError(400, 'INVALID_EVENT_CURSOR', '事件游标参数无效');
            const first = await events.prepare(
                session,
                params.runId,
                url.searchParams.get('after'),
                request.headers.get('last-event-id'),
            );
            const body = createSseBody({
                first,
                next: (after) => events.next(session, params.runId, after),
                signal: request.signal,
                expiresAt: session.expiresAt,
                clock: () => services.clock(),
                registry: services.streams,
                policy: services.sse,
            });
            return new Response(body, {
                headers: {
                    'content-type': 'text/event-stream; charset=utf-8',
                    'cache-control': 'no-store',
                    connection: 'keep-alive',
                    'x-accel-buffering': 'no',
                },
            });
        },
    };
}
