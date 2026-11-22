import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqliteState } from '@scova/db/sqlite-state';
import { describe, expect, it } from 'vite-plus/test';
import {
    countLocalAttempts,
    reserveLocalDraft,
    settleLocalDraft,
} from '@/repo/sqlite-coordination';

describe('SQLite-backed API coordination', () => {
    it('shares counters and settles a bounded reservation only once across connections', () => {
        const directory = mkdtempSync(join(tmpdir(), 'scova-sqlite-api-'));
        const path = join(directory, 'state.sqlite');
        const first = openSqliteState(path);
        const second = openSqliteState(path);
        try {
            expect(countLocalAttempts(first, ['global', 'owner-1'], 60)).toEqual([1, 1]);
            expect(countLocalAttempts(second, ['global', 'owner-2'], 60)).toEqual([2, 1]);
            const keys = ['user-budget', 'global-budget'];
            const limits = [1, 2, 10, 10, 1, 2, 10, 10, 60];
            expect(reserveLocalDraft(first, keys, 'a', [0, 1, 10, 10, ...limits])).toEqual([1]);
            expect(reserveLocalDraft(second, keys, 'b', [0, 1, 5, 5, ...limits])).toEqual([0]);
            expect(settleLocalDraft(second, keys, 'a', [5, 5])).toEqual([1]);
            expect(settleLocalDraft(first, keys, 'a', [0, 0])).toEqual([0]);
            expect(reserveLocalDraft(second, keys, 'b', [0, 1, 5, 5, ...limits])).toEqual([1]);
            expect(reserveLocalDraft(first, keys, 'c', [0, 1, 0, 0, ...limits])).toEqual([0]);
        } finally {
            second.close();
            first.close();
            rmSync(directory, { recursive: true, force: true });
        }
    });
});
