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
    eq,
} from '@scova/db';
import { migrateDatabase } from '@scova/db/migrate';
import { openCredential, openProviderCredentials } from '@scova/shared/credentials';
import type { AgentProvider } from '@scova/models';
import type { readProviderBalance } from '@scova/connectors';
import { createDefaultServices } from '../src/app/services';
import { createApiErrorPlugin } from '../src/app/errors';
import { createAgentProviderPlugin } from '../src/router/agent-providers';
import { createAgentProviderService } from '../src/service/agent-providers';
import { csrfForSession, tokenHash } from '../src/utils/security';
import { activeAgentProvider } from '../../worker/src/repo/agent-providers';
import { ConnectorError } from '@scova/connectors';

const baseUrl =
    process.env.SCOVA_TEST_DATABASE_URL ??
    process.env.RUNTIME_DATABASE_URL ??
    'postgresql://scova_test:scova_test@127.0.0.1:55432/scova_test';
const schema = `scova_providers_${randomUUID().replaceAll('-', '')}`;
const scopedUrl = new URL(baseUrl);
scopedUrl.searchParams.set('schema', schema);
const db = createDatabaseClient({ connectionString: scopedUrl.toString() });
const admin = new pg.Client({ connectionString: baseUrl });
const origin = 'https://scova.test';
const encryptionKey = 'ab'.repeat(32);
const input = {
    name: '研究模型',
    model: 'test-model',
    baseUrl: 'https://api.example.com/v1',
    protocol: 'openai_chat_completions',
    apiKey: 'fixture-private-key',
};
const providerModels = vi.fn(async () => ({
    items: [{ id: 'model-a', name: 'Model A' }],
    truncated: false,
}));
const providerBalance = vi.fn<typeof readProviderBalance>(async () => ({
    adapter: 'deepseek',
    items: [{ label: '账号余额', scope: 'account', remaining: 6.88, unit: 'CNY' }],
}));
const services = createDefaultServices({
    origin,
    db: () => db,
    production: false,
    providerModels,
    providerBalance,
});
const service = createAgentProviderService(services);
const app = new Elysia().use(createApiErrorPlugin()).use(createAgentProviderPlugin(services));
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
        new Request(`${origin}/api/v1/me/agent-providers${suffix}`, {
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
async function create(overrides = {}) {
    const response = await request('POST', '', { ...input, ...overrides });
    expect(response.status).toBe(201);
    return (await response.json()) as AgentProvider;
}
describe('账号供应商的 HTTP、数据库与模型选择', () => {
    it('独立搜索配置脱敏、独立加密、密钥保留与账号隔离，拒绝向新地址复用密钥', async () => {
        const searchApi = {
            protocol: 'deepseek',
            baseUrl: 'https://api.deepseek.com/v1',
            apiKey: 'search-private-key',
            contentMode: 'prefer_api',
        };
        const p = await create({ searchApi });
        expect(p.searchApi).toEqual({
            protocol: searchApi.protocol,
            baseUrl: searchApi.baseUrl,
            contentMode: 'prefer_api',
            hasApiKey: true,
        });
        expect(JSON.stringify(p)).not.toContain(searchApi.apiKey);
        const row = (await db.select().from(agentProviders).where(eq(agentProviders.id, p.id)))[0]!;
        expect(row.encryptedApiKey).not.toContain(searchApi.apiKey);
        expect(openProviderCredentials(row.encryptedApiKey, owner.id, p.id)).toEqual({
            modelApiKey: input.apiKey,
            searchApi,
        });
        const balance = await request('POST', `/${p.id}/balance`, { revision: p.revision });
        expect(balance.status).toBe(200);
        expect(providerBalance).toHaveBeenLastCalledWith(
            expect.objectContaining({ apiKey: input.apiKey }),
        );
        expect((await request('GET', '', undefined, other)).status).toBe(200);
        expect(
            JSON.stringify(await (await request('GET', '', undefined, other)).json()),
        ).not.toContain(p.id);
        const preserved = await request('PATCH', `/${p.id}`, {
            ...input,
            apiKey: 'rotated-model-key',
            revision: p.revision,
        });
        expect(preserved.status).toBe(200);
        const saved = (await preserved.json()) as AgentProvider;
        expect(saved.searchApi).toEqual(p.searchApi);
        const changed = await request('PATCH', `/${p.id}`, {
            ...input,
            revision: saved.revision,
            searchApi: {
                protocol: 'deepseek',
                baseUrl: 'https://new.example/v1',
                contentMode: 'prefer_api',
            },
        });
        expect(changed.status).toBe(422);
        expect(JSON.stringify(await changed.json())).not.toContain(searchApi.apiKey);
        const dual = await request('PATCH', `/${p.id}`, {
            ...input,
            revision: saved.revision,
            webSearch: 'openai_responses',
        });
        expect(dual.status).toBe(422);
        const edit = await request('PATCH', `/${p.id}`, {
            ...input,
            revision: saved.revision,
            searchApi: { protocol: 'deepseek', baseUrl: searchApi.baseUrl, contentMode: 'reader' },
        });
        expect(edit.status).toBe(200);
        const edited = (await edit.json()) as AgentProvider;
        expect(edited.searchApi?.contentMode).toBe('reader');
        const updated = (
            await db.select().from(agentProviders).where(eq(agentProviders.id, p.id))
        )[0]!;
        expect(
            openProviderCredentials(updated.encryptedApiKey, owner.id, p.id).searchApi?.apiKey,
        ).toBe(searchApi.apiKey);
        const removed = await request('PATCH', `/${p.id}`, {
            ...input,
            revision: edited.revision,
            searchApi: null,
        });
        expect(removed.status).toBe(200);
        expect(((await removed.json()) as AgentProvider).searchApi).toBeNull();
        expect(JSON.stringify(await (await request('GET')).json())).not.toContain(
            'search-private-key',
        );
    });
    it('内置搜索默认关闭、显式授权、旧客户端保留，协议变更需匹配且账号隔离', async () => {
        const p = await create();
        expect(p.webSearch).toBe('disabled');
        const enabled = await request('PATCH', `/${p.id}`, {
            ...input,
            revision: p.revision,
            webSearch: 'openai_responses',
        });
        expect(enabled.status).toBe(200);
        const saved = (await enabled.json()) as AgentProvider;
        expect(saved.webSearch).toBe('openai_responses');
        expect((await activeAgentProvider(db, owner.id, p.id))?.webSearch).toBe('openai_responses');
        expect(await activeAgentProvider(db, other.id, p.id)).toBeNull();
        const legacy = await request('PATCH', `/${p.id}`, { ...input, revision: saved.revision });
        expect(legacy.status).toBe(200);
        const kept = (await legacy.json()) as AgentProvider;
        expect(kept.webSearch).toBe('openai_responses');
        expect(
            (
                await request('PATCH', `/${p.id}`, {
                    ...input,
                    protocol: 'gemini',
                    revision: kept.revision,
                })
            ).status,
        ).toBe(422);
        expect(
            (
                await request(
                    'PATCH',
                    `/${p.id}`,
                    { ...input, revision: kept.revision, webSearch: 'disabled' },
                    other,
                )
            ).status,
        ).toBe(404);
        const disabled = await request('PATCH', `/${p.id}`, {
            ...input,
            protocol: 'gemini',
            revision: kept.revision,
            webSearch: 'disabled',
        });
        expect(disabled.status).toBe(200);
        expect((await disabled.json()).webSearch).toBe('disabled');
        expect(
            (await request('POST', '', { ...input, webSearch: 'anthropic_web_search' })).status,
        ).toBe(422);
        expect(
            (await create({ protocol: 'anthropic_messages', webSearch: 'anthropic_web_search' }))
                .webSearch,
        ).toBe('anthropic_web_search');
        expect(providerModels).not.toHaveBeenCalled();
    });
    beforeAll(async () => {
        await admin.connect();
        await migrateDatabase({ connectionString: scopedUrl.toString() });
    }, 120_000);
    beforeEach(async () => {
        providerBalance.mockReset();
        providerBalance.mockResolvedValue({
            adapter: 'deepseek',
            items: [{ label: '账号余额', scope: 'account', remaining: 6.88, unit: 'CNY' }],
        });
        providerModels.mockReset();
        providerModels.mockResolvedValue({
            items: [{ id: 'model-a', name: 'Model A' }],
            truncated: false,
        });
        vi.stubEnv('AGENT_CREDENTIAL_KEY', encryptionKey);
        owner = await account();
        other = await account();
    });
    afterAll(async () => {
        vi.unstubAllEnvs();
        await closeDatabase(db);
        if (/^scova_providers_[0-9a-f]{32}$/.test(schema))
            await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await admin.end();
    });
    it('额度读取要求本人会话、CSRF和修订号，复用密钥但不改配置', async () => {
        const p = await create();
        expect((await request('POST', `/${p.id}/balance`, { revision: 1 }, null)).status).toBe(401);
        expect(
            (
                await request('POST', `/${p.id}/balance`, { revision: 1 }, owner, {
                    'x-csrf-token': '',
                })
            ).status,
        ).toBe(403);
        expect((await request('POST', `/${p.id}/balance`, { revision: 1 }, other)).status).toBe(
            404,
        );
        expect((await request('POST', `/${p.id}/balance`, { revision: 2 })).status).toBe(409);
        expect(providerBalance).not.toHaveBeenCalled();
        const before = (
            await db.select().from(agentProviders).where(eq(agentProviders.id, p.id))
        )[0];
        const result = await request('POST', `/${p.id}/balance`, {
            revision: 1,
            template: 'new_api',
        });
        expect(result.status).toBe(200);
        expect(result.headers.get('cache-control')).toBe('no-store');
        const body = await result.json();
        expect(body).toMatchObject({
            adapter: 'deepseek',
            items: [{ scope: 'account', remaining: 6.88, unit: 'CNY' }],
        });
        expect(JSON.stringify(body)).not.toContain(input.apiKey);
        expect(providerBalance.mock.calls[0]?.[0]).toMatchObject({
            baseUrl: input.baseUrl,
            apiKey: input.apiKey,
            template: 'new_api',
        });
        const after = (
            await db.select().from(agentProviders).where(eq(agentProviders.id, p.id))
        )[0];
        expect(after).toEqual(before);
    });
    it.each([
        ['balance_unsupported', undefined, 'PROVIDER_BALANCE_UNSUPPORTED', 422],
        ['http', 403, 'PROVIDER_BALANCE_AUTH', 422],
        ['http', 404, 'PROVIDER_BALANCE_UNSUPPORTED', 422],
        ['network', undefined, 'PROVIDER_BALANCE_NETWORK', 503],
        ['invalid_response', undefined, 'PROVIDER_BALANCE_INVALID_RESPONSE', 503],
        ['http', 429, 'PROVIDER_BALANCE_RATE_LIMITED', 503],
    ] as const)('额度错误脱敏：%s/%s', async (code, status, expectedCode, expectedStatus) => {
        const p = await create();
        providerBalance.mockRejectedValueOnce(
            new ConnectorError(code, 'fixture-private-key UPSTREAM_SECRET', false, status),
        );
        const response = await request('POST', `/${p.id}/balance`, { revision: 1 });
        expect(response.status).toBe(expectedStatus);
        const body = await response.json();
        expect(body.code).toBe(expectedCode);
        expect(JSON.stringify(body)).not.toContain('UPSTREAM_SECRET');
        expect(JSON.stringify(body)).not.toContain(input.apiKey);
    });
    it('加密存储且不回显密钥；不同账号列表、读取与写入均隔离', async () => {
        const provider = await create();
        expect(provider).not.toHaveProperty('apiKey');
        const row = (
            await db.select().from(agentProviders).where(eq(agentProviders.id, provider.id))
        )[0]!;
        expect(row.encryptedApiKey).not.toContain(input.apiKey);
        expect(openCredential(row.encryptedApiKey, owner.id, provider.id)).toBe(input.apiKey);
        const list = await request();
        expect(list.headers.get('cache-control')).toBe('no-store');
        expect(JSON.stringify(await list.json())).not.toContain(input.apiKey);
        expect((await (await request('GET', '', undefined, other)).json()).items).toEqual([]);
        for (const [method, path, body] of [
            ['PATCH', `/${provider.id}`, { ...input, revision: 1 }],
            ['POST', `/${provider.id}/activate`, { revision: 1 }],
            ['DELETE', `/${provider.id}`, { revision: 1 }],
        ] as const)
            expect((await request(method, path, body, other)).status).toBe(404);
        expect(await activeAgentProvider(db, other.id)).toBeNull();
    });
    it('读取新配置目录要求会话与CSRF，无密钥拒绝，成功不保存或激活配置', async () => {
        const body = { baseUrl: input.baseUrl, protocol: input.protocol, apiKey: input.apiKey };
        expect((await request('POST', '/models', body, null)).status).toBe(401);
        expect((await request('POST', '/models', body, owner, { 'x-csrf-token': '' })).status).toBe(
            403,
        );
        expect((await request('POST', '/models', { ...body, apiKey: undefined })).status).toBe(422);
        expect(providerModels).not.toHaveBeenCalled();
        const response = await request('POST', '/models', body);
        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(await response.json()).toEqual({
            items: [{ id: 'model-a', name: 'Model A' }],
            truncated: false,
        });
        expect((await service.list(owner.id)).items).toEqual([]);
    });
    it('目录复用本人指定修订密钥，不回显、修改记录或允许跨账号访问', async () => {
        const p = await create();
        const body = {
            baseUrl: input.baseUrl,
            protocol: input.protocol,
            providerId: p.id,
            revision: p.revision,
        };
        expect((await request('POST', '/models', body, other)).status).toBe(404);
        expect((await request('POST', '/models', { ...body, revision: 99 })).status).toBe(409);
        expect(providerModels).not.toHaveBeenCalled();
        const response = await request('POST', '/models', body);
        expect(response.status).toBe(200);
        expect(providerModels).toHaveBeenCalledWith(
            expect.objectContaining({ apiKey: input.apiKey, baseUrl: input.baseUrl }),
        );
        expect(JSON.stringify(await response.json())).not.toContain(input.apiKey);
        expect((await service.list(owner.id)).items).toEqual([p]);
    });
    it('改变目的地址或协议不能复用已存密钥，新密钥仅用于本次目录读取', async () => {
        const p = await create();
        const body = {
            baseUrl: input.baseUrl,
            protocol: input.protocol,
            providerId: p.id,
            revision: 1,
        };
        expect(
            (await request('POST', '/models', { ...body, baseUrl: 'https://other.example.com/v1' }))
                .status,
        ).toBe(422);
        expect((await request('POST', '/models', { ...body, protocol: 'gemini' })).status).toBe(
            422,
        );
        expect(providerModels).not.toHaveBeenCalled();
        expect(
            (
                await request('POST', '/models', {
                    ...body,
                    baseUrl: 'https://other.example.com/v1',
                    apiKey: 'new-fixture-secret',
                })
            ).status,
        ).toBe(200);
        expect(providerModels).toHaveBeenCalledWith(
            expect.objectContaining({ apiKey: 'new-fixture-secret' }),
        );
        expect((await service.list(owner.id)).items).toEqual([p]);
    });
    it.each([
        [new ConnectorError('http', 'fixture-private-key', false, 401), 422, 'MODEL_CATALOG_AUTH'],
        [
            new ConnectorError('http', 'fixture-private-key', false, 404),
            422,
            'MODEL_CATALOG_UNSUPPORTED',
        ],
        [new ConnectorError('timeout', 'fixture-private-key'), 503, 'MODEL_CATALOG_TIMEOUT'],
        [
            new ConnectorError('invalid_response', 'fixture-private-key'),
            503,
            'MODEL_CATALOG_INVALID_RESPONSE',
        ],
    ] as const)('目录错误脱敏且不误当本地会话失效：%s', async (error, status, code) => {
        providerModels.mockRejectedValueOnce(error);
        const response = await request('POST', '/models', {
            baseUrl: input.baseUrl,
            protocol: input.protocol,
            apiKey: input.apiKey,
        });
        expect(response.status).toBe(status);
        const json = await response.json();
        expect(json.code).toBe(code);
        expect(JSON.stringify(json)).not.toContain(input.apiKey);
        expect((await request()).status).toBe(200);
    });
    it('要求会话、Origin 和 CSRF，拒绝私网地址及未知协议', async () => {
        expect((await request('GET', '', undefined, null)).status).toBe(401);
        expect((await request('POST', '', input, owner, { 'x-csrf-token': '' })).status).toBe(403);
        expect(
            (await request('POST', '', input, owner, { origin: 'https://other.test' })).status,
        ).toBe(403);
        for (const baseUrl of [
            'http://api.example.com/v1',
            'https://127.0.0.1/v1',
            'https://api.example.com/v1?key=secret',
            'https://api.example.com/v1/chat/completions',
        ])
            expect((await request('POST', '', { ...input, baseUrl })).status).toBe(422);
        expect((await request('POST', '', { ...input, protocol: 'unknown' })).status).toBe(422);
    });
    it('编辑保留空缺密钥、允许显式替换，旧修订不能覆盖新配置', async () => {
        const provider = await create();
        const { apiKey: _key, ...fields } = input;
        const updated = await request('PATCH', `/${provider.id}`, {
            ...fields,
            model: 'new-model',
            revision: 1,
        });
        expect(updated.status).toBe(200);
        expect((await updated.json()).revision).toBe(2);
        let row = (
            await db.select().from(agentProviders).where(eq(agentProviders.id, provider.id))
        )[0]!;
        expect(openCredential(row.encryptedApiKey, owner.id, provider.id)).toBe(input.apiKey);
        expect((await request('PATCH', `/${provider.id}`, { ...input, revision: 1 })).status).toBe(
            409,
        );
        expect((await request('DELETE', `/${provider.id}`, { revision: 1 })).status).toBe(409);
        expect(
            (
                await request('PATCH', `/${provider.id}`, {
                    ...input,
                    apiKey: 'replacement',
                    revision: 2,
                })
            ).status,
        ).toBe(200);
        row = (
            await db.select().from(agentProviders).where(eq(agentProviders.id, provider.id))
        )[0]!;
        expect(openCredential(row.encryptedApiKey, owner.id, provider.id)).toBe('replacement');
    });
    it('并发切换后恰一项启用；重复旧操作冲突，删除当前配置恢复默认选择', async () => {
        const first = await create(),
            second = await create({ name: '另一个模型' });
        const responses = await Promise.all(
            [first, second].map((p) => request('POST', `/${p.id}/activate`, { revision: 1 })),
        );
        expect(responses.map((r) => r.status)).toEqual([200, 200]);
        const list = await service.list(owner.id);
        expect(list.items.filter((p) => p.active)).toHaveLength(1);
        const active = list.items.find((p) => p.active)!;
        expect((await activeAgentProvider(db, owner.id))?.id).toBe(active.id);
        expect((await request('POST', `/${active.id}/activate`, { revision: 1 })).status).toBe(409);
        expect(
            (await request('DELETE', `/${active.id}`, { revision: active.revision })).status,
        ).toBe(204);
        expect(await activeAgentProvider(db, owner.id)).toBeNull();
        expect(await service.model(owner.id)).toBeNull();
    });
    it.each(['openai_chat_completions', 'openai_json', 'anthropic_messages', 'gemini'])(
        'Server 草稿与问答及 Worker 都读取当前账号的 %s 配置',
        async (protocol) => {
            const provider = await create({ protocol });
            expect(
                (await request('POST', `/${provider.id}/activate`, { revision: 1 })).status,
            ).toBe(200);
            const research = await service.list(owner.id);
            const revision = research.items.find((item) => item.id === provider.id)!.revision;
            expect(
                (
                    await request('POST', `/${provider.id}/activate`, {
                        revision,
                        purpose: 'task_draft',
                    })
                ).status,
            ).toBe(200);
            expect(await services.taskDraftModel(owner.id)).toHaveProperty('generateStructured');
            expect(await services.reportQuestionModel(owner.id)).toHaveProperty(
                'generateStructured',
            );
            expect((await activeAgentProvider(db, owner.id))?.protocol).toBe(protocol);
            vi.stubEnv('AGENT_CREDENTIAL_KEY', 'cd'.repeat(32));
            await expect(services.taskDraftModel(owner.id)).rejects.toMatchObject({
                code: 'AGENT_CONFIGURATION_INVALID',
            });
        },
    );
    it('两种用途独立切换、可复用配置，草稿密钥故障不影响研究问答或其他账号', async () => {
        const research = await create({ name: '研究执行' });
        const drafting = await create({ name: '需求整理', model: 'draft-model' });
        expect(
            (
                await request('POST', `/${research.id}/activate`, {
                    revision: 1,
                    purpose: 'research',
                })
            ).status,
        ).toBe(200);
        expect(await service.model(owner.id, 'task_draft')).toBeNull();
        expect(
            (
                await request('POST', `/${drafting.id}/activate`, {
                    revision: 1,
                    purpose: 'task_draft',
                })
            ).status,
        ).toBe(200);
        let items = (await service.list(owner.id)).items;
        expect(items.find((p) => p.id === research.id)).toMatchObject({
            active: true,
            draftActive: false,
        });
        expect(items.find((p) => p.id === drafting.id)).toMatchObject({
            active: false,
            draftActive: true,
        });
        expect((await activeAgentProvider(db, owner.id))?.id).toBe(research.id);
        expect(await service.model(other.id, 'task_draft')).toBeNull();
        await db
            .update(agentProviders)
            .set({ encryptedApiKey: 'invalid-fixture' })
            .where(eq(agentProviders.id, drafting.id));
        await expect(services.taskDraftModel(owner.id)).rejects.toMatchObject({
            code: 'AGENT_CONFIGURATION_INVALID',
        });
        expect(await services.reportQuestionModel(owner.id)).toHaveProperty('generateStructured');
        const current = items.find((p) => p.id === research.id)!;
        expect(
            (
                await request('POST', `/${research.id}/activate`, {
                    revision: current.revision,
                    purpose: 'task_draft',
                })
            ).status,
        ).toBe(200);
        items = (await service.list(owner.id)).items;
        expect(items.find((p) => p.id === research.id)).toMatchObject({
            active: true,
            draftActive: true,
        });
        expect(items.find((p) => p.id === drafting.id)).toMatchObject({
            active: false,
            draftActive: false,
        });
        expect(await services.taskDraftModel(owner.id)).toHaveProperty('generateStructured');
        expect(
            (
                await request('POST', `/${research.id}/activate`, {
                    revision: current.revision,
                    purpose: 'task_draft',
                })
            ).status,
        ).toBe(409);
    });
    it('并发切换需求整理后唯一启用，研究执行不受影响', async () => {
        const research = await create(),
            first = await create(),
            second = await create();
        expect(
            (
                await request('POST', `/${research.id}/activate`, {
                    revision: 1,
                    purpose: 'research',
                })
            ).status,
        ).toBe(200);
        const responses = await Promise.all(
            [first, second].map((p) =>
                request('POST', `/${p.id}/activate`, { revision: 1, purpose: 'task_draft' }),
            ),
        );
        expect(responses.map((r) => r.status)).toEqual([200, 200]);
        const items = (await service.list(owner.id)).items;
        expect(items.filter((p) => p.draftActive)).toHaveLength(1);
        expect(items.filter((p) => p.active).map((p) => p.id)).toEqual([research.id]);
        const current = items.find((p) => p.draftActive)!;
        expect(
            (await request('DELETE', `/${current.id}`, { revision: current.revision })).status,
        ).toBe(204);
        expect(await service.model(owner.id, 'task_draft')).toBeNull();
        expect((await activeAgentProvider(db, owner.id))?.id).toBe(research.id);
    });
    it('缺失加密主密钥时仅可读取或删除，不能新增、编辑或切换', async () => {
        const provider = await create();
        vi.stubEnv('AGENT_CREDENTIAL_KEY', '');
        expect((await (await request()).json()).storageReady).toBe(false);
        expect((await request('POST', '', input)).status).toBe(503);
        expect((await request('PATCH', `/${provider.id}`, { ...input, revision: 1 })).status).toBe(
            503,
        );
        expect((await request('POST', `/${provider.id}/activate`, { revision: 1 })).status).toBe(
            503,
        );
        expect((await request('DELETE', `/${provider.id}`, { revision: 1 })).status).toBe(204);
    });
});
