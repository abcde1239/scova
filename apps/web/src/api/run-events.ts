import { readonly, shallowRef } from 'vue';
import { UuidSchema, parseContract, type Run, type RunEvent, type SseMessage } from '@scova/models';
import { HttpError, InvalidResponseError, raceSignal } from 'requestlane';
import type { SessionLifecycle } from '@/api/session';
import { toApiError } from '@/api/errors';
import { apiUrl, apiCredentials } from '@/api/config';
import { createSseParser, SseParseError } from '@/api/sse-parser';
import { requestRun, runQueryOptions } from '@/api/runs';

export type RunConnectionState =
    | 'connecting'
    | 'open'
    | 'reconnecting'
    | 'complete'
    | 'closed'
    | 'error';
export interface RunEventOptions {
    signal?: AbortSignal;
    headerTimeoutMs?: number;
    idleTimeoutMs?: number;
    maxReconnects?: number;
    backoffMs?: number;
    onEvent?: (event: RunEvent) => void | Promise<void>;
    onSnapshot?: (snapshot: Run) => void | Promise<void>;
    onReset?: (snapshot: Run) => void | Promise<void>;
}
const terminal = new Set(['succeeded', 'partial', 'failed', 'canceled']);
class CallbackError extends Error {
    constructor(cause: unknown) {
        super('执行订阅回调失败', { cause });
    }
}

