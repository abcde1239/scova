import { describe, expect, it, vi } from 'vite-plus/test';
import {
    ConnectorError,
    createModelProvider,
    isModelPreflightFailure,
    type SafeHttpClient,
} from '../src/index.ts';

const validInput = {
    prompt: 'Answer this bounded fixture',
    schema: {
        type: 'object',
        properties: { answer: { type: 'string' } },
        required: ['answer'],
        additionalProperties: false,
    },
    maxInputTokens: 4000,
    maxOutputTokens: 100,
};

describe('trusted model preflight failures', () => {
    it.each([
        { ...validInput, schema: { type: 'string', enum: [] } },
        { ...validInput, prompt: '' },
        { ...validInput, maxOutputTokens: 0 },
        { ...validInput, maxInputTokens: 1 },
    ])('certifies only validation that completes before any provider attempt', async (input) => {
        const request = vi.fn<SafeHttpClient['request']>();
        const beforeAttempt = vi.fn();
        const model = createModelProvider({
            apiKey: 'fixture',
            model: 'fixture',
            http: { request },
        });
        const error = await model
            .generateStructured(input, { beforeAttempt })
            .catch((error: unknown) => error);
        expect(error).toBeInstanceOf(ConnectorError);
        expect(isModelPreflightFailure(error)).toBe(true);
        expect(beforeAttempt).not.toHaveBeenCalled();
        expect(request).not.toHaveBeenCalled();
    });

    it('never certifies a failure from provider transport even with the same configuration code', async () => {
        const error = new ConnectorError('configuration', 'transport refused');
        const request = vi.fn<SafeHttpClient['request']>(async () => {
            throw error;
        });
        const beforeAttempt = vi.fn();
        const model = createModelProvider({
            apiKey: 'fixture',
            model: 'fixture',
            http: { request },
        });
        await expect(model.generateStructured(validInput, { beforeAttempt })).rejects.toBe(error);
        expect(beforeAttempt).toHaveBeenCalledExactlyOnceWith('model');
        expect(request).toHaveBeenCalledTimes(1);
        expect(isModelPreflightFailure(error)).toBe(false);
        expect(
            isModelPreflightFailure(
                Object.assign(new ConnectorError('configuration', 'forged'), {
                    modelPreflightFailure: true,
                }),
            ),
        ).toBe(false);
    });
});
