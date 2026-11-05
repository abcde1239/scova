import { describe, expect, it, vi } from 'vite-plus/test';
import { ConnectorError } from '@scova/connectors';
import { createDefaultServices } from '../src/app/services';
import { createAgentProviderService } from '../src/service/agent-providers';

const secret = 'fixture-secret-must-not-appear';
const input = {
    baseUrl: 'https://api.example.com/v1',
    protocol: 'openai_chat_completions',
    apiKey: secret,
};

describe('模型列表错误保留可诊断分类且不公开上游内容', () => {
    it.each([
        [new ConnectorError('network', secret), 'MODEL_CATALOG_NETWORK', 503],
        [new ConnectorError('response_too_large', secret), 'MODEL_CATALOG_TOO_LARGE', 503],
        [new ConnectorError('invalid_response', secret), 'MODEL_CATALOG_INVALID_RESPONSE', 503],
        [new ConnectorError('aborted', secret), 'MODEL_CATALOG_CANCELLED', 503],
        [new ConnectorError('configuration', secret), 'MODEL_CATALOG_CONFIGURATION', 503],
        [new ConnectorError('timeout', secret), 'MODEL_CATALOG_TIMEOUT', 503],
        [new ConnectorError('unsafe_url', secret), 'MODEL_CATALOG_ADDRESS', 422],
        [new ConnectorError('http', secret, false, 401), 'MODEL_CATALOG_AUTH', 422],
        [new ConnectorError('http', secret, false, 403), 'MODEL_CATALOG_AUTH', 422],
        [new ConnectorError('http', secret, false, 404), 'MODEL_CATALOG_UNSUPPORTED', 422],
        [new ConnectorError('http', secret, false, 429), 'MODEL_CATALOG_RATE_LIMITED', 503],
        [new ConnectorError('http', secret, false, 502), 'MODEL_CATALOG_UPSTREAM', 503],
        [new Error(secret), 'MODEL_CATALOG_UNAVAILABLE', 503],
    ] as const)('%s → %s', async (cause, code, status) => {
        const providerModels = vi.fn().mockRejectedValue(cause);
        const services = createDefaultServices({ providerModels });
        const service = createAgentProviderService(services);
        const error = await service
            .models('019a0000-0000-7000-8000-000000000001', input)
            .catch((error: unknown) => error);
        expect(error).toMatchObject({ code, status });
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).not.toContain(secret);
        expect(JSON.stringify(error)).not.toContain(secret);
        expect(providerModels).toHaveBeenCalledTimes(1);
    });
});
