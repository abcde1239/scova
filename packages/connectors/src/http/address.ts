import { isIP } from 'node:net';
import { ConnectorError } from '../types.ts';

export interface ResolvedAddress {
    address: string;
    family: number;
}

/** Preserve DNS preference within each family without spending every attempt on one family. */
export function interleaveAddressFamilies(addresses: ResolvedAddress[]): ResolvedAddress[] {
    const unique = [...new Map(addresses.map((address) => [address.address, address])).values()];
    const preferred = unique[0]?.family;
    const first = unique.filter((address) => address.family === preferred);
    const second = unique.filter((address) => address.family !== preferred);
    const result: ResolvedAddress[] = [];
    for (let index = 0; index < Math.max(first.length, second.length); index++) {
        if (first[index]) result.push(first[index]);
        if (second[index]) result.push(second[index]);
    }
    return result;
}

export function isPublicIp(address: string): boolean {
    if (isIP(address) === 4) {
        const [a, b, c] = address.split('.').map(Number);
        return !(
            a === 0 ||
            a === 10 ||
            a === 127 ||
            a >= 224 ||
            (a === 100 && b >= 64 && b <= 127) ||
            (a === 169 && b === 254) ||
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 &&
                ((b === 0 && (c === 0 || c === 2)) || b === 168 || (b === 88 && c === 99))) ||
            (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
            (a === 203 && b === 0 && c === 113)
        );
    }
    if (isIP(address) !== 6 || address.includes('.')) return false;
    const parts = address.toLowerCase().split(':');
    const first = Number.parseInt(parts[0] || '0', 16);
    const second = Number.parseInt(parts[1] || '0', 16);
    // Only global unicast, excluding transition, protocol-assignment and documentation ranges.
    return (
        first >= 0x2000 &&
        first <= 0x3fff &&
        first !== 0x2002 &&
        !(first === 0x2001 && (second < 0x200 || second === 0xdb8)) &&
        !(first === 0x3fff && second < 0x1000)
    );
}

export function validatePublicUrl(value: string): URL {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new ConnectorError('unsafe_url', '来源 URL 无效');
    }
    if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        (url.port && url.port !== (url.protocol === 'https:' ? '443' : '80'))
    ) {
        throw new ConnectorError('unsafe_url', '来源协议、凭据或端口不允许');
    }
    const hostname = url.hostname
        .replace(/^\[|\]$/g, '')
        .replace(/\.$/, '')
        .toLowerCase();
    if (
        !hostname ||
        hostname === 'localhost' ||
        hostname.endsWith('.localhost') ||
        hostname.endsWith('.local') ||
        hostname.endsWith('.internal') ||
        (isIP(hostname) !== 0 && !isPublicIp(hostname))
    ) {
        throw new ConnectorError('unsafe_url', '来源地址不是公共网络地址');
    }
    url.hash = '';
    return url;
}

export function normalizeUrl(value: string): string {
    const url = validatePublicUrl(value);
    // Snapshot keys before deletion: the live iterator would skip adjacent tracking keys.
    const keys = Array.from(url.searchParams.keys());
    for (const key of keys) {
        if (/^utm_/i.test(key) || /^(fbclid|gclid|msclkid)$/i.test(key))
            url.searchParams.delete(key);
    }
    return url.toString();
}
