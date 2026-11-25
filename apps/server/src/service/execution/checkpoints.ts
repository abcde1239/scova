import { sql, type DatabaseClient, type DatabaseTransaction } from '@scova/db';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { installedCheckpointVersion } from '@/utils/checkpoint-version.ts';
import { AgentPersistenceError } from '@scova/execution/agent';
import type { RunLeaseToken } from '@scova/execution/runs';
import { sqliteCheckpointStore } from './sqlite-checkpoints.ts';
import pg from 'pg';
import { checkpointRef } from '../../repo/execution/agent/validation.ts';
import { withRunFence } from '../../repo/execution/runs.ts';

const checkpointId = /^[A-Za-z0-9_-]{1,128}$/;

// PostgresSaver opens a transaction for each write. Route its parameterized SQL through the
// transaction that already holds the Run lock, so a final fence failure rolls back the write.
function saverInTransaction(tx: DatabaseTransaction, schema: string) {
    const pool = {
        async connect() {
            return {
                query(text: string, values: unknown[] = []) {
                    if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return;
                    const chunks = text
                        .split(/\$(\d+)/)
                        .map((part, index) =>
                            index % 2 ? sql.param(values[Number(part) - 1] ?? null) : sql.raw(part),
                        );
                    return tx.execute(sql.join(chunks));
                },
                release() {},
            };
        },
    };
    return new PostgresSaver(pool as unknown as pg.Pool, undefined, { schema });
}

