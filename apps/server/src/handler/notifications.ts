import type { Context } from 'elysia';
import type { ApiServices } from '@/app/services';
import { requireCsrf, requireSession } from '@/http/session.ts';
import { createNotificationService } from '@/service/notifications.ts';

export function createNotificationHandlers(services: ApiServices) {
    const notifications = createNotificationService(services);
    return {
        async list(this: void, { request, query }: Pick<Context, 'request'> & { query: unknown }) {
            const session = await requireSession(request, services);
            return notifications.list(session.userId, query);
        },
        async patch(
            this: void,
            {
                request,
                params,
                body,
            }: Pick<Context, 'request'> & {
                params: { notificationId: string };
                body: unknown;
            },
        ) {
            const session = await requireSession(request, services);
            requireCsrf(request, session, services);
            return notifications.patch(session.userId, params.notificationId, body);
        },
    };
}
