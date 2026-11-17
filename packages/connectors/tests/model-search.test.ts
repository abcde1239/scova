import { describe, expect, it, vi } from 'vite-plus/test';
import {
    createModelSearch,
    createConnectorBundle,
    createSafeHttpClient,
    MODEL_SEARCH_RESERVATION,
    type ModelSearchProtocol,
    type HttpTransport,
} from '../src/index.ts';

const source = {
    url: 'https://source.example/article',
    title: 'Source title',
    encrypted_content: 'NEVER_EVIDENCE',
};
const payload = (protocol: ModelSearchProtocol) =>
    protocol === 'openai_responses'
        ? {
              status: 'completed',
              usage: { input_tokens: 8100, output_tokens: 80 },
              output: [
                  {
                      type: 'web_search_call',
                      status: 'completed',
                      action: { type: 'search', sources: [source] },
                  },
                  { type: 'message', content: [{ text: 'NEVER_EVIDENCE' }] },
              ],
          }
        : {
              stop_reason: 'end_turn',
              usage: {
                  input_tokens: 8000,
                  cache_read_input_tokens: 100,
                  output_tokens: 80,
                  server_tool_use: { web_search_requests: 1 },
              },
              content: [
                  { type: 'server_tool_use', name: 'web_search', id: 'call1' },
                  { type: 'web_search_tool_result', tool_use_id: 'call1', content: [source] },
                  { type: 'text', text: 'NEVER_EVIDENCE' },
              ],
          };
