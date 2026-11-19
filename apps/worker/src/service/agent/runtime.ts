import { type DatabaseClient } from '@scova/db';
import { openProviderCredentials } from '@scova/shared/credentials';
import { activeAgentProvider } from '@/repo/agent-providers.ts';
import { accountSearchConfiguration } from '@/repo/search-configuration.ts';
import {
    customConfigurationHash,
    freezeSearchConfiguration,
} from '@/repo/search-configuration-freeze.ts';
import { installedCheckpointVersion } from '@scova/shared/checkpoint-version';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import pg from 'pg';
import { Redis } from 'ioredis';
import { createSearchStateRepository } from '@/repo/search.ts';
import { createManagedSearch } from '@/service/search.ts';
import { searchScope } from '@/utils/search-scope.ts';
import { accountSearchConfig, SearchConfigurationError } from '@/app/search-config.ts';
import { type AgentCandidate } from '@scova/agent-core';
import { ConnectorError, createConnectorBundle, type ConnectorBundle } from '@scova/connectors';
import { createAgentRepository } from '@/repo/agent.ts';
import type { RunExecutionContext, RunExecutor } from '@/service/runs.ts';
import { RunExecutionError, RunFenceError, type RunLeaseToken } from '@/utils/runs.ts';
import { createDeliveryService } from '@/service/delivery.ts';
import { digest } from '@/service/agent/tool-results.ts';
import { createAgentSession } from '@/service/agent/session.ts';

export interface AgentRuntimeOptions {
    redis?: Redis;
    databaseUrl: string;
    database: DatabaseClient;
    env?: NodeJS.ProcessEnv;
    checkpointSchema?: string;
    bundle?: ConnectorBundle;
    /** Production application wires atomic domain delivery; standalone graph tests may omit it. */
    enableDelivery?: boolean;
    /** #16 supplies a fenced domain delivery service; absent means explicit failure. */
    deliver?: (
        context: RunExecutionContext,
        candidate: AgentCandidate,
        deadline: boolean,
    ) => Promise<void>;
}

