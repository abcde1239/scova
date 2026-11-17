import type { ApiServices } from '@/app/services';
import { requireSession, requireCsrf } from '@/http/session';
import { createSearchConfigurationService } from '@/service/search-configuration';

export function createSearchConfigurationHandlers(services: ApiServices) {
    const configuration = createSearchConfigurationService(services);
    async function writableSession(request: Request) {
        const session = await requireSession(request, services);
        requireCsrf(request, session, services);
        return session;
    }
    return {
        async get(request: Request) {
            return configuration.get((await requireSession(request, services)).userId);
        },
        async save(request: Request, body: unknown) {
            return configuration.save((await writableSession(request)).userId, body);
        },
        async importLegacy(request: Request, providerId: string, body: unknown) {
            return configuration.importLegacy(
                (await writableSession(request)).userId,
                providerId,
                body,
            );
        },
    };
}
