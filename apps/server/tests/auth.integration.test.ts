import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@scova/models';
import { Redis as RedisClient } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { Elysia } from 'elysia';
import { createAuthPlugin } from '../src/router/auth.ts';
import { requireOwnedTask } from '../src/handler/session.ts';
import { createApiErrorPlugin } from '../src/app/errors.ts';
import { createDefaultServices, type ApiServices } from '../src/app/context.ts';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../../', import.meta.url));
const baseUrl =
    process.env.SCOVA_TEST_DATABASE_URL ??
    process.env.RUNTIME_DATABASE_URL ??
    'postgresql://scova_test:scova_test@127.0.0.1:55432/scova_test';
const redisUrl =
    process.env.SCOVA_TEST_REDIS_URL ?? process.env.RUNTIME_REDIS_URL ?? 'redis://127.0.0.1:56379';
const schema = `scova_auth_${randomUUID().replaceAll('-', '')}`;
const scopedUrl = new URL(baseUrl);
scopedUrl.searchParams.set('schema', schema);
const prisma = new PrismaClient({ datasources: { db: { url: scopedUrl.toString() } } });
const admin = new (require('pg').Client)({ connectionString: baseUrl });
const redis = new RedisClient(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
});
const origin = 'https://scova.test';
const hashText = (value: string) => createHash('sha256').update(value).digest('hex');
let schemaCreated = false;
let now = new Date('2026-10-24T12:00:00.000Z');
let services: ApiServices;
let app: { handle(request: Request): Response | Promise<Response> };

const headers = (extra: Record<string, string> = {}) => ({
    origin,
    'content-type': 'application/json',
    ...extra,
});
const registerBody = (email = `${randomUUID()}@example.test`) => ({
    email,
    password: 'correct horse battery staple',
    defaultTimezone: 'Asia/Shanghai',
});
const cookieHeader = (response: Response) =>
    response.headers.get('set-cookie')?.split(';')[0] ?? '';
const responseJson = async (response: Response) => (await response.json()) as Record<string, any>;

function makeServices(overrides: Partial<Parameters<typeof createDefaultServices>[0]> = {}) {
    return createDefaultServices({
        origin,
        production: false,
        registrationEnabled: true,
        sessionTtlSeconds: 3600,
        clock: () => now,
        db: () => prisma,
        redis: () => redis,
        rateLimit: {
            windowSeconds: 60,
            loginAttempts: 5,
            registerAttempts: 5,
            globalAttempts: 100,
            keyPrefix: `scova:test:${randomUUID()}:`,
        },
        ...overrides,
    });
}
async function request(path: string, init: RequestInit = {}) {
    return app.handle(new Request(`${origin}${path}`, init));
}
async function register(email?: string, service = services) {
    app = new Elysia().use(createApiErrorPlugin()).use(createAuthPlugin(service));
    return request('/api/v1/auth/register', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(registerBody(email)),
    });
}

