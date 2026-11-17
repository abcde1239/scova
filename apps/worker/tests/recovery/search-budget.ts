import { runs as dbRuns, eq, toolCalls as dbToolCalls, runEvents as dbRunEvents } from '@scova/db';
import {
    createModelSearch,
    createSafeHttpClient,
    MODEL_SEARCH_RESERVATION,
    ConnectorError,
    type StructuredInput,
} from '@scova/connectors';
import { expect, it } from 'vite-plus/test';
import { scenarioConnectors } from '../support/acceptance-scenario-fixtures.ts';
import { setup, sessionFixture, takeover, fixture, usage } from './fixture.ts';

export function registerSearchBudget() {
    it('内置搜索供应商额度不足持久阻止后续模型和内置搜索，跨epoch保留', async () => {
        const seed = await setup({ mode: 'live' });
        let dispatches = 0;
        const bundle = scenarioConnectors('research', 'A');
        bundle.search = createModelSearch({
            protocol: 'openai_responses',
            model: 'model',
            baseUrl: 'https://model.example/v1',
            apiKey: 'fixture-key',
            http: createSafeHttpClient({
                resolve: async () => [{ address: '93.184.216.34', family: 4 }],
                transport: async () => {
                    dispatches++;
                    return { status: 402, headers: {}, body: '{}' };
                },
            }),
        });
        const first = sessionFixture(seed, bundle);
        try {
            await expect(first.session.tools.search('quota', 'q')).rejects.toMatchObject({
                code: 'model_quota_exceeded',
            });
            await expect(first.session.tools.search('new-search', 'q')).rejects.toMatchObject({
                code: 'model_quota_exceeded',
            });
            await expect(
                first.session.tools.model('new-model', {
                    prompt: 'q',
                    schema: {},
                    maxInputTokens: 1000,
                    maxOutputTokens: 100,
                }),
            ).rejects.toMatchObject({ code: 'model_quota_exceeded' });
            const next = await takeover(seed.run.id);
            const resumed = sessionFixture({ ...seed, ...next }, bundle);
            try {
                await expect(resumed.session.tools.search('resumed', 'q')).rejects.toMatchObject({
                    code: 'model_quota_exceeded',
                });
                expect(dispatches).toBe(1);
                expect(await next.repo.usage()).toMatchObject({
                    searches: 1,
                    ...MODEL_SEARCH_RESERVATION,
                });
            } finally {
                await resumed.close();
            }
        } finally {
            await first.close();
        }
    });

    it('模型搜索先预留搜索和Token，按实际用量结算与复用；预算不足不出站', async () => {
        const seed = await setup({ mode: 'live' });
        let dispatches = 0;
        const bundle = scenarioConnectors('research', 'A');
        bundle.search = createModelSearch({
            protocol: 'openai_responses',
            model: 'selected-model',
            baseUrl: 'https://model.example/v1',
            apiKey: 'fixture-key',
            http: createSafeHttpClient({
                resolve: async () => [{ address: '93.184.216.34', family: 4 }],
                transport: async () => {
                    dispatches++;
                    expect(await seed.repo.usage()).toMatchObject({
                        searches: 1,
                        ...MODEL_SEARCH_RESERVATION,
                    });
                    return {
                        status: 200,
                        headers: {},
                        body: JSON.stringify({
                            status: 'completed',
                            usage: { input_tokens: 8100, output_tokens: 80 },
                            output: [
                                {
                                    type: 'web_search_call',
                                    status: 'completed',
                                    action: {
                                        type: 'search',
                                        sources: [{ url: 'https://source.example/article' }],
                                    },
                                },
                            ],
                        }),
                    };
                },
            }),
        });
        const active = sessionFixture(seed, bundle);
        try {
            const result = await active.session.tools.search('native', 'query');
            expect(await seed.repo.usage()).toMatchObject({
                searches: 1,
                inputTokens: 8100,
                outputTokens: 80,
            });
            expect(await active.session.tools.search('native', 'query')).toEqual(result);
            expect(dispatches).toBe(1);
            await fixture.db
                .update(dbRuns)
                .set({ budgetJson: { ...seed.current.budget, maxInputTokens: 9000 } })
                .where(eq(dbRuns.id, seed.run.id));
            await expect(active.session.tools.search('another', 'query')).rejects.toThrow();
            expect(dispatches).toBe(1);
        } finally {
            await active.close();
        }
    });

    it('模型搜索失败保留全部预留，不自动重试，取消阻止后续出站', async () => {
        const seed = await setup({ mode: 'live' });
        let dispatches = 0;
        const bundle = scenarioConnectors('research', 'A');
        bundle.search = createModelSearch({
            protocol: 'openai_responses',
            model: 'model',
            baseUrl: 'https://model.example/v1',
            apiKey: 'fixture-key',
            http: createSafeHttpClient({
                resolve: async () => [{ address: '93.184.216.34', family: 4 }],
                transport: async () => {
                    dispatches++;
                    return { status: 503, headers: {}, body: '{}' };
                },
            }),
        });
        const controller = new AbortController();
        const active = sessionFixture(seed, bundle, { signal: controller.signal });
        try {
            await expect(active.session.tools.search('native', 'q')).rejects.toMatchObject({
                code: 'http',
            });
            expect(dispatches).toBe(1);
            expect(await seed.repo.usage()).toMatchObject({
                searches: 1,
                ...MODEL_SEARCH_RESERVATION,
            });
            controller.abort();
            await expect(active.session.tools.search('later', 'q')).rejects.toMatchObject({
                code: 'aborted',
            });
            expect(dispatches).toBe(1);
        } finally {
            await active.close();
        }
    });

    it('persists quota blocking across epochs without refunding or blocking a fresh Run', async () => {
        const seed = await setup({ mode: 'live' });
        const input: StructuredInput = {
            prompt: 'fixture quota check',
            schema: {},
            maxInputTokens: 2000,
            maxOutputTokens: 100,
        };
        let dispatches = 0;
        const bundle = scenarioConnectors('research', 'A');
        bundle.model = {
            async generateStructured(_input, context = {}) {
                dispatches++;
                await context.beforeAttempt?.('model');
                throw new ConnectorError('model_quota_exceeded', 'DO_NOT_RENDER');
            },
        };
        const first = sessionFixture(seed, bundle);
        try {
            await first.prepare();
            await expect(first.session.tools.model('first', input)).rejects.toMatchObject({
                code: 'model_quota_exceeded',
            });
            const heldUsage = await seed.repo.usage();
            expect(heldUsage.outputTokens).toBe(100);
            await expect(first.session.tools.model('later', input)).rejects.toMatchObject({
                code: 'model_quota_exceeded',
            });
            const next = await takeover(seed.run.id);
            const recovered = sessionFixture({ ...seed, ...next }, bundle);
            try {
                await recovered.prepare();
                await expect(recovered.session.tools.model('first', input)).rejects.toMatchObject({
                    code: 'model_quota_exceeded',
                });
                expect(await next.repo.usage()).toEqual(heldUsage);
                expect(dispatches).toBe(1);
                const events = await fixture.db.query.runEvents.findMany({
                    where: eq(dbRunEvents.runId, seed.run.id),
                });
                expect(events.filter((event) => event.type === 'tool.failed')).toHaveLength(1);
                expect(JSON.stringify(events)).toContain('TOOL_MODEL_QUOTA_EXCEEDED');
                expect(JSON.stringify(events)).not.toContain('DO_NOT_RENDER');
                const calls = await fixture.db.query.toolCalls.findMany({
                    where: eq(dbToolCalls.runId, seed.run.id),
                });
                expect(calls).toHaveLength(1);
                expect(calls[0].status).toBe('unknown');
            } finally {
                await recovered.close();
            }
            const fresh = await setup({ mode: 'live' });
            await expect(
                fresh.repo.reserve({
                    operationKey: 'new-after-topup',
                    tool: 'model',
                    reserved: usage({ inputTokens: 2000, outputTokens: 100 }),
                }),
            ).resolves.toMatchObject({ kind: 'reserved' });
        } finally {
            await first.close();
        }
    });
}
