import { createSafeHttpClient } from './http.ts';
import { createPublicDnsResolver } from './public-dns.ts';

/** 网页读取独立配置，不继承模型供应商的解析设置。 */
export function createReaderDnsResolver(
    options: Parameters<typeof createPublicDnsResolver>[0] = {},
) {
    return createPublicDnsResolver({
        ...options,
        mode: options.mode ?? process.env.READER_DNS_RESOLVER ?? 'auto',
        configName: 'READER_DNS_RESOLVER',
    });
}
export function createReaderHttpClient() {
    return createSafeHttpClient({ resolve: createReaderDnsResolver() });
}
