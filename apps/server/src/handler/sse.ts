import type { ApiStreamRegistry } from '@/app/streams.ts';
import type { EventPage } from '@/repo/run-events.ts';
import { eventMessage, resetMessage } from '@/service/run-events.ts';
import { encodeSse, type SsePolicy } from '@/utils/sse.ts';
const terminal = new Set(['succeeded', 'partial', 'failed', 'canceled']);
const encoder = new TextEncoder();

/** 零预取、逐帧 pull；HTTP 适配器的 socket 背压不会变为无界事件缓冲。 */
export function createSseBody(options: {
    first: EventPage;
    next(after: number): Promise<EventPage>;
    signal: AbortSignal;
    expiresAt: Date;
    clock(): Date;
    registry: ApiStreamRegistry;
    policy: SsePolicy;
}): ReadableStream<Uint8Array> {
    const { policy } = options;
    for (const value of Object.values(policy))
        if (!Number.isSafeInteger(value) || value < 1) throw new Error('SSE 配置必须为正安全整数');
    const abort = new AbortController();
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
        resolveDone = resolve;
    });
    let finishing: Promise<void> | undefined;
    let pending: Promise<EventPage> | undefined;
    let wake: (() => void) | undefined;
    let waiting: ReturnType<typeof setTimeout> | undefined;
    let slow: ReturnType<typeof setTimeout> | undefined;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    let page = options.first;
    let index = 0;
    let cursor = page.cursor;
    let resetSent = false;
    let lastFrameAt = performance.now();

    const finish = (error = false) => {
        if (finishing) return finishing;
        abort.abort();
        clearTimeout(waiting);
        clearTimeout(slow);
        clearTimeout(expiry);
        wake?.();
        options.signal.removeEventListener('abort', onAbort);
        try {
            if (error) controller?.error(new Error('事件连接已结束，请重新连接'));
            else controller?.close();
        } catch {
            /* cancel 已关闭控制器。 */
        }
        finishing = (async () => {
            await pending?.catch(() => undefined);
            resolveDone();
        })();
        return finishing;
    };
    function onAbort() {
        void finish(true);
    }
    function armSlow() {
        clearTimeout(slow);
        slow = setTimeout(onAbort, policy.slowClientMs);
    }
    function armExpiry() {
        const remaining = options.expiresAt.getTime() - options.clock().getTime();
        if (remaining <= 0) {
            onAbort();
            return;
        }
        expiry = setTimeout(armExpiry, Math.min(remaining, 2_147_483_647));
    }
    function send(bytes: Uint8Array) {
        if (bytes.byteLength > policy.maxFrameBytes) {
            onAbort();
            return;
        }
        controller!.enqueue(bytes);
        lastFrameAt = performance.now();
        armSlow();
    }
    async function wait(milliseconds: number) {
        if (abort.signal.aborted) return;
        await new Promise<void>((resolve) => {
            wake = resolve;
            waiting = setTimeout(resolve, milliseconds);
        });
        wake = undefined;
        clearTimeout(waiting);
    }
    options.registry.register(onAbort, done);
    options.signal.addEventListener('abort', onAbort, { once: true });
    return new ReadableStream<Uint8Array>(
        {
            start(value) {
                controller = value;
                if (options.signal.aborted) {
                    onAbort();
                    return;
                }
                armSlow();
                armExpiry();
            },
            async pull() {
                clearTimeout(slow);
                try {
                    while (!abort.signal.aborted) {
                        if (page.reset) {
                            if (resetSent) {
                                await finish();
                                return;
                            }
                            resetSent = true;
                            send(encodeSse(resetMessage(page)));
                            return;
                        }
                        const event = page.events[index++];
                        if (event) {
                            send(encodeSse(eventMessage(event)));
                            cursor = event.seq;
                            return;
                        }
                        if (terminal.has(page.run.status) && cursor >= page.latest) {
                            await finish();
                            return;
                        }
                        if (cursor >= page.latest) {
                            const untilHeartbeat =
                                policy.heartbeatMs - (performance.now() - lastFrameAt);
                            if (untilHeartbeat <= 0) {
                                send(encoder.encode(': heartbeat\n\n'));
                                return;
                            }
                            await wait(Math.min(policy.pollIntervalMs, untilHeartbeat));
                            if (abort.signal.aborted) return;
                        }
                        pending = options.next(cursor);
                        page = await pending;
                        pending = undefined;
                        index = 0;
                    }
                } catch {
                    await finish(true);
                }
            },
            cancel() {
                return finish();
            },
        },
        { highWaterMark: 0, size: (chunk) => chunk?.byteLength ?? 0 },
    );
}
