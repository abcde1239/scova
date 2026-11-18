import { createSafeHttpClient } from '../http/index.ts';
import { createPublicDnsResolver } from '../http/dns.ts';
import { MODEL_CALL_TIMEOUT_MS } from '../types.ts';

export function createModelDnsResolver(
    options: Parameters<typeof createPublicDnsResolver>[0] = {},
) {
    return createPublicDnsResolver({
        ...options,
        mode: options.mode ?? process.env.MODEL_DNS_RESOLVER ?? 'auto',
        configName: 'MODEL_DNS_RESOLVER',
    });
}
export function createModelHttpClient() {
    return createSafeHttpClient({
        resolve: createModelDnsResolver(),
        maxTimeoutMs: MODEL_CALL_TIMEOUT_MS,
    });
}
