import { requiredDatabaseValue } from '../../../server/src/utils/execution/database.ts';
import {
    runs as dbRuns,
    eq,
    toolCalls as dbToolCalls,
    reports as dbReports,
    count as dbCount,
} from '@scova/db';
import type { AgentCandidate } from '@scova/agent-core';
import {
    createConnectorBundle,
    estimateModelInputTokens,
    DEMO_URL,
    type StructuredInput,
    type CallContext,
} from '@scova/connectors';
import { expect, it } from 'vite-plus/test';
import { createLocalAgentRuntime as createAgentRuntime } from '../support/local-agent-runtime.ts';
import { RunService } from '../../src/service/runs.ts';
import { prepareTestCheckpointSchema } from '../support/checkpoint-schema.ts';
import { setup, sessionFixture, fixture, usage, expireAfterEvidence, runs } from './fixture.ts';

export function registerDeadline() {
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
                checkpointSchema: fixture.checkpointSchema,
                env: {},
                async deliver(context, candidate, deadline) {
                    expect(deadline).toBe(true);
                    expect(context.signal.aborted).toBe(true);
                    expect(context.signal.reason).toBe('deadline');
                    delivered = candidate;
                },
            });
            try {
                await prepareTestCheckpointSchema(fixture.databaseUrl, fixture.checkpointSchema);
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
}
