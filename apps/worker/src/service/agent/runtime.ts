import { Redis } from 'ioredis';
import { createSearchStateRepository, type SearchStateRepository } from '@/repo/search.ts';
import type { AgentPersistence } from '@/repo/execution.ts';
import { createManagedSearch } from '@/service/search.ts';
import { searchScope } from '@/utils/search-scope.ts';
import { type AgentCandidate } from '@scova/agent-core';
import { ConnectorError, createConnectorBundle, type ConnectorBundle } from '@scova/connectors';
import type { RunExecutionContext, RunExecutor } from '@/service/runs.ts';
import { RunExecutionError, type RunLeaseToken } from '@scova/shared/execution/runs';
import { digest } from '@/service/agent/tool-results.ts';
import { createAgentSession } from '@/service/agent/session.ts';

export interface AgentRuntimeOptions {
    redis?: Redis;
    persistence: AgentPersistence;
    env?: NodeJS.ProcessEnv;
    localSearch?: (token: RunLeaseToken) => SearchStateRepository;
    bundle?: ConnectorBundle;
    deliver?: (
        context: RunExecutionContext,
        candidate: AgentCandidate,
        deadline: boolean,
    ) => Promise<void>;
}

/** Construction is offline. App lifecycle owns search connections and agent shutdown. */
export function createAgentRuntime(options: AgentRuntimeOptions) {
    const env = options.env ?? process.env;
    const { persistence } = options;
    let ready = false;
    let searchRedis = options.redis;
    let ownsRedis = false;
    let closing: Promise<void> | undefined;
    async function bundle(context: RunExecutionContext, token: RunLeaseToken) {
        if (options.bundle) {
            await persistence.credentials(token, true);
            return options.bundle;
        }
        const credentials = await persistence.credentials(token);
        if (!credentials || context.mode !== 'live')
            throw new RunExecutionError('AGENT_CONFIGURATION_INVALID');
        const live = createConnectorBundle({
            ...credentials,
            managedSearch: true,
            modelSearch: 'disabled',
        });
        if (live.mode !== 'live') throw new RunExecutionError('AGENT_CONFIGURATION_INVALID');
        live.searchProvider = credentials.searchProvider;
        live.searchIdentity = credentials.searchIdentity;
        if (!live.search.tokenReservation && credentials.searchProvider === 'searxng') {
            const namespace = `scova:search:v1:${digest(JSON.stringify([credentials.searxngBaseUrl ?? 'http://127.0.0.1:8080', env.SEARCH_CONFIG_VERSION ?? '1']))}`;
            const repository =
                options.localSearch?.(token) ??
                (searchRedis &&
                    createSearchStateRepository(
                        searchRedis,
                        namespace,
                        Number(env.SEARCH_ENGINE_INTERVAL_MS ?? 10_000),
                    ));
            if (!repository) throw new RunExecutionError('AGENT_CONFIGURATION_INVALID');
            const scope = context.startedAt
                ? searchScope(context.userId, context.config, context.startedAt)
                : { key: JSON.stringify([context.userId, context.runId]), ttlMs: 0 };
            live.search = createManagedSearch({
                source: live.search,
                repository,
                scope: scope.key,
                cacheTtlMs: env.SEARCH_CACHE_ENABLED === 'false' ? 0 : scope.ttlMs,
                cacheExpiresAt: 'expiresAt' in scope ? scope.expiresAt : undefined,
            });
        }
        return live;
    }
    return {
        async connect() {
            await persistence.ready();
            if (!options.localSearch && !options.bundle && !searchRedis && env.REDIS_URL) {
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
            ready = true;
        },
        executorFactory(token: RunLeaseToken): RunExecutor {
            let session: ReturnType<typeof createAgentSession> | undefined;
            const start = (context: RunExecutionContext, connectors: ConnectorBundle) =>
                createAgentSession({
                    answerSupplementEnabled: env.RESEARCH_ANSWER_SUPPLEMENT_ENABLED === 'true',
                    adaptiveSearchDisabled: env.SEARCH_ADAPTIVE_ENABLED === 'false',
                    repository: persistence.repository(token),
                    saver: persistence.checkpoints(token),
                    readDeadlineCheckpoint:
                        persistence.readDeadlineCheckpoint &&
                        ((config) => persistence.readDeadlineCheckpoint!(token, config)),
                    token,
                    context,
                    bundle: connectors,
                });
            async function deliver(
                context: RunExecutionContext,
                candidate: AgentCandidate,
                deadline: boolean,
            ) {
                if (options.deliver) await options.deliver(context, candidate, deadline);
                else if (persistence.deliver) await persistence.deliver(token, candidate, deadline);
                else throw new RunExecutionError('AGENT_DELIVERY_NOT_CONFIGURED');
            }
            return {
                async execute(context) {
                    if (!ready) throw new RunExecutionError('AGENT_CONFIGURATION_INVALID');
                    session = start(context, await bundle(context, token));
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
                    await context.assertActive();
                    await session.persist(() => deliver(context, candidate, false));
                },
                async onDeadline(context) {
                    if (!options.bundle && context.mode !== 'live')
                        throw new RunExecutionError('AGENT_CONFIGURATION_INVALID');
                    const disabled = async (): Promise<never> => {
                        throw new ConnectorError('timeout', '截止后禁止外部调用');
                    };
                    session ??= start(context, {
                        mode: context.mode,
                        ...(context.mode === 'demo' ? { reason: '本次执行已固定为演示模式' } : {}),
                        search: { search: disabled },
                        reader: { read: disabled },
                        model: { generateStructured: disabled },
                    });
                    const candidate = await session.partial();
                    if (candidate && (options.deliver || persistence.deliver))
                        await session.persist(() => deliver(context, candidate, true), true);
                },
                drain: () => session?.drain() ?? Promise.resolve(),
            };
        },
        close: () =>
            (closing ??= (async () => {
                try {
                    await persistence.close?.();
                } finally {
                    if (ownsRedis && searchRedis) {
                        try {
                            if (searchRedis.status === 'ready') await searchRedis.quit();
                        } finally {
                            searchRedis.disconnect();
                        }
                    }
                }
            })()),
    };
}
