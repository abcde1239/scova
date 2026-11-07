import { validatePublicUrl, withDeadline, type SafeHttpClient } from './http.ts';
import { ConnectorError } from './types.ts';
import type { ModelProtocol } from './model-protocol.ts';
import { createModelHttpClient } from './model-http.ts';

export interface ModelCatalogInput {
    baseUrl: string;
    protocol: ModelProtocol;
    apiKey: string;
    signal?: AbortSignal;
}
const record = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === 'object' && !Array.isArray(v);
function invalid(): never {
    throw new ConnectorError('invalid_response', '供应商模型列表格式无效');
}

/** 只读取目录，不生成内容；带密钥的请求禁止重定向和自动重试。 */
export function listProviderModels(
    input: ModelCatalogInput,
    http: SafeHttpClient = createModelHttpClient(),
) {
    return withDeadline(12_000, input.signal, async (signal) => {
        const base = validatePublicUrl(input.baseUrl);
        if (base.protocol !== 'https:' || base.search || base.hash)
            throw new ConnectorError('unsafe_url', '模型目录需要公开 HTTPS 根地址');
        const headers: Record<string, string> = { accept: 'application/json' };
        if (input.protocol === 'anthropic_messages') {
            headers['x-api-key'] = input.apiKey;
            headers['anthropic-version'] = '2023-06-01';
        } else if (input.protocol === 'gemini') headers['x-goog-api-key'] = input.apiKey;
        else if (['openai_chat_completions', 'openai_json'].includes(input.protocol))
            headers.authorization = `Bearer ${input.apiKey}`;
        else throw new ConnectorError('configuration', '模型协议不受支持');
        const items = new Map<string, { id: string; name: string }>();
        const cursors = new Set<string>();
        let cursor = '',
            truncated = false;
        for (let page = 0; page < 5; page++) {
            const url = new URL(`${base.toString().replace(/\/$/, '')}/models`);
            if (input.protocol === 'anthropic_messages') {
                url.searchParams.set('limit', '100');
                if (cursor) url.searchParams.set('after_id', cursor);
            } else if (input.protocol === 'gemini') {
                url.searchParams.set('pageSize', '100');
                if (cursor) url.searchParams.set('pageToken', cursor);
            }
            const response = await http.request(url.toString(), {
                method: 'GET',
                headers,
                signal,
                timeoutMs: 10_000,
                maxBytes: 1024 * 1024,
                maxRedirects: 0,
            });
            if (response.status < 200 || response.status >= 300)
                throw new ConnectorError('http', '供应商未返回模型列表', false, response.status);
            let data: unknown;
            try {
                data = JSON.parse(response.body);
            } catch {
                invalid();
            }
            if (!record(data)) invalid();
            const entries = input.protocol === 'gemini' ? data.models : data.data;
            if (!Array.isArray(entries)) invalid();
            for (const entry of entries) {
                if (!record(entry)) invalid();
                if (input.protocol === 'gemini') {
                    if (!Array.isArray(entry.supportedGenerationMethods)) invalid();
                    if (!entry.supportedGenerationMethods.includes('generateContent')) continue;
                }
                const rawId = input.protocol === 'gemini' ? entry.name : entry.id;
                if (typeof rawId !== 'string') invalid();
                const id = input.protocol === 'gemini' ? rawId.replace(/^models\//, '') : rawId;
                if (!id || id.length > 160 || /\s/.test(id)) continue;
                const name = entry.display_name ?? entry.displayName ?? entry.name ?? id;
                if (items.size >= 1000 && !items.has(id)) {
                    truncated = true;
                    continue;
                }
                items.set(id, {
                    id,
                    name: typeof name === 'string' && name.trim() ? name.slice(0, 200) : id,
                });
            }
            let next = '';
            if (input.protocol === 'anthropic_messages') {
                if (data.has_more === true) {
                    if (typeof data.last_id !== 'string' || !data.last_id) invalid();
                    next = data.last_id;
                }
            } else if (input.protocol === 'gemini' && data.nextPageToken !== undefined) {
                if (typeof data.nextPageToken !== 'string') invalid();
                next = data.nextPageToken;
            }
            if (!next) break;
            if (cursors.has(next)) invalid();
            cursors.add(next);
            cursor = next;
            if (page === 4 || items.size >= 1000) {
                truncated = true;
                break;
            }
        }
        return { items: [...items.values()].sort((a, b) => a.id.localeCompare(b.id)), truncated };
    });
}
