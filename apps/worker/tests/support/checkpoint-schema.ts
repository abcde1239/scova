import pg from 'pg';
import { provisionAgentCheckpointSchema } from '../../../server/src/service/agent-checkpoint-schema.ts';

/** Test data setup, deliberately outside the production Worker startup path. */
export async function prepareTestCheckpointSchema(databaseUrl: string, schema: string | undefined) {
    if (
        !schema ||
        !/^scova_(?:agent|worker|acceptance|questions|e2e_agent)_[a-f0-9]{32}$/.test(schema)
    )
        throw new Error('Expected an isolated test checkpoint schema');
    const url = new URL(databaseUrl);
    url.searchParams.delete('schema');
    const pool = new pg.Pool({ connectionString: url.toString(), max: 2 });
    try {
        await provisionAgentCheckpointSchema(pool, schema);
    } finally {
        await pool.end();
    }
}
