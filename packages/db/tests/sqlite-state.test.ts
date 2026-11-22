import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vite-plus/test';
import { openSqliteRunQueue, openSqliteState, readSqliteStatePath } from '../src/sqlite-state.ts';

function withState(work: (path: string) => void) {
    const directory = mkdtempSync(join(tmpdir(), 'scova-sqlite-'));
    try {
        work(join(directory, 'state.sqlite'));
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
}

describe('single-host SQLite coordination', () => {
    it('is opt-in and rejects paths whose meaning depends on the working directory', () => {
        expect(readSqliteStatePath({})).toBeUndefined();
        expect(() => readSqliteStatePath({ SCOVA_SQLITE_STATE_PATH: './state.sqlite' })).toThrow(
            'SCOVA_SQLITE_STATE_PATH',
        );
    });

    it('reopens durable jobs, fences stale claims, deduplicates and allows an explicit recovery replay', () => {
        withState((path) => {
            const producer = openSqliteRunQueue(path, 'runs');
            producer.publish('one', 'run.enqueue', { runId: 'one' });
            producer.publish('one', 'run.enqueue', { runId: 'ignored replay' });
            producer.close();

            const first = openSqliteRunQueue(path, 'runs');
            const second = openSqliteRunQueue(path, 'runs');
            const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
            try {
                const original = first.claim(100)!;
                expect(original.data).toEqual({ runId: 'one' });
                expect(second.claim(100)).toBeNull();
                clock.mockReturnValue(1050);
                expect(original.renew()).toBe(true);
                clock.mockReturnValue(1125);
                expect(second.claim(100)).toBeNull();
                clock.mockReturnValue(1150);
                const recovered = second.claim(100)!;
                expect(original.settle()).toBe(false);
                expect(original.renew()).toBe(false);
                expect(recovered.settle()).toBe(true);
                first.publish('one', 'run.enqueue', { runId: 'ignored' });
                expect(first.claim(100)).toBeNull();
                first.publish('one', 'run.enqueue', { runId: 'one' }, true);
                expect(first.claim(100)?.data).toEqual({ runId: 'one' });
                second.remove(['one']);
                expect(second.claim(100)).toBeNull();
            } finally {
                clock.mockRestore();
                second.close();
                first.close();
            }
        });
    });

    it('recovers a job claimed by a separate process that exits without acknowledgement', () => {
        withState((path) => {
            const queue = openSqliteRunQueue(path, 'runs');
            try {
                queue.publish('one', 'run.enqueue', { runId: 'one' });
                const module = new URL('../src/sqlite-state.ts', import.meta.url).href;
                const child = spawnSync(
                    process.execPath,
                    [
                        '--input-type=module',
                        '-e',
                        `
                    import { openSqliteRunQueue } from ${JSON.stringify(module)};
                    const queue = openSqliteRunQueue(process.argv[1], 'runs');
                    const job = queue.claim(60_000);
                    process.stdout.write(JSON.stringify(job.data));
                    process.exit(0);
                `,
                        path,
                    ],
                    { encoding: 'utf8', timeout: 10_000, windowsHide: true },
                );
                expect(child.status, child.stderr).toBe(0);
                expect(JSON.parse(child.stdout)).toEqual({ runId: 'one' });
                expect(queue.claim(100)).toBeNull();
                const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_001);
                try {
                    expect(queue.claim(100)?.settle()).toBe(true);
                } finally {
                    clock.mockRestore();
                }
            } finally {
                queue.close();
            }
        });
    });

    it('honors expiry and rolls back a failed local coordination transaction', () => {
        withState((path) => {
            const state = openSqliteState(path);
            try {
                state.transaction((store, now) => store.set('key', { active: true }, now + 30_000));
                expect(() =>
                    state.transaction((store) => {
                        store.delete('key');
                        throw new Error('rollback');
                    }),
                ).toThrow('rollback');
                expect(state.get('key', Date.now())?.value).toEqual({ active: true });
                expect(state.get('key', Date.now() + 30_001)).toBeNull();
            } finally {
                state.close();
            }
        });
    });
});
