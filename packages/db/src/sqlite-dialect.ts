import {
    aliasedTableColumn,
    and,
    Column,
    eq,
    getTableColumns,
    getTableName,
    getTableUniqueName,
    is,
    mapColumnsInAliasedSQLToAlias,
    mapColumnsInSQLToAlias,
    Param,
    SQL,
    sql,
} from 'drizzle-orm';
import { PgBoolean, PgDialect } from 'drizzle-orm/pg-core';
import { getOperators, getOrderByOperators, Many, normalizeRelation } from 'drizzle-orm/relations';

export class SqliteBusinessDialect extends PgDialect {
    constructor(private readonly defaults: ReadonlyMap<string, ReadonlyMap<string, string>>) {
        super();
    }

    override escapeParam() {
        return '?';
    }

    override buildInsertQuery(config: Parameters<PgDialect['buildInsertQuery']>[0]) {
        if (!Array.isArray(config.values)) return super.buildInsertQuery(config);
        const defaults = this.defaults.get(getTableName(config.table));
        const columns = Object.entries(getTableColumns(config.table));
        const values = config.values.map((row) => {
            const filled = { ...row };
            for (const [key, column] of columns) {
                const value = filled[key];
                if (value !== undefined && !(is(value, Param) && value.value === undefined))
                    continue;
                const fallback = defaults?.get(column.name);
                if (column.defaultFn) {
                    const generated = column.defaultFn();
                    filled[key] = is(generated, SQL) ? generated : sql.param(generated, column);
                } else if (fallback !== undefined) {
                    filled[key] = sql.raw(fallback);
                } else if (column.onUpdateFn && column.default === undefined) {
                    const generated = column.onUpdateFn();
                    filled[key] = is(generated, SQL) ? generated : sql.param(generated, column);
                } else {
                    filled[key] = sql`null`;
                }
            }
            return filled;
        });
        return super.buildInsertQuery({ ...config, values });
    }

    override buildSelectQuery(config: Parameters<PgDialect['buildSelectQuery']>[0]) {
        // All Scova row-lock queries are protected by the SQLite write transaction.
        return super.buildSelectQuery({
            ...config,
            lockingClause: undefined,
            limit: config.limit ?? (config.offset !== undefined ? -1 : undefined),
        });
    }

    override buildRelationalQueryWithoutPK(
        input: Parameters<PgDialect['buildRelationalQueryWithoutPK']>[0],
    ): ReturnType<PgDialect['buildRelationalQueryWithoutPK']> {
        const { fullSchema, schema, tableNamesMap, table, tableConfig, queryConfig, tableAlias } =
            input;
        type Selection = ReturnType<PgDialect['buildRelationalQueryWithoutPK']>['selection'];
        const config = queryConfig === true ? {} : queryConfig;
        const columns = Object.fromEntries(
            Object.entries(tableConfig.columns).map(([key, column]) => [
                key,
                aliasedTableColumn(column, tableAlias),
            ]),
        );
        const include = Object.values(config.columns ?? {}).includes(true);
        const selection: Selection = [];
        for (const [key, column] of Object.entries(columns)) {
            if (include ? config.columns?.[key] !== true : config.columns?.[key] === false)
                continue;
            selection.push({
                dbKey: column.name,
                tsKey: key,
                field: is(column, PgBoolean)
                    ? sql`${column}`.mapWith(Boolean)
                    : sql`${column}`.mapWith(column),
                isJson: false,
                relationTableTsKey: undefined,
                selection: [],
            });
        }
        const extras =
            typeof config.extras === 'function' ? config.extras(columns, { sql }) : config.extras;
        for (const [key, field] of Object.entries(extras ?? {})) {
            selection.push({
                dbKey: field.fieldAlias,
                tsKey: key,
                field: mapColumnsInAliasedSQLToAlias(field, tableAlias),
                isJson: false,
                relationTableTsKey: undefined,
                selection: [],
            });
        }
        for (const [key, nested] of Object.entries(config.with ?? {})) {
            if (!nested) continue;
            const relation = tableConfig.relations[key];
            const relatedKey = tableNamesMap[getTableUniqueName(relation.referencedTable)];
            const relatedTable = relation.referencedTable as typeof table;
            const relatedAlias = `${tableAlias}_${key}`;
            const { fields, references } = normalizeRelation(schema, tableNamesMap, relation);
            const joinOn = and(
                ...fields.map((field, index) =>
                    eq(
                        aliasedTableColumn(references[index], relatedAlias),
                        aliasedTableColumn(field, tableAlias),
                    ),
                ),
            );
            const related = this.buildRelationalQueryWithoutPK({
                fullSchema,
                schema,
                tableNamesMap,
                table: relatedTable,
                tableConfig: schema[relatedKey],
                tableAlias: relatedAlias,
                queryConfig: nested,
                nestedQueryRelation: relation,
                joinOn,
            });
            selection.push({
                dbKey: key,
                tsKey: key,
                field: sql`(${related.sql})`,
                isJson: true,
                relationTableTsKey: relatedKey,
                selection: related.selection,
            });
        }
        if (!selection.length) throw new Error(`No fields selected for ${tableAlias}`);
        const rawWhere =
            typeof config.where === 'function'
                ? config.where(columns, getOperators())
                : config.where;
        const where = and(input.joinOn, rawWhere && mapColumnsInSQLToAlias(rawWhere, tableAlias));
        const rawOrder =
            typeof config.orderBy === 'function'
                ? config.orderBy(columns, getOrderByOperators())
                : config.orderBy;
        const order = (
            rawOrder === undefined ? [] : Array.isArray(rawOrder) ? rawOrder : [rawOrder]
        ).map((field) =>
            is(field, Column)
                ? aliasedTableColumn(field, tableAlias)
                : mapColumnsInSQLToAlias(field, tableAlias),
        );
        const relation = input.nestedQueryRelation;
        const many = relation && is(relation, Many);
        const limit = relation && !many ? 1 : config.limit;
        const chosen = selection.map(({ field, isJson }) => {
            const expression = is(field, SQL.Aliased) ? field.sql : field;
            return relation && isJson ? sql`json(${expression})` : expression;
        });
        const values = sql.join(chosen, sql`, `);
        const projection = relation ? sql`json_array(${values}) AS "data"` : values;
        const rows = sql`select ${projection} from ${table} AS ${sql.identifier(tableAlias)}${where ? sql` where ${where}` : undefined}${order.length ? sql` order by ${sql.join(order, sql`, `)}` : undefined}${limit !== undefined || config.offset !== undefined ? sql` limit ${limit ?? -1}` : undefined}${config.offset !== undefined ? sql` offset ${config.offset}` : undefined}`;
        return {
            tableTsKey: tableConfig.tsName,
            selection,
            sql: many ? sql`select json_group_array(json("data")) from (${rows})` : rows,
        };
    }
}
