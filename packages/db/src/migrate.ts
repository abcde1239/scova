import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { databaseConnection } from './client.ts';
import { assertCatalog, catalogSignature, type SchemaSignature } from './catalog.ts';

export interface MigrationOptions {
    connectionString: string;
}
export interface DatabaseMigration {
    name: string;
    hash: string;
    sql: string;
    when: number;
}
interface LegacyMigration {
    name: string;
    hash: string;
    windowsHash: string;
    sql: string;
}
interface SchemaBaseline {
    version: 1;
    migrations: { name: string; hash: string }[];
    signature: SchemaSignature;
}

// Git checkouts may use CRLF while Linux uses LF. Compare canonical scripts without editing archives.
const digest = (text: string) =>
    createHash('sha256').update(text.replaceAll('\r\n', '\n')).digest('hex');
const root = new URL('../', import.meta.url);
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** Kit emits logical public qualifiers; scope identifiers without changing string/comment contents. */
export function scopeMigrationSql(text: string, namespace: string): string {
    let result = '';
    for (let index = 0; index < text.length;) {
        const rest = text.slice(index);
        const comment = rest.match(/^--[^\n]*(?:\n|$)|^\/\*[\s\S]*?\*\//);
        if (comment) {
            result += comment[0];
            index += comment[0].length;
            continue;
        }
        const literal = rest.match(/^'(?:''|[^'])*'/);
        if (literal) {
            result += literal[0];
            index += literal[0].length;
            continue;
        }
        const dollar = rest.match(/^(\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$)/);
        if (dollar) {
            const end = text.indexOf(dollar[0], index + dollar[0].length);
            if (end < 0) throw new Error('迁移含未闭合 dollar 字符串');
            result += text.slice(index, end + dollar[0].length);
            index = end + dollar[0].length;
            continue;
        }
        const identifier = rest.match(/^"(?:""|[^"])*"/);
        if (identifier) {
            result +=
                identifier[0] === '"public"' && /^\s*\./.test(rest.slice(identifier[0].length))
                    ? quote(namespace)
                    : identifier[0];
            index += identifier[0].length;
            continue;
        }
        result += text[index++];
    }
    return result;
}

export async function readLegacyMigrations(): Promise<LegacyMigration[]> {
    const manifest: { name: string; hash: string; windowsHash: string }[] = JSON.parse(
        await readFile(new URL('legacy-manifest.json', root), 'utf8'),
    );
    return Promise.all(
        manifest.map(async (entry) => {
            if (!/^\d{14}_[a-z0-9_]+$/.test(entry.name)) throw new Error('非法历史迁移名称');
            const sql = await readFile(
                new URL(`prisma/migrations/${entry.name}/migration.sql`, root),
                'utf8',
            );
            if (digest(sql) !== entry.hash) throw new Error(`历史迁移校验和改变：${entry.name}`);
            return { ...entry, sql };
        }),
    );
}

export async function readDatabaseMigrations(): Promise<DatabaseMigration[]> {
    const journal: {
        version: string;
        dialect: string;
        entries: { idx: number; when: number; tag: string }[];
    } = JSON.parse(await readFile(new URL('drizzle/meta/_journal.json', root), 'utf8'));
    if (journal.version !== '7' || journal.dialect !== 'postgresql' || !journal.entries.length)
        throw new Error('不支持的 Drizzle 迁移 journal');
    return Promise.all(
        journal.entries.map(async (entry, index) => {
            if (
                entry.idx !== index ||
                !/^\d{4}_[a-z0-9_]+$/.test(entry.tag) ||
                !Number.isSafeInteger(entry.when) ||
                (index > 0 && journal.entries[index - 1]!.when >= entry.when)
            )
                throw new Error('Drizzle 迁移顺序或名称不合法');
            const sql = await readFile(new URL(`drizzle/${entry.tag}.sql`, root), 'utf8');
            return { name: entry.tag, hash: digest(sql), sql, when: entry.when };
        }),
    );
}

async function baseline(migrations: DatabaseMigration[]): Promise<SchemaBaseline> {
    const expected: SchemaBaseline = JSON.parse(
        await readFile(new URL('schema-baseline.json', root), 'utf8'),
    );
    if (
        expected.version !== 1 ||
        JSON.stringify(expected.migrations) !==
            JSON.stringify(migrations.map(({ name, hash }) => ({ name, hash })))
    )
        throw new Error('迁移 SQL 与已审查数据库结构基线不匹配；请重新生成并审查基线');
    return expected;
}

async function hasTable(client: pg.Client, namespace: string, table: string): Promise<boolean> {
    const result = await client.query('SELECT to_regclass($1) AS value', [
        `${quote(namespace)}.${quote(table)}`,
    ]);
    return result.rows[0].value !== null;
}

async function verifyLegacy(client: pg.Client, namespace: string): Promise<boolean> {
    if (!(await hasTable(client, namespace, '_prisma_migrations'))) return false;
    const expected = await readLegacyMigrations();
    const result =
        await client.query(`SELECT migration_name,checksum,finished_at,rolled_back_at,applied_steps_count
        FROM ${quote(namespace)}._prisma_migrations ORDER BY migration_name`);
    if (
        result.rows.length !== expected.length ||
        result.rows.some((row, index) => {
            const entry = expected[index]!;
            return (
                row.migration_name !== entry.name ||
                ![entry.hash, entry.windowsHash].includes(row.checksum) ||
                !row.finished_at ||
                row.rolled_back_at !== null ||
                row.applied_steps_count < 1
            );
        })
    )
        throw new Error('旧数据库迁移历史不完整、未知或校验失败，拒绝接管；请先核查历史与备份');
    return true;
}

