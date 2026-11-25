import { MemorySaver } from '@langchain/langgraph';
import { queryRows, sql, type DatabaseExecutor } from '@scova/db';
import type { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';

interface StoredCheckpoint {
    checkpoint_id: string;
    checkpoint: Uint8Array;
    metadata: Uint8Array;
    parent_id: string | null;
}
interface StoredWrite {
    checkpoint_id: string;
    write_key: string;
    task_id: string;
    channel: string;
    value: Uint8Array;
    task_path: string;
}

export function sqliteCheckpointStore(db: DatabaseExecutor) {
    async function readWrites(memory: MemorySaver, thread: string, id: string) {
        const rows = await queryRows<StoredWrite>(
            db,
            sql`SELECT * FROM scova_checkpoint_writes
            WHERE thread_id=${thread} AND checkpoint_id=${id}`,
        );
        memory.writes[JSON.stringify([thread, '', id])] = Object.fromEntries(
            rows.map((row) => [
                row.write_key,
                [row.task_id, row.channel, row.value, row.task_path],
            ]),
        );
    }

    const store: Pick<PostgresSaver, 'getTuple' | 'put' | 'putWrites'> = {
        async getTuple(config) {
            const { thread_id: thread, checkpoint_id: id } = config.configurable ?? {};
            const [row] = await queryRows<StoredCheckpoint>(
                db,
                sql`SELECT * FROM scova_checkpoints
                WHERE thread_id=${thread} ${id ? sql`AND checkpoint_id=${id}` : undefined}
                ORDER BY checkpoint_id DESC LIMIT 1`,
            );
            if (!row) return undefined;
            const memory = new MemorySaver();
            memory.storage[thread] = {
                '': {
                    [row.checkpoint_id]: [row.checkpoint, row.metadata, row.parent_id ?? undefined],
                },
            };
            await readWrites(memory, thread, row.checkpoint_id);
            if (row.parent_id) await readWrites(memory, thread, row.parent_id);
            return memory.getTuple({
                configurable: {
                    thread_id: thread,
                    checkpoint_ns: '',
                    checkpoint_id: row.checkpoint_id,
                },
            });
        },
        async put(config, checkpoint, metadata) {
            const memory = new MemorySaver();
            const result = await memory.put(config, checkpoint, metadata);
            const thread = result.configurable!.thread_id as string;
            const [data, details, parent] = memory.storage[thread][''][checkpoint.id];
            await db.execute(sql`INSERT INTO scova_checkpoints (thread_id, checkpoint_id, checkpoint, metadata, parent_id)
                VALUES (${thread}, ${checkpoint.id}, ${data}, ${details}, ${parent ?? null})
                ON CONFLICT (thread_id, checkpoint_id) DO NOTHING`);
            return result;
        },
        async putWrites(config, writes, taskId, taskPath) {
            const memory = new MemorySaver();
            await memory.putWrites(config, writes, taskId, taskPath);
            const { thread_id: thread, checkpoint_id: id } = config.configurable!;
            const rows = Object.entries(memory.writes[JSON.stringify([thread, '', id])] ?? {});
            for (const [key, [task, channel, value, path]] of rows) {
                const special = Number(key.slice(key.lastIndexOf(',') + 1)) < 0;
                await db.execute(sql`INSERT INTO scova_checkpoint_writes
                    (thread_id, checkpoint_id, write_key, task_id, channel, value, task_path)
                    VALUES (${thread}, ${id}, ${key}, ${task}, ${channel}, ${value}, ${path ?? ''})
                    ON CONFLICT (thread_id, checkpoint_id, write_key) ${
                        special
                            ? sql`DO UPDATE SET channel=excluded.channel, value=excluded.value, task_path=excluded.task_path`
                            : sql`DO NOTHING`
                    }`);
            }
        },
    };
    return store;
}
