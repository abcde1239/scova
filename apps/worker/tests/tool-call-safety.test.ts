import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import {
    ConnectorError,
    createModelProvider,
    isModelPreflightFailure,
    READ_CALL_TIMEOUT_MS,
    type CallContext,
} from '@scova/connectors';
import { createToolCaller } from '../src/service/agent/tool-call.ts';
import { emptyUsage } from '../src/service/agent/tool-results.ts';

const invalidInput = {
    prompt: 'Test local schema compilation',
    schema: { type: 'string', enum: [] },
    maxInputTokens: 4096,
    maxOutputTokens: 100,
};
function model() {
    const request = vi.fn(async () => {
        throw new ConnectorError('network', 'network result unknown');
    });
    return {
        provider: createModelProvider({
            apiKey: 'test-key',
            model: 'test-model',
            http: { request },
        }),
        request,
    };
}
function fixture(searchProvider: 'api' | 'searxng' = 'api', remaining = 60_000) {
    const current = emptyUsage();
    const held = { ...emptyUsage(), inputTokens: 4096, outputTokens: 100 };
    const repository = {
        reserve: vi.fn(async () => ({
            kind: 'reserved',
            toolCallId: 'call',
            attemptNo: 1,
            usage: held,
        })),
        fail: vi.fn(async () => {}),
        usage: vi.fn(async () => emptyUsage()),
        settle: vi.fn(async () => ({ usage: held })),
    };
    const controller = new AbortController();
    const guard = vi.fn(async () => {});
    const invalidateBudget = vi.fn();
    const call = createToolCaller(
        {
            repository,
            bundle: { searchProvider, search: {} },
            context: { deadlineAt: new Date(Date.now() + remaining), signal: controller.signal },
        } as unknown as Parameters<typeof createToolCaller>[0],
        current,
        guard,
        invalidateBudget,
    );
    return { call, repository, current, held, controller, guard, invalidateBudget };
}
afterEach(() => vi.useRealTimers());

describe('Worker trusted model preflight settlement', () => {
    it('refunds a real local AJV compile failure with zero confirmed usage', async () => {
        const f = fixture(),
            m = model();
        await expect(
            f.call(
                'synthesize-0',
                'model',
                invalidInput,
                f.held,
                (context) => m.provider.generateStructured(invalidInput, context),
                () => {},
            ),
        ).rejects.toMatchObject({ code: 'configuration' });
        expect(m.request).not.toHaveBeenCalled();
        expect(f.repository.fail).toHaveBeenCalledWith(
            expect.objectContaining({
                failureCode: 'TOOL_CONFIGURATION',
                actualUsage: { ...emptyUsage(), estimated: false },
            }),
        );
        expect(f.current).toEqual(emptyUsage());
    });
    it('releases local input-limit failures without poisoning the remaining session budget', async () => {
        const f = fixture(),
            m = model();
        const input = { ...invalidInput, schema: { type: 'string' }, maxInputTokens: 1 };
        await expect(
            f.call(
                'synthesize-0',
                'model',
                input,
                f.held,
                (context) => m.provider.generateStructured(input, context),
                () => {},
            ),
        ).rejects.toMatchObject({ code: 'budget_exceeded' });
        expect(m.request).not.toHaveBeenCalled();
        expect(f.repository.fail).toHaveBeenCalledWith(
            expect.objectContaining({
                actualUsage: { ...emptyUsage(), estimated: false },
            }),
        );
        expect(f.invalidateBudget).not.toHaveBeenCalled();
    });
    it('does not certify a failure thrown by an attempt guard', async () => {
        const f = fixture(),
            m = model();
        const error = new ConnectorError('configuration', 'guard failure');
        f.guard.mockResolvedValueOnce().mockRejectedValueOnce(error);
        const input = { ...invalidInput, schema: { type: 'string' } };
        await expect(
            f.call(
                'synthesize-0',
                'model',
                input,
                f.held,
                (context) => m.provider.generateStructured(input, context),
                () => {},
            ),
        ).rejects.toBe(error);
        expect(m.request).not.toHaveBeenCalled();
        expect(isModelPreflightFailure(error)).toBe(false);
        expect(f.repository.fail).toHaveBeenCalledWith({
            toolCallId: 'call',
            failureCode: 'TOOL_CONFIGURATION',
        });
        expect(f.repository.usage).not.toHaveBeenCalled();
    });
    it.each(['configuration', 'network', 'forged'] as const)(
        'retains unknown reservation for untrusted zero-callback %s errors',
        async (kind) => {
            const f = fixture();
            const error = new ConnectorError(
                kind === 'network' ? 'network' : 'configuration',
                'failure',
            );
            if (kind === 'forged')
                Object.assign(error, { preflight: true, dispatched: false, modelUsage: undefined });
            await expect(
                f.call(
                    'synthesize-0',
                    'model',
                    invalidInput,
                    f.held,
                    async (context) => {
                        await context.beforeDispatch?.();
                        throw error;
                    },
                    () => {},
                ),
            ).rejects.toBe(error);
            expect(isModelPreflightFailure(error)).toBe(false);
            expect(f.repository.fail).toHaveBeenCalledWith({
                toolCallId: 'call',
                failureCode: kind === 'network' ? 'TOOL_NETWORK' : 'TOOL_CONFIGURATION',
            });
            expect(f.repository.usage).not.toHaveBeenCalled();
            expect(f.current).toEqual(f.held);
        },
    );
    it('does not refund a branded error reused after the attempt callback', async () => {
        const f = fixture(),
            m = model();
        let preflight: unknown;
        try {
            await m.provider.generateStructured(invalidInput);
        } catch (error) {
            preflight = error;
        }
        expect(isModelPreflightFailure(preflight)).toBe(true);
        await expect(
            f.call(
                'synthesize-0',
                'model',
                invalidInput,
                f.held,
                async (context) => {
                    await context.beforeAttempt?.('model');
                    throw preflight;
                },
                () => {},
            ),
        ).rejects.toBe(preflight);
        expect(f.repository.fail).toHaveBeenCalledWith({
            toolCallId: 'call',
            failureCode: 'TOOL_CONFIGURATION',
        });
        expect(f.repository.usage).not.toHaveBeenCalled();
    });
    it('retains unknown usage after a real HTTP dispatch fails', async () => {
        const f = fixture(),
            m = model();
        const input = { ...invalidInput, schema: { type: 'string' } };
        await expect(
            f.call(
                'synthesize-0',
                'model',
                input,
                f.held,
                (context) => m.provider.generateStructured(input, context),
                () => {},
            ),
        ).rejects.toMatchObject({ code: 'network' });
        expect(m.request).toHaveBeenCalledOnce();
        expect(f.repository.fail).toHaveBeenCalledWith({
            toolCallId: 'call',
            failureCode: 'TOOL_NETWORK',
        });
        expect(f.repository.usage).not.toHaveBeenCalled();
    });
});

