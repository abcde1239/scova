import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { installedCheckpointVersion } from '@/utils/checkpoint-version.ts';
import type pg from 'pg';
import { schemaName } from '../utils/operations.ts';

/** Only the offline Server maintenance command installs or upgrades the graph schema. */
export async function provisionAgentCheckpointSchema(pool: pg.Pool, schema: string) {
    const agent = `"${schemaName(schema)}"`;
    const key = `scova-agent-schema:${schema}`;
    const client = await pool.connect();
    try {
        await client.query('SELECT pg_advisory_lock(hashtext($1))', [key]);
        await new PostgresSaver(pool, undefined, { schema }).setup();
        await client.query(
            `CREATE TABLE IF NOT EXISTS ${agent}.scova_schema_version (id integer PRIMARY KEY CHECK(id=1), version text NOT NULL)`,
        );
        await client.query(
            `INSERT INTO ${agent}.scova_schema_version VALUES (1,$1) ON CONFLICT(id) DO UPDATE SET version=EXCLUDED.version`,
            [installedCheckpointVersion(import.meta.url)],
        );
    } finally {
        // Discard the connection if unlock fails so it cannot retain a session lock in the pool.
        let destroy = false;
        try {
            await client.query('SELECT pg_advisory_unlock(hashtext($1))', [key]);
        } catch {
            destroy = true;
        } finally {
            client.release(destroy);
        }
    }
}
