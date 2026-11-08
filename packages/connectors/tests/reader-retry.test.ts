import { describe, expect, it, vi } from 'vite-plus/test';
import {
    ConnectorError,
    createPageReader,
    createSafeHttpClient,
    type HttpTransport,
} from '../src/index.ts';

const url = 'https://public.example/article';
const article = {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    body: '<article><h1>Data</h1><p>The published fee is 100 dollars. Applications open in November.</p></article>',
};
function fixture(transport: HttpTransport) {
    return createPageReader({
        http: createSafeHttpClient({
            resolve: async () => [{ address: '93.184.216.34', family: 4 }],
            transport,
        }),
    });
}
describe('bounded reader recovery', () => {
    it.each(['network', 'server'] as const)(
        'retries %s once and reserves both attempts',
        async (kind) => {
            const firstFailure = new ConnectorError('network', 'private error', true);
            const transport = vi
                .fn<HttpTransport>()
                .mockImplementationOnce(async () => {
                    if (kind === 'network') throw firstFailure;
                    return { status: 503, headers: {}, body: '' };
                })
                .mockResolvedValue(article);
            const reserve = vi.fn(async () => {});
            const result = await fixture(transport).read(url, { beforeAttempt: reserve });
            expect(result.text).toContain('100 dollars');
            expect(transport).toHaveBeenCalledTimes(2);
            expect(reserve).toHaveBeenCalledTimes(2);
            expect(reserve.mock.calls[1]).toEqual([
                'read',
                expect.objectContaining({ code: kind === 'network' ? 'network' : 'http' }),
            ]);
        },
    );
    it.each([401, 403, 404, 429])('does not retry HTTP %s', async (status) => {
        const transport = vi.fn<HttpTransport>(async () => ({ status, headers: {}, body: '' }));
        await expect(fixture(transport).read(url)).rejects.toMatchObject({ code: 'http', status });
        expect(transport).toHaveBeenCalledTimes(1);
    });
    it('stops after a second failure and shares the original deadline', async () => {
        const transport = vi.fn<HttpTransport>(async () => ({
            status: 503,
            headers: {},
            body: '',
        }));
        await expect(fixture(transport).read(url)).rejects.toMatchObject({ status: 503 });
        expect(transport).toHaveBeenCalledTimes(2);
        transport.mockClear();
        await expect(fixture(transport).read(url, { timeoutMs: 30 })).rejects.toMatchObject({
            code: 'timeout',
        });
        expect(transport).toHaveBeenCalledTimes(1);
    });
    it('does not dispatch a retry when reservation is refused', async () => {
        const transport = vi.fn<HttpTransport>(async () => ({
            status: 503,
            headers: {},
            body: '',
        }));
        const reserve = vi
            .fn()
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(new ConnectorError('budget_exceeded', 'no pages'));
        await expect(
            fixture(transport).read(url, { beforeAttempt: reserve }),
        ).rejects.toMatchObject({ code: 'budget_exceeded' });
        expect(transport).toHaveBeenCalledTimes(1);
    });
});
