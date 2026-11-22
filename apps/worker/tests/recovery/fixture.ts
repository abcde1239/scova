import { requiredDatabaseValue } from '../../../server/src/utils/execution/database.ts';
import { runs as dbRuns, eq, sql, queryRows } from '@scova/db';
import type { Usage } from '@scova/models';
import { type ConnectorBundle } from '@scova/connectors';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import pg from 'pg';
import { afterAll, beforeAll } from 'vite-plus/test';
import {
    createAgentRepository,
    type AgentRepository,
} from '../../../server/src/repo/execution/agent.ts';
import { createRunRepository, type ClaimedRun } from '../../../server/src/repo/execution/runs.ts';
import { createAgentSession } from '../../src/service/agent.ts';
import { prepareTestCheckpointSchema } from '../support/checkpoint-schema.ts';
import { testWorkerExecution } from '../support/worker-execution.ts';
import { outboxDatabase } from '../support/outbox-database.ts';
import { emptyUsage, seedRun } from '../support/run-database.ts';

export const fixture = outboxDatabase();

export const runs = createRunRepository(fixture.db);

export const usage = (values: Partial<Usage> = {}): Usage => ({ ...emptyUsage(), ...values });

export const search = (operationKey: string) => ({
    operationKey,
    tool: 'search' as const,
    reserved: usage({ searches: 1 }),
});

async function claim(runId: string, owner = 'recovery-A'): Promise<ClaimedRun> {
    const result = await runs.claim(runId, owner, 60_000);
    if (result.kind !== 'claimed') throw new Error(`Expected claim, got ${result.kind}`);
    return result;
}

export async function setup(options: { mode?: 'live' | 'demo' } = {}) {
    const seed = await seedRun(fixture.db, options);
    const current = await claim(seed.run.id);
    return { ...seed, current, repo: createAgentRepository(fixture.db, current.token) };
}

export async function takeover(runId: string) {
    await fixture.db
        .update(dbRuns)
        .set({ leaseExpiresAt: new Date(0) })
        .where(eq(dbRuns.id, runId))
        .returning()
        .then((rows) => requiredDatabaseValue(rows[0]));
    const current = await claim(runId, 'recovery-B');
    return { current, repo: createAgentRepository(fixture.db, current.token) };
}

/** Preserve the real ordering: a successful ToolCall commits before the fixed deadline elapses. */
export async function expireAfterEvidence(runId: string, expireLease = false): Promise<Date> {
    const [row] = await queryRows<{ deadlineAt: Date }>(
        fixture.db,
        sql`
    UPDATE runs
    SET deadline_at = clock_timestamp(),
        lease_expires_at = CASE WHEN ${expireLease} THEN clock_timestamp() - interval '1 second' ELSE lease_expires_at END
    WHERE id = ${runId}::uuid
    RETURNING deadline_at AS "deadlineAt"
  `,
    );
    return row!.deadlineAt;
}

export function sessionFixture(
    seed: Awaited<ReturnType<typeof setup>>,
    bundle: ConnectorBundle,
    options: { repository?: AgentRepository; signal?: AbortSignal } = {},
) {
    const saver = new PostgresSaver(
        new pg.Pool({ connectionString: fixture.databaseUrl, max: 1 }),
        undefined,
        { schema: new URL(fixture.databaseUrl).searchParams.get('schema')! },
    );
    const session = createAgentSession({
        repository: options.repository ?? seed.repo,
        saver,
        token: seed.current.token,
        bundle,
        context: {
            runId: seed.run.id,
            userId: seed.run.userId,
            taskId: seed.run.taskId,
            taskVersionId: seed.run.taskVersionId,
            mode: seed.run.mode,
            config: seed.current.config,
            budget: seed.current.budget,
            usage: seed.current.usage,
            deadlineAt: seed.current.run.deadlineAt!,
            signal: options.signal ?? new AbortController().signal,
            assertActive: () => runs.assertActive(seed.current.token),
            emit: (event) => runs.emit(seed.current.token, event),
        },
    });
    return { session, prepare: () => saver.setup(), close: () => saver.end() };
}

export let executionFixture: Awaited<ReturnType<typeof testWorkerExecution>>;
beforeAll(async () => {
    await fixture.setup();
    await prepareTestCheckpointSchema(fixture.databaseUrl, fixture.checkpointSchema);
    executionFixture = await testWorkerExecution(fixture.db, {
        DATABASE_URL: fixture.databaseUrl,
        AGENT_CHECKPOINT_SCHEMA: fixture.checkpointSchema,
    });
}, 120_000);

afterAll(async () => {
    try {
        await executionFixture?.stop();
    } finally {
        await fixture.cleanup();
    }
});
