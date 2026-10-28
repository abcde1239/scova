import { requiredDatabaseValue } from '@/utils/database.ts';
import {
    runs as dbRuns,
    eq,
    sql,
    queryRows,
    toolCalls as dbToolCalls,
    runEvents as dbRunEvents,
    reports as dbReports,
    count as dbCount,
    asc,
    taskVersions as dbTaskVersions,
} from '@scova/db';
import type { Usage } from '@scova/models';
import type { AgentCandidate } from '@scova/agent-core';
import {
    createConnectorBundle,
    createModelProvider,
    estimateModelInputTokens,
    DEMO_URL,
    type ConnectorBundle,
    type StructuredInput,
    type SafeHttpClient,
    type CallContext,
} from '@scova/connectors';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { createAgentRepository, type AgentRepository } from '../src/repo/agent.ts';
import { createRunRepository, type ClaimedRun } from '../src/repo/runs.ts';
import { createAgentSession, createAgentRuntime } from '../src/service/agent.ts';
import { RunService } from '../src/service/runs.ts';
import { outboxDatabase } from './support/outbox-database.ts';
import { emptyUsage, seedRun } from './support/run-database.ts';
import { nodeScriptCommand } from '../../../scripts/process-runtime.mjs';

const fixture = outboxDatabase();
const runs = createRunRepository(fixture.db);
const usage = (values: Partial<Usage> = {}): Usage => ({ ...emptyUsage(), ...values });
const search = (operationKey: string) => ({
    operationKey,
    tool: 'search' as const,
    reserved: usage({ searches: 1 }),
});
async function claim(runId: string, owner = 'recovery-A'): Promise<ClaimedRun> {
    const result = await runs.claim(runId, owner, 60_000);
    if (result.kind !== 'claimed') throw new Error(`Expected claim, got ${result.kind}`);
    return result;
}
async function setup(options: { mode?: 'live' | 'demo' } = {}) {
    const seed = await seedRun(fixture.db, options);
    const current = await claim(seed.run.id);
    return { ...seed, current, repo: createAgentRepository(fixture.db, current.token) };
}
async function takeover(runId: string) {
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
async function expireAfterEvidence(runId: string, expireLease = false): Promise<Date> {
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
function sessionFixture(
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
    return { session, close: () => saver.end() };
}

beforeAll(async () => {
    await fixture.setup();
    await fixture.db.execute(
        sql`CREATE TABLE recovery_external_calls (id bigserial PRIMARY KEY, run_id uuid NOT NULL, kind text NOT NULL, input text NOT NULL)`,
    );
}, 120_000);
afterAll(() => fixture.cleanup());

describe('Agent 工具账本与恢复授权（真实 PostgreSQL，无 Redis）', () => {
    it('C14-F01 已提交 operationKey 跨 epoch 复用，结算重放不改结果或重复扣费', async () => {
        const seed = await setup();
        const first = await seed.repo.reserve({
            ...search('search:1'),
            inputSummary: 'secret prompt',
        });
        const result = { kind: 'search_results', results: [{ url: 'https://example.com' }] };
        await seed.repo.settle({ toolCallId: first.toolCallId, output: result });
        await seed.repo.settle({ toolCallId: first.toolCallId, output: { overwritten: true } });
        const next = await takeover(seed.run.id);
        expect(await next.repo.reserve(search('search:1'))).toMatchObject({
            kind: 'reused',
            toolCallId: first.toolCallId,
            attemptNo: 1,
            output: result,
            usage: { searches: 1 },
        });
        const calls = await fixture.db.query.toolCalls.findMany({
            where: eq(dbToolCalls.runId, seed.run.id),
        });
        expect(calls).toHaveLength(1);
        expect(calls[0]!.inputSummary).not.toContain('secret');
        const events = await fixture.db.query.runEvents.findMany({
            where: eq(dbRunEvents.runId, seed.run.id),
        });
        expect(JSON.stringify(events)).not.toContain('secret prompt');
        expect(events.filter((event) => event.type === 'tool.started')).toHaveLength(1);
        expect(events.filter((event) => event.type === 'tool.completed')).toHaveLength(1);
        expect(
            await fixture.db
                .select({ count: dbCount() })
                .from(dbReports)
                .where(eq(dbReports.runId, seed.run.id))
                .then((rows) => rows[0]!.count),
        ).toBe(0);
    });

    it.each([
        {
            tool: 'search',
            counter: 'searches',
            budget: 'maxSearches',
            reserved: usage({ searches: 1 }),
        },
        { tool: 'read', counter: 'pages', budget: 'maxPages', reserved: usage({ pages: 1 }) },
        {
            tool: 'model',
            counter: 'inputTokens',
            budget: 'maxInputTokens',
            reserved: usage({ inputTokens: 1, outputTokens: 1 }),
        },
        {
            tool: 'model',
            counter: 'outputTokens',
            budget: 'maxOutputTokens',
            reserved: usage({ inputTokens: 1, outputTokens: 1 }),
        },
    ] as const)(
        'C14-E01 并发预留 $counter 到上限后原子拒绝，不能超卖',
        async ({ tool, counter, budget, reserved }) => {
            const seed = await setup();
            await fixture.db
                .update(dbRuns)
                .set({ budgetJson: { ...seed.config.budget, [budget]: 2 } })
                .where(eq(dbRuns.id, seed.run.id))
                .returning()
                .then((rows) => requiredDatabaseValue(rows[0]));
            const results = await Promise.allSettled(
                Array.from({ length: 8 }, (_, i) =>
                    seed.repo.reserve({
                        operationKey: `${tool}:${i}`,
                        tool,
                        reserved,
                    }),
                ),
            );
            expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(2);
            const rejected = results.filter((item) => item.status === 'rejected');
            expect(rejected).toHaveLength(6);
            for (const item of rejected)
                if (item.status === 'rejected')
                    expect(item.reason).toMatchObject({ code: 'BUDGET_EXCEEDED' });
            expect((await seed.repo.usage())[counter]).toBe(2);
            expect(
                await fixture.db
                    .select({ count: dbCount() })
                    .from(dbToolCalls)
                    .where(eq(dbToolCalls.runId, seed.run.id))
                    .then((rows) => rows[0]!.count),
            ).toBe(2);
            const events = await fixture.db.query.runEvents.findMany({
                where: eq(dbRunEvents.runId, seed.run.id),
                orderBy: [asc(dbRunEvents.seq)],
            });
            expect(events.filter((event) => event.type === 'tool.started')).toHaveLength(2);
            expect(events.filter((event) => event.type === 'budget.updated')).toHaveLength(2);
            expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1));
        },
    );

    it('C14-E02 同 operationKey 并发只有一个在途调用；工具类型不允许换用', async () => {
        const seed = await setup();
        const results = await Promise.allSettled(
            Array.from({ length: 5 }, () => seed.repo.reserve(search('same-operation'))),
        );
        expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
        for (const item of results)
            if (item.status === 'rejected')
                expect(item.reason).toMatchObject({ code: 'TOOL_CALL_BUSY' });
        await expect(
            seed.repo.reserve({
                operationKey: 'same-operation',
                tool: 'read',
                reserved: usage({ pages: 1 }),
            }),
        ).rejects.toMatchObject({ code: 'INVALID_TOOL_CALL' });
        expect(await seed.repo.usage()).toMatchObject({ searches: 1, pages: 0 });
    });

    it.each([true, false])(
        'C14-ST01 unknown=%s 保留已预留预算，重试新 attempt 再收费',
        async (unknown) => {
            const seed = await setup();
            await fixture.db
                .update(dbRuns)
                .set({ budgetJson: { ...seed.config.budget, maxSearches: 2 } })
                .where(eq(dbRuns.id, seed.run.id))
                .returning()
                .then((rows) => requiredDatabaseValue(rows[0]));
            const first = await seed.repo.reserve(search('retry'));
            await seed.repo.fail({ toolCallId: first.toolCallId, unknown });
            expect(await seed.repo.usage()).toMatchObject({ searches: 1 });
            const second = await seed.repo.reserve(search('retry'));
            expect(second).toMatchObject({
                kind: 'reserved',
                attemptNo: 2,
                usage: { searches: 2 },
            });
            await seed.repo.fail({ toolCallId: second.toolCallId, unknown });
            await expect(seed.repo.reserve(search('retry'))).rejects.toMatchObject({
                code: 'BUDGET_EXCEEDED',
            });
            const calls = await fixture.db.query.toolCalls.findMany({
                where: eq(dbToolCalls.runId, seed.run.id),
                orderBy: [asc(dbToolCalls.attemptNo)],
            });
            expect(calls.map((call) => call.status)).toEqual([
                unknown ? 'unknown' : 'failed',
                unknown ? 'unknown' : 'failed',
            ]);
            expect(await seed.repo.usage()).toMatchObject({ searches: 2 });
        },
    );

    it('C14-ST02 接管把在途变 unknown，旧 epoch settle 拒绝且无法污染新结果', async () => {
        const seed = await setup();
        const old = await seed.repo.reserve(search('interrupted'));
        const next = await takeover(seed.run.id);
        expect(await next.repo.markInterruptedUnknown()).toBe(1);
        expect(await next.repo.markInterruptedUnknown()).toBe(0);
        const retried = await next.repo.reserve(search('interrupted'));
        expect(retried).toMatchObject({ attemptNo: 2, usage: { searches: 2 } });
        expect(await next.repo.markInterruptedUnknown()).toBe(0);
        await expect(
            seed.repo.settle({ toolCallId: old.toolCallId, output: { stale: true } }),
        ).rejects.toMatchObject({ code: 'LEASE_LOST' });
        await expect(
            next.repo.settle({ toolCallId: old.toolCallId, output: { stale: true } }),
        ).rejects.toMatchObject({ code: 'INVALID_TOOL_CALL' });
        await next.repo.settle({ toolCallId: retried.toolCallId, output: { current: true } });
        expect(await next.repo.reserve(search('interrupted'))).toMatchObject({
            kind: 'reused',
            output: { current: true },
        });
        expect(
            await fixture.db.query.toolCalls
                .findFirst({ where: eq(dbToolCalls.id, old.toolCallId) })
                .then((row) => requiredDatabaseValue(row)),
        ).toMatchObject({ status: 'unknown', outputRef: null });
    });

    it('C14-ERR05 不同 owner 的相同 operationKey 不复用结果，工具id与伪造token均隔离', async () => {
        const first = await setup();
        const other = await setup();
        const held = await first.repo.reserve(search('shared-key'));
        await first.repo.settle({
            toolCallId: held.toolCallId,
            output: { private: first.user.id },
        });
        const page = await first.repo.reserve({
            operationKey: 'private-page',
            tool: 'read',
            reserved: usage({ pages: 1 }),
        });
        await first.repo.settle({
            toolCallId: page.toolCallId,
            output: { private: 'owner-only-evidence' },
        });
        expect(await other.repo.reserve(search('shared-key'))).toMatchObject({
            kind: 'reserved',
            attemptNo: 1,
            usage: { searches: 1 },
        });
        await expect(
            other.repo.settle({ toolCallId: held.toolCallId, output: { overwritten: true } }),
        ).rejects.toMatchObject({ code: 'INVALID_TOOL_CALL' });
        expect(await other.repo.readPages()).toEqual([]);
        const forged = createAgentRepository(fixture.db, {
            ...first.current.token,
            userId: other.user.id,
        });
        await expect(forged.reserve(search('forged'))).rejects.toMatchObject({
            code: 'LEASE_LOST',
        });
        await expect(forged.readAuthorizedCheckpoint()).rejects.toMatchObject({
            code: 'LEASE_LOST',
        });
        await expect(forged.comparison({ allowDeadline: true })).rejects.toMatchObject({
            code: 'LEASE_LOST',
        });
        await expect(forged.readPages({ allowDeadline: true })).rejects.toMatchObject({
            code: 'LEASE_LOST',
        });
        expect(await first.repo.reserve(search('shared-key'))).toMatchObject({
            kind: 'reused',
            output: { private: first.user.id },
        });
    });

    it('C14-E03 仅可信实际 token 结算退差额，estimated 与超额结果不释放预留', async () => {
        const seed = await setup();
        const reserveModel = (operationKey: string) =>
            seed.repo.reserve({
                operationKey,
                tool: 'model',
                reserved: usage({ inputTokens: 100, outputTokens: 40 }),
            });
        const first = await reserveModel('model:actual');
        await seed.repo.settle({
            toolCallId: first.toolCallId,
            output: { ok: true },
            actualUsage: usage({ inputTokens: 60, outputTokens: 20, estimated: false }),
        });
        const second = await reserveModel('model:estimated');
        await seed.repo.settle({
            toolCallId: second.toolCallId,
            output: { ok: true },
            actualUsage: usage({ inputTokens: 1, outputTokens: 1 }),
        });
        expect(await seed.repo.usage()).toMatchObject({ inputTokens: 160, outputTokens: 60 });
        const third = await reserveModel('model:invalid');
        await expect(
            seed.repo.settle({
                toolCallId: third.toolCallId,
                output: {},
                actualUsage: usage({ inputTokens: 101, outputTokens: 1, estimated: false }),
            }),
        ).rejects.toMatchObject({ code: 'INVALID_TOOL_RESULT' });
        expect(await seed.repo.usage()).toMatchObject({ inputTokens: 260, outputTokens: 100 });
        expect(
            await fixture.db.query.toolCalls
                .findFirst({ where: eq(dbToolCalls.id, third.toolCallId) })
                .then((row) => requiredDatabaseValue(row)),
        ).toMatchObject({ status: 'running', outputRef: null });
    });

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

    it.each(['cancel', 'deadline'] as const)(
        'C14-ERR02 %s 后不预留或结算，deadline 仅可读取已存正文',
        async (reason) => {
            const seed = await setup();
            const page = await seed.repo.reserve({
                operationKey: 'read:1',
                tool: 'read',
                reserved: usage({ pages: 1 }),
            });
            const storedPage = { kind: 'read_page', text: 'saved evidence' };
            await seed.repo.settle({ toolCallId: page.toolCallId, output: storedPage });
            const pending = await seed.repo.reserve(search('pending'));
            if (reason === 'cancel')
                await fixture.db
                    .update(dbRuns)
                    .set({ cancelRequestedAt: new Date(), status: 'cancel_requested' })
                    .where(eq(dbRuns.id, seed.run.id))
                    .returning()
                    .then((rows) => requiredDatabaseValue(rows[0]));
            else await expireAfterEvidence(seed.run.id);
            const code = reason === 'cancel' ? 'RUN_CANCELED' : 'DEADLINE_EXCEEDED';
            await expect(seed.repo.reserve(search('forbidden'))).rejects.toMatchObject({ code });
            await expect(
                seed.repo.settle({ toolCallId: pending.toolCallId, output: { late: true } }),
            ).rejects.toMatchObject({ code });
            await expect(seed.repo.readPages()).rejects.toMatchObject({ code });
            await expect(seed.repo.comparison()).rejects.toMatchObject({ code });
            if (reason === 'deadline') {
                expect(await seed.repo.comparison({ allowDeadline: true })).toMatchObject({
                    comparisonScopeHash: seed.run.comparisonScopeHash,
                    feedback: { userId: seed.user.id, taskId: seed.task.id, items: [] },
                });
            } else {
                await expect(seed.repo.comparison({ allowDeadline: true })).rejects.toMatchObject({
                    code,
                });
            }
            if (reason === 'deadline')
                expect(await seed.repo.readPages({ allowDeadline: true })).toEqual([storedPage]);
            else
                await expect(seed.repo.readPages({ allowDeadline: true })).rejects.toMatchObject({
                    code,
                });
            expect(
                await fixture.db
                    .select({ count: dbCount() })
                    .from(dbToolCalls)
                    .where(eq(dbToolCalls.runId, seed.run.id))
                    .then((rows) => rows[0]!.count),
            ).toBe(2);
            expect(
                await fixture.db
                    .select({ count: dbCount() })
                    .from(dbReports)
                    .where(eq(dbReports.runId, seed.run.id))
                    .then((rows) => rows[0]!.count),
            ).toBe(0);
        },
    );

    it.each(['cancel', 'deadline'] as const)(
        'C14-ERR04 session %s 后 search/read/model 均不得进入 provider，partial 仅使用已存正文',
        async (reason) => {
            const seed = await setup();
            const base = createConnectorBundle();
            const counts = { search: 0, read: 0, model: 0 };
            const { session, close } = sessionFixture(seed, {
                ...base,
                search: {
                    async search(query, options) {
                        counts.search++;
                        return base.search.search(query, options);
                    },
                },
                reader: {
                    async read(url, options) {
                        counts.read++;
                        return base.reader.read(url, options);
                    },
                },
                model: {
                    async generateStructured() {
                        counts.model++;
                        throw new Error('Model must not be called');
                    },
                },
            });
            try {
                await session.tools.read('saved', DEMO_URL);
                if (reason === 'cancel')
                    await fixture.db
                        .update(dbRuns)
                        .set({ cancelRequestedAt: new Date(), status: 'cancel_requested' })
                        .where(eq(dbRuns.id, seed.run.id))
                        .returning()
                        .then((rows) => requiredDatabaseValue(rows[0]));
                else await expireAfterEvidence(seed.run.id);
                const code = reason === 'cancel' ? 'RUN_CANCELED' : 'DEADLINE_EXCEEDED';
                await expect(
                    session.tools.search('forbidden-search', 'query'),
                ).rejects.toMatchObject({
                    code,
                });
                await expect(session.tools.read('forbidden-read', DEMO_URL)).rejects.toMatchObject({
                    code,
                });
                await expect(
                    session.tools.model('forbidden-model', {
                        prompt: 'must not leave worker',
                        schema: {},
                        maxInputTokens: 1,
                        maxOutputTokens: 1,
                    }),
                ).rejects.toMatchObject({ code });
                if (reason === 'deadline') {
                    const partial = await session.partial();
                    expect(partial).toMatchObject({
                        mode: 'demo',
                        comparison: 'not_performed',
                        coverage: { completeness: 'partial', exhausted: ['time'] },
                        pages: [expect.objectContaining({ kind: 'read_page', url: DEMO_URL })],
                    });
                } else await expect(session.partial()).rejects.toMatchObject({ code });
                expect(counts).toEqual({ search: 0, read: 1, model: 0 });
                expect(
                    await fixture.db
                        .select({ count: dbCount() })
                        .from(dbToolCalls)
                        .where(eq(dbToolCalls.runId, seed.run.id))
                        .then((rows) => rows[0]!.count),
                ).toBe(1);
                expect(
                    await fixture.db
                        .select({ count: dbCount() })
                        .from(dbReports)
                        .where(eq(dbReports.runId, seed.run.id))
                        .then((rows) => rows[0]!.count),
                ).toBe(0);
            } finally {
                await close();
            }
        },
    );

    it('C14-ST04 provider 内重试每次独立收费；成功同key复用且超预算不进入provider', async () => {
        const seed = await setup();
        await fixture.db
            .update(dbRuns)
            .set({ budgetJson: { ...seed.config.budget, maxSearches: 2 } })
            .where(eq(dbRuns.id, seed.run.id))
            .returning()
            .then((rows) => requiredDatabaseValue(rows[0]));
        const base = createConnectorBundle();
        let externalAttempts = 0;
        const { session, close } = sessionFixture(seed, {
            ...base,
            search: {
                async search(query, options) {
                    for (let i = 0; i < 2; i++) {
                        await options?.beforeAttempt?.('search');
                        externalAttempts++;
                    }
                    return base.search.search(query, { ...options, beforeAttempt: undefined });
                },
            },
        });
        try {
            const result = await session.tools.search('retry-provider', 'same-input');
            expect(await session.tools.search('retry-provider', 'same-input')).toEqual(result);
            expect(externalAttempts).toBe(2);
            const calls = await fixture.db.query.toolCalls.findMany({
                where: eq(dbToolCalls.runId, seed.run.id),
                orderBy: [asc(dbToolCalls.attemptNo)],
            });
            expect(
                calls.map((call) => ({ attemptNo: call.attemptNo, status: call.status })),
            ).toEqual([
                { attemptNo: 1, status: 'unknown' },
                { attemptNo: 2, status: 'succeeded' },
            ]);
            expect(await seed.repo.usage()).toMatchObject({ searches: 2 });
            await expect(
                session.tools.search('retry-provider', 'different-input'),
            ).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
            expect(externalAttempts).toBe(2);
            expect(
                await fixture.db
                    .select({ count: dbCount() })
                    .from(dbToolCalls)
                    .where(eq(dbToolCalls.runId, seed.run.id))
                    .then((rows) => rows[0]!.count),
            ).toBe(2);
        } finally {
            await close();
        }
    });

    it('C14-ST05 stop 后 drain 等待已开始的真实 PG 调用，且不再进入 provider 或创建补偿写', async () => {
        const seed = await setup();
        const deferred = () => {
            let resolve!: () => void;
            const promise = new Promise<void>((done) => {
                resolve = done;
            });
            return { promise, resolve };
        };
        const locked = deferred();
        const release = deferred();
        const entered = deferred();
        const locker = fixture.db.transaction(async (tx) => {
            await queryRows<Record<string, unknown>>(
                tx,
                sql`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${seed.run.id}))`,
            );
            locked.resolve();
            await release.promise;
        });
        const controller = new AbortController();
        let providerCalls = 0;
        const base = createConnectorBundle();
        const slowRepository: AgentRepository = {
            ...seed.repo,
            async reserve(input) {
                const held = await seed.repo.reserve(input);
                entered.resolve();
                await fixture.db.transaction(async (tx) => {
                    await queryRows<Record<string, unknown>>(
                        tx,
                        sql`SELECT 1 AS waited FROM pg_advisory_xact_lock(hashtext(${seed.run.id}))`,
                    );
                });
                return held;
            },
        };
        const { session, close } = sessionFixture(
            seed,
            {
                ...base,
                search: {
                    async search(query, context) {
                        providerCalls++;
                        return base.search.search(query, context);
                    },
                },
            },
            { repository: slowRepository, signal: controller.signal },
        );
        let operation: Promise<unknown> | undefined;
        let draining: Promise<void> | undefined;
        try {
            await locked.promise;
            operation = session.tools.search('pending-database', 'query');
            void operation.catch(() => undefined);
            await entered.promise;
            controller.abort('stop');
            let drained = false;
            draining = session.drain().then(() => {
                drained = true;
            });
            await new Promise((resolve) => setTimeout(resolve, 50));
            expect(drained).toBe(false);
            release.resolve();
            await locker;
            await draining;
            await expect(operation).rejects.toMatchObject({ code: 'aborted' });
            expect(providerCalls).toBe(0);
            const calls = await fixture.db.query.toolCalls.findMany({
                where: eq(dbToolCalls.runId, seed.run.id),
            });
            expect(calls).toMatchObject([{ status: 'running', attemptNo: 1, outputRef: null }]);
            expect(await seed.repo.usage()).toMatchObject({ searches: 1 });
            expect(
                await fixture.db
                    .select({ count: dbCount() })
                    .from(dbReports)
                    .where(eq(dbReports.runId, seed.run.id))
                    .then((rows) => rows[0]!.count),
            ).toBe(0);
        } finally {
            release.resolve();
            await locker;
            await draining;
            await operation?.catch(() => undefined);
            await close();
        }
    });

    it('C14-M01 真实 model provider 重试缺usage保留两次预留，预算已满跨epoch仍按semantic key复用', async () => {
        const seed = await setup({ mode: 'live' });
        const input: StructuredInput = {
            prompt: '用中文归纳已核验资料',
            schema: {
                type: 'object',
                properties: { answer: { type: 'string' } },
                required: ['answer'],
                additionalProperties: false,
            },
            untrustedSources: [{ text: '原文证据' }],
            maxInputTokens: 40_000,
            maxOutputTokens: 100,
        };
        const estimated = estimateModelInputTokens(input);
        const budget = {
            ...seed.config.budget,
            maxInputTokens: estimated * 2,
            maxOutputTokens: 200,
        };
        await fixture.db
            .update(dbRuns)
            .set({ budgetJson: budget })
            .where(eq(dbRuns.id, seed.run.id))
            .returning()
            .then((rows) => requiredDatabaseValue(rows[0]));
        seed.current.budget = budget;
        let httpCalls = 0;
        const http: SafeHttpClient = {
            async request(url) {
                httpCalls++;
                return {
                    url,
                    status: httpCalls === 1 ? 503 : 200,
                    headers: {},
                    body: JSON.stringify({
                        choices: [
                            {
                                finish_reason: 'stop',
                                message: { content: JSON.stringify({ answer: '固定测试结果' }) },
                            },
                        ],
                    }),
                };
            },
        };
        const base = createConnectorBundle();
        const bundle = {
            ...base,
            mode: 'live' as const,
            reason: undefined,
            model: createModelProvider({
                apiKey: 'fixture-only',
                model: 'fixture',
                http,
                retryDelayMs: 0,
            }),
        };
        const first = sessionFixture(seed, bundle);
        let resumed: ReturnType<typeof sessionFixture> | undefined;
        try {
            const response = await first.session.tools.model('semantic-model', input);
            expect(response.usage).toEqual({
                inputTokens: estimated,
                outputTokens: 100,
                estimated: true,
            });
            const calls = await fixture.db.query.toolCalls.findMany({
                where: eq(dbToolCalls.runId, seed.run.id),
                orderBy: [asc(dbToolCalls.attemptNo)],
            });
            expect(
                calls.map((call) => ({ status: call.status, attemptNo: call.attemptNo })),
            ).toEqual([
                { status: 'unknown', attemptNo: 1 },
                { status: 'succeeded', attemptNo: 2 },
            ]);
            expect(await seed.repo.usage()).toMatchObject({
                inputTokens: estimated * 2,
                outputTokens: 200,
            });
            expect(
                (
                    await fixture.db.query.runs
                        .findFirst({ where: eq(dbRuns.id, seed.run.id) })
                        .then((row) => requiredDatabaseValue(row))
                ).checkpointRef,
            ).toBeNull();
            const next = await takeover(seed.run.id);
            resumed = sessionFixture({ ...seed, current: next.current, repo: next.repo }, bundle);
            expect(
                await resumed.session.tools.model('semantic-model', {
                    ...input,
                    maxInputTokens: estimated,
                    maxOutputTokens: 1,
                }),
            ).toEqual(response);
            expect(httpCalls).toBe(2);
            expect(await next.repo.usage()).toMatchObject({
                inputTokens: estimated * 2,
                outputTokens: 200,
            });
            expect(
                await fixture.db
                    .select({ count: dbCount() })
                    .from(dbToolCalls)
                    .where(eq(dbToolCalls.runId, seed.run.id))
                    .then((rows) => rows[0]!.count),
            ).toBe(2);
        } finally {
            await first.close();
            await resumed?.close();
        }
    });

    it('C14-M02 两次可信model usage实时累计，第二请求按剩余output上限且仅预留完整输入估算', async () => {
        const seed = await setup({ mode: 'live' });
        const budget = { ...seed.config.budget, maxInputTokens: 5_000, maxOutputTokens: 100 };
        await fixture.db
            .update(dbRuns)
            .set({ budgetJson: budget })
            .where(eq(dbRuns.id, seed.run.id))
            .returning()
            .then((rows) => requiredDatabaseValue(rows[0]));
        seed.current.budget = budget;
        const bodies: { max_tokens: number }[] = [];
        const http: SafeHttpClient = {
            async request(url, options) {
                bodies.push(JSON.parse(options!.body!));
                return {
                    url,
                    status: 200,
                    headers: {},
                    body: JSON.stringify({
                        choices: [
                            {
                                finish_reason: 'stop',
                                message: { content: JSON.stringify({ answer: '结果' }) },
                            },
                        ],
                        usage: {
                            prompt_tokens: bodies.length === 1 ? 12 : 13,
                            completion_tokens: bodies.length === 1 ? 70 : 30,
                        },
                    }),
                };
            },
        };
        const base = createConnectorBundle();
        const { session, close } = sessionFixture(seed, {
            ...base,
            mode: 'live',
            model: createModelProvider({ apiKey: 'fixture-only', model: 'fixture', http }),
        });
        const input: StructuredInput = {
            prompt: '核验原文',
            schema: {
                type: 'object',
                properties: { answer: { type: 'string' } },
                required: ['answer'],
                additionalProperties: false,
            },
            maxInputTokens: 40_000,
            maxOutputTokens: 100,
        };
        try {
            await session.tools.model('first-model', input);
            expect(await seed.repo.usage()).toMatchObject({ inputTokens: 12, outputTokens: 70 });
            await session.tools.model('second-model', { ...input, prompt: '另一次核验' });
            expect(bodies.map((body) => body.max_tokens)).toEqual([100, 30]);
            expect(await seed.repo.usage()).toMatchObject({ inputTokens: 25, outputTokens: 100 });
            const calls = await fixture.db.query.toolCalls.findMany({
                where: eq(dbToolCalls.runId, seed.run.id),
                orderBy: [asc(dbToolCalls.startedAt)],
            });
            expect(calls).toHaveLength(2);
            for (const call of calls)
                expect(
                    (call.reservedBudget as { reserved: Usage }).reserved.inputTokens,
                ).toBeLessThan(5_000);
            expect(
                calls.map(
                    (call) => (call.reservedBudget as { reserved: Usage }).reserved.outputTokens,
                ),
            ).toEqual([100, 30]);
            expect(
                await fixture.db
                    .select({ count: dbCount() })
                    .from(dbReports)
                    .where(eq(dbReports.runId, seed.run.id))
                    .then((rows) => rows[0]!.count),
            ).toBe(0);
        } finally {
            await close();
        }
    });

    it('C14-M03 model响应超出effective预留后预算保留且禁止后续所有外部工具', async () => {
        const seed = await setup({ mode: 'live' });
        const input: StructuredInput = {
            prompt: '核验',
            schema: {},
            maxInputTokens: 40_000,
            maxOutputTokens: 100,
        };
        const estimated = estimateModelInputTokens(input);
        let calls = 0;
        const base = createConnectorBundle();
        const { session, close } = sessionFixture(seed, {
            ...base,
            mode: 'live',
            model: {
                async generateStructured<T>(_input: StructuredInput, options?: CallContext) {
                    await options?.beforeAttempt?.('model');
                    calls++;
                    return {
                        mode: 'live' as const,
                        data: {} as T,
                        usage: { inputTokens: estimated + 1, outputTokens: 1, estimated: false },
                    };
                },
            },
            search: {
                async search() {
                    calls++;
                    throw new Error('Must not search after invalid model usage');
                },
            },
        });
        try {
            await expect(session.tools.model('invalid-model', input)).rejects.toMatchObject({
                code: 'budget_exceeded',
            });
            await expect(session.tools.search('after-invalid', 'query')).rejects.toMatchObject({
                code: 'budget_exceeded',
            });
            expect(calls).toBe(1);
            expect(await seed.repo.usage()).toMatchObject({
                inputTokens: estimated,
                outputTokens: 100,
                estimated: true,
            });
            expect(
                await fixture.db.query.toolCalls.findMany({
                    where: eq(dbToolCalls.runId, seed.run.id),
                }),
            ).toMatchObject([{ status: 'unknown', outputRef: null }]);
        } finally {
            await close();
        }
    });

    it.each([false, true])(
        'C14-ST06 过期接管只读取已存live正文，无远程凭据；deadline回调前取消=%s禁止候选',
        async (cancel) => {
            const seed = await setup({ mode: 'live' });
            const saved = await seed.repo.reserve({
                operationKey: 'before-deadline-page',
                tool: 'read',
                reserved: usage({ pages: 1 }),
            });
            const page = {
                ...(await createConnectorBundle().reader.read(DEMO_URL)),
                mode: 'live' as const,
                originalUrl: 'https://example.com/reference',
                fetchedUrl: 'https://example.com/reference',
                url: 'https://example.com/reference',
            };
            await seed.repo.settle({ toolCallId: saved.toolCallId, output: page });
            const deadlineAt = await expireAfterEvidence(seed.run.id, true);
            let executeCalls = 0;
            let deadlineCalls = 0;
            let delivered: AgentCandidate | undefined;
            const runtime = createAgentRuntime({
                database: fixture.db,
                databaseUrl: fixture.databaseUrl,
                checkpointSchema: new URL(fixture.databaseUrl).searchParams.get('schema')!,
                env: {},
                async deliver(context, candidate, deadline) {
                    expect(deadline).toBe(true);
                    expect(context.signal.aborted).toBe(true);
                    expect(context.signal.reason).toBe('deadline');
                    delivered = candidate;
                },
            });
            try {
                await runtime.connect();
                const service = new RunService({
                    repository: runs,
                    executorFactory: (token) => {
                        const executor = runtime.executorFactory(token);
                        return {
                            ...executor,
                            async execute(context) {
                                executeCalls++;
                                return executor.execute(context);
                            },
                            async onDeadline(context) {
                                deadlineCalls++;
                                if (cancel)
                                    await fixture.db
                                        .update(dbRuns)
                                        .set({
                                            status: 'cancel_requested',
                                            cancelRequestedAt: new Date(),
                                        })
                                        .where(eq(dbRuns.id, seed.run.id))
                                        .returning()
                                        .then((rows) => requiredDatabaseValue(rows[0]));
                                await executor.onDeadline!(context);
                            },
                        };
                    },
                });
                expect(await service.execute(seed.run.id)).toBe('processed');
                expect(executeCalls).toBe(0);
                expect(deadlineCalls).toBe(1);
                if (cancel) expect(delivered).toBeUndefined();
                else
                    expect(delivered).toMatchObject({
                        mode: 'live',
                        comparison: 'not_performed',
                        coverage: { completeness: 'partial', exhausted: ['time'] },
                        pages: [expect.objectContaining({ text: page.text, url: page.url })],
                    });
                expect(
                    await fixture.db.query.runs
                        .findFirst({ where: eq(dbRuns.id, seed.run.id) })
                        .then((row) => requiredDatabaseValue(row)),
                ).toMatchObject({
                    leaseEpoch: seed.current.token.leaseEpoch + 1,
                    recoveryCount: 1,
                    deadlineAt,
                    status: cancel ? 'canceled' : 'failed',
                    failureCode: cancel ? null : 'DEADLINE_EXCEEDED',
                    usageJson: { pages: 1 },
                });
                expect(
                    await fixture.db
                        .select({ count: dbCount() })
                        .from(dbToolCalls)
                        .where(eq(dbToolCalls.runId, seed.run.id))
                        .then((rows) => rows[0]!.count),
                ).toBe(1);
                expect(
                    await fixture.db
                        .select({ count: dbCount() })
                        .from(dbReports)
                        .where(eq(dbReports.runId, seed.run.id))
                        .then((rows) => rows[0]!.count),
                ).toBe(0);
            } finally {
                await runtime.close();
            }
        },
    );
});

