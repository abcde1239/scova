import { afterEach, expect, it, vi } from 'vite-plus/test';
import { createDelegatedReader } from '../src/reader/runtime/delegate.ts';

afterEach(() => vi.unstubAllEnvs());

it('rejects a missing Node executable and drains without waiting for the read deadline', async () => {
    vi.stubEnv('READER_NODE_EXECUTABLE', '__scova_missing_node_executable__');
    const reader = createDelegatedReader({});
    try {
        await expect(reader.read('https://fixture.example/article')).rejects.toMatchObject({
            code: 'extraction_failed',
        });
    } finally {
        await reader.close?.();
    }
});

it('does not start a host for an already cancelled read or after close before first use', async () => {
    vi.stubEnv('READER_NODE_EXECUTABLE', '__scova_missing_node_executable__');
    const reader = createDelegatedReader({});
    const controller = new AbortController();
    controller.abort();
    await expect(
        reader.read('https://fixture.example/article', { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'aborted' });
    await reader.close?.();
    await expect(reader.read('https://fixture.example/article')).rejects.toMatchObject({
        code: 'aborted',
    });
});
