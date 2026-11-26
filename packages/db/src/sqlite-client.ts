import { AsyncLocalStorage } from 'node:async_hooks';
import type { DatabaseSync, SQLInputValue, StatementSync } from 'node:sqlite';
import {
    createTableRelationsHelpers,
    extractTablesRelationalConfig,
    is,
    type ExtractTablesWithRelations,
    type QueryWithTypings,
} from 'drizzle-orm';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
    NodePgSession,
    NodePgTransaction,
    type NodePgClient,
} from 'drizzle-orm/node-postgres/session';
import { PgBoolean } from 'drizzle-orm/pg-core';
import type { SelectedFieldsOrdered } from 'drizzle-orm/pg-core/query-builders/select.types';
import type { PreparedQueryConfig, PgTransactionConfig } from 'drizzle-orm/pg-core/session';
import { type DatabaseClient, registerSqliteConnection } from './client.ts';
import * as schema from './schema.ts';
import { SqliteBusinessDialect } from './sqlite-dialect.ts';
import { openSqliteFile } from './sqlite-file.ts';
import { migrateSqliteDatabase } from './sqlite-migrate.ts';

type Statement = StatementSync & {
    columnNames?: string[];
    values?(...params: SQLInputValue[]): unknown[][];
    finalize?(): void;
};

function withStatement<T>(db: DatabaseSync, text: string, run: (statement: Statement) => T) {
    const statement: Statement = db.prepare(text);
    try {
        return run(statement);
    } finally {
        statement.finalize?.();
    }
}

function databaseValue(value: unknown, type?: string): SQLInputValue {
    if (value instanceof Date) return value.toISOString().replace(/\.(\d{3})Z$/, '.$1000Z');
    if (typeof value === 'string')
        return type === 'timestamp' ? value.replace(/\.(\d{3})Z$/, '.$1000Z') : value;
    if (typeof value === 'boolean') return Number(value);
    if (
        value === null ||
        typeof value === 'number' ||
        typeof value === 'bigint' ||
        ArrayBuffer.isView(value)
    )
        return value as SQLInputValue;
    throw new TypeError(`Unsupported SQLite parameter type: ${typeof value}`);
}

function output(value: unknown) {
    return value instanceof Uint8Array && !Buffer.isBuffer(value) ? Buffer.from(value) : value;
}

type Tables = ExtractTablesWithRelations<typeof schema>;

export function createSqliteDatabaseClient(path: string): DatabaseClient {
    const extracted = extractTablesRelationalConfig(schema, createTableRelationsHelpers);
    const relationalSchema = {
        ...extracted,
        fullSchema: schema,
        schema: extracted.tables as Tables,
    };
    migrateSqliteDatabase(path);
    const db = openSqliteFile(path);
    const context = new AsyncLocalStorage<{ active: boolean }>();
    // A synchronous writer cannot wait for a lock held by another async request in this process.
    let tail = Promise.resolve();
    function serialize<T>(operation: () => T | Promise<T>): Promise<T> {
        const transaction = context.getStore();
        if (transaction)
            return Promise.resolve().then(() => {
                if (!transaction.active) throw new Error('SQLite transaction has already ended');
                return operation();
            });
        const current = tail.then(operation);
        tail = current.then(
            () => undefined,
            () => undefined,
        );
        return current;
    }
    const defaults = new Map(
        Object.values(extracted.tables).map(({ dbName }) => [
            dbName,
            withStatement(
                db,
                'SELECT name, dflt_value FROM pragma_table_info(?) WHERE dflt_value IS NOT NULL',
                (statement) =>
                    new Map(
                        statement
                            .all(dbName)
                            .map(({ name, dflt_value }) => [String(name), String(dflt_value)]),
                    ),
            ),
        ]),
    );
    const dialect = new SqliteBusinessDialect(defaults);

    function connection(query: QueryWithTypings, booleans: ReadonlySet<number>) {
        // Drizzle's node-postgres row mapper consumes the two query modes below.
        return {
            query(config: { text: string; rowMode?: 'array' }, params: unknown[]) {
                return serialize(() =>
                    withStatement(db, config.text, (statement) => {
                        const bindings = params.map((value, index) =>
                            databaseValue(value, query.typings?.[index]),
                        );
                        if (config.rowMode === 'array') {
                            const rows = statement.values
                                ? statement.values(...bindings)
                                : (() => {
                                      statement.setReturnArrays(true);
                                      return statement.all(...bindings) as unknown as unknown[][];
                                  })();
                            return {
                                rows: rows.map((row) =>
                                    row.map((value, index) =>
                                        value !== null && booleans.has(index)
                                            ? Boolean(value)
                                            : output(value),
                                    ),
                                ),
                            };
                        }
                        // A non-returning statement needs run() to preserve affected-row counts.
                        const returnsRows =
                            (statement.columnNames ?? statement.columns()).length > 0;
                        if (!returnsRows)
                            return {
                                rows: [],
                                fields: [],
                                rowCount: Number(statement.run(...bindings).changes),
                            };
                        const rows = statement
                            .all(...bindings)
                            .map((row) =>
                                Object.fromEntries(
                                    Object.entries(row).map(([key, value]) => [key, output(value)]),
                                ),
                            );
                        return { rows, fields: [], rowCount: rows.length };
                    }),
                );
            },
        } as unknown as NodePgClient;
    }

    class SqliteSession extends NodePgSession<typeof schema, Tables> {
        constructor() {
            super(connection({ sql: '', params: [] }, new Set()), dialect, relationalSchema);
        }

        override prepareQuery<T extends PreparedQueryConfig = PreparedQueryConfig>(
            query: QueryWithTypings,
            fields: SelectedFieldsOrdered | undefined,
            name: string | undefined,
            arrayMode: boolean,
            mapper?: (rows: unknown[][]) => T['execute'],
        ) {
            const booleans = new Set(
                fields?.flatMap(({ field }, index) => (is(field, PgBoolean) ? [index] : [])),
            );
            return new NodePgSession(
                connection(query, booleans),
                dialect,
                relationalSchema,
            ).prepareQuery<T>(query, fields, name, arrayMode, mapper);
        }

        override transaction<T>(
            operation: (tx: NodePgTransaction<typeof schema, Tables>) => Promise<T>,
            config?: PgTransactionConfig,
        ) {
            if (context.getStore()?.active)
                throw new Error('Use the current SQLite transaction for nested work');
            return serialize(() => {
                const state = { active: true };
                return context.run(state, async () => {
                    const readOnly = config?.accessMode === 'read only';
                    if (readOnly) db.exec('PRAGMA query_only = ON');
                    let began = false;
                    try {
                        db.exec(readOnly ? 'BEGIN' : 'BEGIN IMMEDIATE');
                        began = true;
                        const result = await operation(
                            new NodePgTransaction(dialect, this, relationalSchema),
                        );
                        db.exec('COMMIT');
                        return result;
                    } catch (error) {
                        if (began) db.exec('ROLLBACK');
                        throw error;
                    } finally {
                        state.active = false;
                        if (readOnly) db.exec('PRAGMA query_only = OFF');
                    }
                });
            });
        }
    }

    const client = new NodePgDatabase<typeof schema>(
        dialect,
        new SqliteSession(),
        relationalSchema,
    );
    registerSqliteConnection(client, () => serialize(() => db.close()));
    return client;
}
