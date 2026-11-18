import { ConnectorError } from '../types.ts';

export function positiveLimit(value: number, max: number, label: string): number {
    if (!Number.isSafeInteger(value) || value < 1 || value > max) {
        throw new ConnectorError('configuration', `${label} 超出允许范围`);
    }
    return value;
}

export async function withDeadline<T>(
    timeoutMs: number,
    signal: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
    positiveLimit(timeoutMs, 300_000, '超时');
    if (signal?.aborted) throw new ConnectorError('aborted', '调用已取消');
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const stopped = new Promise<never>((_, reject) => {
        const stop = (error: ConnectorError) => {
            controller.abort(error);
            reject(error);
        };
        onAbort = () => stop(new ConnectorError('aborted', '调用已取消'));
        signal?.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => stop(new ConnectorError('timeout', '调用超时', true)), timeoutMs);
    });
    try {
        // Subscribe to cancellation even when starting the operation throws synchronously.
        const work = (async () => operation(controller.signal))();
        return await Promise.race([work, stopped]);
    } finally {
        clearTimeout(timer);
        if (onAbort) signal?.removeEventListener('abort', onAbort);
    }
}
