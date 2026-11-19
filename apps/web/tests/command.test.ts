import { describe, expect, it } from 'vite-plus/test';
import { useCommand } from '@/composable/useCommand';

describe('command concurrency boundary', () => {
    it('locks synchronously, ignores overlapping calls and allows the next user action', async () => {
        const command = useCommand();
        let release!: (value: string) => void;
        let calls = 0;
        const first = command.run(() => {
            calls++;
            return new Promise<string>((resolve) => {
                release = resolve;
            });
        });
        expect(command.pending.value).toBe(true);
        expect(
            await command.run(async () => {
                calls++;
                return 'duplicate';
            }),
        ).toBeUndefined();
        expect(calls).toBe(1);
        release('saved');
        expect(await first).toBe('saved');
        expect(command.pending.value).toBe(false);
        expect(await command.run(async () => 'next')).toBe('next');
    });
    it('releases after asynchronous rejection and preserves the original failure', async () => {
        const command = useCommand();
        const error = new Error('request failed');
        await expect(command.run(() => Promise.reject(error))).rejects.toBe(error);
        expect(command.pending.value).toBe(false);
        expect(await command.run(async () => 'retry')).toBe('retry');
    });
    it('releases after a synchronous dispatch error', async () => {
        const command = useCommand();
        await expect(
            command.run(() => {
                throw new Error('dispatch');
            }),
        ).rejects.toThrow('dispatch');
        expect(command.pending.value).toBe(false);
    });
});
