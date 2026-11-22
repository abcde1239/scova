import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqliteState } from '@scova/db/sqlite-state';
import { describe, expect, it } from 'vite-plus/test';
import { createSqliteSearchStateRepository } from '../../server/src/repo/execution/sqlite-search.ts';

describe('SQLite-backed managed search', () => {
    it('shares engine leases and cooldowns and fences cache writes across connections', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'scova-sqlite-search-'));
        const path = join(directory, 'state.sqlite');
        const first = openSqliteState(path);
        const second = openSqliteState(path);
        try {
            const a = createSqliteSearchStateRepository(first, 'test', 1000);
            const b = createSqliteSearchStateRepository(second, 'test', 1000);
            expect((await a.acquire(['example'], 'a')).engines).toEqual(['example']);
            expect((await b.acquire(['example'], 'b')).engines).toEqual([]);
            await b.finish(['example'], 'b', [{ engine: 'example', error: 'captcha' }]);
            expect((await b.status(['example'])).engines).toEqual(['example']);
            await a.finish(['example'], 'a', [{ engine: 'example', error: 'rate_limited' }]);
            expect((await b.status(['example'])).engines).toEqual([]);
            expect(await a.lock('query', 'a')).toBe(true);
            expect(await b.lock('query', 'b')).toBe(false);
            await b.publish('query', 'b', 'stale', 10_000);
            await b.unlock('query', 'b');
            expect(await b.cached('query')).toBeNull();
            expect(await b.lock('query', 'b')).toBe(false);
            await a.publish('query', 'a', 'result', 10_000);
            await a.unlock('query', 'a');
            expect(await b.cached('query')).toBe('result');
            expect(await b.lock('query', 'b')).toBe(true);
        } finally {
            second.close();
            first.close();
            rmSync(directory, { recursive: true, force: true });
        }
    });
});
