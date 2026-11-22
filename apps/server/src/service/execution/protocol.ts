import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseClient } from '@scova/db';
import { openSqliteRunQueue, openSqliteState } from '@scova/db/sqlite-state';
import { readRunQueueName } from '@scova/shared/outbox-job';
import { type AgentPageRef } from '@scova/agent-core';
import type { ExecutionCandidate } from '@scova/shared/execution/protocol';
import { type AgentRepository } from '@scova/shared/execution/agent';
import {
    RUN_FAILURE_MESSAGES,
    type RunLeaseToken,
    type RunProgressEvent,
} from '@scova/shared/execution/runs';
import { SEARXNG_ENGINES } from '@scova/connectors';
import type { SearchStateRepository } from '@scova/shared/execution/search';
import { createRunRepository, withRunFence } from '../../repo/execution/runs.ts';
import { createAgentRepository } from '../../repo/execution/agent.ts';
import { createSqliteSearchStateRepository } from '../../repo/execution/sqlite-search.ts';
import { createExecutionCheckpoints } from './checkpoints.ts';
import { createDeliveryService } from './delivery.ts';
import { executionCredentials } from './credentials.ts';

export class InvalidExecutionRequest extends Error {}
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const queueLeaseMs = 30_000;
function invalid(): never {
    throw new InvalidExecutionRequest();
}
function object(value: unknown): Record<string, unknown> {
    if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.getPrototypeOf(value) !== Object.prototype
    )
        invalid();
    return value as Record<string, unknown>;
}
function string(value: unknown, length = 200): string {
    if (typeof value !== 'string' || !value || value.length > length) invalid();
    return value;
}
function uuid(value: unknown): string {
    if (typeof value !== 'string' || !uuidPattern.test(value)) invalid();
    return value;
}
function flag(value: unknown) {
    if (value !== undefined && typeof value !== 'boolean') invalid();
    return value === true;
}
function leaseDuration(value: unknown): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 3 || value > 3_600_000)
        invalid();
    return value;
}
function lease(value: unknown): RunLeaseToken {
    const input = object(value);
    if (
        typeof input.leaseEpoch !== 'number' ||
        !Number.isSafeInteger(input.leaseEpoch) ||
        input.leaseEpoch < 1
    )
        invalid();
    return {
        runId: uuid(input.runId),
        userId: uuid(input.userId),
        leaseOwner: uuid(input.leaseOwner),
        leaseEpoch: input.leaseEpoch,
    };
}

function searchEngines(value: unknown): string[] {
    if (
        !Array.isArray(value) ||
        value.length > SEARXNG_ENGINES.length ||
        !value.every((engine) => SEARXNG_ENGINES.some((name) => name === engine))
    )
        invalid();
    return value;
}

function boundedInteger(value: unknown, maximum: number) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum)
        invalid();
    return value;
}

function searchOperation(search: SearchStateRepository, method: unknown, args: unknown) {
    if (!Array.isArray(args) || args.length > 4) invalid();
    const [first, second, third, fourth] = args;
    const key = () => {
        if (typeof first !== 'string' || !/^[a-f0-9]{64}$/.test(first)) invalid();
        return first;
    };
    switch (method) {
        case 'status':
            return search.status(searchEngines(first));
        case 'acquire':
            return search.acquire(searchEngines(first), uuid(second));
        case 'finish': {
            if (!Array.isArray(third) || third.length > SEARXNG_ENGINES.length) invalid();
            const failures = third.map((value) => {
                const input = object(value);
                const [engine] = searchEngines([input.engine]);
                return {
                    engine: engine!,
                    error: string(input.error),
                    retryAfterMs:
                        input.retryAfterMs === undefined
                            ? undefined
                            : boundedInteger(input.retryAfterMs, Number.MAX_SAFE_INTEGER),
                };
            });
            return search.finish(searchEngines(first), uuid(second), failures);
        }
        case 'cached':
            return search.cached(key());
        case 'lock':
            return search.lock(key(), uuid(second));
        case 'publish':
            return search.publish(
                key(),
                uuid(second),
                string(third, 4_000_000),
                boundedInteger(fourth, 7 * 86_400_000),
            );
        case 'unlock':
            return search.unlock(key(), uuid(second));
        default:
            return invalid();
    }
}

