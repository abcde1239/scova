import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export function readSqliteStatePath(env: NodeJS.ProcessEnv = process.env) {
    const path = env.SCOVA_SQLITE_STATE_PATH;
    if (path !== undefined && (!path.trim() || !isAbsolute(path)))
        throw new Error('SCOVA_SQLITE_STATE_PATH 必须为本机绝对文件路径');
    return path === undefined ? undefined : resolve(path);
}

/** Coordination data for a single host. Business rows and Run leases stay in PostgreSQL. */
export function openSqliteState(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // Bun 1.3 ships bun:sqlite, Node ships node:sqlite; these statements use their shared API.
    const Database = (
        process.versions.bun ? require('bun:sqlite').Database : require('node:sqlite').DatabaseSync
    ) as typeof import('node:sqlite').DatabaseSync;
    const db = new Database(path);
    try {
        db.exec(`
            PRAGMA busy_timeout = 500;
            PRAGMA journal_mode = WAL;
            CREATE TABLE IF NOT EXISTS scova_ephemeral (
                key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS scova_ephemeral_expiry ON scova_ephemeral(expires_at);
            CREATE TABLE IF NOT EXISTS scova_jobs (
                queue TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, data TEXT NOT NULL,
                queued_at INTEGER NOT NULL, owner TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
                removed_after INTEGER, PRIMARY KEY (queue, id)
            );
            CREATE INDEX IF NOT EXISTS scova_jobs_claim
                ON scova_jobs(queue, queued_at, id) WHERE removed_after IS NULL;
        `);
    } catch (error) {
        db.close();
        throw error;
    }

    const read = db.prepare('SELECT value, expires_at FROM scova_ephemeral WHERE key = ?');
    const write = db.prepare(`INSERT INTO scova_ephemeral VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`);
    const remove = db.prepare('DELETE FROM scova_ephemeral WHERE key = ?');
    const prune = db.prepare(`DELETE FROM scova_ephemeral WHERE key IN (
        SELECT key FROM scova_ephemeral WHERE expires_at <= ? ORDER BY expires_at LIMIT 100
    )`);
    const state = {
        get<T>(this: void, key: string, now: number): { value: T; expiresAt: number } | null {
            const row = read.get(key);
            if (!row || Number(row.expires_at) <= now) return null;
            return { value: JSON.parse(String(row.value)) as T, expiresAt: Number(row.expires_at) };
        },
        set(key: string, value: unknown, expiresAt: number) {
            write.run(key, JSON.stringify(value), expiresAt);
        },
        delete(key: string) {
            remove.run(key);
        },
    };

    return {
        db,
        get: state.get,
        transaction<T>(work: (store: typeof state, now: number) => T): T {
            db.exec('BEGIN IMMEDIATE');
            try {
                const now = Date.now();
                const result = work(state, now);
                prune.run(now);
                db.exec('COMMIT');
                return result;
            } catch (error) {
                db.exec('ROLLBACK');
                throw error;
            }
        },
        close: () => db.close(),
    };
}

export type SqliteState = ReturnType<typeof openSqliteState>;

export function openSqliteRunQueue(path: string, name: string) {
    const state = openSqliteState(path);
    const { db } = state;
    const prune = db.prepare('DELETE FROM scova_jobs WHERE queue = ? AND removed_after <= ?');
    const publish = db.prepare(`INSERT INTO scova_jobs (queue, id, name, data, queued_at)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT(queue, id) DO UPDATE SET
            queued_at = excluded.queued_at, removed_after = NULL
        WHERE ? = 1 AND scova_jobs.removed_after IS NOT NULL`);
    const hasReadyJob = db.prepare(
        'SELECT 1 FROM scova_jobs WHERE queue = ? AND removed_after IS NULL AND lease_until <= ? LIMIT 1',
    );
    const claim = db.prepare(`UPDATE scova_jobs SET owner = ?, lease_until = ? WHERE rowid = (
        SELECT rowid FROM scova_jobs WHERE queue = ? AND removed_after IS NULL AND lease_until <= ?
        ORDER BY queued_at, id LIMIT 1
    ) RETURNING id, name, data`);
    const renew = db.prepare(`UPDATE scova_jobs SET lease_until = ?
        WHERE queue = ? AND id = ? AND owner = ? AND lease_until > ?`);
    const settle =
        db.prepare(`UPDATE scova_jobs SET owner = NULL, lease_until = 0, removed_after = ?
        WHERE queue = ? AND id = ? AND owner = ? AND lease_until > ?`);
    const removeJob = db.prepare('DELETE FROM scova_jobs WHERE queue = ? AND id = ?');

    const renewJob = (id: string, owner: string, leaseMs: number) => {
        const at = Date.now();
        return Number(renew.run(at + leaseMs, name, id, owner, at).changes) === 1;
    };
    const settleJob = (id: string, owner: string, retry: boolean) => {
        const at = Date.now();
        // Keep a completed job briefly so a late Outbox acknowledgement is safe to replay.
        return (
            Number(settle.run(retry ? null : at + 86_400_000, name, id, owner, at).changes) === 1
        );
    };

    return {
        publish(id: string, event: string, payload: unknown, recover = false) {
            state.transaction((_store, now) => {
                prune.run(name, now);
                publish.run(name, id, event, JSON.stringify(payload), now, Number(recover));
            });
        },
        claim(leaseMs: number) {
            const now = Date.now();
            if (!hasReadyJob.get(name, now)) return null;
            const owner = randomUUID();
            const row = claim.get(owner, now + leaseMs, name, now);
            if (!row) return null;
            const id = String(row.id);
            return {
                id,
                owner,
                name: String(row.name),
                data: JSON.parse(String(row.data)) as unknown,
                renew: () => renewJob(id, owner, leaseMs),
                settle: (retry = false) => settleJob(id, owner, retry),
            };
        },
        renewJob,
        settleJob,
        remove(ids: Iterable<string>) {
            state.transaction(() => {
                for (const id of ids) removeJob.run(name, id);
            });
        },
        close: state.close,
    };
}
