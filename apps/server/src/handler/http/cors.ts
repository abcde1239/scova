import { Elysia } from 'elysia';
import { ApiError } from '@/utils/errors';

const methods = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
const headers = ['content-type', 'x-csrf-token', 'idempotency-key', 'if-match', 'last-event-id'];

/** Credentialed requests trust exactly the configured web origin; CSRF checks still apply. */
export function createCorsPlugin(origin: string) {
    return new Elysia({ name: 'scova-cors' })
        .onRequest(({ request, set }) => {
            set.headers.vary = 'Origin';
            const suppliedOrigin = request.headers.get('origin');
            if (!suppliedOrigin) return;
            if (suppliedOrigin !== origin)
                throw new ApiError(403, 'ORIGIN_REJECTED', '请求来源不受信任');
            set.headers['access-control-allow-origin'] = origin;
            set.headers['access-control-allow-credentials'] = 'true';
            set.headers['access-control-expose-headers'] = 'ETag, Retry-After, X-Request-Id';
            if (request.method !== 'OPTIONS') return;
            const method = request.headers.get('access-control-request-method');
            const requestedHeaders = (request.headers.get('access-control-request-headers') ?? '')
                .split(',')
                .map((header) => header.trim().toLowerCase())
                .filter(Boolean);
            if (
                !method ||
                !methods.includes(method) ||
                requestedHeaders.some((header) => !headers.includes(header))
            )
                throw new ApiError(403, 'CORS_REJECTED', '请求方法或请求头不受支持');
            set.headers.vary =
                'Origin, Access-Control-Request-Method, Access-Control-Request-Headers';
            set.headers['access-control-allow-methods'] = methods.join(', ');
            set.headers['access-control-allow-headers'] = headers.join(', ');
            set.headers['access-control-max-age'] = '600';
            set.status = 204;
            return '';
        })
        .as('global');
}