describe('Worker per-read deadline', () => {
    it.each([
        ['api', 60_000, READ_CALL_TIMEOUT_MS],
        ['searxng', 60_000, 15_000],
        ['api', 9_000, 9_000],
    ] as const)(
        'caps %s reading with run remainder %d at %dms',
        async (provider, remaining, limit) => {
            vi.useFakeTimers();
            const f = fixture(provider, remaining);
            let context: CallContext | undefined;
            const pending = f.call(
                'read-0',
                'read',
                'https://example.com',
                { ...emptyUsage(), pages: 1 },
                async (options) => {
                    context = options;
                    await options.beforeAttempt?.('read');
                    return new Promise<never>(() => {});
                },
                () => {},
            );
            const checked = expect(pending).rejects.toMatchObject({ code: 'timeout' });
            await vi.advanceTimersByTimeAsync(limit - 1);
            expect(context?.timeoutMs).toBe(limit);
            expect(context?.signal?.aborted).toBe(false);
            expect(f.repository.fail).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(1);
            await checked;
            expect(context?.signal?.aborted).toBe(true);
            expect(f.repository.fail).toHaveBeenCalledWith({
                toolCallId: 'call',
                failureCode: 'TOOL_TIMEOUT',
            });
        },
    );
    it('cancels an API read before its longer timeout without settling unknown usage', async () => {
        const f = fixture();
        let started!: () => void;
        const ready = new Promise<void>((resolve) => {
            started = resolve;
        });
        let signal: AbortSignal | undefined;
        const pending = f.call(
            'read-0',
            'read',
            'https://example.com',
            { ...emptyUsage(), pages: 1 },
            async (context) => {
                signal = context.signal;
                await context.beforeAttempt?.('read');
                started();
                return new Promise<never>(() => {});
            },
            () => {},
        );
        const checked = expect(pending).rejects.toMatchObject({ code: 'aborted' });
        await ready;
        f.controller.abort();
        await checked;
        expect(signal?.aborted).toBe(true);
        expect(f.repository.fail).toHaveBeenCalledWith({
            toolCallId: 'call',
            failureCode: 'TOOL_ABORTED',
        });
    });
});
