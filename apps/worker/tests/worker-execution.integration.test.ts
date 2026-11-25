import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { createConnectorBundle, DEMO_URL } from '@scova/connectors';
import { eq, runs, reports, toolCalls, sql, queryRows } from '@scova/db';
import { emptyCheckpoint } from '@langchain/langgraph';
import { createFetchTransport } from 'requestlane/fetch';
import { executionPath } from '@scova/execution/protocol';
import { encodeExecutionValue, executionBodyLimit } from '@scova/execution/wire';
import { createExecutionClient } from '../src/repo/execution.ts';
import { createAgentRuntime } from '../src/service/agent.ts';
import { RunService } from '../src/service/runs.ts';
import { outboxDatabase } from './support/outbox-database.ts';
import { prepareTestCheckpointSchema } from './support/checkpoint-schema.ts';
import { emptyUsage, seedRun } from './support/run-database.ts';
import { testWorkerExecution } from './support/worker-execution.ts';

const fixture = outboxDatabase();
let execution: Awaited<ReturnType<typeof testWorkerExecution>>;
let client: ReturnType<typeof createExecutionClient>;

beforeAll(async () => {
    await fixture.setup();
    await prepareTestCheckpointSchema(fixture.databaseUrl, fixture.checkpointSchema);
    execution = await testWorkerExecution(fixture.db, {
        DATABASE_URL: fixture.databaseUrl,
        AGENT_CHECKPOINT_SCHEMA: fixture.checkpointSchema,
    });
    client = createExecutionClient(execution.url, execution.token);
}, 120_000);

afterAll(async () => {
    try {
        await execution?.stop();
    } finally {
        await fixture.cleanup();
    }
});

