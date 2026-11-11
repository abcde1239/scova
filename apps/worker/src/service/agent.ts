import { type DatabaseClient } from '@scova/db';
import { openProviderCredentials, type ProviderCredentials } from '@scova/shared/credentials';
import { activeAgentProvider } from '@/repo/agent-providers.ts';
import { installedCheckpointVersion } from '@/utils/checkpoint-version.ts';
import { classifyToolFailure } from '@/utils/tool-failure.ts';
import { createHash } from 'node:crypto';
import type { RunnableConfig } from '@langchain/core/runnables';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import pg from 'pg';
import { Redis } from 'ioredis';
import { createSearchStateRepository } from '@/repo/search.ts';
import { createManagedSearch } from '@/service/search.ts';
import { searchScope } from '@/utils/search-scope.ts';
import { effectiveSearchConfig } from '@/app/search-config.ts';
import {
    runResearchAgent,
    deterministicPartial,
    comparisonSourceCoverage,
    type AgentModelResponse,
    type AgentCandidate,
    type AgentContext,
    type AgentTools,
} from '@scova/agent-core';
import {
    ConnectorError,
    MODEL_CALL_TIMEOUT_MS,
    PAGE_TEXT_CHAR_LIMIT,
    createConnectorBundle,
    estimateModelInputTokens,
    normalizeUrl,
    withDeadline,
    validPageCollection,
    type CallContext,
    type ConnectorBundle,
    type ReadPage,
    type StructuredInput,
    type ModelResponse,
    type SearchResponse,
} from '@scova/connectors';
import type { Usage } from '@scova/models';
import {
    createAgentRepository,
    AgentPersistenceError,
    type AgentRepository,
    type AgentReservation,
    type AgentTool,
    type AgentCheckpointRef,
} from '@/repo/agent.ts';

import type { RunExecutionContext, RunExecutor } from '@/service/runs.ts';
import { RunExecutionError, type RunLeaseToken, type RunProgressEvent } from '@/utils/runs.ts';
import { createDeliveryService } from '@/service/delivery.ts';
import { readSource } from '@/service/source-reader.ts';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const emptyUsage = (): Usage => ({
    searches: 0,
    pages: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimated: true,
});
const thread = (token: RunLeaseToken) => `run-${token.runId}-epoch-${token.leaseEpoch}`;
const configFromRef = (ref: AgentCheckpointRef): RunnableConfig => ({
    configurable: {
        thread_id: ref.threadId,
        checkpoint_ns: ref.namespace,
        checkpoint_id: ref.checkpointId,
    },
});

function readPage(value: unknown, mode: 'demo' | 'live'): ReadPage {
    const page = value as ReadPage | undefined;
    if (
        !page ||
        page.kind !== 'read_page' ||
        page.mode !== mode ||
        typeof page.text !== 'string' ||
        !page.text.trim() ||
        page.text.length > PAGE_TEXT_CHAR_LIMIT ||
        page.untrusted !== true ||
        typeof page.truncated !== 'boolean' ||
        !validPageCollection(page.collection) ||
        ![page.url, page.originalUrl, page.fetchedUrl].every(
            (url) => typeof url === 'string' && /^https?:\/\//.test(url),
        ) ||
        page.contentHash !== digest(page.text) ||
        !page.extractionVersion ||
        !Number.isFinite(Date.parse(page.collectedAt))
    )
        throw new AgentPersistenceError('INVALID_TOOL_RESULT');
    return page;
}

export interface AgentSessionOptions {
    answerSupplementEnabled?: boolean;
    adaptiveSearchDisabled?: boolean;
    repository: AgentRepository;
    saver: PostgresSaver;
    token: RunLeaseToken;
    context: RunExecutionContext;
    bundle: ConnectorBundle;
}

