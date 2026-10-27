import { timingSafeEqual } from 'node:crypto';
import type { SessionResponse } from '@scova/models';
import type { ApiServices } from '@/app/context.ts';
import { createAuthService, type AuthenticatedSession } from '@/service/auth.ts';
import { ApiError } from '@/utils/errors.ts';
import { tokenHash } from '@/utils/security.ts';
import { serializeUser } from '@/utils/user.ts';

export const SESSION_COOKIE_NAME = 'scova_session';
export function presentedToken(request: Request): string | undefined {
    const values = (request.headers.get('cookie') ?? '')
        .split(';')
        .map((part) => part.trim())
        .filter((part) => part.startsWith(`${SESSION_COOKIE_NAME}=`));
    if (values.length !== 1) return undefined;
    const token = values[0]!.slice(SESSION_COOKIE_NAME.length + 1);
    return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : undefined;
}

export function requireOrigin(request: Request, services: ApiServices): void {
    if (
        request.headers.get('origin') !== services.origin ||
        request.headers.get('sec-fetch-site') === 'cross-site'
    )
        throw new ApiError(403, 'ORIGIN_REJECTED', '请求来源不受信任');
}

export const requireSession = (request: Request, services: ApiServices) =>
    createAuthService(services).authenticate(presentedToken(request));

export function requireCsrf(
    request: Request,
    session: AuthenticatedSession,
    services: ApiServices,
): void {
    requireOrigin(request, services);
    const csrf = request.headers.get('x-csrf-token');
    if (
        !csrf ||
        csrf.length > 128 ||
        !timingSafeEqual(
            Buffer.from(tokenHash(csrf), 'hex'),
            Buffer.from(session.csrfTokenHash, 'hex'),
        )
    )
        throw new ApiError(403, 'CSRF_REJECTED', '请求校验失败，请刷新后重试');
}

export const requireOwnedTask = (
    taskId: string,
    session: AuthenticatedSession,
    services: ApiServices,
) => createAuthService(services).ownedTask(taskId, session);

export function serializeSession(
    session: Pick<AuthenticatedSession, 'user' | 'csrfToken'>,
): SessionResponse {
    return { user: serializeUser(session.user), csrfToken: session.csrfToken };
}

export function sessionCookie(services: ApiServices, token?: string): string {
    return `${SESSION_COOKIE_NAME}=${token ?? ''}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${token ? services.sessionTtlSeconds : 0}${token ? '' : '; Expires=Thu, 01 Jan 1970 00:00:00 GMT'}${services.production ? '; Secure' : ''}`;
}