type Runtime = 'node' | 'bun';
function launchAgent(
    runtime: Runtime,
    phase: 'crash' | 'resume',
    runId: string,
    boundary: 'search' | 'read',
) {
    const bun =
        process.env.BUN_BIN ??
        join(homedir(), '.bun', 'bin', process.platform === 'win32' ? 'bun.exe' : 'bun');
    if (runtime === 'bun' && !existsSync(bun))
        throw new Error('Recovery tests require the standalone Bun runtime');
    const script = 'tests/support/agent-process.ts';
    const args = [phase, runId, boundary];
    const command =
        runtime === 'bun'
            ? { executable: bun, args: ['run', script, ...args] }
            : nodeScriptCommand(script, args);
    const child = spawn(command.executable, command.args, {
        cwd: fileURLToPath(new URL('../', import.meta.url)),
        env: { ...process.env, DATABASE_URL: fixture.databaseUrl },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        windowsHide: true,
    });
    const messages: {
        type: string;
        candidate?: { runId: string; pages: unknown[]; mode: string };
    }[] = [];
    let output = '';
    let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    child.on('message', (value) => {
        if (
            typeof value === 'object' &&
            value !== null &&
            'type' in value &&
            typeof value.type === 'string'
        )
            messages.push(value as (typeof messages)[number]);
    });
    child.stdout!.on('data', (chunk) => {
        output += String(chunk);
    });
    child.stderr!.on('data', (chunk) => {
        output += String(chunk);
    });
    const ended = new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => {
            exit = { code, signal };
            resolve();
        });
    });
    void ended.catch(() => undefined);
    return {
        child,
        messages,
        ended,
        get output() {
            return output;
        },
        get exit() {
            return exit;
        },
    };
}
async function waitAgentMessage(process: ReturnType<typeof launchAgent>, type: string) {
    const deadline = Date.now() + 20_000;
    while (!process.messages.some((message) => message.type === type)) {
        if (process.exit || process.messages.some((message) => message.type === 'error'))
            throw new Error(`Agent exited before ${type}: ${process.output}`);
        if (Date.now() >= deadline)
            throw new Error(`Timed out waiting for ${type}: ${process.output}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}
async function endAgent(process: ReturnType<typeof launchAgent>, force = false) {
    if (force && !process.exit) process.child.kill('SIGKILL');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        await Promise.race([
            process.ended,
            new Promise((_, reject) => {
                timer = setTimeout(() => {
                    process.child.kill('SIGKILL');
                    reject(new Error(`Agent did not exit: ${process.output}`));
                }, 8_000);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

describe('Agent 真实双进程恢复（PostgresSaver，无 Redis）', () => {
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
            const first = launchAgent(runtime, 'crash', seed.run.id, boundary);
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
                    { schema: new URL(fixture.databaseUrl).searchParams.get('schema')! },
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
                second = launchAgent(runtime, 'resume', seed.run.id, boundary);
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
                const calls = await queryRows<{ kind: string; input: string }>(
                    fixture.db,
                    sql`SELECT kind, input FROM recovery_external_calls WHERE run_id = ${seed.run.id}::uuid ORDER BY id`,
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
});
