import { randomUUID } from 'node:crypto';
import pg from 'pg';
import sharp from 'sharp';
import { Redis } from 'ioredis';
import { Elysia } from 'elysia';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { connectDatabase, createDatabaseClient, closeDatabase, eq, users } from '@scova/db';
import { migrateDatabase } from '@scova/db/migrate';
import type { ImageStorage } from '@scova/object-storage/image';
import { createDefaultServices } from '../src/app/services';
import { createApiErrorPlugin } from '../src/app/errors';
import { createAuthPlugin } from '../src/router/auth';
import { createAvatarPlugin } from '../src/router/avatar';

const baseUrl =
    process.env.SCOVA_TEST_DATABASE_URL ??
    'postgresql://scova_test:scova_test@127.0.0.1:55432/scova_test';
const schema = `scova_avatar_${randomUUID().replaceAll('-', '')}`;
const scoped = new URL(baseUrl);
scoped.searchParams.set('schema', schema);
const db = createDatabaseClient({ connectionString: scoped.href });
const admin = new pg.Client({ connectionString: baseUrl });
const redis = new Redis(process.env.SCOVA_TEST_REDIS_URL ?? 'redis://127.0.0.1:56379', {
    lazyConnect: true,
});
const origin = 'https://avatar.test';
const images = {
    upload: vi.fn(async (input) => ({
        key: input.key!,
        url: null,
        contentType: 'image/webp' as const,
        size: input.body.byteLength,
    })),
    delete: vi.fn<ImageStorage['delete']>(async () => {}),
    head: vi.fn(async () => null),
    getPublicUrl: () => null,
    presignUpload: vi.fn(),
    presignDownload: vi.fn(async () => 'https://private.example.com/avatar?signed=test'),
    destroy: vi.fn(),
} satisfies ImageStorage;
let enabled = true;
let png: Buffer;
const services = createDefaultServices({
    origin,
    clock: () => new Date('2026-11-09T00:00:00Z'),
    db: () => db,
    redis: () => redis,
    avatarStorage: () => (enabled ? images : null),
    rateLimit: {
        registerAttempts: 100,
        loginAttempts: 100,
        globalAttempts: 1000,
        keyPrefix: `avatar-test:${schema}:`,
    },
});
const app = new Elysia()
    .use(createApiErrorPlugin())
    .use(createAuthPlugin(services))
    .use(createAvatarPlugin(services));
interface Account {
    cookie: string;
    csrf: string;
    id: string;
}
async function account(): Promise<Account> {
    const response = await app.handle(
        new Request(`${origin}/api/v1/auth/register`, {
            method: 'POST',
            headers: { origin, 'content-type': 'application/json' },
            body: JSON.stringify({
                email: `${randomUUID()}@example.test`,
                password: 'avatar-test-password',
                defaultTimezone: 'UTC',
            }),
        }),
    );
    expect(response.status).toBe(201);
    const body = await response.json();
    return {
        cookie: response.headers.get('set-cookie')!.split(';')[0]!,
        csrf: body.csrfToken,
        id: body.user.id,
    };
}
const send = (
    owner: Account | null,
    method = 'GET',
    query = '',
    body?: Uint8Array,
    extra: Record<string, string> = {},
) =>
    app.handle(
        new Request(`${origin}/api/v1/me/avatar${query}`, {
            method,
            headers: {
                origin,
                ...(owner ? { cookie: owner.cookie, 'x-csrf-token': owner.csrf } : {}),
                ...(body ? { 'content-type': 'image/png' } : {}),
                ...extra,
            },
            ...(method === 'PUT' && body ? { body: new Uint8Array(body) } : {}),
        }),
    );

