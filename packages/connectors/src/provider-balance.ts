import { validatePublicUrl, withDeadline, type SafeHttpClient } from './http.ts';
import { createModelHttpClient } from './model-http.ts';
import { ConnectorError } from './types.ts';

export type BalanceTemplate = 'auto' | 'new_api' | 'sub2api';
export interface ProviderBalanceInput {
    baseUrl: string;
    apiKey: string;
    template?: BalanceTemplate;
    signal?: AbortSignal;
}
export interface ProviderBalanceItem {
    label: string;
    scope: 'account' | 'key' | 'subscription';
    unit: string;
    remaining?: number;
    used?: number;
    total?: number;
    unlimited?: boolean;
}
export interface ProviderBalance {
    adapter: 'deepseek' | 'openrouter' | 'siliconflow' | 'new_api' | 'sub2api';
    items: ProviderBalanceItem[];
}
const record = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);
function invalid(): never {
    throw new ConnectorError('invalid_response', '供应商未返回可识别的额度');
}
function amount(value: unknown): number {
    if (
        (typeof value !== 'number' && typeof value !== 'string') ||
        (typeof value === 'string' && !/^-?\d+(?:\.\d+)?$/.test(value))
    )
        invalid();
    const result = Number(value);
    if (!Number.isFinite(result)) invalid();
    return result;
}
function unit(value: unknown): string {
    if (typeof value !== 'string' || !/^[\p{L}\p{N}_$€¥% /.-]{1,24}$/u.test(value)) invalid();
    return value;
}
function counter(value: unknown): number {
    const result = amount(value);
    if (result < 0) invalid();
    return result;
}

/** 仅手动读取固定接口；只向已存供应商同源发送密钥，不扫描、重试或重定向。 */
export function readProviderBalance(
    input: ProviderBalanceInput,
    http: SafeHttpClient = createModelHttpClient(),
): Promise<ProviderBalance> {
    return withDeadline(12_000, input.signal, async (signal) => {
        const base = validatePublicUrl(input.baseUrl);
        if (base.protocol !== 'https:' || base.search || base.hash)
            throw new ConnectorError('unsafe_url', '额度查询需要公开HTTPS根地址');
        const template = input.template ?? 'auto';
        let adapter: ProviderBalance['adapter'], path: string;
        const prefix = base.pathname.replace(/\/+$/, '').replace(/\/(v1|v1beta)$/, '');
        if (template === 'new_api') {
            adapter = 'new_api';
            path = `${prefix}/api/usage/token/`;
        } else if (template === 'sub2api') {
            adapter = 'sub2api';
            path = `${prefix}/v1/usage`;
        } else if (template !== 'auto') {
            throw new ConnectorError('configuration', '额度查询模板不可用');
        } else if (
            base.hostname === 'api.deepseek.com' &&
            ['', '/', '/v1', '/v1/'].includes(base.pathname)
        ) {
            adapter = 'deepseek';
            path = '/user/balance';
        } else if (
            base.hostname === 'openrouter.ai' &&
            ['/api/v1', '/api/v1/'].includes(base.pathname)
        ) {
            adapter = 'openrouter';
            path = '/api/v1/credits';
        } else if (
            ['api.siliconflow.cn', 'api.siliconflow.com'].includes(base.hostname) &&
            ['', '/', '/v1', '/v1/'].includes(base.pathname)
        ) {
            adapter = 'siliconflow';
            path = '/v1/user/info';
        } else {
            throw new ConnectorError('balance_unsupported', '该供应商没有已识别的余额接口');
        }
        const endpoint = new URL(base.origin);
        // pathname赋值避免双斜线前缀被URL构造器解释为另一台主机。
        endpoint.pathname = path;
        const response = await http.request(endpoint.toString(), {
            method: 'GET',
            headers: { accept: 'application/json', authorization: `Bearer ${input.apiKey}` },
            signal,
            timeoutMs: 10_000,
            maxBytes: 64 * 1024,
            maxRedirects: 0,
        });
        if (response.status < 200 || response.status >= 300)
            throw new ConnectorError('http', '供应商未返回额度', false, response.status);
        let data: unknown;
        try {
            data = JSON.parse(response.body);
        } catch {
            invalid();
        }
        if (!record(data)) invalid();
        const items: ProviderBalanceItem[] = [];
        if (adapter === 'deepseek') {
            if (
                !Array.isArray(data.balance_infos) ||
                !data.balance_infos.length ||
                data.balance_infos.length > 10
            )
                invalid();
            for (const info of data.balance_infos) {
                if (!record(info)) invalid();
                items.push({
                    label: '账号余额',
                    scope: 'account',
                    unit: unit(info.currency),
                    remaining: amount(info.total_balance),
                });
            }
        } else if (adapter === 'openrouter') {
            if (!record(data.data)) invalid();
            const total = counter(data.data.total_credits),
                used = counter(data.data.total_usage);
            const remaining = amount(total - used);
            items.push({
                label: '账号余额',
                scope: 'account',
                unit: 'USD',
                total,
                used,
                remaining,
            });
        } else if (adapter === 'siliconflow') {
            if (
                data.status === false ||
                (data.code !== undefined && data.code !== 20000 && data.code !== 0) ||
                !record(data.data)
            )
                invalid();
            items.push({
                label: '账号余额',
                scope: 'account',
                unit: base.hostname.endsWith('.cn') ? 'CNY' : 'USD',
                remaining: amount(data.data.totalBalance),
            });
        } else if (adapter === 'new_api') {
            if (data.code !== true || !record(data.data)) invalid();
            const usage = data.data;
            if (typeof usage.unlimited_quota !== 'boolean') invalid();
            items.push({
                label: 'API Key 额度',
                scope: 'key',
                unit: '额度点',
                unlimited: usage.unlimited_quota,
                ...(usage.unlimited_quota
                    ? {}
                    : {
                          remaining: amount(usage.total_available),
                          total: counter(usage.total_granted),
                      }),
                used: counter(usage.total_used),
            });
            if (record(usage.user_quota))
                items.push({
                    label: '账号额度',
                    scope: 'account',
                    unit: '额度点',
                    remaining: amount(usage.user_quota.total_available),
                    used: counter(usage.user_quota.total_used),
                });
        } else {
            if (data.isValid === false || data.success === false) invalid();
            const quota = record(data.quota) ? data.quota : {};
            const item: ProviderBalanceItem = {
                label: '供应商额度',
                scope: 'key',
                unit: unit(data.unit ?? quota.unit),
            };
            if (data.remaining !== undefined) item.remaining = amount(data.remaining);
            if (quota.limit !== undefined && counter(quota.limit) > 0) {
                item.total = counter(quota.limit);
                item.used = counter(quota.used);
            }
            if (item.remaining === undefined && item.total === undefined) invalid();
            items.push(item);
        }
        return { adapter, items };
    });
}
