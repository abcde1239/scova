import { prepareTestCheckpointSchema } from '../support/checkpoint-schema.ts';
import {
    reports as dbReports,
    eq,
    count as dbCount,
    evidence as dbEvidence,
    runSources as dbRunSources,
} from '@scova/db';
import { createHash } from 'node:crypto';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import pg from 'pg';
import { afterAll, beforeAll, expect } from 'vite-plus/test';
import { createConnectorBundle } from '@scova/connectors';
import { createAgentRepository } from '../../src/repo/agent.ts';
import { createRunRepository } from '../../src/repo/runs.ts';
import { createAgentSession } from '../../src/service/agent.ts';
import { createDeliveryService } from '../../src/service/delivery.ts';
import { outboxDatabase } from '../support/outbox-database.ts';
import { seedRun } from '../support/run-database.ts';

export const fixture = outboxDatabase();

export const runs = createRunRepository(fixture.db);

export const schema = new URL(fixture.databaseUrl).searchParams.get('schema')!;

export const saver = new PostgresSaver(
    new pg.Pool({ connectionString: fixture.databaseUrl, max: 3 }),
    undefined,
    { schema },
);

export const delivery = createDeliveryService(fixture.db, saver);

export const sha = (value: string) => createHash('sha256').update(value).digest('hex');

beforeAll(async () => {
    await fixture.setup();
    await prepareTestCheckpointSchema(fixture.databaseUrl, schema);
}, 120_000);

afterAll(async () => {
    await saver.end();
    await fixture.cleanup();
});

export async function research() {
    const seed = await seedRun(fixture.db);
    const claimed = await runs.claim(seed.run.id, 'delivery-test', 60_000);
    if (claimed.kind !== 'claimed') throw new Error('Expected claimed Run');
    const context = {
        runId: seed.run.id,
        userId: seed.user.id,
        taskId: seed.task.id,
        taskVersionId: seed.version.id,
        mode: seed.run.mode,
        config: claimed.config,
        budget: claimed.budget,
        usage: claimed.usage,
        startedAt: claimed.run.startedAt!,
        deadlineAt: claimed.run.deadlineAt!,
        signal: new AbortController().signal,
        assertActive: () => runs.assertActive(claimed.token),
        emit: (event: Parameters<typeof runs.emit>[1]) => runs.emit(claimed.token, event),
    };
    const session = createAgentSession({
        repository: createAgentRepository(fixture.db, claimed.token),
        saver,
        token: claimed.token,
        context,
        bundle: createConnectorBundle(),
    });
    const candidate = await session.execute();
    return { ...seed, claimed, context, session, candidate };
}

export async function assertEmpty(runId: string) {
    expect(
        await fixture.db
            .select({ count: dbCount() })
            .from(dbReports)
            .where(eq(dbReports.runId, runId))
            .then((rows) => rows[0]!.count),
    ).toBe(0);
    expect(
        await fixture.db
            .select({ count: dbCount() })
            .from(dbEvidence)
            .where(eq(dbEvidence.runId, runId))
            .then((rows) => rows[0]!.count),
    ).toBe(0);
    expect(
        await fixture.db
            .select({ count: dbCount() })
            .from(dbRunSources)
            .where(eq(dbRunSources.runId, runId))
            .then((rows) => rows[0]!.count),
    ).toBe(0);
}