describe('邮箱密码认证与租户隔离', () => {
    beforeAll(async () => {
        await admin.connect();
        await admin.query(`CREATE SCHEMA "${schema}"`);
        schemaCreated = true;
        const migrate = () =>
            execFileSync(
                process.execPath,
                [
                    require.resolve('prisma/build/index.js'),
                    'migrate',
                    'deploy',
                    '--schema',
                    'packages/models/prisma/schema.prisma',
                ],
                {
                    cwd: root,
                    env: { ...process.env, DATABASE_URL: scopedUrl.toString() },
                    encoding: 'utf8',
                    windowsHide: true,
                    timeout: 60000,
                },
            );
        migrate();
        migrate();
        await prisma.$connect();
        await redis.connect();
    }, 120000);

    beforeEach(async () => {
        now = new Date('2026-10-24T12:00:00.000Z');
        services = makeServices();
        await redis.flushdb();
    });

    afterAll(async () => {
        await prisma.$disconnect();
        await redis.quit();
        if (schemaCreated && /^scova_auth_[0-9a-f]{32}$/.test(schema))
            await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.end();
    });

    it('注册创建 Argon2id 用户、Cookie 会话和可恢复 CSRF，但响应不返回 token', async () => {
        const response = await register();
        expect(response.status).toBe(201);
        const body = await responseJson(response);
        expect(body.user.email).toContain('@example.test');
        expect(body.csrfToken).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(body).not.toHaveProperty('sessionToken');
        const cookie = cookieHeader(response);
        expect(cookie).toMatch(/^scova_session=[A-Za-z0-9_-]{43}$/);
        const session = await prisma.session.findFirstOrThrow();
        expect(session.tokenHash).toMatch(/^[0-9a-f]{64}$/);
        expect(session.tokenHash).not.toBe(cookie.split('=')[1]);
        const user = await prisma.user.findFirstOrThrow();
        expect(user.passwordHash).toMatch(/^\$argon2id\$/);
        expect(user.passwordHash).not.toContain(registerBody().password);
    });

    it('重复规范化邮箱返回409且不创建第二账号', async () => {
        const email = `${randomUUID()}@example.test`;
        expect((await register(email)).status).toBe(201);
        const duplicate = await register(email.toUpperCase());
        expect(duplicate.status).toBe(409);
        expect((await responseJson(duplicate)).code).toBe('EMAIL_ALREADY_REGISTERED');
        expect(await prisma.user.count({ where: { normalizedEmail: email } })).toBe(1);
    });

    it('登录错误使用同样的 Argon2id 校验，重复错误在 Redis 固定窗口后429', async () => {
        const body = registerBody();
        expect((await register(body.email)).status).toBe(201);
        app = new Elysia().use(createApiErrorPlugin()).use(createAuthPlugin(services));
        for (let attempt = 0; attempt < 5; attempt++) {
            const invalid = await request('/api/v1/auth/login', {
                method: 'POST',
                headers: headers(),
                body: JSON.stringify({ email: body.email, password: 'wrong' }),
            });
            expect(invalid.status).toBe(401);
        }
        const limited = await request('/api/v1/auth/login', {
            method: 'POST',
            headers: headers(),
            body: JSON.stringify({ email: body.email, password: 'wrong' }),
        });
        expect(limited.status).toBe(429);
        expect(limited.headers.get('retry-after')).toMatch(/^\d+$/);
        expect((await responseJson(limited)).code).toBe('RATE_LIMITED');
    });

    it('未配置或关闭注册时拒绝注册，限流只使用邮箱哈希与全局固定窗口', async () => {
        const disabled = makeServices({ registrationEnabled: false });
        const response = await register(undefined, disabled);
        expect(response.status).toBe(403);
        const keys = await redis.keys('scova:test:*:*');
        expect(keys.every((key: string) => !key.includes('@'))).toBe(true);
    });

    it('登录和注册缺失或跨站 Origin 被拒绝，未知转发 IP 不改变授权', async () => {
        app = new Elysia().use(createApiErrorPlugin()).use(createAuthPlugin(services));
        const missing = await request('/api/v1/auth/register', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(registerBody()),
        });
        expect(missing.status).toBe(403);
        const cross = await request('/api/v1/auth/register', {
            method: 'POST',
            headers: headers({ origin: 'https://evil.test', 'x-forwarded-for': '127.0.0.1' }),
            body: JSON.stringify(registerBody()),
        });
        expect(cross.status).toBe(403);
    });

    it('登录后 /me 恢复会话，写请求同时要求 Origin 与稳定 CSRF，偏好不改已保存版本', async () => {
        const body = registerBody();
        const registered = await register(body.email);
        const cookie = cookieHeader(registered);
        const csrf = (await responseJson(registered)).csrfToken as string;
        app = new Elysia().use(createApiErrorPlugin()).use(createAuthPlugin(services));
        const me = await request('/api/v1/me', { headers: { cookie } });
        expect(me.status).toBe(200);
        expect((await responseJson(me)).user.email).toBe(body.email);
        const noCsrf = await request('/api/v1/me/preferences', {
            method: 'PATCH',
            headers: headers({ cookie }),
            body: JSON.stringify({ defaultTimezone: 'UTC' }),
        });
        expect(noCsrf.status).toBe(403);
        const badOrigin = await request('/api/v1/me/preferences', {
            method: 'PATCH',
            headers: { ...headers({ cookie, 'x-csrf-token': csrf }), origin: 'https://evil.test' },
            body: JSON.stringify({ defaultTimezone: 'UTC' }),
        });
        expect(badOrigin.status).toBe(403);
        const changed = await request('/api/v1/me/preferences', {
            method: 'PATCH',
            headers: headers({ cookie, 'x-csrf-token': csrf }),
            body: JSON.stringify({ defaultTimezone: 'UTC' }),
        });
        expect(changed.status).toBe(200);
        expect((await responseJson(changed)).user.preferences.defaultTimezone).toBe('UTC');
        expect(
            (await responseJson(await request('/api/v1/me', { headers: { cookie } }))).csrfToken,
        ).toBe(csrf);
        const task = await prisma.task.create({
            data: { userId: (await prisma.user.findFirstOrThrow()).id, title: '版本不回写' },
        });
        const version = await prisma.taskVersion.create({
            data: {
                userId: task.userId,
                taskId: task.id,
                version: 1,
                configJson: { timezone: 'Asia/Shanghai' },
                comparisonScopeHash: hashText('scope'),
            },
        });
        await request('/api/v1/me/preferences', {
            method: 'PATCH',
            headers: headers({ cookie, 'x-csrf-token': csrf }),
            body: JSON.stringify({ defaultTimezone: 'America/New_York' }),
        });
        expect(
            (await prisma.taskVersion.findUniqueOrThrow({ where: { id: version.id } })).configJson,
        ).toEqual({ timezone: 'Asia/Shanghai' });
    });

    it('注销撤销会话并清理 Cookie，过期会话返回401', async () => {
        const response = await register();
        const cookie = cookieHeader(response);
        const csrf = (await responseJson(response)).csrfToken as string;
        app = new Elysia().use(createApiErrorPlugin()).use(createAuthPlugin(services));
        const logout = await request('/api/v1/auth/logout', {
            method: 'POST',
            headers: headers({ cookie, 'x-csrf-token': csrf }),
        });
        expect(logout.status).toBe(204);
        expect(logout.headers.get('set-cookie')).toMatch(/Max-Age=0/);
        expect((await request('/api/v1/me', { headers: { cookie } })).status).toBe(401);
        services = makeServices({ sessionTtlSeconds: 1 });
        const expiring = await register(undefined, services);
        const expiringCookie = cookieHeader(expiring);
        now = new Date(now.getTime() + 2000);
        app = new Elysia().use(createApiErrorPlugin()).use(createAuthPlugin(services));
        expect((await request('/api/v1/me', { headers: { cookie: expiringCookie } })).status).toBe(
            401,
        );
    });

    it('生产环境 Cookie 带 Secure，开发 Cookie 不带 Secure，均无 Domain 与明文 token', async () => {
        const production = makeServices({ production: true });
        const response = await register(undefined, production);
        const setCookie = response.headers.get('set-cookie') ?? '';
        expect(setCookie).toContain('Secure');
        expect(setCookie).not.toContain('Domain=');
        const session = await prisma.session.findFirstOrThrow({ orderBy: { createdAt: 'desc' } });
        expect(setCookie).not.toContain(session.tokenHash);
    });

    it('两个账号的资源 owner 查询隔离，越权任务统一404', async () => {
        const one = await register();
        const oneCookie = cookieHeader(one);
        const two = await register();
        expect(two.status).toBe(201);
        const users = await prisma.user.findMany({ orderBy: { createdAt: 'asc' } });
        const task = await prisma.task.create({
            data: { userId: users[0]!.id, title: '私有任务' },
        });
        const firstSession = await services.db().session.findFirstOrThrow({
            where: { userId: users[0]!.id },
            include: { owner: true },
        });
        const raw = await prisma.session.findFirstOrThrow({
            where: { userId: users[1]!.id },
            include: { owner: true },
        });
        const token = randomUUID();
        expect(raw.tokenHash).not.toBe(token);
        await expect(
            requireOwnedTask(
                task.id,
                {
                    id: firstSession.id,
                    userId: users[1]!.id,
                    user: raw.owner,
                    csrfToken: 'x',
                    csrfTokenHash: hashText('x'),
                    expiresAt: new Date(now.getTime() + 1000),
                },
                services,
            ),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
        expect(oneCookie).toContain('scova_session=');
    });
});
