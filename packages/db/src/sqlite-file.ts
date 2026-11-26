import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

const require = createRequire(import.meta.url);

export function openSqliteFile(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const Database = (
        process.versions.bun ? require('bun:sqlite').Database : require('node:sqlite').DatabaseSync
    ) as typeof DatabaseSync;
    const db = new Database(path);
    try {
        db.exec('PRAGMA busy_timeout = 500; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL');
        return db;
    } catch (error) {
        db.close();
        throw error;
    }
}