async function ledger(
    client: pg.Client,
    namespace: string,
    migrations: DatabaseMigration[],
): Promise<number | null> {
    if (!(await hasTable(client, namespace, '_scova_migrations'))) return null;
    const result = await client.query(
        `SELECT name,hash,applied_at FROM ${quote(namespace)}._scova_migrations ORDER BY name`,
    );
    if (
        result.rows.length > migrations.length ||
        result.rows.some((row, index) => {
            const entry = migrations[index]!;
            return row.name !== entry.name || row.hash !== entry.hash || !row.applied_at;
        })
    )
        throw new Error('数据库迁移账本存在未知、篡改或非连续条目');
    return result.rows.length;
}

async function open(options: MigrationOptions): Promise<{ client: pg.Client; namespace: string }> {
    const config = databaseConnection({ connectionString: options.connectionString, max: 1 });
    const client = new pg.Client({
        connectionString: config.connectionString,
        connectionTimeoutMillis: 5000,
    });
    await client.connect();
    return { client, namespace: config.schema };
}

/** Read-only readiness: no CREATE/ALTER, no legacy baseline registration, no migration side effects. */
export async function verifyDatabase(options: MigrationOptions): Promise<void> {
    const migrations = await readDatabaseMigrations();
    const expected = await baseline(migrations);
    const { client, namespace } = await open(options);
    try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const count = await ledger(client, namespace, migrations);
        if (count !== migrations.length) throw new Error('业务数据库存在待执行迁移');
        await verifyLegacy(client, namespace);
        assertCatalog(await catalogSignature(client, namespace), expected.signature);
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        await client.end();
    }
}

/**
 * Transactional, namespace-scoped migration with an audited Drizzle journal.
 * Existing Prisma databases are adopted only after full historical and physical verification.
 */
export async function migrateDatabase(
    options: MigrationOptions,
): Promise<{ migrated: boolean; current: true }> {
    const migrations = await readDatabaseMigrations();
    const expected = await baseline(migrations);
    // Audit files remain immutable even after the old runtime has been removed.
    await readLegacyMigrations();
    const { client, namespace } = await open(options);
    try {
        await client.query('BEGIN');
        await client.query("SET LOCAL lock_timeout = '30s'");
        await client.query(
            'SELECT pg_advisory_xact_lock(hashtext(current_database()),hashtext($1))',
            [`scova-db:${namespace}`],
        );
        await client.query(`CREATE SCHEMA IF NOT EXISTS ${quote(namespace)}`);
        let count = await ledger(client, namespace, migrations);
        let changed = false;
        const legacy = await verifyLegacy(client, namespace);
        if (count === null) {
            const actual = await catalogSignature(client, namespace);
            const empty = Object.values(actual).every((values) => values.length === 0);
            if (!empty) {
                if (!legacy) throw new Error('已有业务结构缺少可信迁移历史，拒绝自动接管');
                const legacySignature: SchemaSignature = JSON.parse(
                    await readFile(new URL('legacy-schema-baseline.json', root), 'utf8'),
                );
                assertCatalog(actual, legacySignature);
            } else if (legacy) {
                throw new Error('旧迁移记录与空数据库不一致，拒绝接管');
            }
            await client.query(`CREATE TABLE ${quote(namespace)}._scova_migrations (
                name text PRIMARY KEY,hash char(64) NOT NULL,applied_at timestamptz NOT NULL DEFAULT clock_timestamp())`);
            changed = true;
            count = 0;
            if (!empty) {
                // The baseline contains the eight already-applied legacy files. Never replay its DDL.
                const first = migrations[0]!;
                if (first.name !== '0000_database_baseline')
                    throw new Error('缺少受支持的初始迁移基线');
                await client.query(
                    `INSERT INTO ${quote(namespace)}._scova_migrations(name,hash) VALUES($1,$2)`,
                    [first.name, first.hash],
                );
                count = 1;
            }
        }
        for (const migration of migrations.slice(count)) {
            // The initial file preserves legacy unqualified SQL. Future migrations use the same namespace convention.
            await client.query(scopeMigrationSql(migration.sql, namespace));
            await client.query(
                `INSERT INTO ${quote(namespace)}._scova_migrations(name,hash) VALUES($1,$2)`,
                [migration.name, migration.hash],
            );
            changed = true;
        }
        assertCatalog(await catalogSignature(client, namespace), expected.signature);
        await client.query('COMMIT');
        return { migrated: changed, current: true };
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        await client.end();
    }
}

/**
 * Refresh a candidate baseline in a rolled-back random schema in an explicitly supplied test DB.
 * Callers must review the resulting diff before shipping migration files or the baseline together.
 */
export async function generateSchemaBaseline(options: MigrationOptions): Promise<SchemaBaseline> {
    const migrations = await readDatabaseMigrations();
    const { client } = await open(options);
    const namespace = `scova_reference_${randomUUID().replaceAll('-', '')}`;
    try {
        await client.query('BEGIN');
        await client.query("SET LOCAL lock_timeout = '30s'");
        await client.query(`CREATE SCHEMA ${quote(namespace)}`);
        await client.query("SELECT set_config('search_path',$1,true)", [namespace]);
        for (const migration of migrations)
            await client.query(scopeMigrationSql(migration.sql, namespace));
        return {
            version: 1,
            migrations: migrations.map(({ name, hash }) => ({ name, hash })),
            signature: await catalogSignature(client, namespace),
        };
    } finally {
        await client.query('ROLLBACK');
        await client.end();
    }
}
