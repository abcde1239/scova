import type { ApiServices } from '@/app/services';
import { requireSession, requireCsrf } from '@/http/session';
import { createAgentProviderService } from '@/service/agent-providers';

export function createAgentProviderHandlers(services: ApiServices) {
    const providers = createAgentProviderService(services);
    async function writableSession(request: Request) {
        const session = await requireSession(request, services);
        requireCsrf(request, session, services);
        return session;
    }
    return {
        async models(request: Request, body: unknown) {
            const session = await writableSession(request);
            return providers.models(session.userId, body, request.signal);
        },
        async list(request: Request) {
            return providers.list((await requireSession(request, services)).userId);
        },
        async create(request: Request, body: unknown) {
            const session = await writableSession(request);
            return providers.create(session.userId, body);
        },
        async update(request: Request, id: string, body: unknown) {
            return providers.update((await writableSession(request)).userId, id, body);
        },
        async activate(request: Request, id: string, body: unknown) {
            return providers.activate((await writableSession(request)).userId, id, body);
        },
        async remove(request: Request, id: string, body: unknown) {
            return providers.remove((await writableSession(request)).userId, id, body);
        },
    };
}
