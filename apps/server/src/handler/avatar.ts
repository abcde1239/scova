import { AvatarVersionQuerySchema, parseContract } from '@scova/models';
import type { ApiServices } from '@/app/services';
import { requireCsrf, requireSession, serializeSession } from '@/http/session';
import { readAvatarBody } from '@/http/avatar-body';
import { createAvatarService } from '@/service/avatar';

export function createAvatarHandlers(services: ApiServices) {
    const avatar = createAvatarService(services);
    return {
        async state(request: Request) {
            return avatar.state(await requireSession(request, services));
        },
        async upload(request: Request, query: unknown) {
            const session = await requireSession(request, services);
            requireCsrf(request, session, services);
            const { expectedVersion } = parseContract(AvatarVersionQuerySchema, query);
            const user = await avatar.upload(
                session,
                expectedVersion === 'none' ? null : expectedVersion,
                await readAvatarBody(request),
                request.headers.get('content-type')?.split(';')[0]?.trim() ?? '',
                request.signal,
            );
            return serializeSession({ user, csrfToken: session.csrfToken });
        },
        async remove(request: Request, query: unknown) {
            const session = await requireSession(request, services);
            requireCsrf(request, session, services);
            const { expectedVersion } = parseContract(AvatarVersionQuerySchema, query);
            const user = await avatar.remove(
                session,
                expectedVersion === 'none' ? null : expectedVersion,
            );
            return serializeSession({ user, csrfToken: session.csrfToken });
        },
        async image(request: Request, version: string) {
            const session = await requireSession(request, services);
            return new Response(null, {
                status: 302,
                headers: {
                    location: await avatar.location(session, version),
                    'cache-control': 'private, no-store',
                    'referrer-policy': 'no-referrer',
                },
            });
        },
    };
}