function fixture(protocol: ModelSearchProtocol, body: unknown = payload(protocol), status = 200) {
    const transport = vi.fn<HttpTransport>(async () => ({
        status,
        headers: {},
        body: JSON.stringify(body),
    }));
    const http = createSafeHttpClient({
        resolve: async () => [{ address: '93.184.216.34', family: 4 }],
        transport,
    });
    return {
        transport,
        search: createModelSearch({
            protocol,
            model: 'selected-model',
            apiKey: 'test-secret',
            baseUrl: 'https://model.example/prefix/v1',
            http,
        }),
    };
}
describe('authorized model web search', () => {
    it('only explicit authorization replaces deployment search, with no paid fallback', async () => {
        const { transport, search } = fixture('openai_responses');
        const http = createSafeHttpClient({
            resolve: async () => [{ address: '93.184.216.34', family: 4 }],
            transport,
        });
        const config = {
            model: 'selected-model',
            modelApiKey: 'test-secret',
            modelBaseUrl: 'https://model.example/prefix/v1',
            http,
        };
        const disabled = createConnectorBundle(config);
        expect(disabled.search.tokenReservation).toBeUndefined();
        expect(transport).not.toHaveBeenCalled();
        const allowed = createConnectorBundle({
            ...config,
            modelSearch: 'openai_responses',
        });
        expect(allowed.search.tokenReservation).toEqual(search.tokenReservation);
        expect((await allowed.search.search('q')).provider).toBe('openai_responses');
        expect(transport).toHaveBeenCalledTimes(1);
        expect(() =>
            createConnectorBundle({
                ...config,
                modelSearch: 'openai_responses',
                modelProtocol: 'gemini',
            }),
        ).toThrow();
    });
    it.each(['openai_responses', 'anthropic_web_search'] as const)(
        '%s rejects redirects without forwarding credentials',
        async (protocol) => {
            const transport = vi.fn<HttpTransport>(async () => ({
                status: 302,
                headers: { location: 'https://attacker.example/' },
                body: '',
            }));
            const http = createSafeHttpClient({
                resolve: async () => [{ address: '93.184.216.34', family: 4 }],
                transport,
            });
            const search = createModelSearch({
                protocol,
                model: 'selected-model',
                apiKey: 'test-secret',
                baseUrl: 'https://model.example/v1',
                http,
            });
            await expect(search.search('q')).rejects.toThrow();
            expect(transport).toHaveBeenCalledTimes(1);
            expect(transport.mock.calls[0][0].hostname).toBe('model.example');
        },
    );
    it.each(['openai_responses', 'anthropic_web_search'] as const)(
        '%s limits tool calls and returns only source candidates with token usage',
        async (protocol) => {
            const { search, transport } = fixture(protocol);
            const beforeAttempt = vi.fn();
            const result = await search.search('query', { beforeAttempt });
            expect(beforeAttempt).toHaveBeenCalledExactlyOnceWith('search', undefined);
            expect(search.tokenReservation).toEqual(MODEL_SEARCH_RESERVATION);
            const [url, request] = transport.mock.calls[0];
            expect(url.toString()).toBe(
                `https://model.example/prefix/v1/${protocol === 'openai_responses' ? 'responses' : 'messages'}`,
            );
            expect(JSON.parse(request.body!)).toMatchObject(
                protocol === 'openai_responses'
                    ? {
                          model: 'selected-model',
                          max_tool_calls: 1,
                          max_output_tokens: 1024,
                          store: false,
                          include: ['web_search_call.action.sources'],
                          tools: [{ type: 'web_search', search_context_size: 'low' }],
                      }
                    : {
                          model: 'selected-model',
                          max_tokens: 1024,
                          tools: [{ type: 'web_search_20250305', max_uses: 1 }],
                      },
            );
            expect(result.usage).toEqual({ inputTokens: 8100, outputTokens: 80, estimated: false });
            expect(result.results).toMatchObject([
                { title: source.title, snippet: '', kind: 'search_snippet' },
            ]);
            expect(JSON.stringify(result)).not.toContain('NEVER_EVIDENCE');
        },
    );
    it.each(['openai_responses', 'anthropic_web_search'] as const)(
        '%s reserves before dispatch, never retries or falls back',
        async (protocol) => {
            const { search, transport } = fixture(protocol, {}, 503);
            const beforeAttempt = vi.fn();
            await expect(search.search('q', { beforeAttempt })).rejects.toMatchObject({
                code: 'http',
            });
            expect(beforeAttempt).toHaveBeenCalledTimes(1);
            expect(transport).toHaveBeenCalledTimes(1);
            transport.mockClear();
            await expect(
                search.search('q', {
                    beforeAttempt: () => {
                        throw new Error('budget');
                    },
                }),
            ).rejects.toThrow();
            expect(transport).not.toHaveBeenCalled();
        },
    );
    it.each(['openai_responses', 'anthropic_web_search'] as const)(
        '%s rejects missing or excess usage and incomplete calls',
        async (protocol) => {
            const original = payload(protocol);
            const bodies = [
                { ...original, usage: undefined },
                { ...original, usage: { ...original.usage, input_tokens: 100000 } },
                { ...original, usage: { ...original.usage, output_tokens: -1 } },
                { ...original, status: 'incomplete', stop_reason: 'pause_turn' },
                { ...original, output: [], content: [] },
            ];
            for (const body of bodies)
                await expect(fixture(protocol, body).search.search('q')).rejects.toThrow();
        },
    );
    it('filters unsafe, duplicate and malformed sources without retaining generated answers', async () => {
        const body = payload('openai_responses');
        const call = body.output![0]! as { action: { sources: unknown[] } };
        call.action.sources = [
            source,
            source,
            { url: 'http://127.0.0.1/secret' },
            { url: 'file:///secret' },
            { title: 'bad' },
        ];
        const result = await fixture('openai_responses', body).search.search('q');
        expect(result.results).toHaveLength(1);
        expect(result.coverage).toMatchObject({ complete: false, discardedResults: 4 });
    });
    it('cancelled and expired calls do not dispatch', async () => {
        const { search, transport } = fixture('openai_responses');
        await expect(search.search('q', { signal: AbortSignal.abort() })).rejects.toMatchObject({
            code: 'aborted',
        });
        await expect(search.search('q', { timeoutMs: 0 })).rejects.toThrow();
        expect(transport).not.toHaveBeenCalled();
    });
    it('does not accept model answers without actual search provenance', async () => {
        await expect(
            fixture('openai_responses', {
                status: 'completed',
                usage: { input_tokens: 10, output_tokens: 10 },
                output: [{ type: 'message', text: 'answer' }],
            }).search.search('q'),
        ).rejects.toMatchObject({ code: 'invalid_response' });
        const body = payload('anthropic_web_search');
        body.usage.server_tool_use = { web_search_requests: 2 };
        await expect(
            fixture('anthropic_web_search', body).search.search('q'),
        ).rejects.toMatchObject({ code: 'invalid_response' });
    });
});
