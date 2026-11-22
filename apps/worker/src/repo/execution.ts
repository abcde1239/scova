import { setTimeout as delay } from 'node:timers/promises';
import { BaseCheckpointSaver } from '@langchain/langgraph';
import { createFetchTransport } from 'requestlane/fetch';
import { AgentPersistenceError, type AgentRepository } from '@scova/shared/execution/agent';
import {
    executionPath,
    type ExecutionCredentials,
    type ExecutionDelivery,
    type ExecutionOperation,
    type ExecutionQueueJob,
} from '@scova/shared/execution/protocol';
import {
    RunExecutionError,
    RunFenceError,
    type RunLeaseToken,
    type RunRepository,
} from '@scova/shared/execution/runs';
import type { SearchStateRepository } from '@scova/shared/execution/search';
import {
    decodeExecutionValue,
    encodeExecutionValue,
    executionBodyLimit,
    executionOperationHeader,
    executionRequestLimit,
    legacyCheckpointBodyLimit,
    readExecutionBody,
} from '@scova/shared/execution/wire';

export interface AgentPersistence {
    ready(): Promise<unknown>;
    repository(token: RunLeaseToken): AgentRepository;
    checkpoints(token: RunLeaseToken): BaseCheckpointSaver;
    readDeadlineCheckpoint?(
        token: RunLeaseToken,
        config: Parameters<BaseCheckpointSaver['getTuple']>[0],
    ): ReturnType<BaseCheckpointSaver['getTuple']>;
    credentials(
        token: RunLeaseToken,
        confirmationOnly?: boolean,
    ): Promise<ExecutionCredentials | undefined>;
    deliver?: ExecutionDelivery['deliver'];
    close?(): Promise<void>;
}

class ExecutionUnavailable extends Error {
    readonly code = 'EXECUTION_UNAVAILABLE';
}

function checkpointConfig(config: Parameters<BaseCheckpointSaver['getTuple']>[0]) {
    const { thread_id, checkpoint_ns, checkpoint_id } = config.configurable ?? {};
    return { configurable: { thread_id, checkpoint_ns, checkpoint_id } };
}

class RemoteCheckpointSaver extends BaseCheckpointSaver {
    constructor(
        private readonly call: <T>(action: ExecutionOperation, ...args: unknown[]) => Promise<T>,
        private readonly token: RunLeaseToken,
    ) {
        super();
    }
    getTuple(config: Parameters<BaseCheckpointSaver['getTuple']>[0]) {
        return this.call<Awaited<ReturnType<BaseCheckpointSaver['getTuple']>>>(
            'checkpointGet',
            this.token,
            checkpointConfig(config),
        );
    }
    put(
        config: Parameters<BaseCheckpointSaver['put']>[0],
        checkpoint: Parameters<BaseCheckpointSaver['put']>[1],
        metadata: Parameters<BaseCheckpointSaver['put']>[2],
        versions: Parameters<BaseCheckpointSaver['put']>[3],
    ) {
        return this.call<Awaited<ReturnType<BaseCheckpointSaver['put']>>>(
            'checkpointPut',
            this.token,
            checkpointConfig(config),
            checkpoint,
            metadata,
            versions,
        );
    }
    putWrites(
        config: Parameters<BaseCheckpointSaver['putWrites']>[0],
        writes: Parameters<BaseCheckpointSaver['putWrites']>[1],
        taskId: string,
        taskPath?: string,
    ) {
        return this.call<void>(
            'checkpointWrites',
            this.token,
            checkpointConfig(config),
            writes,
            taskId,
            taskPath,
        );
    }
    list(): never {
        throw new AgentPersistenceError('INVALID_CHECKPOINT');
    }
    deleteThread(): Promise<void> {
        return Promise.reject(new AgentPersistenceError('INVALID_CHECKPOINT'));
    }
    getNextVersion(current: number | undefined): number {
        return Math.floor(current ?? 0) + 1 + Math.random();
    }
}