/** native 不经过 Client hooks，认证、超时、清理与代次核对均在此显式补齐。 */
export function subscribeRunEvents(
    lifecycle: SessionLifecycle,
    runId: string,
    options: RunEventOptions = {},
) {
    parseContract(UuidSchema, runId);
    const headerTimeoutMs = options.headerTimeoutMs ?? 15_000;
    const idleTimeoutMs = options.idleTimeoutMs ?? 45_000;
    const maxReconnects = options.maxReconnects ?? 6;
    const backoffMs = options.backoffMs ?? 500;
    for (const value of [headerTimeoutMs, idleTimeoutMs])
        if (!Number.isSafeInteger(value) || value < 1)
            throw new RangeError('连接超时须为正安全整数');
    for (const value of [maxReconnects, backoffMs])
        if (!Number.isSafeInteger(value) || value < 0)
            throw new RangeError('重连预算须为非负安全整数');
    const scope = lifecycle.capture();
    const runKey = runQueryOptions(lifecycle, runId).queryKey;
    const state = shallowRef<RunConnectionState>('connecting');
    const error = shallowRef<ReturnType<typeof toApiError>>();
    const abort = new AbortController();
    const signal = AbortSignal.any([
        abort.signal,
        scope.signal,
        ...(options.signal ? [options.signal] : []),
    ]);
    let after = 0;
    let lastEventId: string | undefined;
    let removeCleanup = () => {};
    const current = () => !signal.aborted && scope.isCurrent();
    function stop() {
        abort.abort();
        if (state.value !== 'complete' && state.value !== 'error') state.value = 'closed';
    }
    removeCleanup = scope.registerCleanup(stop);

    function invalidate() {
        if (!current()) return;
        const domains = new Set(['run', 'runs', 'tasks', 'reports', 'notifications', 'inbox']);
        void lifecycle.queryClient.invalidateQueries({
            predicate: ({ queryKey }) =>
                queryKey[0] === 'session' &&
                queryKey[1] === scope.accountId &&
                queryKey[2] === scope.epoch &&
                domains.has(String(queryKey[3])),
        });
    }
    async function notify<T>(callback: ((value: T) => void | Promise<void>) | undefined, value: T) {
        if (!callback || !current()) return;
        try {
            await raceSignal(
                Promise.resolve().then(() => current() && callback(value)),
                signal,
            );
        } catch (cause) {
            throw new CallbackError(cause);
        }
    }
    async function snapshot(run: Run) {
        if (!current()) return;
        await lifecycle.queryClient.cancelQueries({ queryKey: runKey, exact: true });
        if (!current()) return;
        lifecycle.queryClient.setQueryData(runKey, {
            data: run,
            status: 200,
            headers: {},
            url: apiUrl(`/runs/${runId}`),
        });
        await notify(options.onSnapshot, run);
    }
    async function process(messages: readonly SseMessage[]) {
        let reset = false;
        for (const message of messages) {
            if (!current()) break;
            if (message.type === 'stream.reset') {
                await notify(options.onReset, message.payload.snapshot);
                await snapshot(message.payload.snapshot);
                if (!current()) break;
                after = message.payload.resumeAfter;
                lastEventId = undefined;
                invalidate();
                reset = true;
                break;
            }
            if (message.seq <= after) continue;
            await notify(options.onEvent, message);
            if (!current()) break;
            after = message.seq;
            lastEventId = message.eventId;
            invalidate();
        }
        return reset;
    }
    async function connect() {
        const connection = new AbortController();
        const connectionSignal = AbortSignal.any([signal, connection.signal]);
        let timer: ReturnType<typeof setTimeout> | undefined;
        let response: Response | undefined;
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        const arm = (milliseconds: number) => {
            clearTimeout(timer);
            timer = setTimeout(
                () => connection.abort(new DOMException('事件连接超时', 'TimeoutError')),
                milliseconds,
            );
        };
        try {
            arm(headerTimeoutMs);
            const pendingResponse = scope.transport.native(
                apiUrl(`/runs/${runId}/events?after=${after}`),
                {
                    method: 'GET',
                    credentials: apiCredentials,
                    cache: 'no-store',
                    signal: connectionSignal,
                    headers: {
                        accept: 'text/event-stream',
                        ...(lastEventId ? { 'last-event-id': lastEventId } : {}),
                    },
                },
            );
            void pendingResponse.then(
                (late) => {
                    if (connectionSignal.aborted) void late.body?.cancel().catch(() => {});
                },
                () => {},
            );
            response = await raceSignal(pendingResponse, connectionSignal);
            if (!current()) return 'cancelled';
            if (!response.ok) {
                let body: unknown;
                try {
                    body = await raceSignal(response.json(), connectionSignal);
                } catch {
                    /* 非JSON错误仍保留HTTP状态。 */
                }
                const failure = toApiError(
                    new HttpError({
                        status: response.status,
                        statusText: response.statusText,
                        url: response.url,
                        headers: Object.fromEntries(response.headers),
                        data: body,
                    }),
                );
                if (response.status === 401 && current()) scope.replaceSession(null);
                throw failure;
            }
            if (
                !/^text\/event-stream(?:\s*;|\s*$)/i.test(
                    response.headers.get('content-type') ?? '',
                ) ||
                !response.body
            )
                throw new InvalidResponseError('事件连接未返回SSE流');
            reader = response.body.getReader();
            const parser = createSseParser({ runId });
            state.value = 'open';
            for (;;) {
                arm(idleTimeoutMs);
                const chunk = await raceSignal(reader.read(), connectionSignal);
                if (!current()) return 'cancelled';
                try {
                    if (await process(chunk.done ? parser.finish() : parser.push(chunk.value)))
                        return 'reset';
                } catch (cause) {
                    if (cause instanceof SseParseError && (await process(cause.completedMessages)))
                        return 'reset';
                    if (
                        chunk.done &&
                        cause instanceof SseParseError &&
                        ['INCOMPLETE_FRAME', 'INVALID_UTF8'].includes(cause.code)
                    )
                        throw new Error('事件连接在帧完成前中断', { cause });
                    throw cause;
                }
                if (chunk.done) return 'eof';
            }
        } finally {
            clearTimeout(timer);
            connection.abort();
            // 某些 transport 的 cancel promise 不会 settle，不能让它阻塞 stop/done 或重连预算。
            void (reader ? reader.cancel() : response?.body?.cancel())?.catch(() => {});
            reader?.releaseLock();
        }
    }
    async function wait(milliseconds: number) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            await raceSignal(
                new Promise<void>((resolve) => {
                    timer = setTimeout(resolve, milliseconds);
                }),
                signal,
            );
        } finally {
            clearTimeout(timer);
        }
    }
    const done = (async () => {
        let retryCause: unknown;
        try {
            for (let reconnects = 0; current(); reconnects++) {
                if (reconnects) {
                    if (reconnects > maxReconnects)
                        throw retryCause ?? new Error('事件连接重试预算已用尽');
                    state.value = 'reconnecting';
                    await wait(Math.min(backoffMs * 2 ** Math.min(reconnects - 1, 20), 8_000));
                }
                try {
                    const outcome = await connect();
                    if (!current()) return;
                    if (outcome === 'eof') {
                        const response = await requestRun(scope, runId, signal);
                        if (!current()) return;
                        await snapshot(response.data);
                        if (!current()) return;
                        if (terminal.has(response.data.status)) {
                            state.value = 'complete';
                            return;
                        }
                    }
                    retryCause = new Error(
                        outcome === 'reset'
                            ? '事件游标已重置，等待续传'
                            : '事件连接已断开，执行尚未终止',
                    );
                } catch (cause) {
                    if (!current()) return;
                    const failure = toApiError(cause);
                    if (
                        cause instanceof CallbackError ||
                        cause instanceof SseParseError ||
                        cause instanceof InvalidResponseError ||
                        failure.kind === 'validation' ||
                        failure.kind === 'protocol' ||
                        (failure.status !== undefined &&
                            failure.status < 500 &&
                            failure.status !== 429)
                    )
                        throw cause;
                    retryCause = failure;
                }
            }
        } catch (cause) {
            if (current()) {
                error.value = toApiError(cause);
                state.value = 'error';
            }
        } finally {
            removeCleanup();
            if (state.value !== 'complete' && state.value !== 'error') state.value = 'closed';
        }
    })();
    return { state: readonly(state), error: readonly(error), done, stop };
}
