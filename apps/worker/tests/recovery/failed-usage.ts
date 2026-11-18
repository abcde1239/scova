import { eq, toolCalls as dbToolCalls, runEvents as dbRunEvents, asc } from '@scova/db';
import { createModelProvider } from '@scova/connectors';
import { expect, it } from 'vite-plus/test';
import { scenarioConnectors } from '../support/acceptance-scenario-fixtures.ts';
import { setup, sessionFixture, fixture, usage, takeover } from './fixture.ts';

export function registerFailedUsage() {
    it('releases only confirmed local preflight reservations and keeps immutable failed receipts', async () => {
        const seed = await setup({ mode: 'live' });
        const bundle = scenarioConnectors('research', 'A');
        let dispatched = 0;
        bundle.model = createModelProvider({
            apiKey: 'test-key',
            model: 'test-model',
            http: {
                async request() {
                    dispatched++;
                    throw new Error('Unexpected provider dispatch');
                },
            },
        });
        const { session, close } = sessionFixture(seed, bundle);
        const input = {
            prompt: 'Compile before dispatch',
            schema: { type: 'string', enum: [] },
            maxInputTokens: 4096,
            maxOutputTokens: 100,
        };
        try {
            for (let attempt = 1; attempt <= 2; attempt++) {
                await expect(
                    session.tools.model('local-schema-failure', input),
                ).rejects.toMatchObject({
                    code: 'configuration',
                });
                expect(await seed.repo.usage()).toMatchObject({ inputTokens: 0, outputTokens: 0 });
            }
            expect(dispatched).toBe(0);
            const calls = await fixture.db.query.toolCalls.findMany({
                where: eq(dbToolCalls.runId, seed.run.id),
                orderBy: [asc(dbToolCalls.attemptNo)],
            });
            expect(
                calls.map((call) => ({
                    attemptNo: call.attemptNo,
                    status: call.status,
                    usage: call.usage,
                    outputRef: call.outputRef,
                })),
            ).toEqual(
                [1, 2].map((attemptNo) => ({
                    attemptNo,
                    status: 'failed',
                    usage: usage({ estimated: false }),
                    outputRef: null,
                })),
            );
            await seed.repo.fail({
                toolCallId: calls[0]!.id,
                actualUsage: usage({ estimated: false }),
                failureCode: 'TOOL_CONFIGURATION',
            });
            expect(await seed.repo.usage()).toMatchObject({ inputTokens: 0, outputTokens: 0 });
            const events = await fixture.db.query.runEvents.findMany({
                where: eq(dbRunEvents.runId, seed.run.id),
            });
            expect(events.filter((event) => event.type === 'tool.failed')).toHaveLength(2);
            expect(JSON.stringify(events)).not.toContain('test-key');
        } finally {
            await close();
        }
    });
    it('settles confirmed usage on rejected model JSON without saving a success receipt or refunding twice', async () => {
        const seed = await setup({ mode: 'live' });
        const bundle = scenarioConnectors('research', 'A');
        let valid = false;
        bundle.model = createModelProvider({
            apiKey: 'test-key',
            model: 'test-model',
            maxAttempts: 1,
            http: {
                async request(url) {
                    return {
                        url,
                        status: 200,
                        headers: {},
                        body: JSON.stringify({
                            choices: [
                                {
                                    finish_reason: 'stop',
                                    message: {
                                        content: JSON.stringify({ answer: valid ? 'ok' : 42 }),
                                    },
                                },
                            ],
                            usage: { prompt_tokens: 20, completion_tokens: 8 },
                        }),
                    };
                },
            },
        });
        const { session } = sessionFixture(seed, bundle);
        const input = {
            prompt: 'Test',
            schema: {
                type: 'object',
                properties: { answer: { type: 'string' } },
                required: ['answer'],
                additionalProperties: false,
            },
            maxInputTokens: 4096,
            maxOutputTokens: 100,
        };
        await expect(session.tools.model('schema-retry', input)).rejects.toMatchObject({
            modelFailure: 'schema',
        });
        const calls = await fixture.db.query.toolCalls.findMany({
            where: eq(dbToolCalls.runId, seed.run.id),
        });
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({
            status: 'failed',
            usage: { inputTokens: 20, outputTokens: 8, estimated: false },
            outputRef: null,
        });
        expect(await seed.repo.usage()).toMatchObject({ inputTokens: 20, outputTokens: 8 });
        await seed.repo.fail({
            toolCallId: calls[0]!.id,
            actualUsage: usage({ inputTokens: 20, outputTokens: 8, estimated: false }),
            failureCode: 'TOOL_MODEL_SCHEMA_MISMATCH',
        });
        expect(await seed.repo.usage()).toMatchObject({ inputTokens: 20, outputTokens: 8 });
        valid = true;
        expect((await session.tools.model('schema-retry', input)).data).toEqual({ answer: 'ok' });
        const retried = await fixture.db.query.toolCalls.findMany({
            where: eq(dbToolCalls.runId, seed.run.id),
            orderBy: [asc(dbToolCalls.attemptNo)],
        });
        expect(retried.map((call) => call.status)).toEqual(['failed', 'succeeded']);
        expect(await seed.repo.usage()).toMatchObject({ inputTokens: 40, outputTokens: 16 });
        const events = await fixture.db.query.runEvents.findMany({
            where: eq(dbRunEvents.runId, seed.run.id),
        });
        expect(
            events.filter((event) => event.type === 'tool.failed').map((event) => event.payload),
        ).toEqual([
            expect.objectContaining({
                code: 'TOOL_MODEL_SCHEMA_MISMATCH',
                modelDiagnostic: {
                    stage: 'other',
                    schemaHash: expect.stringMatching(/^[a-f0-9]{64}$/),
                    failure: 'schema',
                    issues: [{ schemaPath: '#/properties/answer/type', keyword: 'type' }],
                },
            }),
        ]);
        expect(JSON.stringify(events)).not.toMatch(/test-key|DO_NOT_RENDER/);
    });

    it('rejects untrusted failed-call usage and fences confirmed failure settlement after takeover', async () => {
        const seed = await setup({ mode: 'live' });
        const held = await seed.repo.reserve({
            operationKey: 'known-failure',
            tool: 'model',
            reserved: usage({ inputTokens: 100, outputTokens: 50 }),
        });
        for (const actual of [
            usage({ inputTokens: 101, outputTokens: 1, estimated: false }),
            usage({ inputTokens: 20, outputTokens: 8, estimated: true }),
            usage({ searches: 1, inputTokens: 20, outputTokens: 8, estimated: false }),
        ]) {
            await expect(
                seed.repo.fail({ toolCallId: held.toolCallId, actualUsage: actual }),
            ).rejects.toMatchObject({ code: 'INVALID_TOOL_RESULT' });
        }
        expect(await seed.repo.usage()).toMatchObject({ inputTokens: 100, outputTokens: 50 });
        await takeover(seed.run.id);
        await expect(
            seed.repo.fail({
                toolCallId: held.toolCallId,
                actualUsage: usage({ inputTokens: 20, outputTokens: 8, estimated: false }),
            }),
        ).rejects.toThrow();
        const call = await fixture.db.query.toolCalls.findFirst({
            where: eq(dbToolCalls.id, held.toolCallId),
        });
        expect(call).toMatchObject({ usage: null, outputRef: null });
    });
}
