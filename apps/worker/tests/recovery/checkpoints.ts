import { eq, reports as dbReports, count as dbCount } from '@scova/db';
import { createConnectorBundle } from '@scova/connectors';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import pg from 'pg';
import { expect, it } from 'vite-plus/test';
import { setup, takeover, fixture, sessionFixture } from './fixture.ts';

export function registerCheckpoints() {
    it('C14-ERR01 checkpoint 只能提升本 Run/epoch；接管读取明确旧指针且拒绝迟到提升', async () => {
        const seed = await setup();
        expect(await seed.repo.readAuthorizedCheckpoint()).toBeNull();
        const ref = {
            threadId: `run-${seed.run.id}-epoch-${seed.current.token.leaseEpoch}`,
            namespace: '' as const,
            checkpointId: 'checkpoint-approved',
            leaseEpoch: seed.current.token.leaseEpoch,
        };
        await seed.repo.promoteCheckpoint(ref);
        const next = await takeover(seed.run.id);
        expect(await next.repo.readAuthorizedCheckpoint()).toEqual(ref);
        await expect(
            seed.repo.promoteCheckpoint({ ...ref, checkpointId: 'late-stale' }),
        ).rejects.toMatchObject({ code: 'LEASE_LOST' });
        await expect(next.repo.promoteCheckpoint(ref)).rejects.toMatchObject({
            code: 'INVALID_CHECKPOINT',
        });
        for (const invalid of [
            { ...ref, threadId: 'run-another-epoch-2', leaseEpoch: 2 },
            { ...ref, namespace: 'foreign' },
            { ...ref, checkpointId: '../../latest' },
        ]) {
            await expect(next.repo.promoteCheckpoint(invalid as typeof ref)).rejects.toMatchObject({
                code: 'INVALID_CHECKPOINT',
            });
        }
        expect(await next.repo.readAuthorizedCheckpoint()).toEqual(ref);
    });

    it('C14-ERR03 真实 PostgresSaver 接受旧 thread 原始迟到写，但不能提升或污染合法恢复指针', async () => {
        const seed = await setup();
        const pool = new pg.Pool({ connectionString: fixture.databaseUrl, max: 2 });
        const saver = new PostgresSaver(pool, undefined, {
            schema: new URL(fixture.databaseUrl).searchParams.get('schema')!,
        });
        const state = Annotation.Root({
            value: Annotation<string>({ reducer: (_old, next) => next, default: () => '' }),
        });
        const graph = new StateGraph(state)
            .addNode('stored', () => ({ value: 'approved-result' }))
            .addEdge(START, 'stored')
            .addEdge('stored', END)
            .compile({ checkpointer: saver });
        const config = {
            configurable: {
                thread_id: `run-${seed.run.id}-epoch-${seed.current.token.leaseEpoch}`,
                checkpoint_ns: '',
            },
        };
        try {
            await saver.setup();
            await graph.invoke({ value: 'initial' }, config);
            const approved = await graph.getState(config);
            const ref = {
                threadId: config.configurable.thread_id,
                namespace: '' as const,
                checkpointId: approved.config.configurable!.checkpoint_id as string,
                leaseEpoch: seed.current.token.leaseEpoch,
            };
            await seed.repo.promoteCheckpoint(ref);
            const next = await takeover(seed.run.id);
            const late = await graph.updateState(approved.config, { value: 'stale-result' });
            expect((await saver.getTuple(config))!.checkpoint.channel_values.value).toBe(
                'stale-result',
            );
            await expect(
                seed.repo.promoteCheckpoint({
                    ...ref,
                    checkpointId: late.configurable!.checkpoint_id as string,
                }),
            ).rejects.toMatchObject({ code: 'LEASE_LOST' });
            expect(await next.repo.readAuthorizedCheckpoint()).toEqual(ref);
            const authorized = await saver.getTuple({
                configurable: {
                    thread_id: ref.threadId,
                    checkpoint_ns: ref.namespace,
                    checkpoint_id: ref.checkpointId,
                },
            });
            expect(authorized!.checkpoint.channel_values.value).toBe('approved-result');
            await saver.putWrites(
                approved.config,
                [['value', 'unauthorized-late-pending-result']],
                'stale-worker-task',
            );
            expect((await saver.getTuple(approved.config))!.pendingWrites).toContainEqual([
                'stale-worker-task',
                'value',
                'unauthorized-late-pending-result',
            ]);
            const recovery = sessionFixture(
                { ...seed, current: next.current, repo: next.repo },
                createConnectorBundle(),
            );
            try {
                const opened = await recovery.session.openCheckpoint();
                expect(opened.resume).toBe(true);
                expect(opened.config.configurable!.thread_id).toBe(
                    `run-${seed.run.id}-epoch-${next.current.token.leaseEpoch}`,
                );
                const fork = await saver.getTuple(opened.config);
                expect(fork!.checkpoint.channel_values.value).toBe('approved-result');
                expect(fork!.pendingWrites ?? []).toEqual([]);
                expect(await next.repo.readAuthorizedCheckpoint()).toMatchObject({
                    leaseEpoch: next.current.token.leaseEpoch,
                    checkpointId: opened.config.configurable!.checkpoint_id,
                });
            } finally {
                await recovery.close();
            }
            expect(
                await fixture.db
                    .select({ count: dbCount() })
                    .from(dbReports)
                    .where(eq(dbReports.runId, seed.run.id))
                    .then((rows) => rows[0]!.count),
            ).toBe(0);
        } finally {
            await saver.end();
        }
    });
}
