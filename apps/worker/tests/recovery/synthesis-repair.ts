import { runs as dbRuns, eq, toolCalls as dbToolCalls, runEvents as dbRunEvents } from '@scova/db';
import type { Usage } from '@scova/models';
import {
    estimateModelInputTokens,
    ConnectorError,
    type StructuredInput,
    type CallContext,
} from '@scova/connectors';
import { expect, it } from 'vite-plus/test';
import { scenarioConnectors } from '../support/acceptance-scenario-fixtures.ts';
import { setup, runs, fixture, sessionFixture } from './fixture.ts';

export function registerSynthesisRepair() {
    it('persists fixed research diagnostics through the fenced PG progress entry', async () => {
        const seed = await setup({ mode: 'live' });
        for (const state of ['waiting', 'cooldown', 'cache_hit', 'claims_repair'] as const)
            await runs.emit(seed.current.token, { type: 'research.updated', payload: { state } });
        const events = await fixture.db.query.runEvents.findMany({
            where: eq(dbRunEvents.runId, seed.run.id),
        });
        expect(
            events
                .filter((event) => event.type === 'research.updated')
                .map((event) => event.payload),
        ).toEqual([
            { state: 'waiting' },
            { state: 'cooldown' },
            { state: 'cache_hit' },
            { state: 'claims_repair' },
        ]);
        await expect(
            runs.emit(seed.current.token, {
                type: 'research.updated',
                payload: { state: 'secret' },
            } as never),
        ).rejects.toThrow();
    });

    it('keeps invalid attempts in receipts without occupying active answers when a later field call fails', async () => {
        const seed = await setup({ mode: 'live' });
        const bundle = scenarioConnectors('research', 'A');
        const model = bundle.model;
        let syntheses = 0;
        const synthesisBudgets: number[] = [];
        bundle.model = {
            async generateStructured<T>(input: StructuredInput, context: CallContext = {}) {
                if ('claims' in (input.schema.properties as Record<string, unknown>)) {
                    syntheses++;
                    synthesisBudgets.push(input.maxOutputTokens);
                    if (syntheses === 2) {
                        await context.beforeAttempt?.('model');
                        throw new ConnectorError('network', 'repair unavailable');
                    }
                    const result = await model.generateStructured<{ claims: unknown[] }>(
                        input,
                        context,
                    );
                    return {
                        ...result,
                        data: {
                            ...result.data,
                            claims: [
                                ...result.data.claims,
                                {
                                    outputFormat:
                                        result.data.claims[0] &&
                                        (result.data.claims[0] as { outputFormat?: string })
                                            .outputFormat,
                                    kind: 'fact',
                                    text: 'fabricated',
                                    questionIds: ['q0'],
                                    citations: [],
                                },
                            ],
                        } as T,
                    };
                }
                return model.generateStructured<T>(input, context);
            },
        };
        const { session, prepare, close } = sessionFixture(seed, bundle);
        try {
            await prepare();
            const candidate = await session.execute();
            expect(candidate.claims.some((claim) => claim.kind !== 'insufficient')).toBe(true);
            expect(candidate.claims.find((claim) => claim.text === 'fabricated')).toBeUndefined();
            expect(candidate.coverage.completeness).toBe('partial');
            const calls = await fixture.db.query.toolCalls.findMany({
                where: eq(dbToolCalls.runId, seed.run.id),
            });
            // Compact inputs now leave room for the failed field's one bounded repair.
            expect(syntheses).toBe(3);
            // Unused successful reservations are reusable. The second cap is bounded by
            // committed usage (plan, comparison, synthesis), not the sum of old caps.
            expect(synthesisBudgets[0]).toBeLessThanOrEqual(seed.config.budget.maxOutputTokens - 2);
            expect(synthesisBudgets[1]).toBeLessThanOrEqual(seed.config.budget.maxOutputTokens - 3);
            expect(candidate.coverage.artifacts).toHaveLength(1);
            expect(candidate.coverage.artifacts![0]!.summary).not.toContain('fabricated');
            const synthesisCalls = calls.filter(
                (call) => call.tool === 'model' && call.operationKey.startsWith('synthesize-'),
            );
            expect(synthesisCalls).toHaveLength(3);
            expect(synthesisCalls.filter((call) => call.status === 'succeeded')).toHaveLength(2);
            expect(
                JSON.stringify(
                    synthesisCalls.find((call) => call.status === 'succeeded')!.outputRef,
                ),
            ).toContain('fabricated');
            expect(
                synthesisCalls.find((call) => call.operationKey.startsWith('synthesize-0:'))
                    ?.status,
            ).toBe('succeeded');
            const failedRepair = synthesisCalls.find((call) => call.status === 'unknown')!;
            expect(failedRepair.operationKey).toMatch(/^synthesize-batch-1-0:/);
            expect(failedRepair.status).toBe('unknown');
            expect(failedRepair.usage).toBeNull();
            const reserved = (failedRepair.reservedBudget as { reserved: Usage }).reserved
                .outputTokens;
            const successfulTokens = calls
                .filter((call) => call.status === 'succeeded' && call.tool === 'model')
                .reduce((sum, call) => sum + (call.usage as Usage).outputTokens, 0);
            expect((await seed.repo.usage()).outputTokens).toBe(reserved + successfulTokens);
            const events = await fixture.db.query.runEvents.findMany({
                where: eq(dbRunEvents.runId, seed.run.id),
            });
            expect(events.some((event) => event.type === 'tool.failed')).toBe(true);
        } finally {
            await close();
        }
    });

    it('keeps the failed plan reservation charged and completes its bounded repair under an old 8000 token Run', async () => {
        const seed = await setup({ mode: 'live' });
        const bundle = scenarioConnectors('research', 'A');
        const model = bundle.model;
        const outputs: number[] = [];
        bundle.model = {
            async generateStructured<T>(input: StructuredInput, context: CallContext = {}) {
                outputs.push(input.maxOutputTokens);
                if (outputs.length === 1) {
                    await context.beforeAttempt?.('model');
                    throw new ConnectorError('output_truncated', 'fixture secret');
                }
                return model.generateStructured<T>(input, context);
            },
        };
        const { session, prepare, close } = sessionFixture(seed, bundle);
        try {
            await prepare();
            const candidate = await session.execute();
            expect(candidate.claims.length).toBeGreaterThan(0);
            expect(outputs.slice(0, 2)).toEqual([1000, 2000]);
            // Knowledge drafting shares the original envelope; failed planning stays charged.
            const calls = await fixture.db.query.toolCalls.findMany({
                where: eq(dbToolCalls.runId, seed.run.id),
            });
            expect(calls.filter((call) => call.status === 'unknown')).toHaveLength(1);
            expect(calls.some((call) => call.operationKey.startsWith('model-draft-'))).toBe(true);
            const billed = calls
                .filter((call) => call.tool === 'model')
                .reduce(
                    (sum, call) =>
                        sum +
                        (call.status === 'succeeded'
                            ? (call.usage as Usage).outputTokens
                            : (call.reservedBudget as { reserved: Usage }).reserved.outputTokens),
                    0,
                );
            expect((await seed.repo.usage()).outputTokens).toBe(billed);
            expect(billed).toBeGreaterThanOrEqual(1000);
            expect(billed).toBeLessThanOrEqual(seed.config.budget.maxOutputTokens);
            const events = await fixture.db.query.runEvents.findMany({
                where: eq(dbRunEvents.runId, seed.run.id),
            });
            expect(
                events.some(
                    (event) =>
                        event.type === 'tool.failed' &&
                        JSON.stringify(event.payload).includes('TOOL_OUTPUT_TRUNCATED'),
                ),
            ).toBe(true);
            expect(JSON.stringify(events)).not.toContain('fixture secret');
            expect(
                (await fixture.db.query.runs.findFirst({ where: eq(dbRuns.id, seed.run.id) }))
                    ?.budgetJson,
            ).toEqual(seed.config.budget);
        } finally {
            await close();
        }
    });

    it('charges truncated comparison and its compact repair within the old Run budget', async () => {
        const seed = await setup({ mode: 'live' });
        const bundle = scenarioConnectors('research', 'A');
        const original = bundle.model;
        let comparisons = 0;
        const outputs: number[] = [];
        bundle.model = {
            async generateStructured<T>(input: StructuredInput, context: CallContext = {}) {
                outputs.push(input.maxOutputTokens);
                if (
                    'pages' in (input.schema.properties as Record<string, unknown>) &&
                    ++comparisons === 1
                ) {
                    await context.beforeAttempt?.('model');
                    throw new ConnectorError('output_truncated', 'DO_NOT_RENDER');
                }
                expect(estimateModelInputTokens(input)).toBeLessThanOrEqual(input.maxInputTokens);
                return original.generateStructured<T>(input, context);
            },
        };
        const { session, prepare, close } = sessionFixture(seed, bundle);
        try {
            await prepare();
            const candidate = await session.execute();
            expect(candidate.comparison).toBe('completed');
            expect(comparisons).toBe(2);
            expect(outputs[0]).toBe(1000);
            expect(outputs.every((n) => n <= seed.config.budget.maxOutputTokens)).toBe(true);
            const calls = await fixture.db.query.toolCalls.findMany({
                where: eq(dbToolCalls.runId, seed.run.id),
            });
            expect(calls.filter((c) => c.status === 'unknown')).toHaveLength(1);
            const failed = calls.find((c) => c.status === 'unknown')!;
            expect(failed.operationKey).toMatch(/^compare-facts-v1:/);
            expect((failed.reservedBudget as { reserved: Usage }).reserved.outputTokens).toBe(1333);
            const billed = calls
                .filter((c) => c.tool === 'model')
                .reduce(
                    (sum, call) =>
                        sum +
                        (call.status === 'succeeded'
                            ? (call.usage as Usage).outputTokens
                            : (call.reservedBudget as { reserved: Usage }).reserved.outputTokens),
                    0,
                );
            expect((await seed.repo.usage()).outputTokens).toBe(billed);
            expect(billed).toBeLessThanOrEqual(seed.config.budget.maxOutputTokens);
            expect(
                calls.some(
                    (c) =>
                        c.operationKey.startsWith('compare-facts-repair-v1') &&
                        c.status === 'succeeded',
                ),
            ).toBe(true);
            const events = await fixture.db.query.runEvents.findMany({
                where: eq(dbRunEvents.runId, seed.run.id),
            });
            expect(JSON.stringify(events)).not.toContain('DO_NOT_RENDER');
        } finally {
            await close();
        }
    });
}
