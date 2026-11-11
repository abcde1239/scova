import { randomUUID } from 'node:crypto';
import {
    AgentProviderInputSchema,
    AgentProviderUpdateSchema,
    AgentProviderRevisionSchema,
    AgentProviderActivationSchema,
    AgentModelCatalogInputSchema,
    AgentProviderBalanceInputSchema,
    AgentProviderBalanceSchema,
    parseContract,
    type AgentProvider,
    type AgentProviderPurpose,
} from '@scova/models';
import { ConnectorError, createModelProvider, validatePublicUrl } from '@scova/connectors';
import {
    credentialStorageReady,
    sealProviderCredentials,
    openProviderCredentials,
    type ProviderCredentials,
} from '@scova/shared/credentials';
import type { ApiServices } from '@/app/services';
import { createAgentProviderRepo } from '@/repo/agent-providers';
import { ApiError } from '@/utils/errors';

type ProviderRow = Awaited<ReturnType<ReturnType<typeof createAgentProviderRepo>['list']>>[number];
export function providerWebSearch(
    protocol: AgentProvider['protocol'],
    search: NonNullable<AgentProvider['webSearch']>,
) {
    if (
        search === 'disabled' ||
        (search === 'openai_responses' &&
            ['openai_chat_completions', 'openai_json'].includes(protocol)) ||
        (search === 'anthropic_web_search' && protocol === 'anthropic_messages')
    )
        return search;
    throw new ApiError(422, 'VALIDATION_ERROR', '内置搜索与接口协议不匹配', [
        { path: '/webSearch', message: '请选择当前接口支持的搜索方式，或关闭内置搜索' },
    ]);
}
export function providerDto(row: ProviderRow): AgentProvider {
    let searchApi: AgentProvider['searchApi'];
    try {
        const saved = openProviderCredentials(row.encryptedApiKey, row.userId, row.id).searchApi;
        searchApi = saved
            ? {
                  protocol: saved.protocol,
                  baseUrl: saved.baseUrl,
                  contentMode: saved.contentMode,
                  hasApiKey: true,
              }
            : null;
    } catch {
        /* Listing stays available while credential storage is unavailable. */
    }
    return {
        id: row.id,
        name: row.name,
        baseUrl: row.baseUrl,
        model: row.model,
        active: row.active,
        draftActive: row.draftActive,
        revision: row.revision,
        hasApiKey: true,
        protocol: row.protocol,
        webSearch: row.webSearch,
        ...(searchApi !== undefined ? { searchApi } : {}),
        updatedAt: row.updatedAt.toISOString(),
    };
}
export function providerSearchApi(
    input:
        | {
              protocol: 'deepseek' | 'perplexity' | 'tavily';
              baseUrl: string;
              contentMode: 'prefer_api' | 'reader';
              apiKey?: string;
          }
        | null
        | undefined,
    previous: ProviderCredentials['searchApi'],
    webSearch: NonNullable<AgentProvider['webSearch']>,
): ProviderCredentials['searchApi'] {
    const next = input === undefined ? previous : input;
    if (!next) return undefined;
    if (webSearch !== 'disabled')
        throw new ApiError(422, 'VALIDATION_ERROR', '请选择一种研究搜索方式', [
            { path: '/searchApi', message: '独立搜索 API 与内置搜索不能同时启用' },
        ]);
    let baseUrl: string;
    try {
        baseUrl = providerBaseUrl(next.baseUrl);
    } catch {
        throw new ApiError(422, 'VALIDATION_ERROR', '搜索 API 地址无效', [
            { path: '/searchApi/baseUrl', message: '请填写公网 HTTPS API 根地址' },
        ]);
    }
    const apiKey =
        next.apiKey ||
        (previous?.protocol === next.protocol && previous.baseUrl === baseUrl
            ? previous.apiKey
            : undefined);
    if (!apiKey)
        throw new ApiError(422, 'VALIDATION_ERROR', '请填写独立搜索密钥', [
            { path: '/searchApi/apiKey', message: '新建或更改搜索地址、协议时必须重新填写密钥' },
        ]);
    return { protocol: next.protocol, baseUrl, contentMode: next.contentMode, apiKey };
}
export function providerBaseUrl(value: string) {
    try {
        const url = validatePublicUrl(value);
        if (
            url.protocol !== 'https:' ||
            url.search ||
            url.hash ||
            /\/(chat\/completions|responses)\/?$/.test(url.pathname)
        )
            throw new Error();
        return url.toString().replace(/\/$/, '');
    } catch {
        throw new ApiError(422, 'VALIDATION_ERROR', '请填写公开 HTTPS API 根地址', [
            { path: '/baseUrl', message: '使用 HTTPS API 根地址，例如 https://api.openai.com/v1' },
        ]);
    }
}
export function createAgentProviderService(services: ApiServices) {
    const repo = createAgentProviderRepo(services);
    function writable() {
        if (!credentialStorageReady())
            throw new ApiError(
                503,
                'CREDENTIAL_STORAGE_UNAVAILABLE',
                '管理员尚未配置模型密钥加密，请稍后再试',
            );
    }
    function revision(row: ProviderRow | null, expected: number): asserts row is ProviderRow {
        if (!row) throw new ApiError(404, 'NOT_FOUND', '供应商不存在');
        if (row.revision !== expected)
            throw new ApiError(409, 'PROVIDER_CONFLICT', '配置已更新，请重新读取后再操作');
    }
    return {
        async balance(userId: string, id: string, body: unknown, signal?: AbortSignal) {
            const input = parseContract(AgentProviderBalanceInputSchema, body);
            const row = await repo.get(userId, id);
            revision(row, input.revision);
            writable();
            let apiKey: string;
            try {
                apiKey = openProviderCredentials(row.encryptedApiKey, userId, row.id).modelApiKey;
            } catch {
                throw new ApiError(
                    503,
                    'CREDENTIAL_STORAGE_UNAVAILABLE',
                    '模型密钥无法读取，请重新保存配置',
                );
            }
            try {
                const result = await services.providerBalance({
                    baseUrl: row.baseUrl,
                    apiKey,
                    template: input.template,
                    signal,
                });
                return parseContract(AgentProviderBalanceSchema, {
                    ...result,
                    checkedAt: services.clock().toISOString(),
                });
            } catch (cause) {
                // 不向浏览器返回上游错误正文、URL或凭据。
                if (cause instanceof ConnectorError) {
                    if (
                        cause.code === 'balance_unsupported' ||
                        cause.status === 404 ||
                        cause.status === 405
                    )
                        throw new ApiError(
                            422,
                            'PROVIDER_BALANCE_UNSUPPORTED',
                            '该地址未提供所选额度接口；中转站可选择对应查询方式，其他供应商请查看其控制台',
                        );
                    if (cause.status === 401 || cause.status === 403)
                        throw new ApiError(
                            422,
                            'PROVIDER_BALANCE_AUTH',
                            '供应商拒绝额度查询，请检查密钥及额度接口权限',
                        );
                    const failures = {
                        unsafe_url: [
                            'PROVIDER_BALANCE_ADDRESS',
                            '供应商地址未通过公网校验，请检查地址与DNS配置',
                        ],
                        timeout: ['PROVIDER_BALANCE_TIMEOUT', '读取供应商额度超时，请重试'],
                        network: [
                            'PROVIDER_BALANCE_NETWORK',
                            '无法连接供应商额度接口，请检查网络、DNS与TLS后重试',
                        ],
                        invalid_response: [
                            'PROVIDER_BALANCE_INVALID_RESPONSE',
                            '供应商未返回可识别的额度，请核对查询方式；未将缺失值记为零',
                        ],
                        response_too_large: [
                            'PROVIDER_BALANCE_TOO_LARGE',
                            '供应商额度响应超过大小限制',
                        ],
                        aborted: ['PROVIDER_BALANCE_CANCELLED', '额度查询已取消'],
                        configuration: [
                            'PROVIDER_BALANCE_CONFIGURATION',
                            '额度查询配置不可用，请检查服务端设置',
                        ],
                    } as const;
                    if (cause.code in failures) {
                        const [code, message] = failures[cause.code as keyof typeof failures];
                        throw new ApiError(503, code, message);
                    }
                    if (cause.status === 429)
                        throw new ApiError(
                            503,
                            'PROVIDER_BALANCE_RATE_LIMITED',
                            '供应商额度查询过于频繁，请稍后重试',
                        );
                }
                throw new ApiError(
                    503,
                    'PROVIDER_BALANCE_UNAVAILABLE',
                    '暂时无法读取供应商额度，请稍后重试',
                );
            }
        },
        async models(userId: string, body: unknown, signal?: AbortSignal) {
            const input = parseContract(AgentModelCatalogInputSchema, body);
            const baseUrl = providerBaseUrl(input.baseUrl);
            let apiKey = input.apiKey;
            if (input.providerId) {
                const row = await repo.get(userId, input.providerId);
                revision(row, input.revision ?? 0);
                if (!apiKey) {
                    if (baseUrl !== row.baseUrl || input.protocol !== row.protocol)
                        throw new ApiError(
                            422,
                            'MODEL_KEY_REQUIRED',
                            '更改地址或协议后，请重新填写密钥以读取模型列表',
                        );
                    writable();
                    try {
                        apiKey = openProviderCredentials(
                            row.encryptedApiKey,
                            userId,
                            row.id,
                        ).modelApiKey;
                    } catch {
                        throw new ApiError(
                            503,
                            'CREDENTIAL_STORAGE_UNAVAILABLE',
                            '模型密钥无法读取，请重新填写',
                        );
                    }
                }
            }
            if (!apiKey)
                throw new ApiError(422, 'MODEL_KEY_REQUIRED', '请先填写 API Key，再获取模型列表');
            try {
                return await services.providerModels({
                    baseUrl,
                    protocol: input.protocol,
                    apiKey,
                    signal,
                });
            } catch (cause) {
                // 上游响应和异常可能含凭据，只公开固定文案。
                if (cause instanceof ConnectorError) {
                    if (cause.status === 401 || cause.status === 403)
                        throw new ApiError(
                            422,
                            'MODEL_CATALOG_AUTH',
                            '供应商拒绝访问，请检查密钥与模型列表权限',
                        );
                    if (cause.status === 404 || cause.status === 405)
                        throw new ApiError(
                            422,
                            'MODEL_CATALOG_UNSUPPORTED',
                            '该地址未提供模型列表，可检查 API 根地址或手动填写',
                        );
                    if (cause.code === 'unsafe_url')
                        throw new ApiError(
                            422,
                            'MODEL_CATALOG_ADDRESS',
                            '模型地址解析到非公网地址，或重定向被拒绝；请检查 DNS/代理设置与 API 根地址',
                        );
                    if (cause.code === 'timeout')
                        throw new ApiError(
                            503,
                            'MODEL_CATALOG_TIMEOUT',
                            '读取模型列表超时，请重试',
                        );
                    const failures = {
                        network: [
                            'MODEL_CATALOG_NETWORK',
                            '无法连接供应商，请检查代理、DNS 或 TLS 连接后重试',
                        ],
                        response_too_large: [
                            'MODEL_CATALOG_TOO_LARGE',
                            '供应商模型列表响应超过大小限制，可暂时手动填写模型 ID',
                        ],
                        invalid_response: [
                            'MODEL_CATALOG_INVALID_RESPONSE',
                            '供应商未返回可读取的模型列表，请检查 API 根地址与接口协议',
                        ],
                        aborted: ['MODEL_CATALOG_CANCELLED', '模型列表请求已取消，请重试'],
                        configuration: [
                            'MODEL_CATALOG_CONFIGURATION',
                            '模型连接配置不可用，请检查服务端解析器配置',
                        ],
                    } as const;
                    if (cause.code in failures) {
                        const [code, message] = failures[cause.code as keyof typeof failures];
                        throw new ApiError(503, code, message);
                    }
                    if (cause.status === 429)
                        throw new ApiError(
                            503,
                            'MODEL_CATALOG_RATE_LIMITED',
                            '供应商请求过于频繁，请稍后重试',
                        );
                    if (cause.status && cause.status >= 500)
                        throw new ApiError(
                            503,
                            'MODEL_CATALOG_UPSTREAM',
                            '供应商模型列表服务暂时异常，请稍后重试',
                        );
                }
                throw new ApiError(
                    503,
                    'MODEL_CATALOG_UNAVAILABLE',
                    '暂时无法读取模型列表，请稍后重试',
                );
            }
        },
        async list(userId: string) {
            return {
                items: (await repo.list(userId)).map(providerDto),
                storageReady: credentialStorageReady(),
                systemConfigured:
                    !!process.env.MODEL_API_KEY?.trim() && !!process.env.MODEL_NAME?.trim(),
            };
        },
        async create(userId: string, body: unknown) {
            const input = parseContract(AgentProviderInputSchema, body);
            writable();
            const id = randomUUID(),
                baseUrl = providerBaseUrl(input.baseUrl);
            const webSearch = providerWebSearch(input.protocol, input.webSearch ?? 'disabled');
            const encryptedApiKey = sealProviderCredentials(
                {
                    modelApiKey: input.apiKey,
                    searchApi: providerSearchApi(input.searchApi, undefined, webSearch),
                },
                userId,
                id,
            );
            return repo.write(userId, async (tx) => {
                return providerDto(
                    await repo.insert(tx, {
                        id,
                        userId,
                        name: input.name.trim(),
                        baseUrl,
                        model: input.model,
                        protocol: input.protocol,
                        webSearch,
                        encryptedApiKey,
                        updatedAt: services.clock(),
                    }),
                );
            });
        },
        async update(userId: string, id: string, body: unknown) {
            const input = parseContract(AgentProviderUpdateSchema, body);
            writable();
            const baseUrl = providerBaseUrl(input.baseUrl);
            return repo.write(userId, async (tx) => {
                const row = await repo.find(tx, userId, id);
                revision(row, input.revision);
                const previous = openProviderCredentials(row.encryptedApiKey, userId, id);
                const webSearch = providerWebSearch(
                    input.protocol,
                    input.webSearch ?? row.webSearch,
                );
                const encryptedApiKey = sealProviderCredentials(
                    {
                        modelApiKey: input.apiKey ?? previous.modelApiKey,
                        searchApi: providerSearchApi(
                            input.searchApi,
                            previous.searchApi,
                            webSearch,
                        ),
                    },
                    userId,
                    id,
                );
                return providerDto(
                    await repo.update(tx, userId, id, {
                        name: input.name.trim(),
                        baseUrl,
                        model: input.model,
                        protocol: input.protocol,
                        webSearch,
                        encryptedApiKey,
                        updatedAt: services.clock(),
                    }),
                );
            });
        },
        async activate(userId: string, id: string, body: unknown) {
            const input = parseContract(AgentProviderActivationSchema, body);
            const purpose = input.purpose ?? 'research';
            const column = purpose === 'task_draft' ? 'draftActive' : 'active';
            writable();
            return repo.write(userId, async (tx) => {
                const row = await repo.find(tx, userId, id);
                revision(row, input.revision);
                try {
                    openProviderCredentials(row.encryptedApiKey, userId, id);
                } catch {
                    throw new ApiError(
                        503,
                        'CREDENTIAL_STORAGE_UNAVAILABLE',
                        '模型密钥无法读取，请重新填写密钥或联系管理员',
                    );
                }
                if (row[column]) return providerDto(row);
                await repo.deactivate(tx, userId, services.clock(), purpose);
                return providerDto(
                    await repo.update(tx, userId, id, {
                        [column]: true,
                        updatedAt: services.clock(),
                    }),
                );
            });
        },
        async remove(userId: string, id: string, body: unknown) {
            const input = parseContract(AgentProviderRevisionSchema, body);
            return repo.write(userId, async (tx) => {
                const row = await repo.find(tx, userId, id);
                revision(row, input.revision);
                await repo.remove(tx, userId, id);
            });
        },
        async model(userId: string, purpose: AgentProviderPurpose = 'research') {
            const row = await repo.active(userId, purpose);
            if (!row) return null;
            try {
                return createModelProvider({
                    apiKey: openProviderCredentials(row.encryptedApiKey, userId, row.id)
                        .modelApiKey,
                    model: row.model,
                    baseUrl: row.baseUrl,
                    protocol: row.protocol,
                    maxAttempts: 1,
                });
            } catch {
                throw new ApiError(
                    503,
                    'AGENT_CONFIGURATION_INVALID',
                    '当前账号模型配置不可用，请检查供应商设置',
                );
            }
        },
    };
}
