import { requiredDatabaseValue } from '../../../server/src/utils/execution/database.ts';
import { reports as dbReports, eq, runs as dbRuns, baselines as dbBaselines } from '@scova/db';
import { expect, it } from 'vite-plus/test';
import { candidateFromCheckpoint, type AgentCandidate } from '@scova/agent-core';
import { createAgentRepository } from '../../../server/src/repo/execution/agent.ts';
import { research, fixture, saver, sha, delivery, assertEmpty } from './fixture.ts';
import { liveResearch } from './live-research.ts';
import { checkpointWithBodies } from './checkpoint.ts';

export function registerSourceAuthentication() {
    it('即使伪造正文已写入并提升checkpoint也必须匹配当前Run成功read账本', async () => {
        const seed = await research();
        const run = await fixture.db.query.runs
            .findFirst({ where: eq(dbRuns.id, seed.run.id) })
            .then((row) => requiredDatabaseValue(row));
        const ref = run.checkpointRef as {
            threadId: string;
            namespace: '';
            checkpointId: string;
            leaseEpoch: number;
        };
        const config = {
            configurable: {
                thread_id: ref.threadId,
                checkpoint_ns: '',
                checkpoint_id: ref.checkpointId,
            },
        };
        const tuple = (await saver.getTuple(config))!;
        const checkpoint = structuredClone(tuple.checkpoint);
        const state = checkpoint.channel_values.research as {
            pages: AgentCandidate['pages'];
            claims: AgentCandidate['claims'];
        };
        const text = '伪造正文不能冒充成功采集结果';
        state.pages[0].text = text;
        state.pages[0].contentHash = sha(text);
        state.claims[0].text = text;
        state.claims[0].citations[0].quote = text;
        checkpoint.id = crypto.randomUUID();
        const saved = await saver.put(
            config,
            checkpoint,
            tuple.metadata!,
            checkpoint.channel_versions,
        );
        await createAgentRepository(fixture.db, seed.claimed.token).promoteCheckpoint({
            ...ref,
            checkpointId: saved.configurable!.checkpoint_id as string,
        });
        const forged = candidateFromCheckpoint(
            { ...seed.context, demoReason: seed.candidate.demoReason },
            state,
        );
        await expect(delivery.deliver(seed.claimed.token, forged)).rejects.toMatchObject({
            code: 'INVALID_DELIVERY_EVIDENCE',
        });
        await assertEmpty(seed.run.id);
    });

    it.each(['upgrade', 'delete'] as const)(
        '提升checkpoint后%s采集状态仍须匹配不可变read账本，正文hash相同不能证明完整采集',
        async (forgery) => {
            const seed = await liveResearch({
                collection: {
                    version: 1,
                    method: 'browser',
                    complete: false,
                    limitations: ['resource_failure'],
                },
            });
            const run = await fixture.db.query.runs
                .findFirst({ where: eq(dbRuns.id, seed.run.id) })
                .then((row) => requiredDatabaseValue(row));
            const ref = run.checkpointRef as {
                threadId: string;
                namespace: '';
                checkpointId: string;
                leaseEpoch: number;
            };
            const config = {
                configurable: {
                    thread_id: ref.threadId,
                    checkpoint_ns: '',
                    checkpoint_id: ref.checkpointId,
                },
            };
            const tuple = (await saver.getTuple(config))!;
            const checkpoint = structuredClone(tuple.checkpoint);
            const state = checkpoint.channel_values.research as {
                gaps: string[];
                pages: AgentCandidate['pages'];
            };
            const originalHash = state.pages[0].contentHash;
            const repository = createAgentRepository(fixture.db, seed.claimed.token);
            const restoredContext = {
                ...seed.context,
                ...(await repository.comparison()),
                usage: await repository.usage(),
            };
            expect(
                candidateFromCheckpoint(
                    restoredContext,
                    checkpointWithBodies(state, seed.candidate.pages),
                ),
            ).toEqual(seed.candidate);
            if (forgery === 'delete') delete state.pages[0].collection;
            else
                state.pages[0].collection = {
                    version: 1,
                    method: 'browser',
                    complete: true,
                    limitations: [],
                };
            state.gaps = [];
            expect(state.pages[0].contentHash).toBe(originalHash);
            checkpoint.id = crypto.randomUUID();
            const saved = await saver.put(
                config,
                checkpoint,
                tuple.metadata!,
                checkpoint.channel_versions,
            );
            await createAgentRepository(fixture.db, seed.claimed.token).promoteCheckpoint({
                ...ref,
                checkpointId: saved.configurable!.checkpoint_id as string,
            });
            const forged = candidateFromCheckpoint(
                restoredContext,
                checkpointWithBodies(state, seed.candidate.pages),
            );
            await expect(delivery.deliver(seed.claimed.token, forged)).rejects.toMatchObject({
                code: 'INVALID_DELIVERY_EVIDENCE',
            });
            await assertEmpty(seed.run.id);
        },
    );

    it('删除checkpoint采集缺口后仍从不可变正文恢复诊断与比较阻断', async () => {
        const seed = await liveResearch({
            collection: {
                version: 1,
                method: 'browser',
                complete: false,
                limitations: ['render_timeout'],
            },
        });
        const run = await fixture.db.query.runs
            .findFirst({ where: eq(dbRuns.id, seed.run.id) })
            .then((row) => requiredDatabaseValue(row));
        const ref = run.checkpointRef as {
            threadId: string;
            namespace: '';
            checkpointId: string;
            leaseEpoch: number;
        };
        const config = {
            configurable: {
                thread_id: ref.threadId,
                checkpoint_ns: '',
                checkpoint_id: ref.checkpointId,
            },
        };
        const tuple = (await saver.getTuple(config))!;
        const checkpoint = structuredClone(tuple.checkpoint);
        const state = checkpoint.channel_values.research as { gaps: string[] };
        const repository = createAgentRepository(fixture.db, seed.claimed.token);
        const restoredContext = {
            ...seed.context,
            ...(await repository.comparison()),
            usage: await repository.usage(),
        };
        expect(
            candidateFromCheckpoint(
                restoredContext,
                checkpointWithBodies(state, seed.candidate.pages),
            ),
        ).toEqual(seed.candidate);
        state.gaps = [];
        checkpoint.id = crypto.randomUUID();
        const saved = await saver.put(
            config,
            checkpoint,
            tuple.metadata!,
            checkpoint.channel_versions,
        );
        await createAgentRepository(fixture.db, seed.claimed.token).promoteCheckpoint({
            ...ref,
            checkpointId: saved.configurable!.checkpoint_id as string,
        });
        const restored = candidateFromCheckpoint(
            restoredContext,
            checkpointWithBodies(state, seed.candidate.pages),
        );
        expect(restored.coverage.completeness).toBe('partial');
        expect([...restored.coverage.gaps, ...(restored.coverage.notes ?? [])].join(' ')).toContain(
            '网页渲染或资源加载受限',
        );
        const delivered = await delivery.deliver(seed.claimed.token, restored);
        expect(
            await fixture.db.query.reports.findFirst({
                where: eq(dbReports.id, delivered.reportId),
            }),
        ).toMatchObject({ completeness: 'partial' });
        expect(
            await fixture.db.query.baselines.findFirst({
                where: eq(dbBaselines.taskId, seed.task.id),
            }),
        ).toBeUndefined();
    });
}