/** Construction is offline. App lifecycle explicitly owns setup and pool shutdown. */
export function createAgentRuntime(options: AgentRuntimeOptions) {
    const env = options.env ?? process.env;
    const schema = options.checkpointSchema ?? env.AGENT_CHECKPOINT_SCHEMA ?? 'scova_agent';
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema)) throw new Error('AGENT_CHECKPOINT_SCHEMA 无效');
    const connection = new URL(options.databaseUrl);
    connection.searchParams.delete('schema');
    const pool = new pg.Pool({
        connectionString: connection.toString(),
        max: 4,
        connectionTimeoutMillis: 5000,
        statement_timeout: 5000,
        idleTimeoutMillis: 10_000,
    });
    const saver = new PostgresSaver(pool, undefined, { schema });
    const delivery = options.enableDelivery
        ? createDeliveryService(options.database, saver)
        : undefined;
    let ready = false;
    let searchRedis = options.redis;
    let ownsRedis = false;
    let closing: Promise<void> | undefined;
    async function bundle(context: RunExecutionContext, token: RunLeaseToken) {
        const { mode, userId } = context;
        if (options.bundle) return options.bundle;
        if (mode !== 'live') throw new RunExecutionError('AGENT_CONFIGURATION_INVALID');
        {
            const own = await activeAgentProvider(
                options.database,
                userId,
                context.config.agentProviderId,
            );
            if (context.config.agentProviderId && !own)
                throw new RunExecutionError('AGENT_CONFIGURATION_INVALID');
            let modelApiKey = env.MODEL_API_KEY;
            if (own) {
                try {
                    const credentials = openProviderCredentials(
                        own.encryptedApiKey,
                        userId,
                        own.id,
                        env.AGENT_CREDENTIAL_KEY,
                    );
                    modelApiKey = credentials.modelApiKey;
                } catch {
                    throw new RunExecutionError('AGENT_CONFIGURATION_INVALID');
                }
            }
            let liveBundle: ConnectorBundle;
            let usesSearxng = false;
            try {
                // Task models have no authority over search. Built-in overrides do not
                // open credentials belonging to an unused search API.
                const savedSearch =
                    context.config.searchMode === 'searxng'
                        ? null
                        : await accountSearchConfiguration(options.database, userId);
                const searchConfig = accountSearchConfig(
                    env,
                    savedSearch,
                    userId,
                    context.config.searchMode,
                );
                const frozenSearchHash = customConfigurationHash(
                    savedSearch,
                    searchConfig.searchProvider,
                );
                await freezeSearchConfiguration(options.database, token, frozenSearchHash);
                usesSearxng =
                    'searchProvider' in searchConfig && searchConfig.searchProvider === 'searxng';
                liveBundle = createConnectorBundle({
                    managedSearch: true,
                    modelApiKey,
                    model: own?.model ?? env.MODEL_NAME,
                    modelBaseUrl: own?.baseUrl ?? env.MODEL_BASE_URL,
                    modelProtocol: own?.protocol,
                    ...searchConfig,
                });
                liveBundle.searchProvider = searchConfig.searchProvider;
                if (frozenSearchHash) liveBundle.searchIdentity = frozenSearchHash;
            } catch (error) {
                if (error instanceof RunExecutionError || error instanceof RunFenceError)
                    throw error;
                if (error instanceof SearchConfigurationError)
                    throw new RunExecutionError(error.failureCode);
                throw new RunExecutionError('AGENT_CONFIGURATION_INVALID');
            }
            if (liveBundle.mode !== 'live')
                throw new RunExecutionError('AGENT_CONFIGURATION_INVALID');
            if (!liveBundle.search.tokenReservation && usesSearxng) {
                if (!searchRedis) throw new RunExecutionError('AGENT_CONFIGURATION_INVALID');
                const namespace = `scova:search:v1:${digest(
                    JSON.stringify([
                        env.SEARXNG_BASE_URL ?? 'http://127.0.0.1:8080',
                        env.SEARCH_CONFIG_VERSION ?? '1',
                    ]),
                )}`;
                const scope = context.startedAt
                    ? searchScope(userId, context.config, context.startedAt)
                    : { key: JSON.stringify([userId, context.runId]), ttlMs: 0 };
                liveBundle.search = createManagedSearch({
                    source: liveBundle.search,
                    repository: createSearchStateRepository(
                        searchRedis,
                        namespace,
                        Number(env.SEARCH_ENGINE_INTERVAL_MS ?? 10_000),
                    ),
                    scope: scope.key,
                    cacheTtlMs: env.SEARCH_CACHE_ENABLED === 'false' ? 0 : scope.ttlMs,
                    cacheExpiresAt: 'expiresAt' in scope ? scope.expiresAt : undefined,
                });
            }
            return liveBundle;
        }
    }
    return {
        async connect() {
            if (!options.bundle && !searchRedis && env.REDIS_URL) {
                searchRedis = new Redis(env.REDIS_URL, {
                    lazyConnect: true,
                    enableOfflineQueue: false,
                    maxRetriesPerRequest: 1,
                    connectTimeout: 5000,
                    commandTimeout: 5000,
                });
                searchRedis.on('error', () => undefined);
                ownsRedis = true;
                await searchRedis.connect();
            }
            const version = await pool
                .query(`SELECT version FROM "${schema}".scova_schema_version WHERE id=1`)
                .catch((error: unknown) => {
                    if (
                        error &&
                        typeof error === 'object' &&
                        'code' in error &&
                        (error.code === '42P01' || error.code === '3F000')
                    )
                        throw new Error('先执行 Server 图状态迁移');
                    throw error;
                });
            if (version.rows[0]?.version !== installedCheckpointVersion(import.meta.url))
                throw new Error('先执行 Server 图状态迁移');
            ready = true;
        },
        executorFactory(token: RunLeaseToken): RunExecutor {
            let session: ReturnType<typeof createAgentSession> | undefined;
            return {
                async execute(context) {
                    if (!ready) throw new RunExecutionError('AGENT_CONFIGURATION_INVALID');
                    session = createAgentSession({
                        answerSupplementEnabled: env.RESEARCH_ANSWER_SUPPLEMENT_ENABLED === 'true',
                        adaptiveSearchDisabled: env.SEARCH_ADAPTIVE_ENABLED === 'false',
                        repository: createAgentRepository(options.database, token),
                        saver,
                        token,
                        context,
                        bundle: await bundle(context, token),
                    });
                    let candidate: AgentCandidate;
                    try {
                        candidate = await session.execute();
                    } catch (error) {
                        if (
                            error &&
                            typeof error === 'object' &&
                            'code' in error &&
                            error.code === 'NO_EVIDENCE'
                        )
                            throw new RunExecutionError('NO_EVIDENCE');
                        throw error;
                    }
                    if (!options.deliver && !delivery)
                        throw new RunExecutionError('AGENT_DELIVERY_NOT_CONFIGURED');
                    await context.assertActive();
                    await session.persist(async () => {
                        if (options.deliver) await options.deliver(context, candidate, false);
                        else await delivery!.deliver(token, candidate);
                    });
                },
                async onDeadline(context) {
                    if (!options.bundle && context.mode !== 'live')
                        throw new RunExecutionError('AGENT_CONFIGURATION_INVALID');
                    if (!session) {
                        // A restarted Run may already be past its fixed deadline. Only persisted evidence
                        // is needed; remote credentials and providers must never be consulted here.
                        const disabled = async (): Promise<never> => {
                            throw new ConnectorError('timeout', '截止后禁止外部调用');
                        };
                        session = createAgentSession({
                            repository: createAgentRepository(options.database, token),
                            saver,
                            token,
                            context,
                            bundle: {
                                mode: context.mode,
                                ...(context.mode === 'demo'
                                    ? { reason: '本次执行已固定为演示模式' }
                                    : {}),
                                search: { search: disabled },
                                reader: { read: disabled },
                                model: { generateStructured: disabled },
                            },
                        });
                    }
                    const candidate = await session?.partial();
                    if (candidate && (options.deliver || delivery))
                        await session.persist(async () => {
                            if (options.deliver) await options.deliver(context, candidate, true);
                            else await delivery!.deliver(token, candidate, true);
                        }, true);
                },
                drain: () => session?.drain() ?? Promise.resolve(),
            };
        },
        close: () =>
            (closing ??= (async () => {
                await saver.end();
                if (ownsRedis && searchRedis) {
                    try {
                        if (searchRedis.status === 'ready') await searchRedis.quit();
                    } finally {
                        searchRedis.disconnect();
                    }
                }
            })()),
    };
}
