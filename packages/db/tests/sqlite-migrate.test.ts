import { mkdtempSync, rmdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { openSqliteFile } from '../src/sqlite-file.ts';
import { migrateSqliteDatabase } from '../src/sqlite-migrate.ts';
import { openSqliteState } from '../src/sqlite-state.ts';

let directory: string;
let path: string;
beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'scova-sqlite-business-'));
    path = join(directory, 'database.sqlite');
});
afterEach(() => {
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
    rmdirSync(directory);
});

describe('SQLite business migration', () => {
    it('applies only once, preserves coordination and business rows, and enforces ownership', () => {
        const state = openSqliteState(path);
        try {
            state.transaction((store, now) =>
                store.set('migration-test', 'retained', now + 60_000),
            );
        } finally {
            state.close();
        }
        expect(migrateSqliteDatabase(path)).toEqual({
            version: 2,
            applied: ['0001_business.sql', '0002_checkpoints.sql'],
        });
        const db = openSqliteFile(path);
        try {
            db.exec(`INSERT INTO users (id, email, normalized_email, password_hash)
                VALUES ('user', 'user@example.test', 'user@example.test', 'test')`);
            const insert = db.prepare(
                'INSERT INTO workflows (id, user_id, title, draft_json) VALUES (?, ?, ?, ?)',
            );
            expect(() => insert.run('missing-user', 'unknown', 'Test', '{}')).toThrow();
            expect(() => insert.run('invalid-draft', 'user', 'Test', '{')).toThrow();
            insert.run('draft', 'user', 'Test', '{}');
            expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
        } finally {
            db.close();
        }
        expect(migrateSqliteDatabase(path)).toEqual({ version: 2, applied: [] });
        const reopened = openSqliteState(path);
        try {
            expect(reopened.get('migration-test', Date.now())?.value).toBe('retained');
            expect(reopened.db.prepare('SELECT user_id FROM workflows').get()?.user_id).toBe(
                'user',
            );
        } finally {
            reopened.close();
        }
    });

    it('rolls back a failed migration without altering existing tables', () => {
        const db = openSqliteFile(path);
        try {
            db.exec("CREATE TABLE workflows (data TEXT); INSERT INTO workflows VALUES ('keep')");
            expect(() => migrateSqliteDatabase(path)).toThrow();
            expect(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all()).toEqual(
                [{ name: 'workflows' }],
            );
            expect(db.prepare('SELECT data FROM workflows').get()?.data).toBe('keep');
        } finally {
            db.close();
        }
    });

    it('rejects a migration history with a changed checksum', () => {
        migrateSqliteDatabase(path);
        const db = openSqliteFile(path);
        try {
            db.exec("UPDATE scova_business_migrations SET hash = 'different'");
        } finally {
            db.close();
        }
        expect(() => migrateSqliteDatabase(path)).toThrow('SQLite 业务迁移历史不匹配');
    });
});
