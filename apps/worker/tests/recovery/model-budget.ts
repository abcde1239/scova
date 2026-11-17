import { requiredDatabaseValue } from '@/utils/database.ts';
import {
    runs as dbRuns,
    eq,
    toolCalls as dbToolCalls,
    reports as dbReports,
    count as dbCount,
    asc,
} from '@scova/db';
import type { Usage } from '@scova/models';
import {
    createConnectorBundle,
    createModelProvider,
    estimateModelInputTokens,
    type StructuredInput,
    type SafeHttpClient,
} from '@scova/connectors';
import { expect, it } from 'vite-plus/test';
import { setup, fixture, sessionFixture, takeover } from './fixture.ts';

export function registerModelBudget() {
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
}
