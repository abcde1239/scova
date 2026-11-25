import type { Context } from 'elysia';
import {
    PROJECT_THREAD_MAX_PAGE_SIZE,
    PROJECT_THREAD_MAX_SEQ,
    PROJECT_THREAD_PAGE_SIZE,
    ProjectThreadItemSchema,
    parseContract,
    type SendProjectTurn,
    type CreateProjectThread,
    type UpdateProjectThread,
} from '@scova/models';
import type { ApiServices } from '@/app/services';
import { requireCsrf, requireSession } from '@/handler/http/session.ts';
import { createPagedSseBody } from '@/handler/http/sse.ts';
import { createProjectThreadService } from '@/service/project-threads.ts';
import { createProjectTurnService } from '@/service/project-turns.ts';
import { createProjectThreadStore } from '@/repo/project-threads.ts';
import { createThreadScheduleActionService } from '@/service/thread-schedule-actions.ts';
import { createThreadActionService } from '@/service/thread-actions.ts';
import { ApiError } from '@/utils/errors.ts';

type HttpContext = Pick<Context, 'request' | 'set'>;
type ProjectContext = HttpContext & { params: { projectId: string } };
type ThreadContext = HttpContext & { params: { threadId: string } };
const encoder = new TextEncoder();

function parseAfter(value: string | null): number | undefined {
    if (value === null) return undefined;
    if (!/^(0|[1-9]\d*)$/.test(value) || Number(value) > PROJECT_THREAD_MAX_SEQ)
        throw new ApiError(400, 'INVALID_EVENT_CURSOR', '事件游标超出会话序号范围');
    return Number(value);
}

function readQuery(request: Request, keys: readonly string[]) {
    const query = new URL(request.url).searchParams;
    const seen = new Set<string>();
    for (const key of query.keys()) {
        if (!keys.includes(key) || seen.has(key)) {
            if (keys.length === 1 || key === 'after')
                throw new ApiError(400, 'INVALID_EVENT_CURSOR', '事件游标参数无效');
            throw new ApiError(400, 'INVALID_THREAD_QUERY', '会话查询参数无效');
        }
        seen.add(key);
    }
    return query;
}

export function createThreadHandlers(services: ApiServices) {
    const threads = createProjectThreadService(services);
    const turns = createProjectTurnService(services);
    const decideResearch = createThreadActionService(services);
    const schedules = createThreadScheduleActionService(services);
    async function decide(userId: string, threadId: string, itemId: string, approve: boolean) {
        const kind = await createProjectThreadStore(services.db(), userId).itemKind(
            threadId,
            itemId,
        );
        return kind === 'schedule'
            ? schedules.decide({ userId, threadId }, itemId, approve)
            : decideResearch(userId, threadId, itemId, approve);
    }
    async function authenticate({ request, set }: HttpContext) {
        const session = await requireSession(request, services);
        set.headers['cache-control'] = 'private, no-store';
        return session;
    }

    return {
        async send(this: void, context: ThreadContext & { body: SendProjectTurn }) {
            const session = await authenticate(context);
            requireCsrf(context.request, session, services);
            return turns.send(session, context.params.threadId, context.body);
        },
        async cancel(
            this: void,
            context: HttpContext & { params: { threadId: string; turnId: string } },
        ) {
            const session = await authenticate(context);
            requireCsrf(context.request, session, services);
            return turns.cancel(session.userId, context.params.threadId, context.params.turnId);
        },
        async approve(
            this: void,
            context: HttpContext & { params: { threadId: string; itemId: string } },
        ) {
            const session = await authenticate(context);
            requireCsrf(context.request, session, services);
            return decide(session.userId, context.params.threadId, context.params.itemId, true);
        },
        async reject(
            this: void,
            context: HttpContext & { params: { threadId: string; itemId: string } },
        ) {
            const session = await authenticate(context);
            requireCsrf(context.request, session, services);
            return decide(session.userId, context.params.threadId, context.params.itemId, false);
        },
        async undo(
            this: void,
            context: HttpContext & { params: { threadId: string; itemId: string } },
        ) {
            const session = await authenticate(context);
            requireCsrf(context.request, session, services);
            return schedules.undo(
                { userId: session.userId, threadId: context.params.threadId },
                context.params.itemId,
            );
        },
        async list(this: void, context: ProjectContext) {
            const session = await authenticate(context);
            return threads.list(session.userId, context.params.projectId);
        },
        async create(this: void, context: ProjectContext & { body: CreateProjectThread }) {
            const session = await authenticate(context);
            requireCsrf(context.request, session, services);
            const thread = await threads.create(
                session.userId,
                context.params.projectId,
                context.body,
            );
            context.set.status = 201;
            return thread;
        },
        async update(this: void, context: ThreadContext & { body: UpdateProjectThread }) {
            const session = await authenticate(context);
            requireCsrf(context.request, session, services);
            return threads.update(session.userId, context.params.threadId, context.body);
        },
        async snapshot(this: void, context: ThreadContext) {
            const session = await authenticate(context);
            const query = readQuery(context.request, ['after', 'limit']);
            const after = parseAfter(query.get('after'));
            const rawLimit = query.get('limit');
            if (
                rawLimit !== null &&
                (!/^[1-9]\d*$/.test(rawLimit) || Number(rawLimit) > PROJECT_THREAD_MAX_PAGE_SIZE)
            )
                throw new ApiError(400, 'INVALID_THREAD_QUERY', '会话快照分页大小无效');
            const limit = rawLimit === null ? PROJECT_THREAD_PAGE_SIZE : Number(rawLimit);
            return threads.snapshot(session.userId, context.params.threadId, { after, limit });
        },
        async events(this: void, { request, params }: ThreadContext) {
            const session = await requireSession(request, services);
            const query = readQuery(request, ['after']);
            const cursor =
                parseAfter(query.get('after') ?? request.headers.get('last-event-id')) ?? 0;
            const threadId = params.threadId;
            const readPage = async (after: number) => {
                request.signal.throwIfAborted();
                const items = await threads.items(
                    session.userId,
                    threadId,
                    after,
                    PROJECT_THREAD_PAGE_SIZE,
                );
                return { items, hasMore: () => items.length === PROJECT_THREAD_PAGE_SIZE };
            };
            const first = await readPage(cursor);
            const body = createPagedSseBody({
                cursor,
                first,
                async next(after) {
                    const current = await requireSession(request, services);
                    if (current.id !== session.id || current.userId !== session.userId)
                        throw new ApiError(401, 'SESSION_REQUIRED', '请先登录');
                    return readPage(after);
                },
                encode(item) {
                    const data = JSON.stringify(parseContract(ProjectThreadItemSchema, item));
                    return encoder.encode(`id: ${item.seq}\nevent: item\ndata: ${data}\n\n`);
                },
                signal: request.signal,
                expiresAt: session.expiresAt,
                clock: () => services.clock(),
                registry: services.streams,
                policy: services.sse,
            });
            return new Response(body, {
                headers: {
                    'content-type': 'text/event-stream; charset=utf-8',
                    'cache-control': 'private, no-store',
                    connection: 'keep-alive',
                    'x-accel-buffering': 'no',
                },
            });
        },
    };
}
