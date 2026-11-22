import { requiredDatabaseValue } from '../../../server/src/utils/execution/database.ts';
import {
    runs as dbRuns,
    eq,
    toolCalls as dbToolCalls,
    reports as dbReports,
    count as dbCount,
    taskVersions as dbTaskVersions,
} from '@scova/db';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import pg from 'pg';
import { expect, it } from 'vite-plus/test';
import { seedRun } from '../support/run-database.ts';
import { fixture, executionFixture } from './fixture.ts';
import { launchAgent, waitAgentMessage, endAgent } from './process-fixture.ts';

export function registerProcessRecovery() {
    it.each([
        { runtime: 'node', boundary: 'search' },
        { runtime: 'bun', boundary: 'search' },
        { runtime: 'node', boundary: 'read' },
        { runtime: 'bun', boundary: 'read' },
    ] as const)(
        'C14-ST03 $runtime $boundary 最后额度已提交但 checkpoint 未写时 SIGKILL，B 接管复用而不再调用供应商',
        async ({ runtime, boundary }) => {
            const seed = await seedRun(fixture.db);
            const budget = { ...seed.config.budget, maxSearches: 1, maxPages: 1 };
            await fixture.db
                .update(dbTaskVersions)
                .set({ configJson: { ...seed.config, focusPoints: [], budget } })
                .where(eq(dbTaskVersions.id, seed.version.id))
                .returning()
                .then((rows) => requiredDatabaseValue(rows[0]));
            await fixture.db
                .update(dbRuns)
                .set({ budgetJson: budget })
                .where(eq(dbRuns.id, seed.run.id))
                .returning()
                .then((rows) => requiredDatabaseValue(rows[0]));
            const first = launchAgent(runtime, 'crash', seed.run.id, boundary, executionFixture);
            let second: ReturnType<typeof launchAgent> | undefined;
            try {
                await waitAgentMessage(first, 'settled-before-checkpoint');
                const initial = await fixture.db.query.runs
                    .findFirst({ where: eq(dbRuns.id, seed.run.id) })
                    .then((row) => requiredDatabaseValue(row));
                expect(initial.checkpointRef).not.toBeNull();
                expect(initial.usageJson).toMatchObject({
                    searches: 1,
                    pages: boundary === 'read' ? 1 : 0,
                });
                const initialCalls = await fixture.db.query.toolCalls.findMany({
                    where: eq(dbToolCalls.runId, seed.run.id),
                });
                expect(initialCalls).toHaveLength(boundary === 'read' ? 2 : 1);
                expect(
                    initialCalls.every(
                        (call) => call.status === 'succeeded' && call.attemptNo === 1,
                    ),
                ).toBe(true);
                await endAgent(first, true);
                const raw = new PostgresSaver(
                    new pg.Pool({ connectionString: fixture.databaseUrl, max: 1 }),
                    undefined,
                    { schema: fixture.checkpointSchema },
                );
                try {
                    const ref = initial.checkpointRef as {
                        threadId: string;
                        namespace: string;
                        checkpointId: string;
                    };
                    const approved = await raw.getTuple({
                        configurable: {
                            thread_id: ref.threadId,
                            checkpoint_ns: ref.namespace,
                            checkpoint_id: ref.checkpointId,
                        },
                    });
                    expect(approved!.checkpoint.channel_values.research).toMatchObject(
                        boundary === 'search'
                            ? { searchIndex: 0, searches: [] }
                            : { readIndex: 0, pages: [] },
                    );
                    expect(approved!.pendingWrites ?? []).toEqual([]);
                } finally {
                    await raw.end();
                }
                await fixture.db
                    .update(dbRuns)
                    .set({ leaseExpiresAt: new Date(0) })
                    .where(eq(dbRuns.id, seed.run.id))
                    .returning()
                    .then((rows) => requiredDatabaseValue(rows[0]));
                second = launchAgent(runtime, 'resume', seed.run.id, boundary, executionFixture);
                await waitAgentMessage(second, 'candidate');
                await endAgent(second);
                expect(second.exit?.code, second.output).toBe(0);
                const recovered = await fixture.db.query.runs
                    .findFirst({ where: eq(dbRuns.id, seed.run.id) })
                    .then((row) => requiredDatabaseValue(row));
                expect(recovered).toMatchObject({
                    leaseEpoch: initial.leaseEpoch + 1,
                    recoveryCount: initial.recoveryCount + 1,
                    startedAt: initial.startedAt,
                    deadlineAt: initial.deadlineAt,
                    status: 'running',
                    usageJson: { searches: 1, pages: 1 },
                    budgetJson: budget,
                    checkpointRef: { leaseEpoch: initial.leaseEpoch + 1 },
                });
                const calls = [...first.messages, ...second.messages].filter(
                    (message) => message.type === 'connector',
                );
                expect(calls.map((call) => call.kind)).toEqual(['search', 'read']);
                const ledger = await fixture.db.query.toolCalls.findMany({
                    where: eq(dbToolCalls.runId, seed.run.id),
                });
                expect(ledger).toHaveLength(2);
                expect(
                    ledger.every((call) => call.status === 'succeeded' && call.attemptNo === 1),
                ).toBe(true);
                expect(
                    second.messages.find((message) => message.type === 'candidate')!.candidate,
                ).toMatchObject({ runId: seed.run.id, mode: 'demo', pages: [expect.anything()] });
                expect(
                    await fixture.db
                        .select({ count: dbCount() })
                        .from(dbReports)
                        .where(eq(dbReports.runId, seed.run.id))
                        .then((rows) => rows[0]!.count),
                ).toBe(0);
            } finally {
                if (!first.exit) await endAgent(first, true);
                if (second && !second.exit) await endAgent(second, true);
            }
        },
        40_000,
    );
}
