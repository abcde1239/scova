import { sql, type SQLWrapper } from 'drizzle-orm';
import { isSqliteDatabase, queryRows, type DatabaseExecutor } from './client.ts';

export function databaseClock(db: DatabaseExecutor, mode: 'statement' | 'current' = 'current') {
    if (isSqliteDatabase(db)) return sql`(strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z')`;
    return mode === 'statement' ? sql`statement_timestamp()` : sql`clock_timestamp()`;
}

export async function readDatabaseClock(db: DatabaseExecutor): Promise<Date> {
    const [row] = await queryRows<{ now: Date | string }>(
        db,
        sql`SELECT ${databaseClock(db)} AS now`,
    );
    return typeof row.now === 'string' ? new Date(row.now) : row.now;
}

export function timestampCursor(db: DatabaseExecutor, column: SQLWrapper) {
    return isSqliteDatabase(db)
        ? sql<string>`${column}`
        : sql<string>`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

export function rowLock(
    db: DatabaseExecutor,
    strength: 'update' | 'no key update',
    skipLocked = false,
) {
    if (isSqliteDatabase(db)) return sql.empty();
    return sql`FOR ${sql.raw(strength)}${skipLocked ? sql` SKIP LOCKED` : undefined}`;
}
