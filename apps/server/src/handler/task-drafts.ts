import type { Context } from 'elysia';
import type { ApiServices } from '@/app/services';
import { requireSession, requireCsrf } from '@/handler/http/session.ts';
import { createTaskDraftService } from '@/service/task-drafts.ts';

export function createTaskDraftHandlers(services: ApiServices) {
    const drafts = createTaskDraftService(services);
    return {
        async questions(
            this: void,
            { request, body, set }: Pick<Context, 'request' | 'set'> & { body: unknown },
        ) {
            const session = await requireSession(request, services);
            requireCsrf(request, session, services);
            set.headers['cache-control'] = 'no-store';
            return drafts.questions(session, body, request.signal);
        },
        async create(
            this: void,
            { request, body, set }: Pick<Context, 'request' | 'set'> & { body: unknown },
        ) {
            const session = await requireSession(request, services);
            requireCsrf(request, session, services);
            set.headers['cache-control'] = 'no-store';
            return drafts.create(session, body, request.signal);
        },
    };
}
