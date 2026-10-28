import type { Context } from 'elysia';
import type { ApiServices } from '@/app/services';
import { requireCsrf, requireSession } from '@/http/session.ts';
import { createFeedbackService } from '@/service/feedback.ts';
type Http = Pick<Context, 'request' | 'set'>;
export function createFeedbackHandlers(services: ApiServices) {
    const feedback = createFeedbackService(services);
    return {
        async list(this: void, { request, params, set }: Http & { params: { taskId: string } }) {
            const session = await requireSession(request, services);
            set.headers['cache-control'] = 'no-store';
            return feedback.list(session.userId, params.taskId);
        },
        async set(this: void, { request, body, set }: Http & { body: unknown }) {
            const session = await requireSession(request, services);
            requireCsrf(request, session, services);
            set.headers['cache-control'] = 'no-store';
            return feedback.set(session.userId, body);
        },
        async revoke(
            this: void,
            { request, params, set }: Http & { params: { feedbackId: string } },
        ) {
            const session = await requireSession(request, services);
            requireCsrf(request, session, services);
            set.headers['cache-control'] = 'no-store';
            return feedback.revoke(session.userId, params.feedbackId);
        },
    };
}
