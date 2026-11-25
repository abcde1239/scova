import type { Context } from 'elysia';
import type { WorkspaceIntakeInput } from '@scova/models';
import type { ApiServices } from '@/app/services';
import { requireCsrf, requireSession } from '@/handler/http/session';
import { createWorkspaceIntakeService } from '@/service/workspace-intake';

type HttpContext = Pick<Context, 'request' | 'set'>;

export function createWorkspaceIntakeHandlers(services: ApiServices) {
    const service = createWorkspaceIntakeService(services);
    async function authenticate({ request, set }: HttpContext) {
        set.headers['cache-control'] = 'private, no-store';
        return requireSession(request, services);
    }
    return {
        async home(this: void, context: HttpContext) {
            const session = await authenticate(context);
            return service.home(session.userId);
        },
        async intake(
            this: void,
            context: HttpContext & {
                body: WorkspaceIntakeInput;
                headers: { 'idempotency-key': string };
            },
        ) {
            const session = await authenticate(context);
            requireCsrf(context.request, session, services);
            return service.intake(session.userId, context.body, context.headers['idempotency-key']);
        },
    };
}