export function createExecutionService(options: {
    db: () => DatabaseClient;
    databaseUrl: string;
    checkpointSchema: string;
    sqlitePath?: string;
    env: NodeJS.ProcessEnv;
}) {
    const { db, env, sqlitePath } = options;
    const checkpoints = createExecutionCheckpoints(options.databaseUrl, options.checkpointSchema);
    let queue: ReturnType<typeof openSqliteRunQueue> | undefined;
    let state: ReturnType<typeof openSqliteState> | undefined;
    const sqliteQueue = () =>
        sqlitePath ? (queue ??= openSqliteRunQueue(sqlitePath, readRunQueueName(env))) : invalid();
    function sqliteSearch() {
        if (!sqlitePath) invalid();
        state ??= openSqliteState(sqlitePath);
        const key = createHash('sha256')
            .update(
                JSON.stringify([
                    env.SEARXNG_BASE_URL ?? 'http://127.0.0.1:8080',
                    env.SEARCH_CONFIG_VERSION ?? '1',
                ]),
            )
            .digest('hex');
        return createSqliteSearchStateRepository(
            state,
            `scova:search:v1:${key}`,
            Number(env.SEARCH_ENGINE_INTERVAL_MS ?? 10_000),
        );
    }
    return {
        async dispatch(action: string, args: unknown[]) {
            const [first, second, third, fourth, fifth] = args;
            if (action === 'ready') {
                await checkpoints.ready();
                await db().execute('SELECT 1');
                if (sqlitePath) sqliteQueue();
                return {
                    queue: sqlitePath ? 'sqlite' : 'bullmq',
                    queueName: readRunQueueName(env),
                };
            }
            if (action === 'queueClaim') {
                const job = sqliteQueue().claim(queueLeaseMs);
                if (!job) return null;
                return { id: job.id, owner: job.owner, name: job.name, data: job.data };
            }
            if (action === 'queueRenew')
                return sqliteQueue().renewJob(string(first), uuid(second), queueLeaseMs);
            if (action === 'queueSettle')
                return sqliteQueue().settleJob(string(first), uuid(second), flag(third));
            const database = db();
            const runs = createRunRepository(database);
            if (action === 'claim') {
                const result = await runs.claim(uuid(first), randomUUID(), leaseDuration(second), {
                    allowDeadlineRecovery: flag(third),
                });
                if (result.kind !== 'claimed') return result;
                const {
                    id,
                    userId,
                    taskId,
                    taskVersionId,
                    mode,
                    startedAt,
                    deadlineAt,
                    conversationContextJson,
                } = result.run;
                return {
                    ...result,
                    run: {
                        id,
                        userId,
                        taskId,
                        taskVersionId,
                        mode,
                        startedAt,
                        deadlineAt,
                        conversationContextJson,
                    },
                };
            }
            const token = lease(first);
            const ledger = createAgentRepository(database, token);
            const saver = checkpoints.bind(database, token);
            const allowDeadline = () => ({ allowDeadline: flag(second) });
            switch (action) {
                case 'renew':
                    return runs.renew(token, leaseDuration(second), { allowDeadline: flag(third) });
                case 'release':
                    return runs.release(token);
                case 'finish': {
                    const code = string(second);
                    if (!Object.hasOwn(RUN_FAILURE_MESSAGES, code)) invalid();
                    return runs.finish(token, { code });
                }
                case 'emit':
                    return runs.emit(token, object(second) as unknown as RunProgressEvent);
                case 'assertActive':
                    return runs.assertActive(token);
                case 'credentials':
                    return executionCredentials(database, token, env, flag(second));
                case 'deliver':
                    return createDeliveryService(database, checkpoints.saver).deliver(
                        token,
                        object(second) as unknown as ExecutionCandidate,
                        flag(third),
                        true,
                    );
                case 'comparison':
                    return ledger.comparison(allowDeadline());
                case 'reserve':
                    return ledger.reserve(
                        object(second) as unknown as Parameters<AgentRepository['reserve']>[0],
                    );
                case 'settle':
                    return ledger.settle(
                        object(second) as unknown as Parameters<AgentRepository['settle']>[0],
                    );
                case 'fail':
                    return ledger.fail(
                        object(second) as unknown as Parameters<AgentRepository['fail']>[0],
                    );
                case 'markInterruptedUnknown':
                    return ledger.markInterruptedUnknown();
                case 'usage':
                    return ledger.usage();
                case 'readCheckpointPages': {
                    if (!Array.isArray(second) || second.length !== 1) invalid();
                    return ledger.readCheckpointPages(second as AgentPageRef[], {
                        allowDeadline: flag(third),
                    });
                }
                case 'readAuthorizedCheckpoint':
                    return ledger.readAuthorizedCheckpoint(allowDeadline());
                case 'promoteCheckpoint':
                    return saver.promote(second, () =>
                        ledger.promoteCheckpoint(
                            second as Parameters<AgentRepository['promoteCheckpoint']>[0],
                        ),
                    );
                case 'readPages':
                    return ledger.readPages({
                        ...allowDeadline(),
                        offset: boundedInteger(third, Number.MAX_SAFE_INTEGER),
                    });
                case 'searchPage':
                    return ledger.searchPage!(string(second, 8192));
                case 'checkpointGet':
                    return saver.getTuple(
                        second as Parameters<typeof saver.getTuple>[0],
                        flag(third),
                    );
                case 'checkpointPut':
                    return saver.put(
                        second as Parameters<typeof saver.put>[0],
                        third as Parameters<typeof saver.put>[1],
                        fourth as Parameters<typeof saver.put>[2],
                        fifth as Parameters<typeof saver.put>[3],
                    );
                case 'checkpointWrites':
                    return saver.putWrites(
                        second as Parameters<typeof saver.putWrites>[0],
                        third as Parameters<typeof saver.putWrites>[1],
                        string(fourth),
                        fifth === undefined || fifth === '' ? undefined : string(fifth, 4096),
                    );
                case 'searchState': {
                    const search = sqliteSearch();
                    return withRunFence(database, token, 'work', async () =>
                        searchOperation(search, second, third),
                    );
                }
                default:
                    return invalid();
            }
        },
        async close() {
            try {
                await checkpoints.close();
            } finally {
                try {
                    queue?.close();
                } finally {
                    state?.close();
                }
            }
        },
    };
}