export function createExecutionCheckpoints(
    db: () => DatabaseClient,
    databaseUrl: string | undefined,
    schema: string,
) {
    const storage = databaseUrl
        ? createPostgresCheckpointStorage(databaseUrl, schema)
        : {
              saver: {
                  getTuple: (config: Parameters<PostgresSaver['getTuple']>[0]) =>
                      sqliteCheckpointStore(db()).getTuple(config),
              },
              inTransaction: sqliteCheckpointStore,
              read: (tx: DatabaseTransaction) => sqliteCheckpointStore(tx),
              async ready() {
                  await db().execute(sql`SELECT 1 FROM scova_checkpoints LIMIT 0`);
              },
              async close() {},
          };
    return {
        ...storage,
        bind(database: DatabaseClient, token: RunLeaseToken) {
            const thread = `run-${token.runId}-epoch-${token.leaseEpoch}`;
            function config(input: Parameters<PostgresSaver['getTuple']>[0], current = true) {
                const { thread_id, checkpoint_ns = '', checkpoint_id } = input?.configurable ?? {};
                if (
                    typeof thread_id !== 'string' ||
                    (current && thread_id !== thread) ||
                    checkpoint_ns !== '' ||
                    (checkpoint_id !== undefined &&
                        (typeof checkpoint_id !== 'string' || !checkpointId.test(checkpoint_id)))
                )
                    throw new AgentPersistenceError('INVALID_CHECKPOINT');
                return { configurable: { thread_id, checkpoint_ns, checkpoint_id } };
            }
            return {
                getTuple(input: Parameters<PostgresSaver['getTuple']>[0], deadline = false) {
                    const checked = config(input, false);
                    return withRunFence(
                        database,
                        token,
                        deadline ? 'checkpoint_read' : 'work',
                        async (tx, run) => {
                            if (deadline || checked.configurable.thread_id !== thread) {
                                if (!run.checkpointRef)
                                    throw new AgentPersistenceError('INVALID_CHECKPOINT');
                                const ref = checkpointRef(
                                    run.checkpointRef,
                                    run.id,
                                    token.leaseEpoch,
                                );
                                if (
                                    ref.threadId !== checked.configurable.thread_id ||
                                    ref.checkpointId !== checked.configurable.checkpoint_id
                                )
                                    throw new AgentPersistenceError('INVALID_CHECKPOINT');
                            }
                            return storage.read(tx).getTuple(checked);
                        },
                    );
                },
                put(
                    input: Parameters<PostgresSaver['put']>[0],
                    checkpoint: Parameters<PostgresSaver['put']>[1],
                    metadata: Parameters<PostgresSaver['put']>[2],
                    versions: Parameters<PostgresSaver['put']>[3],
                ) {
                    const checked = config(input);
                    if (
                        !checkpoint ||
                        typeof checkpoint.id !== 'string' ||
                        !checkpointId.test(checkpoint.id)
                    )
                        throw new AgentPersistenceError('INVALID_CHECKPOINT');
                    return withRunFence(database, token, 'work', async (tx) => {
                        // IDs are immutable. A repeated or late write cannot replace an approved checkpoint.
                        const saver = storage.inTransaction(tx);
                        const stored = await storage.read(tx).getTuple({
                            configurable: { ...checked.configurable, checkpoint_id: checkpoint.id },
                        });
                        return stored?.config ?? saver.put(checked, checkpoint, metadata, versions);
                    });
                },
                putWrites(
                    input: Parameters<PostgresSaver['putWrites']>[0],
                    writes: Parameters<PostgresSaver['putWrites']>[1],
                    taskId: string,
                    taskPath?: string,
                ) {
                    const checked = config(input);
                    if (
                        !checked.configurable.checkpoint_id ||
                        typeof taskId !== 'string' ||
                        !checkpointId.test(taskId) ||
                        !Array.isArray(writes) ||
                        writes.some(
                            (write) =>
                                !Array.isArray(write) ||
                                write.length !== 2 ||
                                typeof write[0] !== 'string',
                        )
                    )
                        throw new AgentPersistenceError('INVALID_CHECKPOINT');
                    return withRunFence(database, token, 'work', (tx) =>
                        storage.inTransaction(tx).putWrites(checked, writes, taskId, taskPath),
                    );
                },
                promote(ref: unknown, operation: () => Promise<void>) {
                    const checked = checkpointRef(ref, token.runId, token.leaseEpoch);
                    if (checked.leaseEpoch !== token.leaseEpoch)
                        throw new AgentPersistenceError('INVALID_CHECKPOINT');
                    // The checkpoint cannot be replaced or deleted through this protocol.
                    return withRunFence(database, token, 'work', async (tx) => {
                        if (
                            !(await storage.read(tx).getTuple({
                                configurable: {
                                    thread_id: checked.threadId,
                                    checkpoint_ns: '',
                                    checkpoint_id: checked.checkpointId,
                                },
                            }))
                        )
                            throw new AgentPersistenceError('INVALID_CHECKPOINT');
                    }).then(operation);
                },
            };
        },
    };
}

export function createPostgresCheckpointStorage(databaseUrl: string, schema: string) {
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema)) throw new Error('AGENT_CHECKPOINT_SCHEMA 无效');
    const connection = new URL(databaseUrl);
    connection.searchParams.delete('schema');
    const pool = new pg.Pool({
        connectionString: connection.toString(),
        max: 4,
        connectionTimeoutMillis: 5000,
        statement_timeout: 5000,
        idleTimeoutMillis: 10_000,
    });
    pool.on('error', () => console.error('Server checkpoint connection lost'));
    const saver = new PostgresSaver(pool, undefined, { schema });
    return {
        saver,
        read: () => saver,
        inTransaction: (tx: DatabaseTransaction) => saverInTransaction(tx, schema),
        async ready() {
            const version = await pool
                .query(`SELECT version FROM "${schema}".scova_schema_version WHERE id=1`)
                .catch((error: unknown) => {
                    if (
                        error &&
                        typeof error === 'object' &&
                        'code' in error &&
                        ['42P01', '3F000'].includes(String(error.code))
                    )
                        throw new Error('先执行 Server 图状态迁移');
                    throw error;
                });
            if (version.rows[0]?.version !== installedCheckpointVersion(import.meta.url))
                throw new Error('先执行 Server 图状态迁移');
        },
        close: () => saver.end(),
    };
}
