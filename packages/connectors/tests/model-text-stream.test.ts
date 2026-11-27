import { once } from 'node:events';
import { createServer, type RequestListener } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
    ConnectorError,
    createModelProvider,
    createSafeHttpClient,
    estimateModelTextInputTokens,
    isModelPreflightFailure,
    nodeHttpTransport,
    type ModelProtocol,
} from '../src/index.ts';

const input = { prompt: '请直接回答', maxInputTokens: 4000, maxOutputTokens: 100 };
const headers = { 'content-type': 'text/event-stream; charset=utf-8' };
const done = 'data: [DONE]\n\n';
const data = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const event = (delta: object, finish_reason: string | null = null) =>
    data({ choices: [{ index: 0, delta, finish_reason }], usage: null });
const stop = event({}, 'stop');
const usage = (prompt_tokens = 82, completion_tokens = 9) =>
    data({ choices: [], usage: { prompt_tokens, completion_tokens } });
const ignore = () => undefined;

describe('Chat Completions text streaming over HTTP sockets', () => {
    let handle: RequestListener;
    let server: ReturnType<typeof createServer>;
    let port: number;

    beforeEach(async () => {
        server = createServer((req, res) => handle(req, res));
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const bound = server.address();
        if (!bound || typeof bound === 'string') throw new Error('fixture port');
        port = bound.port;
    });

    afterEach(async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
        );
    });

    function model(enableTextStreaming = true, protocol?: ModelProtocol) {
        return createModelProvider({
            apiKey: 'fixture',
            model: 'fixture',
            baseUrl: 'https://api.fixture.example/v1',
            protocol,
            enableTextStreaming,
            maxAttempts: 2,
            retryDelayMs: 0,
            http: createSafeHttpClient({
                resolve: async () => [{ address: '93.184.216.34', family: 4 }],
                // The production request still uses HTTPS with public address validation. Only the
                // injected socket fixture substitutes local HTTP and a pinned loopback address.
                transport: (url, options) =>
                    nodeHttpTransport(new URL(`http://fixture.example:${port}${url.pathname}`), {
                        ...options,
                        address: { address: '127.0.0.1', family: 4 },
                    }),
            }),
        });
    }

    it('delivers three delayed deltas before [DONE], across UTF-8, JSON and line splits', async () => {
        const published: string[] = [];
        const beforeEnd: string[][] = [];
        const release = [
            Promise.withResolvers<void>(),
            Promise.withResolvers<void>(),
            Promise.withResolvers<void>(),
        ];
        const completed = Promise.withResolvers<void>();
        const received = Promise.withResolvers<{ url?: string; accept?: string; body: string }>();
        const first = Buffer.from(
            '\uFEFF: keepalive\r\ndata: {"choices":\r\ndata: [{"index":0,"delta":{"role":"assistant","content":"你好🙂","reasoning_content":"private","tool_calls":[{"function":{"arguments":"private"}}]},"finish_reason":null}]}\r\n\r\n',
        );
        const unicodeCut = first.indexOf(Buffer.from('🙂')) + 2;
        handle = (req, res) => {
            const body: Buffer[] = [];
            req.on('data', (chunk: Buffer) => body.push(chunk));
            req.on('end', () => {
                received.resolve({
                    url: req.url,
                    accept: req.headers.accept,
                    body: Buffer.concat(body).toString(),
                });
                void (async () => {
                    res.on('close', () => completed.resolve());
                    res.writeHead(200, headers);
                    res.write(first.subarray(0, 15));
                    await delay(10);
                    res.write(first.subarray(15, unicodeCut));
                    await delay(10);
                    res.write(first.subarray(unicodeCut, first.length - 1));
                    await release[0]!.promise;
                    beforeEnd.push([...published]);
                    res.write('\n' + event({ content: '，第二段' }));
                    await release[1]!.promise;
                    beforeEnd.push([...published]);
                    await delay(10);
                    res.write(event({ content: '和第三段' }));
                    await release[2]!.promise;
                    beforeEnd.push([...published]);
                    res.write(stop + usage() + 'data: [DO');
                    await delay(10);
                    res.write('NE]\n\n');
                })();
            });
        };
        const beforeAttempt = vi.fn();
        const beforeDispatch = vi.fn(async () => {});
        const result = await model().streamText!(
            input,
            (text) => {
                published.push(text);
                release[published.length - 1]!.resolve();
            },
            { timeoutMs: 2000, beforeAttempt, beforeDispatch },
        );
        expect(beforeEnd).toEqual([
            ['你好🙂'],
            ['你好🙂', '，第二段'],
            ['你好🙂', '，第二段', '和第三段'],
        ]);
        expect(result).toEqual({
            data: '你好🙂，第二段和第三段',
            mode: 'live',
            usage: { inputTokens: 82, outputTokens: 9, estimated: false },
        });
        const request = await received.promise;
        expect(request).toMatchObject({ url: '/v1/chat/completions', accept: 'text/event-stream' });
        const body: unknown = JSON.parse(request.body);
        expect(body).toMatchObject({
            stream: true,
            stream_options: { include_usage: true },
            max_tokens: 100,
        });
        expect(body).not.toHaveProperty('response_format');
        expect(body).not.toHaveProperty('tools');
        expect(beforeAttempt).toHaveBeenCalledExactlyOnceWith('model');
        expect(beforeDispatch).toHaveBeenCalledTimes(1);
        await completed.promise;
    });

    it('keeps structured generation available by default and for unsupported protocols', async () => {
        handle = (_req, res) =>
            res.end(
                JSON.stringify({
                    choices: [
                        { finish_reason: 'stop', message: { content: '{"answer":"整条回答"}' } },
                    ],
                }),
            );
        const fallback = model(true, 'openai_json');
        expect(fallback.streamText).toBeUndefined();
        expect(model(false).streamText).toBeUndefined();
        await expect(
            fallback.generateStructured({ ...input, schema: { type: 'object' } }),
        ).resolves.toMatchObject({ data: { answer: '整条回答' } });
    });

    it('uses conservative reservations for omitted usage and rejects a budget overflow', async () => {
        handle = (_req, res) =>
            res.writeHead(200, headers).end(event({ content: 'answer' }) + stop + done);
        await expect(model().streamText!(input, ignore)).resolves.toMatchObject({
            usage: {
                inputTokens: estimateModelTextInputTokens(input),
                outputTokens: 100,
                estimated: true,
            },
        });
        handle = (_req, res) =>
            res
                .writeHead(200, headers)
                .end(event({ content: 'answer' }) + stop + usage(82, 101) + done);
        await expect(model().streamText!(input, ignore)).rejects.toMatchObject({
            code: 'budget_exceeded',
            modelOutputPublished: true,
        });
        const beforeAttempt = vi.fn();
        const failure: unknown = await model().streamText!(
            { ...input, maxInputTokens: 5 },
            ignore,
            { beforeAttempt },
        ).catch((error: unknown) => error);
        expect(isModelPreflightFailure(failure)).toBe(true);
        expect(beforeAttempt).not.toHaveBeenCalled();
    });

    it.each([
        ['missing terminal marker', stop, 'invalid_response'],
        ['missing final choice', done, 'invalid_response'],
        ['truncation', event({}, 'length') + usage() + done, 'output_truncated'],
        [
            'in-band provider error',
            data({ error: { message: 'SECRET_PROVIDER_BODY' } }),
            'invalid_response',
        ],
        [
            'provider error event',
            'event: error\ndata: SECRET_PROVIDER_BODY\n\n',
            'invalid_response',
        ],
        ['malformed JSON', 'data: {\n\n', 'invalid_response'],
        [
            'refusal',
            event({ content: 'SECRET_PROVIDER_BODY', refusal: 'SECRET_PROVIDER_BODY' }),
            'invalid_response',
        ],
        [
            'unexpected tool completion',
            event({ tool_calls: [{ arguments: 'SECRET_PROVIDER_BODY' }] }, 'tool_calls') + done,
            'invalid_response',
        ],
    ])('ends an attempt after public output on %s', async (_reason, ending, code) => {
        handle = (_req, res) =>
            res.writeHead(200, headers).end(event({ content: 'prefix' }) + ending);
        const onText = vi.fn(ignore);
        const beforeAttempt = vi.fn();
        const failure = await model().streamText!(input, onText, { beforeAttempt }).catch(
            (error: unknown) => error,
        );
        expect(failure).toMatchObject({ code, retryable: false, modelOutputPublished: true });
        if (code === 'output_truncated')
            expect(failure).toMatchObject({
                modelUsage: { inputTokens: 82, outputTokens: 9, estimated: false },
            });
        expect(String(failure)).not.toContain('SECRET_PROVIDER_BODY');
        expect(beforeAttempt).toHaveBeenCalledTimes(1);
        expect(onText).toHaveBeenCalledExactlyOnceWith('prefix');
    });

    it('reserves each pre-output retry and preserves the HTTP error classification', async () => {
        let requests = 0;
        handle = (_req, res) => {
            if (++requests === 1) res.writeHead(503).end('temporary');
            else res.writeHead(200, headers).end(event({ content: 'answer' }) + stop + done);
        };
        const beforeAttempt = vi.fn();
        const onText = vi.fn(ignore);
        await expect(model().streamText!(input, onText, { beforeAttempt })).resolves.toMatchObject({
            data: 'answer',
        });
        expect(requests).toBe(2);
        expect(beforeAttempt.mock.calls[1]).toMatchObject(['model', { code: 'http', status: 503 }]);
        expect(onText).toHaveBeenCalledExactlyOnceWith('answer');
        handle = (_req, res) => res.writeHead(429).end('{"error":{"code":"insufficient_quota"}}');
        beforeAttempt.mockClear();
        await expect(model().streamText!(input, ignore, { beforeAttempt })).rejects.toMatchObject({
            code: 'model_quota_exceeded',
            status: 429,
        });
        expect(beforeAttempt).toHaveBeenCalledTimes(1);
    });

    it('checks the caller dispatch guard before opening a provider socket', async () => {
        const requests = vi.fn();
        handle = (_req, res) => {
            requests();
            res.writeHead(200, headers).end(event({ content: 'answer' }) + stop + done);
        };
        const beforeAttempt = vi.fn();
        const onText = vi.fn(ignore);
        await expect(
            model().streamText!(input, onText, {
                beforeAttempt,
                async beforeDispatch() {
                    throw new ConnectorError('aborted', 'fixture authorization revoked');
                },
            }),
        ).rejects.toMatchObject({ code: 'aborted' });
        expect(beforeAttempt).toHaveBeenCalledExactlyOnceWith('model');
        expect(requests).not.toHaveBeenCalled();
        expect(onText).not.toHaveBeenCalled();
    });

    it('aborts before publishing a second frame and closes the pending HTTP response', async () => {
        const controller = new AbortController();
        const closed = Promise.withResolvers<void>();
        handle = (_req, res) => {
            res.on('close', () => closed.resolve());
            res.writeHead(200, headers).write(
                event({ content: 'first' }) + event({ content: 'second' }),
            );
        };
        const onText = vi.fn((): undefined => {
            controller.abort();
        });
        await expect(
            model().streamText!(input, onText, { signal: controller.signal, timeoutMs: 2000 }),
        ).rejects.toMatchObject({ code: 'aborted', retryable: false, modelOutputPublished: true });
        expect(onText).toHaveBeenCalledExactlyOnceWith('first');
        await closed.promise;
    });

    it.each(['network', 'timeout'])(
        'does not replay a billed POST after a public chunk and %s failure',
        async (code) => {
            const received = Promise.withResolvers<void>();
            handle = (_req, res) => {
                res.writeHead(200, headers).write(event({ content: 'first' }));
                if (code === 'network') void received.promise.then(() => res.destroy());
            };
            const beforeAttempt = vi.fn();
            const onText = vi.fn((): undefined => {
                received.resolve();
            });
            await expect(
                model().streamText!(input, onText, {
                    beforeAttempt,
                    timeoutMs: code === 'timeout' ? 300 : 2000,
                }),
            ).rejects.toMatchObject({ code, retryable: false, modelOutputPublished: true });
            expect(onText).toHaveBeenCalledExactlyOnceWith('first');
            expect(beforeAttempt).toHaveBeenCalledTimes(1);
        },
    );

    it('bounds the text contract and cumulative wire bytes before exposing over-limit text', async () => {
        handle = (_req, res) =>
            res
                .writeHead(200, headers)
                .end(event({ content: 'prefix' }) + event({ content: 'overflow' }) + stop + done);
        const onText = vi.fn(ignore);
        await expect(
            model().streamText!({ ...input, maxOutputChars: 6 }, onText),
        ).rejects.toMatchObject({ code: 'output_truncated' });
        expect(onText).toHaveBeenCalledExactlyOnceWith('prefix');
        handle = (_req, res) => res.writeHead(200, headers).end(':' + 'x'.repeat(2 * 1024 * 1024));
        onText.mockClear();
        await expect(model().streamText!(input, onText)).rejects.toMatchObject({
            code: 'response_too_large',
        });
        expect(onText).not.toHaveBeenCalled();
    });

    it('rejects invalid UTF-8 and HTML bodies without exposing provider content', async () => {
        const onText = vi.fn(ignore);
        handle = (_req, res) => res.writeHead(200, headers).end(Buffer.from([0x80]));
        await expect(model().streamText!(input, onText)).rejects.toMatchObject({
            code: 'invalid_response',
        });
        handle = (_req, res) =>
            res
                .writeHead(200, { 'content-type': 'text/html' })
                .end(event({ content: 'unexpected' }) + stop + done);
        await expect(model().streamText!(input, onText)).rejects.toMatchObject({
            code: 'invalid_response',
        });
        expect(onText).not.toHaveBeenCalled();
    });
});
