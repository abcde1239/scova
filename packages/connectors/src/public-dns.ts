import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import {
    createSafeHttpClient,
    isPublicIp,
    type ResolvedAddress,
    type SafeHttpClient,
} from './http.ts';
import { ConnectorError } from './types.ts';

const resolvers = {
    alidns: { url: 'https://dns.alidns.com/resolve', address: '223.5.5.5' },
    cloudflare: { url: 'https://cloudflare-dns.com/dns-query', address: '1.1.1.1' },
    google: { url: 'https://dns.google/resolve', address: '8.8.8.8' },
};
function fakeIp(address: string) {
    const parts = address.split('.');
    return isIP(address) === 4 && parts[0] === '198' && (parts[1] === '18' || parts[1] === '19');
}

/** Fake-IP只触发重新解析，永远不成为允许连接的地址。 */
export function createPublicDnsResolver(
    options: {
        mode?: string;
        configName?: string;
        lookup?: (hostname: string) => Promise<ResolvedAddress[]>;
        dnsHttp?: SafeHttpClient;
    } = {},
) {
    const mode = options.mode ?? 'auto';
    if (!['auto', 'system', ...Object.keys(resolvers)].includes(mode))
        throw new ConnectorError(
            'configuration',
            `${options.configName ?? 'DNS_RESOLVER'} 配置无效`,
        );
    const systemLookup =
        options.lookup ?? ((hostname: string) => lookup(hostname, { all: true, verbatim: true }));
    const server =
        resolvers[
            (mode === 'auto' || mode === 'system' ? 'alidns' : mode) as keyof typeof resolvers
        ];
    // 引导DNS服务本身使用固定公网IP，同时保留服务域名的TLS/SNI/证书验证。
    const dnsHttp =
        options.dnsHttp ??
        createSafeHttpClient({
            resolve: async () => [{ address: server.address, family: 4 }],
        });
    return async (hostname: string, signal?: AbortSignal): Promise<ResolvedAddress[]> => {
        if (signal?.aborted) throw new ConnectorError('aborted', '域名解析已取消');
        if (mode === 'auto' || mode === 'system') {
            const addresses = await systemLookup(hostname);
            if (signal?.aborted) throw new ConnectorError('aborted', '域名解析已取消');
            if (
                mode === 'system' ||
                !addresses.length ||
                !addresses.every((item) => fakeIp(item.address))
            )
                return addresses;
        }
        const endpoint = new URL(server.url);
        endpoint.searchParams.set('name', hostname);
        endpoint.searchParams.set('type', 'A');
        const response = await dnsHttp.request(endpoint.toString(), {
            method: 'GET',
            headers: { accept: 'application/dns-json' },
            timeoutMs: 5000,
            maxBytes: 65536,
            maxRedirects: 0,
            signal,
        });
        if (response.status !== 200) throw new ConnectorError('network', '可信DNS查询失败');
        let value: unknown;
        try {
            value = JSON.parse(response.body);
        } catch {
            throw new ConnectorError('network', '可信DNS响应无效');
        }
        if (
            !value ||
            typeof value !== 'object' ||
            !('Status' in value) ||
            value.Status !== 0 ||
            !('Answer' in value) ||
            !Array.isArray(value.Answer)
        )
            throw new ConnectorError('network', '可信DNS未返回域名解析');
        const addresses: ResolvedAddress[] = [];
        for (const entry of value.Answer) {
            if (!entry || typeof entry !== 'object' || ![1, 28].includes(entry.type)) continue;
            if (
                typeof entry.data !== 'string' ||
                !isPublicIp(entry.data) ||
                isIP(entry.data) !== (entry.type === 1 ? 4 : 6)
            )
                throw new ConnectorError('unsafe_url', '可信DNS返回了非公网地址');
            if (!addresses.some((a) => a.address === entry.data))
                addresses.push({ address: entry.data, family: entry.type === 1 ? 4 : 6 });
        }
        if (!addresses.length) throw new ConnectorError('network', '可信DNS未返回公网地址');
        return addresses;
    };
}
