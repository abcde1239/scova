import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { Elysia } from 'elysia';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
    createDatabaseClient,
    closeDatabase,
    users,
    sessions,
    agentProviders,
    searchConfigurations,
    eq,
} from '@scova/db';
import { migrateDatabase } from '@scova/db/migrate';
import { openCredential, sealProviderCredentials } from '@scova/shared/credentials';
import { BRAVE_SEARCH_PRESET, type SearchConfiguration } from '@scova/models';
import { createDefaultServices } from '../src/app/services';
import { createApiErrorPlugin } from '../src/app/errors';
import { createSearchConfigurationPlugin } from '../src/router/search-configuration';
import { csrfForSession, tokenHash } from '../src/utils/security';

const baseUrl =
    process.env.SCOVA_TEST_DATABASE_URL ??
    process.env.RUNTIME_DATABASE_URL ??
    'postgresql://scova_test:scova_test@127.0.0.1:55432/scova_test';
const schema = `scova_search_config_${randomUUID().replaceAll('-', '')}`;
const scopedUrl = new URL(baseUrl);
scopedUrl.searchParams.set('schema', schema);
const db = createDatabaseClient({ connectionString: scopedUrl.toString() });
const admin = new pg.Client({ connectionString: baseUrl });
const origin = 'https://scova.test';
const encryptionKey = 'ac'.repeat(32);
const api = {
    protocol: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    contentMode: 'reader',
    apiKey: 'independent-search-private-key',
};
const services = createDefaultServices({ origin, db: () => db, production: false });
const app = new Elysia().use(createApiErrorPlugin()).use(createSearchConfigurationPlugin(services));
type Account = { id: string; token: string; csrf: string };
let owner: Account, other: Account;
async function account(): Promise<Account> {
    const id = randomUUID(),
        token = randomBytes(32).toString('base64url'),
        csrf = csrfForSession(token);
    await db.insert(users).values({
        id,
        email: `${id}@example.test`,
        normalizedEmail: `${id}@example.test`,
        passwordHash: 'test-only',
    });
    await db.insert(sessions).values({
        userId: id,
        tokenHash: tokenHash(token),
        csrfTokenHash: tokenHash(csrf),
        expiresAt: new Date(Date.now() + 3600_000),
    });
    return { id, token, csrf };
}
function request(
    method = 'GET',
    suffix = '',
    body?: unknown,
    who: Account | null = owner,
    extra: Record<string, string> = {},
) {
    return app.handle(
        new Request(`${origin}/api/v1/me/search-configuration${suffix}`, {
            method,
            headers: {
                origin,
                'content-type': 'application/json',
                ...(who ? { cookie: `scova_session=${who.token}`, 'x-csrf-token': who.csrf } : {}),
                ...extra,
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
    );
}
async function save(body: unknown) {
    const response = await request('PUT', '', body);
    expect(response.status).toBe(200);
    return (await response.json()) as SearchConfiguration;
}
beforeAll(async () => {
    vi.stubEnv('AGENT_CREDENTIAL_KEY', encryptionKey);
    await admin.connect();
    await migrateDatabase({ connectionString: scopedUrl.toString() });
});
beforeEach(async () => {
    vi.stubEnv('AGENT_CREDENTIAL_KEY', encryptionKey);
    owner = await account();
    other = await account();
});
afterAll(async () => {
    await closeDatabase(db);
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
    vi.unstubAllEnvs();
});

describe('独立搜索与正文提取配置', () => {
    it('保存仅搜索的自定义模板，显式使用本地 Reader，并隔离密钥与账号', async () => {
        const saved = await save({
            defaultMode: 'api',
            api: {
                ...BRAVE_SEARCH_PRESET,
                protocol: 'custom_json',
                contentMode: 'reader',
                apiKey: api.apiKey,
            },
        });
        expect(saved.api).toMatchObject({
            protocol: 'custom_json',
            contentMode: 'reader',
            custom: BRAVE_SEARCH_PRESET.custom,
            hasApiKey: true,
        });
        expect(JSON.stringify(saved)).not.toContain(api.apiKey);
        const loaded = (await (await request()).json()).configuration;
        expect(loaded.api.custom).toEqual(BRAVE_SEARCH_PRESET.custom);
        const row = (
            await db
                .select()
                .from(searchConfigurations)
                .where(eq(searchConfigurations.userId, owner.id))
        )[0]!;
        expect(openCredential(row.encryptedApiKey!, owner.id, row.id)).toBe(api.apiKey);
        expect(row.customTemplate).toEqual(BRAVE_SEARCH_PRESET.custom);
        expect(
            (await (await request('GET', '', undefined, other)).json()).configuration,
        ).toBeNull();
        const current = await save({ revision: saved.revision, defaultMode: 'searxng' });
        expect(current.api?.contentMode).toBe('reader');
    });
    it('相同自定义模板可以保留密钥，修改认证头或模板必须重新确认密钥', async () => {
        const customApi = {
            ...BRAVE_SEARCH_PRESET,
            protocol: 'custom_json',
            contentMode: 'reader',
        };
        const saved = await save({ defaultMode: 'api', api: { ...customApi, apiKey: api.apiKey } });
        const retained = await save({
            revision: saved.revision,
            defaultMode: 'api',
            api: customApi,
        });
        const changedTemplate = {
            ...customApi.custom,
            auth: { type: 'header', headerName: 'X-Api-Key' },
        };
        const response = await request('PUT', '', {
            revision: retained.revision,
            defaultMode: 'api',
            api: { ...customApi, custom: changedTemplate },
        });
        expect(response.status).toBe(422);
        expect(JSON.stringify(await response.json())).not.toContain(api.apiKey);
        expect((await (await request()).json()).configuration.revision).toBe(retained.revision);
    });
    it('拒绝自定义读取策略歧义、任意头和模板中明文密钥', async () => {
        for (const customApi of [
            { ...BRAVE_SEARCH_PRESET, protocol: 'custom_json', contentMode: 'prefer_api' },
            {
                ...BRAVE_SEARCH_PRESET,
                protocol: 'custom_json',
                contentMode: 'reader',
                custom: {
                    ...BRAVE_SEARCH_PRESET.custom,
                    auth: { type: 'header', headerName: 'Cookie' },
                },
            },
            {
                ...BRAVE_SEARCH_PRESET,
                protocol: 'custom_json',
                contentMode: 'reader',
                custom: {
                    ...BRAVE_SEARCH_PRESET.custom,
                    request: { q: '{{query}}', api_key: 'plaintext-secret' },
                },
            },
        ]) {
            const response = await request('PUT', '', {
                defaultMode: 'api',
                api: { ...customApi, apiKey: api.apiKey },
            });
            expect(response.status).toBe(422);
            expect(JSON.stringify(await response.json())).not.toContain(api.apiKey);
        }
    });
    it('没有账号配置时返回空，不读取环境中的默认搜索服务或密钥', async () => {
        vi.stubEnv('SEARCH_PROVIDER', 'api');
        vi.stubEnv('SEARCH_API_KEY', 'obsolete-server-key');
        vi.stubEnv('TAVILY_API_KEY', 'obsolete-tavily-key');
        const response = await request();
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ configuration: null, storageReady: true });
        expect(response.headers.get('cache-control')).toBe('no-store');
    });
    it('隔离账号并加密搜索密钥，模型记录不是独立搜索配置的依赖', async () => {
        const saved = await save({ defaultMode: 'api', api });
        expect(saved).toMatchObject({
            revision: 1,
            defaultMode: 'api',
            api: { protocol: 'deepseek', hasApiKey: true, contentMode: 'prefer_api' },
        });
        expect(JSON.stringify(saved)).not.toContain(api.apiKey);
        const row = (
            await db
                .select()
                .from(searchConfigurations)
                .where(eq(searchConfigurations.userId, owner.id))
        )[0]!;
        expect(row.encryptedApiKey).not.toContain(api.apiKey);
        expect(row.contentMode).toBe('prefer_api');
        expect(openCredential(row.encryptedApiKey!, owner.id, row.id)).toBe(api.apiKey);
        expect(() => openCredential(row.encryptedApiKey!, other.id, row.id)).toThrow();
        expect(
            (await (await request('GET', '', undefined, other)).json()).configuration,
        ).toBeNull();
        expect(
            await db.select().from(agentProviders).where(eq(agentProviders.userId, owner.id)),
        ).toEqual([]);
    });
    it('旧 Reader 策略读取时归一化，保存后保留原密钥并使用 API 读取', async () => {
        const saved = await save({ defaultMode: 'api', api });
        await db
            .update(searchConfigurations)
            .set({ contentMode: 'reader' })
            .where(eq(searchConfigurations.userId, owner.id));
        const loaded = (await (await request()).json()).configuration as SearchConfiguration;
        expect(loaded.api?.contentMode).toBe('prefer_api');
        const current = await save({ defaultMode: 'api', revision: saved.revision });
        expect(current.api?.contentMode).toBe('prefer_api');
        const row = (
            await db
                .select()
                .from(searchConfigurations)
                .where(eq(searchConfigurations.userId, owner.id))
        )[0]!;
        expect(row.contentMode).toBe('prefer_api');
        expect(openCredential(row.encryptedApiKey!, owner.id, row.id)).toBe(api.apiKey);
    });
    it('不启用仅支持搜索的协议，不调用模型读取或本地 Reader', async () => {
        const response = await request('PUT', '', {
            defaultMode: 'api',
            api: { ...api, protocol: 'perplexity', baseUrl: 'https://api.perplexity.ai' },
        });
        expect(response.status).toBe(422);
        const body = await response.json();
        expect(JSON.stringify(body)).toContain('DeepSeek');
        expect(JSON.stringify(body)).not.toContain(api.apiKey);
        expect(
            await db
                .select()
                .from(searchConfigurations)
                .where(eq(searchConfigurations.userId, owner.id)),
        ).toEqual([]);
    });
    it('同地址和协议保留密钥，改地址或协议须重新填密钥，空值只能在内置模式移除', async () => {
        const saved = await save({ defaultMode: 'api', api });
        const changed = await save({
            revision: saved.revision,
            defaultMode: 'api',
            api: { protocol: api.protocol, baseUrl: api.baseUrl + '/', contentMode: 'prefer_api' },
        });
        expect(changed.api?.contentMode).toBe('prefer_api');
        for (const next of [
            { ...api, apiKey: undefined, baseUrl: 'https://different.example/v1' },
            { ...api, apiKey: undefined, protocol: 'tavily' },
        ])
            expect(
                (
                    await request('PUT', '', {
                        revision: changed.revision,
                        defaultMode: 'api',
                        api: next,
                    })
                ).status,
            ).toBe(422);
        expect(
            (
                await request('PUT', '', {
                    revision: changed.revision,
                    defaultMode: 'api',
                    api: null,
                })
            ).status,
        ).toBe(422);
        const builtin = await save({
            revision: changed.revision,
            defaultMode: 'searxng',
            api: null,
        });
        expect(builtin.api).toBeNull();
    });
    it('首次保存与并发更新严格校验修订号，省略配置保留原 API', async () => {
        expect((await request('PUT', '', { revision: 1, defaultMode: 'searxng' })).status).toBe(
            409,
        );
        const saved = await save({ defaultMode: 'api', api });
        expect((await request('PUT', '', { defaultMode: 'searxng' })).status).toBe(409);
        const responses = await Promise.all([
            request('PUT', '', { revision: saved.revision, defaultMode: 'api' }),
            request('PUT', '', { revision: saved.revision, defaultMode: 'searxng' }),
        ]);
        expect(responses.map((r) => r.status).sort((left, right) => left - right)).toEqual([
            200, 409,
        ]);
        const current = (await (await request()).json()).configuration as SearchConfiguration;
        expect(current.revision).toBe(2);
        expect(current.api?.hasApiKey).toBe(true);
    });
    it('写入要求当前会话和 CSRF，拒绝非公开或非 HTTPS 地址且不泄露密钥', async () => {
        expect((await request('GET', '', undefined, null)).status).toBe(401);
        expect(
            (await request('PUT', '', { defaultMode: 'api', api }, owner, { 'x-csrf-token': '' }))
                .status,
        ).toBe(403);
        for (const address of [
            'http://api.example.com',
            'https://127.0.0.1/v1',
            'https://api.example.com/v1?secret=123',
        ]) {
            const response = await request('PUT', '', {
                defaultMode: 'api',
                api: { ...api, baseUrl: address },
            });
            expect(response.status).toBe(422);
            expect(JSON.stringify(await response.json())).not.toContain(api.apiKey);
        }
        vi.stubEnv('AGENT_CREDENTIAL_KEY', '');
        expect((await (await request()).json()).storageReady).toBe(false);
        expect((await request('PUT', '', { defaultMode: 'searxng' })).status).toBe(503);
    });
    it('显式迁入旧搜索后独立重新加密，删除或更改原模型不影响搜索配置', async () => {
        const providerId = randomUUID();
        await db.insert(agentProviders).values({
            id: providerId,
            userId: owner.id,
            name: '历史模型',
            baseUrl: 'https://api.example.com/v1',
            model: 'legacy',
            encryptedApiKey: sealProviderCredentials(
                {
                    modelApiKey: 'model-only-secret',
                    searchApi: { ...api, protocol: 'deepseek', contentMode: 'reader' },
                },
                owner.id,
                providerId,
            ),
        });
        expect(
            (await request('POST', `/import/${providerId}`, { providerRevision: 2 })).status,
        ).toBe(409);
        expect(
            (await request('POST', `/import/${providerId}`, { providerRevision: 1 }, other)).status,
        ).toBe(404);
        const imported = await request('POST', `/import/${providerId}`, { providerRevision: 1 });
        expect(imported.status).toBe(200);
        const row = (
            await db
                .select()
                .from(searchConfigurations)
                .where(eq(searchConfigurations.userId, owner.id))
        )[0]!;
        expect(row.id).not.toBe(providerId);
        expect(openCredential(row.encryptedApiKey!, owner.id, row.id)).toBe(api.apiKey);
        await db.delete(agentProviders).where(eq(agentProviders.id, providerId));
        expect((await (await request()).json()).configuration).toMatchObject({
            defaultMode: 'api',
            api: { hasApiKey: true },
        });
    });
});
