import type pg from 'pg';

export type SchemaSignature = Record<string, Record<string, unknown>[]>;

/** Compare physical invariants. Nullability is read from columns across PostgreSQL versions. */
export async function catalogSignature(
    client: pg.Client | pg.PoolClient,
    namespace: string,
): Promise<SchemaSignature> {
    const signature: SchemaSignature = {};
    const queries = {
        objects: `SELECT c.relname AS name,c.relkind AS kind,c.relpersistence AS persistence,
            c.relrowsecurity AS row_security,c.relforcerowsecurity AS force_row_security
            FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname=$1 AND c.relkind IN ('r','p','v','m','S','f')
              AND c.relname NOT IN ('_prisma_migrations','_scova_migrations') ORDER BY c.relname`,
        columns: `SELECT c.relname AS table_name,a.attname AS name,a.attnum AS position,
            format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull AS not_null,
            pg_get_expr(d.adbin,d.adrelid) AS default_value,a.attidentity AS identity,a.attgenerated AS generated,
            co.collname AS collation
            FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
            JOIN pg_namespace n ON n.oid=c.relnamespace
            LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
            LEFT JOIN pg_collation co ON co.oid=a.attcollation
            WHERE n.nspname=$1 AND c.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped
              AND c.relname NOT IN ('_prisma_migrations','_scova_migrations') ORDER BY c.relname,a.attnum`,
        enums: `SELECT t.typname AS name,e.enumlabel AS value,e.enumsortorder AS position
            FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace JOIN pg_enum e ON e.enumtypid=t.oid
            WHERE n.nspname=$1 ORDER BY t.typname,e.enumsortorder`,
        constraints: `SELECT c.relname AS table_name,co.conname AS name,co.contype AS type,
            pg_get_constraintdef(co.oid,true) AS definition,co.convalidated AS validated
            FROM pg_constraint co JOIN pg_class c ON c.oid=co.conrelid
            JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname=$1 AND co.contype <> 'n'
              AND c.relname NOT IN ('_prisma_migrations','_scova_migrations')
            ORDER BY c.relname,co.conname`,
        indexes: `SELECT t.relname AS table_name,c.relname AS name,pg_get_indexdef(i.indexrelid) AS definition,
            i.indisvalid AS valid,i.indisready AS ready
            FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid JOIN pg_class c ON c.oid=i.indexrelid
            JOIN pg_namespace n ON n.oid=t.relnamespace
            WHERE n.nspname=$1 AND t.relname NOT IN ('_prisma_migrations','_scova_migrations')
            ORDER BY t.relname,c.relname`,
        triggers: `SELECT c.relname AS table_name,t.tgname AS name,pg_get_triggerdef(t.oid,true) AS definition,
            t.tgenabled AS enabled FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
            JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname=$1 AND NOT t.tgisinternal
              AND c.relname NOT IN ('_prisma_migrations','_scova_migrations') ORDER BY c.relname,t.tgname`,
        foreign_key_triggers: `SELECT c.relname AS table_name,co.conname AS constraint_name,
            t.tgtype AS event,t.tgenabled AS enabled
            FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
            JOIN pg_namespace n ON n.oid=c.relnamespace
            JOIN pg_constraint co ON co.oid=t.tgconstraint
            WHERE n.nspname=$1 AND t.tgisinternal AND co.contype='f'
              AND c.relname NOT IN ('_prisma_migrations','_scova_migrations')
            ORDER BY c.relname,co.conname,t.tgtype,t.tgenabled`,
    };
    for (const [name, query] of Object.entries(queries)) {
        const result = await client.query(query, [namespace]);
        signature[name] = result.rows.map((row: Record<string, unknown>) =>
            Object.fromEntries(
                Object.entries(row).map(([key, value]) => [
                    key,
                    typeof value === 'string'
                        ? value.replaceAll(`"${namespace}".`, '').replaceAll(`${namespace}.`, '')
                        : value,
                ]),
            ),
        );
    }
    return signature;
}

export function assertCatalog(actual: SchemaSignature, expected: SchemaSignature): void {
    for (const kind of Object.keys(expected)) {
        if (JSON.stringify(actual[kind]) !== JSON.stringify(expected[kind]))
            throw new Error(
                `数据库结构与已审查迁移不一致（${kind}），拒绝登记或启动；请检查备份、迁移历史与实际约束`,
            );
    }
}
