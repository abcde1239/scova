import { isIP } from 'node:net';
import { createSafeHttpClient } from '../http/index.ts';
import { createPublicDnsResolver } from '../http/dns.ts';

/** 网页读取独立配置，不继承模型供应商的解析设置。 */
export function createReaderDnsResolver(
    options: Parameters<typeof createPublicDnsResolver>[0] = {},
) {
    const mode = options.mode ?? process.env.READER_DNS_RESOLVER ?? 'auto';
    const create = (selected: string) =>
        createPublicDnsResolver({
            ...options,
            mode: selected,
            configName: 'READER_DNS_RESOLVER',
            // These published Cloudflare DNS HTTPS frontend addresses keep the original
            // cloudflare-dns.com TLS name. Anycast 1.1.1.1 can be unreachable under TUN.
            dnsHttp:
                options.dnsHttp ??
                (selected === 'cloudflare'
                    ? createSafeHttpClient({
                          resolve: async () =>
                              ['104.16.248.249', '104.16.249.249', '1.1.1.1'].map((address) => ({
                                  address,
                                  family: 4,
                              })),
                          maxAddressAttempts: 3,
                          // Keep time for another verified frontend inside the
                          // five-second DNS deadline when the first route stalls.
                          addressTimeoutMs: 1500,
                      })
                    : undefined),
        });
    if (mode !== 'auto') return create(mode);
    const system = create('system');
    const fallback = create('cloudflare');
    return async (hostname: string, signal?: AbortSignal) => {
        const addresses = await system(hostname, signal);
        // Only a wholly synthetic Fake-IP answer triggers public resolution.
        // Empty, mixed and private answers still reach the HTTP client's rejection.
        const allFake =
            addresses.length > 0 &&
            addresses.every(({ address }) => {
                const [first, second] = address.split('.');
                return (
                    isIP(address) === 4 && first === '198' && (second === '18' || second === '19')
                );
            });
        return allFake ? fallback(hostname, signal) : addresses;
    };
}
export function createReaderHttpClient() {
    return createSafeHttpClient({
        resolve: createReaderDnsResolver(),
        maxAddressAttempts: 3,
        bodyIdleTimeoutMs: 4000,
    });
}
