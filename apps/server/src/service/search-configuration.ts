import { randomUUID } from 'node:crypto';
import {
    SearchConfigurationInputSchema,
    SearchConfigurationImportSchema,
    parseContract,
    type SearchConfiguration,
    type SearchConfigurationInput,
} from '@scova/models';
import {
    credentialStorageReady,
    sealCredential,
    openCredential,
    openProviderCredentials,
} from '@/utils/credentials.ts';
import {
    validatePublicUrl,
    validateCustomSearchTemplate,
    customSearchEndpoint,
} from '@scova/connectors';
import type { ApiServices } from '@/app/services';
import { createSearchConfigurationRepo } from '@/repo/search-configuration';
import { ApiError } from '@/utils/errors';

type SearchRow = NonNullable<
    Awaited<ReturnType<ReturnType<typeof createSearchConfigurationRepo>['get']>>
>;
export function searchConfigurationDto(row: SearchRow): SearchConfiguration {
    return {
        revision: row.revision,
        defaultMode: row.defaultMode,
        api:
            row.protocol && row.baseUrl && row.contentMode && row.encryptedApiKey
                ? {
                      protocol: row.protocol,
                      baseUrl: row.baseUrl,
                      contentMode: row.protocol === 'custom_json' ? 'reader' : 'prefer_api',
                      ...(row.protocol === 'custom_json' && row.customTemplate
                          ? { custom: row.customTemplate }
                          : {}),
                      hasApiKey: true,
                  }
                : null,
        updatedAt: row.updatedAt.toISOString(),
    };
}
export function createSearchConfigurationService(services: Pick<ApiServices, 'db' | 'clock'>) {
    const repo = createSearchConfigurationRepo(services);
    function writable() {
        if (!credentialStorageReady())
            throw new ApiError(
                503,
                'CREDENTIAL_STORAGE_UNAVAILABLE',
                '管理员尚未启用凭据加密，暂时无法保存搜索配置',
            );
    }
    function revision(row: SearchRow | null, expected?: number) {
        if ((row && row.revision !== expected) || (!row && expected !== undefined))
            throw new ApiError(
                409,
                'SEARCH_CONFIGURATION_CONFLICT',
                '搜索配置已更新，请重新读取后再操作',
            );
    }
    function searchBaseUrl(value: string) {
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
            throw new ApiError(422, 'VALIDATION_ERROR', '搜索 API 地址无效', [
                { path: '/api/baseUrl', message: '请填写公网 HTTPS API 根地址' },
            ]);
        }
    }
    function apiConfiguration(
        input: SearchConfigurationInput['api'],
        previous: SearchRow | null,
        userId: string,
        id: string,
    ) {
        if (input === undefined)
            return previous
                ? {
                      protocol: previous.protocol,
                      baseUrl: previous.baseUrl,
                      contentMode: previous.contentMode
                          ? previous.protocol === 'custom_json'
                              ? ('reader' as const)
                              : ('prefer_api' as const)
                          : null,
                      encryptedApiKey: previous.encryptedApiKey,
                      customTemplate: previous.customTemplate ?? null,
                  }
                : {
                      protocol: null,
                      baseUrl: null,
                      contentMode: null,
                      encryptedApiKey: null,
                      customTemplate: null,
                  };
        if (input === null)
            return {
                protocol: null,
                baseUrl: null,
                contentMode: null,
                encryptedApiKey: null,
                customTemplate: null,
            };
        if (input.protocol === 'perplexity')
            throw new ApiError(422, 'VALIDATION_ERROR', '所选 API 暂不支持独立网页读取', [
                { path: '/api/protocol', message: '请选择支持搜索与读取的 DeepSeek 或 Tavily' },
            ]);
        let baseUrl: string;
        let customTemplate = null;
        if (input.protocol === 'custom_json') {
            try {
                if (input.contentMode !== 'reader') throw new Error();
                baseUrl = customSearchEndpoint(input.baseUrl);
                customTemplate = validateCustomSearchTemplate(input.custom);
            } catch {
                throw new ApiError(422, 'VALIDATION_ERROR', '自定义搜索配置无效', [
                    {
                        path: '/api/custom',
                        message: '请检查公网 HTTPS 完整端点、有限 JSON 模板，并明确选择本地 Reader',
                    },
                ]);
            }
        } else {
            if (input.custom !== undefined)
                throw new ApiError(422, 'VALIDATION_ERROR', '内置协议不接受自定义搜索模板', [
                    { path: '/api/custom', message: '请移除自定义模板或选择自定义 JSON 协议' },
                ]);
            baseUrl = searchBaseUrl(input.baseUrl);
        }
        let apiKey = input.apiKey;
        if (
            !apiKey &&
            previous?.encryptedApiKey &&
            previous.protocol === input.protocol &&
            previous.baseUrl === baseUrl &&
            (input.protocol !== 'custom_json' ||
                JSON.stringify(validateCustomSearchTemplate(previous.customTemplate)) ===
                    JSON.stringify(customTemplate))
        ) {
            try {
                apiKey = openCredential(previous.encryptedApiKey, userId, id);
            } catch {
                throw new ApiError(
                    503,
                    'CREDENTIAL_STORAGE_UNAVAILABLE',
                    '搜索密钥无法读取，请重新填写密钥',
                );
            }
        }
        if (!apiKey)
            throw new ApiError(422, 'VALIDATION_ERROR', '请填写独立搜索密钥', [
                {
                    path: '/api/apiKey',
                    message: '首次配置或更改地址、协议、自定义模板时须填写密钥',
                },
            ]);
        return {
            protocol: input.protocol,
            baseUrl,
            contentMode:
                input.protocol === 'custom_json' ? ('reader' as const) : ('prefer_api' as const),
            customTemplate,
            encryptedApiKey: sealCredential(apiKey, userId, id),
        };
    }
    return {
        async get(userId: string) {
            const row = await repo.get(userId);
            return {
                configuration: row ? searchConfigurationDto(row) : null,
                storageReady: credentialStorageReady(),
            };
        },
        async save(userId: string, body: unknown) {
            const input = parseContract(SearchConfigurationInputSchema, body);
            writable();
            return repo.write(userId, async (tx) => {
                const previous = await repo.get(userId, tx);
                revision(previous, input.revision);
                const id = previous?.id ?? randomUUID();
                const api = apiConfiguration(input.api, previous, userId, id);
                if (input.defaultMode === 'api' && api.protocol === 'perplexity')
                    throw new ApiError(
                        422,
                        'VALIDATION_ERROR',
                        'Perplexity Search 暂不支持独立网页读取，请选择 DeepSeek 或 Tavily',
                        [
                            {
                                path: '/api/protocol',
                                message: '请选择支持搜索与读取的 DeepSeek 或 Tavily',
                            },
                        ],
                    );
                if (input.defaultMode === 'api' && !api.encryptedApiKey)
                    throw new ApiError(422, 'VALIDATION_ERROR', '请先配置 Search API', [
                        { path: '/api', message: 'Search API 需要独立地址、协议和密钥' },
                    ]);
                return searchConfigurationDto(
                    await repo.save(tx, {
                        userId,
                        id,
                        ...api,
                        defaultMode: input.defaultMode,
                        revision: (previous?.revision ?? 0) + 1,
                        updatedAt: services.clock(),
                    }),
                );
            });
        },
        async importLegacy(userId: string, providerId: string, body: unknown) {
            const input = parseContract(SearchConfigurationImportSchema, body);
            writable();
            return repo.write(userId, async (tx) => {
                const previous = await repo.get(userId, tx);
                revision(previous, input.revision);
                const provider = await repo.legacy(tx, userId, providerId);
                if (!provider) throw new ApiError(404, 'NOT_FOUND', '供应商不存在');
                if (provider.revision !== input.providerRevision)
                    throw new ApiError(
                        409,
                        'PROVIDER_CONFLICT',
                        '供应商配置已更新，请重新读取后再操作',
                    );
                let legacy;
                try {
                    legacy = openProviderCredentials(
                        provider.encryptedApiKey,
                        userId,
                        providerId,
                    ).searchApi;
                } catch {
                    throw new ApiError(
                        503,
                        'CREDENTIAL_STORAGE_UNAVAILABLE',
                        '旧搜索密钥无法读取，请重新填写搜索配置',
                    );
                }
                if (!legacy)
                    throw new ApiError(
                        422,
                        'VALIDATION_ERROR',
                        '该模型中没有可迁入的搜索 API 配置',
                    );
                const id = previous?.id ?? randomUUID();
                const api = apiConfiguration(legacy, previous, userId, id);
                return searchConfigurationDto(
                    await repo.save(tx, {
                        userId,
                        id,
                        ...api,
                        defaultMode: 'api',
                        revision: (previous?.revision ?? 0) + 1,
                        updatedAt: services.clock(),
                    }),
                );
            });
        },
    };
}
