import type { Context } from 'elysia';
import type { ApiServices } from '@/app/services';
import { requireCsrf, requireSession } from '@/handler/http/session.ts';
import { createProjectSettingsService } from '@/service/project-settings.ts';

type ProjectContext = Pick<Context, 'request' | 'set'> & { params: { projectId: string } };

export function createProjectSettingsHandlers(services: ApiServices) {
    const settings = createProjectSettingsService(services);
    async function authenticate({ request, set }: ProjectContext) {
        const session = await requireSession(request, services);
        set.headers['cache-control'] = 'private, no-store';
        return session;
    }
    return {
        async read(this: void, context: ProjectContext) {
            const session = await authenticate(context);
            return settings.read(session.userId, context.params.projectId);
        },
        async update(this: void, context: ProjectContext & { body: unknown }) {
            const session = await authenticate(context);
            requireCsrf(context.request, session, services);
            return settings.update(session.userId, context.params.projectId, context.body);
        },
    };
}