export function createExecutionClient(baseUrl: string, secret: string) {
    const endpoint = new URL(executionPath, baseUrl);
    const transport = createFetchTransport();
    async function call<T>(action: ExecutionOperation, ...args: unknown[]): Promise<T> {
        const body = JSON.stringify({ action, args: encodeExecutionValue(args) });
        if (Buffer.byteLength(body, 'utf8') > executionRequestLimit(action))
            throw new RunExecutionError('EXECUTOR_FAILED');
        let response: Response;
        let data: { code?: string; kind?: string; result?: unknown };
        try {
            response = await transport.native(endpoint, {
                method: 'POST',
                headers: {
                    authorization: `Bearer ${secret}`,
                    'content-type': 'application/json',
                    [executionOperationHeader]: action,
                },
                body,
                redirect: 'error',
                signal: AbortSignal.timeout(action === 'deliver' ? 30_000 : 5_500),
            });
            data = (await readExecutionBody(
                response.body,
                action === 'checkpointGet' ? legacyCheckpointBodyLimit : executionBodyLimit,
            )) as typeof data;
        } catch {
            throw new ExecutionUnavailable('Worker execution service unavailable');
        }
        if (response.ok) return decodeExecutionValue(data.result) as T;
        if (data.kind === 'fence') throw new RunFenceError(data.code as RunFenceError['code']);
        if (data.kind === 'agent')
            throw new AgentPersistenceError(data.code as AgentPersistenceError['code']);
        if (data.kind === 'run') throw new RunExecutionError(data.code!);
        if (response.status === 503)
            throw new ExecutionUnavailable('Worker execution service unavailable');
        throw new RunExecutionError('EXECUTOR_FAILED');
    }
    const runs: RunRepository = {
        claim: (id, _owner, ms = 30_000, options) =>
            call('claim', id, ms, options?.allowDeadlineRecovery),
        renew: (token, ms, options) => call('renew', token, ms, options?.allowDeadline),
        release: (token) => call('release', token),
        finish: (token, failure) => call('finish', token, failure.code),
        emit: (token, event) => call('emit', token, event),
        assertActive: (token) => call('assertActive', token),
    };
    const ready = () => call<{ queue: 'sqlite' | 'bullmq'; queueName: string }>('ready');
    async function waitUntilReady(signal?: AbortSignal) {
        // Local development starts both processes together. Retry readiness only.
        const deadline = Date.now() + 15_000;
        for (;;) {
            signal?.throwIfAborted();
            try {
                return await ready();
            } catch (error) {
                if (!(error instanceof ExecutionUnavailable) || Date.now() >= deadline) throw error;
                await delay(350, undefined, { signal });
            }
        }
    }
    const persistence: AgentPersistence = {
        ready,
        repository: (token) => ({
            comparison: (options) => call('comparison', token, options?.allowDeadline),
            reserve: (input) => call('reserve', token, input),
            settle: (input) => call('settle', token, input),
            fail: (input) => call('fail', token, input),
            markInterruptedUnknown: () => call('markInterruptedUnknown', token),
            usage: () => call('usage', token),
            async readCheckpointPages(refs, options) {
                if (refs.length > 20) throw new AgentPersistenceError('INVALID_CHECKPOINT');
                const pages: Awaited<ReturnType<AgentRepository['readCheckpointPages']>> = [];
                for (const ref of refs) {
                    pages.push(
                        ...(await call<typeof pages>(
                            'readCheckpointPages',
                            token,
                            [ref],
                            options?.allowDeadline,
                        )),
                    );
                }
                return pages;
            },
            readAuthorizedCheckpoint: (options) =>
                call('readAuthorizedCheckpoint', token, options?.allowDeadline),
            promoteCheckpoint: (ref) => call('promoteCheckpoint', token, ref),
            async readPages(options) {
                const pages: Awaited<ReturnType<AgentRepository['readPages']>> = [];
                for (let offset = 0; ; offset++) {
                    const page = await call<typeof pages>(
                        'readPages',
                        token,
                        options?.allowDeadline,
                        offset,
                    );
                    if (!page.length) break;
                    pages.push(...page);
                }
                return pages;
            },
            searchPage: (url) => call('searchPage', token, url),
        }),
        checkpoints: (token) => new RemoteCheckpointSaver(call, token),
        readDeadlineCheckpoint: (token, config) =>
            call('checkpointGet', token, checkpointConfig(config), true),
        credentials: (token, confirmationOnly) => call('credentials', token, confirmationOnly),
        deliver: (token, candidate, deadline) =>
            call(
                'deliver',
                token,
                {
                    ...candidate,
                    pages: candidate.pages.map(({ text: _text, ...page }) => page),
                },
                deadline,
            ),
    };
    function sqliteSearch(token: RunLeaseToken): SearchStateRepository {
        const invoke = <T>(method: keyof SearchStateRepository, ...args: unknown[]) =>
            call<T>('searchState', token, method, args);
        return {
            status: (engines) => invoke('status', engines),
            acquire: (engines, owner) => invoke('acquire', engines, owner),
            finish: (engines, owner, failures) => invoke('finish', engines, owner, failures),
            cached: (key) => invoke('cached', key),
            lock: (key, owner) => invoke('lock', key, owner),
            publish: (key, owner, value, ttlMs) => invoke('publish', key, owner, value, ttlMs),
            unlock: (key, owner) => invoke('unlock', key, owner),
        };
    }
    return {
        ready,
        waitUntilReady,
        runs,
        persistence,
        sqliteSearch,
        sqliteQueue: {
            claim: () => call<ExecutionQueueJob | null>('queueClaim'),
            renew: (job: ExecutionQueueJob) => call<boolean>('queueRenew', job.id, job.owner),
            settle: (job: ExecutionQueueJob, retry: boolean) =>
                call<boolean>('queueSettle', job.id, job.owner, retry),
        },
    };
}
