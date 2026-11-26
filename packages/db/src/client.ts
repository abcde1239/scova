import pg from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql, type SQL } from 'drizzle-orm';
import * as schema from './schema.ts';

export type DatabaseClient = NodePgDatabase<typeof schema>;
export type DatabaseTransaction = Parameters<Parameters<DatabaseClient['transaction']>[0]>[0];
export type DatabaseExecutor = DatabaseClient | DatabaseTransaction;

const sqliteConnections = new WeakMap<DatabaseClient, () => Promise<void>>();
const sqliteSessions = new WeakSet<DatabaseExecutor['_']['session']>();

export function registerSqliteConnection(database: DatabaseClient, close: () => Promise<void>) {
    sqliteConnections.set(database, close);
    sqliteSessions.add(database._.session);
}

export function isSqliteDatabase(database: DatabaseExecutor): boolean {
    return sqliteSessions.has(database._.session);
}

export interface DatabaseOptions {
    connectionString?: string;
    max?: number;
    applicationName?: string;
    onIdleError?: (error: Error) => void;
}

/** URL schema is a Scova convention, not a pg driver parameter. Never silently use public. */
export function databaseConnection(options: DatabaseOptions = {}) {
    const connectionString = options.connectionString ?? process.env.DATABASE_URL;
    if (!connectionString) throw new Error('缺少 DATABASE_URL');
    const url = new URL(connectionString);
    if (!['postgres:', 'postgresql:'].includes(url.protocol))
        throw new Error('数据库必须使用 PostgreSQL URL');
    const namespace = url.searchParams.get('schema') ?? 'public';
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(namespace)) throw new Error('非法数据库 schema');
    url.searchParams.delete('schema');
    const max = options.max ?? 5;
    if (!Number.isSafeInteger(max) || max < 1 || max > 100)
        throw new Error('数据库连接池 max 必须为 1–100');
    // URL options take precedence over constructor options in node-postgres, so set one source.
    const existing = url.searchParams.get('options') ?? '';
    if (/search_path/i.test(existing)) throw new Error('请通过 schema URL 参数指定 search_path');
    const searchPath = namespace === namespace.toLowerCase() ? namespace : `"${namespace}"`;
    url.searchParams.set('options', `${existing} -c search_path=${searchPath}`.trim());
    if (options.applicationName) url.searchParams.set('application_name', options.applicationName);
    return { connectionString: url.toString(), schema: namespace, max };
}

/** Construction is offline. The application owns the native pool and its shutdown. */
export function createDatabaseClient(options: DatabaseOptions = {}) {
    const config = databaseConnection(options);
    const pool = new pg.Pool({
        connectionString: config.connectionString,
        max: config.max,
        connectionTimeoutMillis: 5000,
    });
    pool.on(
        'error',
        options.onIdleError ??
            ((error: Error) => {
                // The pool removes broken idle clients; keep the application alive and expose the failure.
                // Never print driver messages/URLs, which can contain deployment connection information.
                console.error('[scova-db] 空闲数据库连接异常，连接池已移除该连接', {
                    name: error.name,
                });
            }),
    );
    return drizzle(pool, { schema });
}

export async function connectDatabase(database: DatabaseClient): Promise<void> {
    await database.execute(sql`SELECT 1`);
}

export async function closeDatabase(database: DatabaseClient): Promise<void> {
    const sqliteClose = sqliteConnections.get(database);
    if (sqliteClose) await sqliteClose();
    else await (database as DatabaseClient & { $client: pg.Pool }).$client.end();
}

/** Parameterized SQL escape hatch; row shape must be declared at the repository boundary. */
export async function queryRows<T>(database: DatabaseExecutor, query: SQL): Promise<T[]> {
    const result = await database.execute(query);
    // Drizzle deliberately leaves raw timestamp fields as strings. The repository raw-SQL
    // boundary returns Date for timestamp OIDs, while to_char/text cursor fields stay exact.
    const timestamps = result.fields.filter(
        (field) => field.dataTypeID === 1114 || field.dataTypeID === 1184,
    );
    return result.rows.map((row) => {
        const mapped = { ...row };
        for (const field of timestamps) {
            const value = mapped[field.name];
            if (typeof value === 'string')
                mapped[field.name] = new Date(field.dataTypeID === 1114 ? `${value}Z` : value);
        }
        return mapped;
    }) as T[];
}

export function isUniqueConflict(error: unknown): boolean {
    const seen = new Set<unknown>();
    while (error && typeof error === 'object' && !seen.has(error)) {
        seen.add(error);
        if (
            'code' in error &&
            (error.code === '23505' ||
                error.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
                error.code === 'SQLITE_CONSTRAINT_PRIMARYKEY')
        )
            return true;
        if ('errcode' in error && (error.errcode === 2067 || error.errcode === 1555)) return true;
        error = 'cause' in error ? error.cause : undefined;
    }
    return false;
}
