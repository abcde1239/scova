import {
    LoginInputSchema,
    RegisterInputSchema,
    UpdatePreferencesInputSchema,
    parseContract,
} from '@scova/models';
import type { ApiServices } from '@/app/context.ts';
import { createAuthService } from '@/service/auth.ts';
import {
    presentedToken,
    requireCsrf,
    requireOrigin,
    requireSession,
    serializeSession,
    sessionCookie,
} from '@/handler/session.ts';

/** HTTP 输入、Cookie 与响应适配；业务判断由认证 service 执行。 */
export function createAuthHandlers(services: ApiServices) {
    const auth = createAuthService(services);
    return {
        async register(request: Request, body: unknown) {
            requireOrigin(request, services);
            const created = await auth.register(
                parseContract(RegisterInputSchema, body),
                presentedToken(request),
            );
            return {
                body: serializeSession(created.session),
                cookie: sessionCookie(services, created.token),
            };
        },
        async login(request: Request, body: unknown) {
            requireOrigin(request, services);
            const created = await auth.login(
                parseContract(LoginInputSchema, body),
                presentedToken(request),
            );
            return {
                body: serializeSession(created.session),
                cookie: sessionCookie(services, created.token),
            };
        },
        async logout(request: Request) {
            const session = await requireSession(request, services);
            requireCsrf(request, session, services);
            await auth.revoke(session);
            return new Response(null, {
                status: 204,
                headers: { 'set-cookie': sessionCookie(services) },
            });
        },
        async me(request: Request) {
            return serializeSession(await requireSession(request, services));
        },
        async preferences(request: Request, body: unknown) {
            const session = await requireSession(request, services);
            requireCsrf(request, session, services);
            const user = await auth.updatePreferences(
                session,
                parseContract(UpdatePreferencesInputSchema, body),
            );
            return serializeSession({ user, csrfToken: session.csrfToken });
        },
    };
}
