import { describe, expect, it, vi } from 'vite-plus/test';
import { withDeadline } from '../src/http/deadline.ts';

describe('HTTP deadline cancellation', () => {
    it('handles both rejections when an operation cancels its caller and throws synchronously', async () => {
        const caller = new AbortController();
        const failure = new Error('synchronous operation failure');
        await expect(
            withDeadline(1000, caller.signal, () => {
                caller.abort();
                throw failure;
            }),
        ).rejects.toBe(failure);
        // Let the runtime report any unhandled rejection from the cancellation branch.
        await new Promise((resolve) => setTimeout(resolve, 0));
    });

    it('preserves synchronous errors and removes the caller listener and deadline', async () => {
        vi.useFakeTimers();
        try {
            const caller = new AbortController();
            const remove = vi.spyOn(caller.signal, 'removeEventListener');
            const failure = new Error('synchronous operation failure');
            await expect(
                withDeadline(1000, caller.signal, () => {
                    throw failure;
                }),
            ).rejects.toBe(failure);
            expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });

    it('aborts an operation that ignores cancellation when its deadline expires', async () => {
        vi.useFakeTimers();
        try {
            let innerSignal: AbortSignal | undefined;
            const pending = withDeadline(1000, undefined, (signal) => {
                innerSignal = signal;
                return new Promise<never>(() => {});
            });
            const assertion = expect(pending).rejects.toMatchObject({ code: 'timeout' });
            await vi.advanceTimersByTimeAsync(1000);
            await assertion;
            expect(innerSignal?.aborted).toBe(true);
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });
});
