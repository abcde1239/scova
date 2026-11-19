import { listRecoverableRuns } from '../../server/src/repo/recoverable-runs.ts';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { runs as dbRuns, eq, sql } from '@scova/db';
import { createConnectorBundle, DEMO_URL } from '@scova/connectors';
import { createRunRepository, withRunFence } from '../src/repo/runs.ts';
import { createAgentRepository } from '../src/repo/agent.ts';
import { RunService } from '../src/service/runs.ts';
import { outboxDatabase } from './support/outbox-database.ts';
import { emptyUsage, seedRun } from './support/run-database.ts';

const fixture = outboxDatabase();
const repository = createRunRepository(fixture.db);
beforeAll(() => fixture.setup(), 120_000);
afterAll(() => fixture.cleanup());
const claim = async (id: string, leaseMs = 60_000) => {
    const result = await repository.claim(id, 'reliability', leaseMs);
    if (result.kind !== 'claimed') throw new Error('claim failed');
    return result;
};

describe('Worker reliability PostgreSQL regressions', () => {
    it('graceful release remains recoverable and never spends crash recovery attempts', async () => {
        const seed = await seedRun(fixture.db);
        let current = await claim(seed.run.id);
        for (let attempt = 0; attempt < 5; attempt++) {
            expect(await repository.release(current.token)).toBe(true);
            expect(await listRecoverableRuns(fixture.db, 1000)).toContainEqual({
                id: seed.run.id,
                leaseEpoch: current.token.leaseEpoch,
            });
            const previous = current;
            current = await claim(seed.run.id);
            expect(current.token.leaseEpoch).toBe(previous.token.leaseEpoch + 1);
            expect(current.run.recoveryCount).toBe(0);
            expect(await repository.release(previous.token)).toBe(false);
        }
        for (let attempt = 1; attempt <= 3; attempt++) {
            await fixture.db
                .update(dbRuns)
                .set({ leaseExpiresAt: new Date(0) })
                .where(eq(dbRuns.id, seed.run.id));
            current = await claim(seed.run.id);
            expect(current.run.recoveryCount).toBe(attempt);
        }
        await fixture.db
            .update(dbRuns)
            .set({ leaseExpiresAt: new Date(0) })
            .where(eq(dbRuns.id, seed.run.id));
        expect(await repository.claim(seed.run.id, 'reliability')).toEqual({ kind: 'ignored' });
        expect(
            await fixture.db.query.runs.findFirst({ where: eq(dbRuns.id, seed.run.id) }),
        ).toMatchObject({ status: 'failed', failureCode: 'RECOVERY_LIMIT_EXCEEDED' });
    });
    it('delivery fence reserves lease time while row lock blocks heartbeat', async () => {
        const seed = await seedRun(fixture.db);
        const current = await claim(seed.run.id, 1000);
        await withRunFence(fixture.db, current.token, 'delivery', async (tx) => {
            await tx.execute(sql`SELECT pg_sleep(1.1)`);
        });
        expect(await repository.renew(current.token, 1000)).toBe('renewed');
    });
    it('deadline partial delivery keeps renewing the real lease until persistence finishes', async () => {
        const seed = await seedRun(fixture.db);
        await fixture.db
            .update(dbRuns)
            .set({ deadlineAt: new Date(Date.now() + 150) })
            .where(eq(dbRuns.id, seed.run.id));
        let delivered = false;
        const result = await new RunService({
            repository,
            leaseMs: 240,
            renewIntervalMs: 40,
            executorFactory: (token) => ({
                execute: () => new Promise<void>(() => {}),
                async onDeadline() {
                    await new Promise((resolve) => setTimeout(resolve, 500));
                    await withRunFence(fixture.db, token, 'deadline_delivery', async () => {
                        delivered = true;
                    });
                },
            }),
        }).execute(seed.run.id);
        expect(result).toBe('processed');
        expect(delivered).toBe(true);
    });
    it('hydrates exact checkpoint page receipts and rejects modified immutable metadata', async () => {
        const seed = await seedRun(fixture.db),
            current = await claim(seed.run.id);
        const repo = createAgentRepository(fixture.db, current.token);
        const page = await createConnectorBundle().reader.read(DEMO_URL);
        const key = 'read-0:' + createHash('sha256').update(JSON.stringify(DEMO_URL)).digest('hex');
        const call = await repo.reserve({
            operationKey: key,
            tool: 'read',
            reserved: { ...emptyUsage(), pages: 1 },
        });
        await repo.settle({ toolCallId: call.toolCallId, output: page });
        const { text, ...metadata } = page;
        const ref = { ...metadata, id: 'read-0', questionIds: ['q1'] };
        expect(await repo.readCheckpointPages([ref])).toEqual([
            { ...page, id: ref.id, questionIds: ref.questionIds },
        ]);
        await expect(
            repo.readCheckpointPages([{ ...ref, title: 'tampered' }]),
        ).rejects.toMatchObject({ code: 'INVALID_CHECKPOINT' });
        await expect(repo.readCheckpointPages([{ ...ref, id: 'read-1' }])).rejects.toMatchObject({
            code: 'INVALID_CHECKPOINT',
        });
        expect(text.length).toBeGreaterThan(0);
    });
});