describe('Server 持久化与 Worker 内部执行协议', () => {
    it('隔离服务身份，拒绝未知动作和无效请求', async () => {
        const url = new URL(executionPath, execution.url);
        const { native } = createFetchTransport();
        const request = (token: string, action: string, args: unknown[]) =>
            native(url, {
                method: 'POST',
                headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
                body: JSON.stringify({ action, args: encodeExecutionValue(args) }),
            });
        expect((await request('x'.repeat(64), 'ready', [])).status).toBe(401);
        expect((await request(execution.token, 'query', ['SELECT 1'])).status).toBe(400);
        expect((await request(execution.token, 'claim', ['invalid', 30_000])).status).toBe(400);
        expect(
            (await request(execution.token, 'claim', ['invalid', Number.MAX_SAFE_INTEGER])).status,
        ).toBe(400);
        await expect(client.ready()).resolves.toEqual({ queue: 'bullmq', queueName: 'scova-runs' });
    });

    it('以真实 Agent 图、Checkpoint 和账本交付一次，重复消费不产生第二份报告', async () => {
        const seed = await seedRun(fixture.db);
        const agent = createAgentRuntime({
            persistence: client.persistence,
            bundle: createConnectorBundle(),
            env: {},
        });
        const service = new RunService({
            repository: client.runs,
            executorFactory: (token) => agent.executorFactory(token),
        });
        try {
            await agent.connect();
            await expect(service.execute(seed.run.id)).resolves.toBe('processed');
            await expect(service.execute(seed.run.id)).resolves.toBe('ignored');
            const run = await fixture.db.query.runs.findFirst({ where: eq(runs.id, seed.run.id) });
            expect(run?.checkpointRef).toBeTruthy();
            expect(['succeeded', 'partial']).toContain(run?.status);
            expect(
                await fixture.db.query.reports.findMany({ where: eq(reports.runId, seed.run.id) }),
            ).toHaveLength(1);
            expect(
                await fixture.db.query.toolCalls.findMany({
                    where: eq(toolCalls.runId, seed.run.id),
                }),
            ).not.toHaveLength(0);
        } finally {
            await agent.close();
        }
    });

    it('换手读回已批准 checkpoint，拒绝跨账号和旧租约写入', async () => {
        const seed = await seedRun(fixture.db);
        const other = await seedRun(fixture.db);
        const first = await client.runs.claim(seed.run.id, 'test');
        const stranger = await client.runs.claim(other.run.id, 'test');
        if (first.kind !== 'claimed' || stranger.kind !== 'claimed')
            throw new Error('Fixture runs unavailable');
        const thread = `run-${first.token.runId}-epoch-${first.token.leaseEpoch}`;
        const config = { configurable: { thread_id: thread, checkpoint_ns: '' } };
        const prior = client.persistence.checkpoints(first.token);
        const legacyPages = Array.from({ length: 10 }, (_, index) => ({
            text: `${index}`.repeat(900_000),
        }));
        const checkpoint = {
            ...emptyCheckpoint(),
            id: 'checkpoint-1',
            ts: new Date().toISOString(),
            channel_values: { research: { body: new Uint8Array([2, 3]) }, legacy: legacyPages },
            channel_versions: { research: 1, legacy: 1 },
            versions_seen: {},
        };
        const checkpointConfig = await prior.put(
            config,
            checkpoint,
            { source: 'input', step: 0, parents: {} },
            checkpoint.channel_versions,
        );
        await client.persistence.repository(first.token).promoteCheckpoint({
            threadId: thread,
            checkpointId: checkpoint.id,
            namespace: '',
            leaseEpoch: first.token.leaseEpoch,
        });
        await expect(
            client.persistence.checkpoints(stranger.token).getTuple(checkpointConfig),
        ).rejects.toMatchObject({ code: 'INVALID_CHECKPOINT' });
        await expect(
            client.runs.assertActive({ ...first.token, leaseOwner: stranger.token.leaseOwner }),
        ).rejects.toMatchObject({ code: 'LEASE_LOST' });
        await expect(
            client.runs.assertActive({ ...first.token, userId: stranger.token.userId }),
        ).rejects.toMatchObject({ code: 'LEASE_LOST' });
        await prior.put(
            config,
            { ...checkpoint, channel_values: { research: 'different' } },
            { source: 'input', step: 0, parents: {} },
            checkpoint.channel_versions,
        );
        await expect(client.runs.release(first.token)).resolves.toBe(true);
        const next = await client.runs.claim(seed.run.id, 'test');
        if (next.kind !== 'claimed') throw new Error('Fixture cannot recover');
        expect(next.token.leaseEpoch).toBeGreaterThan(first.token.leaseEpoch);
        await expect(client.persistence.repository(first.token).usage()).rejects.toMatchObject({
            code: 'LEASE_LOST',
        });
        await expect(
            prior.putWrites(checkpointConfig, [['research', 1]], 'stale-task'),
        ).rejects.toMatchObject({ code: 'LEASE_LOST' });
        const saver = client.persistence.checkpoints(next.token);
        await expect(saver.getTuple(config)).rejects.toMatchObject({ code: 'INVALID_CHECKPOINT' });
        const restored = await saver.getTuple(checkpointConfig);
        expect(restored?.checkpoint.channel_values.research).toEqual({
            body: new Uint8Array([2, 3]),
        });
        const restoredPages = restored?.checkpoint.channel_values.legacy as typeof legacyPages;
        expect(restoredPages.map((page) => [page.text[0], page.text.length])).toEqual(
            legacyPages.map((page) => [page.text[0], page.text.length]),
        );
        await expect(
            saver.put(
                config,
                checkpoint,
                { source: 'input', step: 0, parents: {} },
                checkpoint.channel_versions,
            ),
        ).rejects.toMatchObject({ code: 'INVALID_CHECKPOINT' });
    });
    it.each([
        { text: 'Small page', requests: 1 },
        { text: '你"'.repeat(419_000), requests: 2 },
    ])('按编码字节批量恢复五页，保持凭据、顺序与回退游标', async ({ text, requests }) => {
        const seed = await seedRun(fixture.db);
        const claimed = await client.runs.claim(seed.run.id, 'test', 60_000);
        if (claimed.kind !== 'claimed') throw new Error('Fixture run unavailable');
        const repo = client.persistence.repository(claimed.token);
        const page = await createConnectorBundle().reader.read(DEMO_URL);
        const hash = (value: string) => createHash('sha256').update(value).digest('hex');
        const refs = [];
        for (let index = 0; index < 5; index++) {
            const id = `read-${index}`;
            const originalUrl = `https://example.test/${index}`;
            const { text: _demoText, ...metadata } = {
                ...page,
                originalUrl,
                contentHash: hash(text),
            };
            const reservation = await repo.reserve({
                operationKey: `${id}:${hash(JSON.stringify(originalUrl))}`,
                tool: 'read',
                reserved: { ...emptyUsage(), pages: 1 },
            });
            await repo.settle({
                toolCallId: reservation.toolCallId,
                output: { ...metadata, text },
            });
            refs.push({ ...metadata, id, questionIds: ['q1'] });
        }
        const fetcher = globalThis.fetch;
        const responses: number[] = [];
        globalThis.fetch = Object.assign(async (...args: Parameters<typeof fetch>) => {
            const response = await fetcher(...args);
            responses.push((await response.clone().arrayBuffer()).byteLength);
            return response;
        }, fetcher);
        let observed: ReturnType<typeof createExecutionClient>;
        try {
            observed = createExecutionClient(execution.url, execution.token);
        } finally {
            globalThis.fetch = fetcher;
        }
        const recovery = observed.persistence.repository(claimed.token);
        const reversed = [...refs].reverse();
        const restored = await recovery.readCheckpointPages(reversed);
        expect(restored.map((page) => page.id)).toEqual(reversed.map((ref) => ref.id));
        expect(restored.every((page) => page.text === text)).toBe(true);
        expect(responses).toHaveLength(requests);
        expect(Math.max(...responses)).toBeLessThanOrEqual(executionBodyLimit);
        responses.length = 0;
        await fixture.db
            .update(runs)
            .set({ deadlineAt: new Date() })
            .where(eq(runs.id, seed.run.id));
        const fallback = await recovery.readPages({ allowDeadline: true });
        expect(fallback.map((page) => (page as { originalUrl: string }).originalUrl)).toEqual(
            refs.map((ref) => ref.originalUrl),
        );
        expect(responses).toHaveLength(requests);
        expect(Math.max(...responses)).toBeLessThanOrEqual(executionBodyLimit);
        await expect(
            recovery.readCheckpointPages(
                [...refs.slice(0, -1), { ...refs.at(-1)!, contentHash: '0'.repeat(64) }],
                { allowDeadline: true },
            ),
        ).rejects.toMatchObject({ code: 'INVALID_CHECKPOINT' });
        await expect(
            observed.persistence
                .repository({ ...claimed.token, leaseEpoch: claimed.token.leaseEpoch + 1 })
                .readPages({ allowDeadline: true }),
        ).rejects.toMatchObject({ code: 'LEASE_LOST' });
    });

    it('检查点写入耗时超过 deadline 时回滚原始 checkpoint 行', async () => {
        const seed = await seedRun(fixture.db);
        const claimed = await client.runs.claim(seed.run.id, 'test');
        if (claimed.kind !== 'claimed') throw new Error('Fixture run unavailable');
        const schema = sql.identifier(fixture.checkpointSchema);
        await fixture.db.execute(sql`CREATE FUNCTION ${schema}.delay_checkpoint() RETURNS trigger
            LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(2); RETURN NEW; END; $$`);
        try {
            await fixture.db
                .execute(sql`CREATE TRIGGER delay_checkpoint BEFORE INSERT ON ${schema}.checkpoints
                 FOR EACH ROW EXECUTE FUNCTION ${schema}.delay_checkpoint()`);
            await fixture.db.execute(
                sql`UPDATE runs SET deadline_at = clock_timestamp() + interval '1 second' WHERE id = ${seed.run.id}::uuid`,
            );
            const checkpoint = emptyCheckpoint();
            const thread = `run-${claimed.token.runId}-epoch-${claimed.token.leaseEpoch}`;
            await expect(
                client.persistence
                    .checkpoints(claimed.token)
                    .put(
                        { configurable: { thread_id: thread } },
                        checkpoint,
                        { source: 'input', step: 0, parents: {} },
                        {},
                    ),
            ).rejects.toMatchObject({ code: 'DEADLINE_EXCEEDED' });
            expect(
                await queryRows(
                    fixture.db,
                    sql`SELECT checkpoint_id FROM ${schema}.checkpoints WHERE thread_id = ${thread}`,
                ),
            ).toEqual([]);
        } finally {
            await fixture.db.execute(
                sql`DROP TRIGGER IF EXISTS delay_checkpoint ON ${schema}.checkpoints`,
            );
            await fixture.db.execute(sql`DROP FUNCTION ${schema}.delay_checkpoint()`);
        }
    });
});