describe('账号头像真实PG与受控图床', () => {
    beforeAll(async () => {
        await admin.connect();
        await admin.query(`CREATE SCHEMA "${schema}"`);
        await migrateDatabase({ connectionString: scoped.href });
        await connectDatabase(db);
        await redis.connect();
        png = await sharp({
            create: { width: 400, height: 200, channels: 3, background: '#6688cc' },
        })
            .png()
            .toBuffer();
    }, 120_000);
    beforeEach(async () => {
        await redis.flushdb();
        vi.clearAllMocks();
        enabled = true;
    });
    afterAll(async () => {
        await closeDatabase(db);
        await redis.quit();
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.end();
    });

    it('未登录和CSRF错误不访问图床', async () => {
        expect((await send(null, 'PUT', '?expectedVersion=none', png)).status).toBe(401);
        const owner = await account();
        expect(
            (await send(owner, 'PUT', '?expectedVersion=none', png, { 'x-csrf-token': 'wrong' }))
                .status,
        ).toBe(403);
        expect(images.upload).not.toHaveBeenCalled();
    });
    it('私有头像重编码、持久化并在恢复会话中返回版本', async () => {
        const owner = await account();
        const response = await send(owner, 'PUT', '?expectedVersion=none', png);
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.user.avatarVersion).toMatch(/^[0-9a-f-]{36}$/);
        expect(body.csrfToken).toBe(owner.csrf);
        const upload = vi.mocked(images.upload).mock.calls[0]![0];
        expect(upload.key).toBe(`avatars/${owner.id}/${body.user.avatarVersion}.webp`);
        const metadata = await sharp(upload.body).metadata();
        expect(metadata).toMatchObject({ format: 'webp', width: 256, height: 256 });
        expect(metadata.exif).toBeUndefined();
        const restored = await app.handle(
            new Request(`${origin}/api/v1/me`, { headers: { cookie: owner.cookie } }),
        );
        expect((await restored.json()).user.avatarVersion).toBe(body.user.avatarVersion);
        expect(JSON.stringify(body)).not.toContain('avatars/');
    });
    it('仅本人当前版本可读取，旧版本与其他账号均404', async () => {
        const owner = await account();
        const other = await account();
        const uploaded = await (await send(owner, 'PUT', '?expectedVersion=none', png)).json();
        const version = uploaded.user.avatarVersion;
        const image = await send(owner, 'GET', `/${version}`);
        expect(image.status).toBe(302);
        expect(image.headers.get('location')).toBe(
            'https://private.example.com/avatar?signed=test',
        );
        expect(image.headers.get('cache-control')).toContain('no-store');
        expect((await send(other, 'GET', `/${version}`)).status).toBe(404);
        expect((await send(owner, 'GET', `/${randomUUID()}`)).status).toBe(404);
    });
    it('替换后清理旧对象，移除恢复默认头像', async () => {
        const owner = await account();
        const first = (await (await send(owner, 'PUT', '?expectedVersion=none', png)).json()).user
            .avatarVersion;
        const second = (await (await send(owner, 'PUT', `?expectedVersion=${first}`, png)).json())
            .user.avatarVersion;
        expect(second).not.toBe(first);
        expect(images.delete).toHaveBeenCalledWith(
            `avatars/${owner.id}/${first}.webp`,
            expect.anything(),
        );
        const removed = await send(owner, 'DELETE', `?expectedVersion=${second}`);
        expect(removed.status).toBe(200);
        expect((await removed.json()).user.avatarVersion).toBeNull();
        expect((await send(owner, 'GET', `/${second}`)).status).toBe(404);
    });
    it('旧版本修改返回409，原头像保持不变', async () => {
        const owner = await account();
        const version = (await (await send(owner, 'PUT', '?expectedVersion=none', png)).json()).user
            .avatarVersion;
        expect((await send(owner, 'PUT', '?expectedVersion=none', png)).status).toBe(409);
        expect((await send(owner, 'DELETE', '?expectedVersion=none')).status).toBe(409);
        expect(
            (await db.query.users.findFirst({ where: eq(users.id, owner.id) }))?.avatarVersion,
        ).toBe(version);
    });
    it('并发首次上传只有一份提交，冲突候选被清理', async () => {
        const owner = await account();
        const responses = await Promise.all([
            send(owner, 'PUT', '?expectedVersion=none', png),
            send(owner, 'PUT', '?expectedVersion=none', png),
        ]);
        expect(responses.map((response) => response.status).sort((a, b) => a - b)).toEqual([
            200, 409,
        ]);
        const current = (await db.query.users.findFirst({ where: eq(users.id, owner.id) }))!
            .avatarVersion;
        for (const [key] of vi.mocked(images.delete).mock.calls)
            expect(key).not.toContain(current!);
    });
    it('图床失败保留原头像且不泄漏上游信息', async () => {
        const owner = await account();
        vi.mocked(images.upload).mockRejectedValueOnce(new Error('SECRET_UPSTREAM_TOKEN'));
        const response = await send(owner, 'PUT', '?expectedVersion=none', png);
        expect(response.status).toBe(503);
        expect(await response.text()).not.toContain('SECRET_UPSTREAM_TOKEN');
        expect(
            (await db.query.users.findFirst({ where: eq(users.id, owner.id) }))?.avatarVersion,
        ).toBeNull();
    });
    it('旧对象清理失败不撤销已完成的头像替换', async () => {
        const owner = await account();
        const first = (await (await send(owner, 'PUT', '?expectedVersion=none', png)).json()).user
            .avatarVersion;
        vi.mocked(images.delete).mockRejectedValueOnce(new Error('cleanup failed'));
        const response = await send(owner, 'PUT', `?expectedVersion=${first}`, png);
        expect(response.status).toBe(200);
        expect((await response.json()).user.avatarVersion).not.toBe(first);
    });
    it('不接受SVG、伪造文件头、不完整图片与超限请求', async () => {
        const owner = await account();
        expect(
            (
                await send(owner, 'PUT', '?expectedVersion=none', Buffer.from('<svg/>'), {
                    'content-type': 'image/svg+xml',
                })
            ).status,
        ).toBe(415);
        expect(
            (await send(owner, 'PUT', '?expectedVersion=none', Buffer.from('not png'))).status,
        ).toBe(422);
        expect((await send(owner, 'PUT', '?expectedVersion=none', png.subarray(0, 8))).status).toBe(
            422,
        );
        expect(
            (
                await send(owner, 'PUT', '?expectedVersion=none', png, {
                    'content-length': '5242881',
                })
            ).status,
        ).toBe(413);
        expect(images.upload).not.toHaveBeenCalled();
    });
    it('未配置存储时可读取状态、禁止上传且不影响原账号功能', async () => {
        const owner = await account();
        enabled = false;
        expect(await (await send(owner)).json()).toEqual({ available: false, version: null });
        expect((await send(owner, 'PUT', '?expectedVersion=none', png)).status).toBe(503);
        expect((await send(owner, 'DELETE', '?expectedVersion=none')).status).toBe(200);
    });
    it('同账号每分钟最多10次头像写操作', async () => {
        const owner = await account();
        for (let index = 0; index < 10; index++)
            expect((await send(owner, 'DELETE', '?expectedVersion=none')).status).toBe(200);
        const limited = await send(owner, 'DELETE', '?expectedVersion=none');
        expect(limited.status).toBe(429);
        expect(limited.headers.get('retry-after')).toBe('60');
    });
});