/** Trusted worker adapter; only bound tools and graph state reach agent-core. */
export function createAgentSession({
    answerSupplementEnabled,
    adaptiveSearchDisabled: optionsAdaptiveSearchDisabled,
    repository: rawRepository,
    saver: rawSaver,
    token,
    context,
    bundle,
}: AgentSessionOptions) {
    const pending = new Set<Promise<unknown>>();
    function trackDomain<T>(operation: () => Promise<T>, allowDeadline = false): Promise<T> {
        if (context.signal.aborted && !(allowDeadline && context.signal.reason === 'deadline'))
            return Promise.reject(new ConnectorError('aborted', '执行已停止'));
        const task = Promise.resolve().then(operation);
        pending.add(task);
        void task.then(
            () => pending.delete(task),
            () => pending.delete(task),
        );
        return task;
    }
    // Track short persistence work separately from possibly uncooperative external providers.
    const repository = new Proxy(rawRepository, {
        get(target, property) {
            const method = Reflect.get(target, property);
            if (typeof method !== 'function') return method;
            return (...args: unknown[]) =>
                trackDomain(
                    async () => Reflect.apply(method, target, args),
                    ['readPages', 'comparison'].includes(String(property)) &&
                        (args[0] as { allowDeadline?: boolean } | undefined)?.allowDeadline ===
                            true,
                );
        },
    });
    const saver = new Proxy(rawSaver, {
        get(target, property) {
            const method = Reflect.get(target, property);
            if (typeof method !== 'function') return method;
            if (['getTuple', 'put', 'putWrites'].includes(String(property)))
                return (...args: unknown[]) =>
                    trackDomain(async () => Reflect.apply(method, target, args));
            return method.bind(target);
        },
    });
    const currentUsage = { ...context.usage };
    let tokenBudgetInvalid = false;
    const guard = async () => {
        if (context.signal.aborted) throw new ConnectorError('aborted', '执行已停止');
        await context.assertActive();
        if (tokenBudgetInvalid)
            throw new ConnectorError('budget_exceeded', '模型预算已失效，停止后续调用');
    };
    async function promote(config: RunnableConfig) {
        await guard();
        const c = config.configurable;
        if (
            c?.thread_id !== thread(token) ||
            (c.checkpoint_ns ?? '') !== '' ||
            typeof c.checkpoint_id !== 'string'
        )
            throw new AgentPersistenceError('INVALID_CHECKPOINT');
        // Explicit ID is mandatory. A saver may contain unpromoted/late raw checkpoints.
        const tuple = await saver.getTuple(config);
        if (!tuple || tuple.checkpoint.id !== c.checkpoint_id)
            throw new AgentPersistenceError('INVALID_CHECKPOINT');
        await repository.promoteCheckpoint({
            threadId: thread(token),
            namespace: '',
            checkpointId: c.checkpoint_id,
            leaseEpoch: token.leaseEpoch,
        });
    }
    async function openCheckpoint(): Promise<{ config: RunnableConfig; resume: boolean }> {
        await guard();
        await repository.markInterruptedUnknown();
        const ref = await repository.readAuthorizedCheckpoint();
        const current: RunnableConfig = {
            configurable: { thread_id: thread(token), checkpoint_ns: '' },
        };
        if (!ref) return { config: current, resume: false };
        const tuple = await saver.getTuple(configFromRef(ref));
        if (!tuple || tuple.checkpoint.id !== ref.checkpointId)
            throw new AgentPersistenceError('INVALID_CHECKPOINT');
        if (ref.leaseEpoch === token.leaseEpoch)
            return { config: configFromRef(ref), resume: true };
        const fork = await saver.put(
            current,
            tuple.checkpoint,
            { ...tuple.metadata!, source: 'fork' },
            tuple.checkpoint.channel_versions,
        );
        // Pending writes can arrive after promotion from the old epoch. They are not authorized
        // by checkpointRef. Replay unfinished nodes using committed tool results from the ledger.
        await promote(fork);
        return { config: fork, resume: true };
    }

    async function call<T>(
        operationKey: string,
        tool: AgentTool,
        input: unknown,
        reserved: Usage,
        invoke: (callContext: CallContext) => Promise<T>,
        validate: (value: T, reused?: boolean) => void,
    ): Promise<T> {
        await guard();
        // Same logical key with changed inputs is a different operation; epoch is deliberately absent.
        const keyInput =
            tool === 'model'
                ? {
                      prompt: (input as StructuredInput).prompt,
                      schema: (input as StructuredInput).schema,
                      untrustedSources: (input as StructuredInput).untrustedSources,
                  }
                : input;
        const key = `${operationKey}:${digest(JSON.stringify(keyInput))}`;
        let held: AgentReservation;
        try {
            held = await repository.reserve({ operationKey: key, tool, reserved });
        } catch (error) {
            if (error instanceof AgentPersistenceError && error.code === 'MODEL_QUOTA_EXCEEDED')
                throw new ConnectorError(
                    'model_quota_exceeded',
                    '模型服务额度不足，请补充额度后新建执行',
                );
            throw error;
        }
        Object.assign(currentUsage, held.usage);
        if (held.kind === 'reused') {
            const result = held.output as T;
            validate(result, true);
            return result;
        }
        let attempts = 0;
        try {
            const remaining = Math.min(
                tool === 'model' || (tool === 'search' && bundle.search.tokenReservation)
                    ? MODEL_CALL_TIMEOUT_MS
                    : 15_000,
                context.deadlineAt.getTime() - Date.now(),
            );
            if (remaining <= 0) throw new ConnectorError('timeout', '时间预算已耗尽');
            const result = await withDeadline(
                Math.max(1, Math.ceil(remaining)),
                context.signal,
                (signal) =>
                    invoke({
                        signal,
                        ...(tool === 'read' && process.env.SCOVA_READER_DIAGNOSTICS === '1'
                            ? {
                                  onReadDiagnostic: (diagnostic) => {
                                      console.info(
                                          JSON.stringify({
                                              type: 'reader.diagnostic',
                                              operationKey: key,
                                              toolCallId: held.toolCallId,
                                              ...diagnostic,
                                          }),
                                      );
                                  },
                              }
                            : {}),
                        timeoutMs: Math.max(1, Math.ceil(remaining)),
                        beforeDispatch: async () => {
                            await guard();
                        },
                        onSearchState: async (state) => {
                            await guard();
                            await context.emit({ type: 'research.updated', payload: { state } });
                        },
                        beforeAttempt: async (kind, previousFailure) => {
                            await guard();
                            if (signal.aborted) throw new ConnectorError('aborted', '调用已停止');
                            if (kind !== tool || attempts >= 3)
                                throw new AgentPersistenceError('INVALID_TOOL_CALL');
                            if (attempts > 0) {
                                await repository.fail({
                                    toolCallId: held.toolCallId,
                                    failureCode: classifyToolFailure(previousFailure),
                                });
                                held = await repository.reserve({
                                    operationKey: key,
                                    tool,
                                    reserved,
                                });
                                Object.assign(currentUsage, held.usage);
                                if (held.kind !== 'reserved')
                                    throw new AgentPersistenceError('INVALID_TOOL_CALL');
                            }
                            attempts++;
                            // Reservation may have waited on a DB lock while the outer timeout elapsed.
                            if (signal.aborted) throw new ConnectorError('aborted', '调用已停止');
                            await guard();
                        },
                    }),
            );
            await guard();
            if (attempts < 1) throw new AgentPersistenceError('INVALID_TOOL_CALL');
            validate(result);
            const actualUsage =
                tool === 'model'
                    ? { ...emptyUsage(), ...(result as ModelResponse).usage }
                    : tool === 'search' && bundle.search.tokenReservation
                      ? { ...reserved, ...(result as SearchResponse).usage }
                      : reserved;
            const settled = await repository.settle({
                toolCallId: held.toolCallId,
                output: result,
                actualUsage,
            });
            Object.assign(currentUsage, settled.usage);
            return result;
        } catch (error) {
            if (error instanceof ConnectorError && error.code === 'budget_exceeded')
                tokenBudgetInvalid = true;
            // Failed/aborted external requests may have been billed. Never refund their reservation.
            await repository
                .fail({ toolCallId: held.toolCallId, failureCode: classifyToolFailure(error) })
                .catch(() => undefined);
            if (error instanceof AgentPersistenceError && error.code === 'BUDGET_EXCEEDED')
                throw new ConnectorError('budget_exceeded', '执行预算不足');
            throw error;
        }
    }
    const tools: AgentTools = {
        search: (operationKey, query) =>
            context.conversation?.operation === 'revise'
                ? Promise.reject(new ConnectorError('configuration', '报告修订禁止联网搜索'))
                : call<SearchResponse>(
                      operationKey,
                      'search',
                      query,
                      { ...emptyUsage(), ...bundle.search.tokenReservation, searches: 1 },
                      (options) => bundle.search.search(query, options),
                      (response) => {
                          if (
                              response.kind !== 'search_results' ||
                              response.mode !== context.mode ||
                              response.query !== query ||
                              !Array.isArray(response.results) ||
                              !response.coverage
                          )
                              throw new AgentPersistenceError('INVALID_TOOL_RESULT');
                          if (bundle.search.tokenReservation) {
                              const usage = response.usage;
                              const limits = bundle.search.tokenReservation;
                              if (
                                  !usage ||
                                  !Number.isSafeInteger(usage.inputTokens) ||
                                  !Number.isSafeInteger(usage.outputTokens) ||
                                  usage.inputTokens < 0 ||
                                  usage.outputTokens < 0 ||
                                  usage.inputTokens > limits.inputTokens ||
                                  usage.outputTokens > limits.outputTokens ||
                                  usage.estimated !== false
                              )
                                  throw new ConnectorError(
                                      'budget_exceeded',
                                      '内置搜索用量缺失或超出预留',
                                  );
                          }
                      },
                  ),
        read: (operationKey, url) =>
            call<ReadPage>(
                operationKey,
                'read',
                url,
                { ...emptyUsage(), pages: 1 },
                async (options) => {
                    if (context.conversation?.operation === 'revise') {
                        const sources = context.conversation.sources.filter((s) => s.url === url);
                        if (!sources.length)
                            throw new ConnectorError('configuration', '修订来源不在冻结报告内');
                        await options.beforeAttempt?.('read');
                        const text = [...new Set(sources.map((s) => s.text))].join('\n\n');
                        return {
                            kind: 'read_page',
                            mode: context.mode,
                            originalUrl: url,
                            fetchedUrl: url,
                            url,
                            title: sources[0].title,
                            text,
                            contentHash: digest(text),
                            extractionVersion: 'scova-report-evidence-v1',
                            collectedAt: sources[0].observedAt,
                            truncated: true,
                            untrusted: true,
                        };
                    }
                    const saved = await repository.searchPage?.(url);
                    let page: ReadPage | undefined;
                    if (saved) {
                        try {
                            const checked = readPage(saved, context.mode);
                            if (
                                normalizeUrl(checked.originalUrl) === normalizeUrl(url) &&
                                normalizeUrl(checked.url) === normalizeUrl(url)
                            )
                                page = checked;
                        } catch {
                            /* Invalid or unusable provider bodies are read by Reader. */
                        }
                    }
                    return readSource(url, page, bundle.reader, options);
                },
                (page) => {
                    readPage(page, context.mode);
                },
            ),
        model: (operationKey, input: StructuredInput) => {
            const effective = {
                ...input,
                maxInputTokens: Math.min(input.maxInputTokens, estimateModelInputTokens(input)),
                maxOutputTokens: Math.max(
                    1,
                    Math.min(
                        input.maxOutputTokens,
                        context.budget.maxOutputTokens - currentUsage.outputTokens,
                    ),
                ),
            };
            const comparison = operationKey.startsWith('compare-facts');
            return call<AgentModelResponse>(
                operationKey,
                'model',
                input,
                {
                    ...emptyUsage(),
                    inputTokens: effective.maxInputTokens,
                    outputTokens: effective.maxOutputTokens,
                },
                async (options) => {
                    const response = await bundle.model.generateStructured(effective, options);
                    return comparison
                        ? { ...response, sourceCoverage: comparisonSourceCoverage(input) }
                        : response;
                },
                (result, reused) => {
                    const limits = reused ? context.budget : effective;
                    if (
                        result.mode !== context.mode ||
                        !result.usage ||
                        !Number.isSafeInteger(result.usage.inputTokens) ||
                        !Number.isSafeInteger(result.usage.outputTokens) ||
                        result.usage.inputTokens < 0 ||
                        result.usage.outputTokens < 0 ||
                        result.usage.inputTokens > limits.maxInputTokens ||
                        result.usage.outputTokens > limits.maxOutputTokens ||
                        typeof result.usage.estimated !== 'boolean'
                    )
                        throw new ConnectorError('budget_exceeded', '模型用量不合法或超出预留');
                },
            ).then((response) =>
                comparison && response.sourceCoverage === undefined
                    ? { ...response, sourceCoverage: null }
                    : response,
            );
        },
    };
    const agentContext: AgentContext = {
        conversation: context.conversation,
        answerSupplementEnabled,
        adaptiveSearchDisabled:
            optionsAdaptiveSearchDisabled || context.conversation?.operation === 'revise',
        runId: context.runId,
        userId: context.userId,
        taskVersionId: context.taskVersionId,
        mode: context.mode,
        config: context.config,
        budget: context.budget,
        usage: currentUsage,
        deadlineAt: context.deadlineAt,
        startedAt: context.startedAt,
        signal: context.signal,
        assertActive: () => context.assertActive(),
        demoReason: bundle.reason,
    };
    return {
        tools,
        openCheckpoint,
        persist: trackDomain,
        drain: async () => {
            await bundle.reader.close?.();
            await Promise.allSettled(pending);
        },
        async execute(): Promise<AgentCandidate> {
            if (bundle.mode !== context.mode)
                throw new RunExecutionError('AGENT_CONFIGURATION_INVALID');
            Object.assign(agentContext, await repository.comparison());
            const opened = await openCheckpoint();
            const startedSteps = new Map<string, number>();
            const candidate = await runResearchAgent(agentContext, {
                ...opened,
                tools,
                checkpointer: saver,
                promote,
                onClaimsRepair: () =>
                    context.emit({ type: 'research.updated', payload: { state: 'claims_repair' } }),
                onStep: async (step, phase) => {
                    const name = step as Extract<
                        RunProgressEvent,
                        { type: 'step.started' }
                    >['payload']['step'];
                    if (phase === 'started') {
                        startedSteps.set(step, performance.now());
                        await context.emit({ type: 'step.started', payload: { step: name } });
                    } else {
                        await context.emit({
                            type: 'step.completed',
                            payload: {
                                step: name,
                                durationMs: Math.max(
                                    0,
                                    Math.floor(
                                        performance.now() -
                                            (startedSteps.get(step) ?? performance.now()),
                                    ),
                                ),
                            },
                        });
                    }
                },
            });
            await guard();
            await context.emit({ type: 'coverage.updated', payload: candidate.coverage });
            return candidate;
        },
        async partial(): Promise<AgentCandidate | null> {
            if (context.signal.aborted && context.signal.reason !== 'deadline')
                throw new ConnectorError('aborted', '执行已停止');
            // A fresh post-deadline session never executes the graph. Load the same frozen context
            // used by delivery while retaining owner, lease and cancellation checks; no external calls.
            Object.assign(agentContext, await repository.comparison({ allowDeadline: true }));
            // This bound domain read still validates lease and cancellation. No network/model operation.
            const pages = (await repository.readPages({ allowDeadline: true })).map((value) =>
                readPage(value, context.mode),
            );
            if (!pages.length) return null;
            const uniquePages = [
                ...new Map(pages.map((page) => [`${page.url}:${page.contentHash}`, page])).values(),
            ];
            return deterministicPartial(
                agentContext,
                uniquePages.map((page) => ({
                    ...page,
                    id: `page-${digest(`${page.url}:${page.contentHash}`)}`,
                    questionIds: [],
                })),
            );
        },
    };
}

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
    if (
        env.AGENT_CHECKPOINT_MIGRATION !== undefined &&
        !['external', 'startup'].includes(env.AGENT_CHECKPOINT_MIGRATION)
    )
        throw new Error('AGENT_CHECKPOINT_MIGRATION 无效');
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
    async function bundle(context: RunExecutionContext) {
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
            let accountSearch: ProviderCredentials['searchApi'];
            if (own) {
                try {
                    const credentials = openProviderCredentials(
                        own.encryptedApiKey,
                        userId,
                        own.id,
                        env.AGENT_CREDENTIAL_KEY,
                    );
                    modelApiKey = credentials.modelApiKey;
                    accountSearch = credentials.searchApi;
                } catch {
                    throw new RunExecutionError('AGENT_CONFIGURATION_INVALID');
                }
            }
            let liveBundle: ConnectorBundle;
            let usesSearxng = false;
            try {
                const searchConfig = effectiveSearchConfig(env, {
                    webSearch: own?.webSearch,
                    searchApi: accountSearch,
                });
                usesSearxng =
                    'searchProvider' in searchConfig && searchConfig.searchProvider === 'searxng';
                liveBundle = createConnectorBundle({
                    ...searchConfig,
                    managedSearch: true,
                    modelApiKey,
                    model: own?.model ?? env.MODEL_NAME,
                    modelBaseUrl: own?.baseUrl ?? env.MODEL_BASE_URL,
                    modelProtocol: own?.protocol,
                    modelSearch: own?.webSearch,
                });
            } catch {
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
            const client = await pool.connect();
            try {
                // Serialize saver migrations across worker processes; no business transaction spans setup.
                await client.query('SELECT pg_advisory_lock(hashtext($1))', [
                    `scova-agent-schema:${schema}`,
                ]);
                if (env.AGENT_CHECKPOINT_MIGRATION === 'external') {
                    const version = await client.query(
                        `SELECT version FROM "${schema}".scova_schema_version WHERE id=1`,
                    );
                    if (version.rows[0]?.version !== installedCheckpointVersion())
                        throw new Error('先执行独立图状态迁移');
                } else {
                    await saver.setup();
                }
                ready = true;
            } finally {
                await client
                    .query('SELECT pg_advisory_unlock(hashtext($1))', [
                        `scova-agent-schema:${schema}`,
                    ])
                    .catch(() => undefined);
                client.release();
            }
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
                        bundle: await bundle(context),
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
