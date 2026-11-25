import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { StatementSync } from 'node:sqlite';
import { openSqliteFile } from './sqlite-file.ts';

const migrations = ['0001_business.sql', '0002_checkpoints.sql'] as const;

/** Initialize or upgrade an offline SQLite business database in one transaction. */
export function migrateSqliteDatabase(path: string) {
    const scripts = migrations.map((name, index) => {
        const sql = readFileSync(new URL(`../sqlite/${name}`, import.meta.url), 'utf8').replaceAll(
            '\r\n',
            '\n',
        );
        return {
            version: index + 1,
            name,
            hash: createHash('sha256').update(sql).digest('hex'),
            sql,
        };
    });
    const db = openSqliteFile(path);
    // Bun keeps the Windows database handle alive until its prepared statements are finalized.
    const statements: (StatementSync & { finalize?(): void })[] = [];
    function prepare(query: string) {
        const statement = db.prepare(query);
        statements.push(statement);
        return statement;
    }
    try {
        db.exec('BEGIN IMMEDIATE');
        try {
            db.exec(`CREATE TABLE IF NOT EXISTS scova_business_migrations (
                version INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                hash TEXT NOT NULL
            ) STRICT`);
            const history = prepare(
                'SELECT version, name, hash FROM scova_business_migrations ORDER BY version',
            ).all();
            for (const [index, applied] of history.entries()) {
                const script = scripts[index];
                if (
                    !script ||
                    applied.version !== script.version ||
                    applied.name !== script.name ||
                    applied.hash !== script.hash
                )
                    throw new Error(`SQLite 业务迁移历史不匹配：版本 ${String(applied.version)}`);
            }
            const record = prepare(
                'INSERT INTO scova_business_migrations (version, name, hash) VALUES (?, ?, ?)',
            );
            const pending = scripts.slice(history.length);
            for (const script of pending) {
                db.exec(script.sql);
                record.run(script.version, script.name, script.hash);
            }
            if (pending.length > 0 && prepare('PRAGMA foreign_key_check').get())
                throw new Error('SQLite 外键校验未通过');
            db.exec('COMMIT');
            return { version: scripts.length, applied: pending.map(({ name }) => name) };
        } catch (error) {
            db.exec('ROLLBACK');
            throw error;
        }
    } finally {
        for (const statement of statements) statement.finalize?.();
        db.close();
    }
}
