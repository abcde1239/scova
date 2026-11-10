// Private Node/vpx subprocess: stdout is reserved exclusively for the parent RPC protocol.
import { createInterface } from 'node:readline';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createPageReader } from './browser-reader.ts';
import { ConnectorError } from './types.ts';

const input = createInterface({ input: process.stdin });
const reads = new AsyncLocalStorage();
const pending = new Map();
const controllers = new Map();
let reader;
let sequence = 0;
let closing;
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const pack = (error) => ({
    code: error instanceof ConnectorError ? error.code : 'extraction_failed',
    message: error instanceof ConnectorError ? error.message : '网页读取失败',
    retryable: error instanceof ConnectorError && error.retryable,
    status: error instanceof ConnectorError ? error.status : undefined,
});
const unpack = (error) =>
    new ConnectorError(error.code, error.message, error.retryable, error.status);
function rpc(type, payload, signal) {
    if (signal?.aborted) return Promise.reject(new ConnectorError('aborted', '网页读取已停止'));
    return new Promise((resolve, reject) => {
        const id = ++sequence;
        const abort = () => {
            pending.delete(id);
            reject(new ConnectorError('aborted', '网页读取已停止'));
        };
        pending.set(id, {
            finish(message) {
                signal?.removeEventListener('abort', abort);
                if (message.ok) resolve(message);
                else reject(unpack(message.error));
            },
            abort,
        });
        signal?.addEventListener('abort', abort, { once: true });
        send({ type, id, readId: reads.getStore(), ...payload });
    });
}
async function close() {
    return (closing ??= (async () => {
        for (const controller of controllers.values()) controller.abort();
        for (const callback of pending.values()) callback.abort();
        await reader?.close();
        input.close();
        process.stdin.destroy();
    })());
}
input.on('close', () => {
    void close();
});
process.on('SIGTERM', () => {
    void close();
});
input.on('line', async (line) => {
    let message;
    try {
        message = JSON.parse(line);
    } catch {
        await close();
        return;
    }
    if (message.type === 'init') {
        try {
            reader = createPageReader({
                http: {
                    request: async (url, options) =>
                        (
                            await rpc(
                                'http',
                                {
                                    url,
                                    options: { ...options, signal: undefined },
                                },
                                options.signal,
                            )
                        ).response,
                },
                maxTextChars: message.maxTextChars,
                renderWaitMs: message.renderWaitMs,
            });
            send({ type: 'ready' });
        } catch {
            await close();
        }
    } else if (message.type === 'read' && reader && !closing) {
        const controller = new AbortController();
        controllers.set(message.id, controller);
        await reads.run(message.id, async () => {
            try {
                const result = await reader.read(message.originalUrl, {
                    timeoutMs: message.timeoutMs,
                    signal: controller.signal,
                    beforeDispatch: async () => {
                        await rpc('beforeDispatch', {}, controller.signal);
                    },
                    beforeAttempt: async (_kind, previousFailure) => {
                        await rpc(
                            'beforeAttempt',
                            {
                                previousFailure: previousFailure
                                    ? pack(previousFailure)
                                    : undefined,
                            },
                            controller.signal,
                        );
                    },
                });
                send({ type: 'result', id: message.id, result });
            } catch (error) {
                send({ type: 'error', id: message.id, error: pack(error) });
            } finally {
                controllers.delete(message.id);
            }
        });
    } else if (message.type === 'abort') {
        controllers.get(message.id)?.abort();
    } else if (message.type === 'response') {
        const callback = pending.get(message.id);
        pending.delete(message.id);
        callback?.finish(message);
    } else if (message.type === 'close') {
        await close();
    }
});
