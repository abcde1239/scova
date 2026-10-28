import { randomUUID, createHash } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { closeDatabase, createDatabaseClient, eq, tasks, users } from '../src/index.ts';
import {
    migrateDatabase,
    readDatabaseMigrations,
    readLegacyMigrations,
    verifyDatabase,
} from '../src/migrate.ts';

const baseUrl =
    process.env.SCOVA_TEST_DATABASE_URL ??
    process.env.RUNTIME_DATABASE_URL ??
    'postgresql://scova_test:scova_test@127.0.0.1:55432/scova_test';
const admin = new pg.Client({ connectionString: baseUrl });
const namespaces = new Set<string>();
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

function target() {
    const namespace = `scova_upgrade_${randomUUID().replaceAll('-', '')}`;
    namespaces.add(namespace);
    const url = new URL(baseUrl);
    url.searchParams.set('schema', namespace);
    return { namespace, connectionString: url.toString() };
}

async function legacyTarget() {
    const item = target();
    await admin.query(`CREATE SCHEMA "${item.namespace}"`);
    const client = new pg.Client({
        connectionString: baseUrl,
        options: `-c search_path=${item.namespace}`,
    });
    await client.connect();
    try {
        await client.query('BEGIN');
        await client.query(`CREATE TABLE _prisma_migrations (
            id text PRIMARY KEY,checksum varchar(64) NOT NULL,finished_at timestamptz,
            migration_name varchar(255) NOT NULL,logs text,rolled_back_at timestamptz,
            started_at timestamptz NOT NULL DEFAULT now(),applied_steps_count integer NOT NULL DEFAULT 0)`);
        for (const migration of await readLegacyMigrations()) {
            await client.query(migration.sql);
            await client.query(
                'INSERT INTO _prisma_migrations(id,checksum,finished_at,migration_name,applied_steps_count) VALUES($1,$2,now(),$3,1)',
                [randomUUID(), migration.hash, migration.name],
            );
        }
        await client.query('COMMIT');
        return item;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        await client.end();
    }
}

async function nativeLedgerExists(namespace: string) {
    return (
        (await admin.query('SELECT to_regclass($1) AS value', [`"${namespace}"._scova_migrations`]))
            .rows[0].value !== null
    );
}

describe('Drizzle SQL 迁移与旧库无损接管', () => {
    beforeAll(async () => {
        await admin.connect();
    });
    afterAll(async () => {
        for (const namespace of namespaces) {
            if (!/^scova_upgrade_[0-9a-f]{32}$/.test(namespace))
                throw new Error('测试 schema 边界不合法');
            await admin.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
        }
        await admin.end();
    });

    it('空库初始化与重复执行安全，原生 Drizzle CRUD/事务回滚正常', async () => {
        const item = target();
        expect(await migrateDatabase(item)).toEqual({ migrated: true, current: true });
        expect(await migrateDatabase(item)).toEqual({ migrated: false, current: true });
        await verifyDatabase(item);
        const db = createDatabaseClient(item);
        try {
            const [user] = await db
                .insert(users)
                .values({
                    email: 'fresh@test.dev',
                    normalizedEmail: 'fresh@test.dev',
                    passwordHash: 'test',
                })
                .returning();
            expect(user!.id).toMatch(/^[a-f0-9-]{36}$/);
            expect(user!.defaultTimezone).toBe('UTC');
            const initial = new Date('2026-10-01T00:00:00Z');
            const [task] = await db
                .insert(tasks)
                .values({ userId: user!.id, title: 'original', updatedAt: initial })
                .returning();
            const [updated] = await db
                .update(tasks)
                .set({ title: 'changed' })
                .where(eq(tasks.id, task!.id))
                .returning();
            expect(updated!.updatedAt.getTime()).toBeGreaterThan(initial.getTime());
            await expect(
                db.transaction(async (tx) => {
                    await tx.insert(users).values({
                        email: 'rollback@test.dev',
                        normalizedEmail: 'rollback@test.dev',
                        passwordHash: 'test',
                    });
                    throw new Error('expected rollback');
                }),
            ).rejects.toThrow('expected rollback');
            expect(
                await db.query.users.findFirst({
                    where: eq(users.normalizedEmail, 'rollback@test.dev'),
                }),
            ).toBeUndefined();
            const rows = await admin.query(
                `SELECT name,hash FROM "${item.namespace}"._scova_migrations ORDER BY name`,
            );
            expect(rows.rows).toEqual(
                (await readDatabaseMigrations()).map(({ name, hash: checksum }) => ({
                    name,
                    hash: checksum,
                })),
            );
        } finally {
            await closeDatabase(db);
        }
    });

    it('只读 readiness 不创建 schema 或迁移账本', async () => {
        const item = target();
        await expect(verifyDatabase(item)).rejects.toThrow('待执行迁移');
        expect(
            (
                await admin.query(
                    'SELECT count(*)::int AS count FROM pg_namespace WHERE nspname=$1',
                    [item.namespace],
                )
            ).rows[0].count,
        ).toBe(0);
    });

    it('完整旧库接管保留有关联的业务数据、原迁移账本、JSON 和微秒时间', async () => {
        const item = await legacyTarget();
        const client = new pg.Client({
            connectionString: baseUrl,
            options: `-c search_path=${item.namespace}`,
        });
        await client.connect();
        try {
            const ids = Array.from({ length: 10 }, () => randomUUID());
            const [
                user,
                task,
                version,
                run,
                source,
                snapshot,
                observation,
                report,
                evidence,
                claim,
            ] = ids;
            await client.query(
                'INSERT INTO users(id,email,normalized_email,password_hash) VALUES($1,$2,$2,$3)',
                [user, 'legacy@test.dev', 'legacy-hash'],
            );
            await client.query(
                "INSERT INTO tasks(id,user_id,title,updated_at) VALUES($1,$2,'legacy','2026-10-01T00:00:00.123456Z')",
                [task, user],
            );
            await client.query(
                'INSERT INTO task_versions(id,user_id,task_id,version,config_json,comparison_scope_hash) VALUES($1,$2,$3,1,$4,$5)',
                [
                    version,
                    user,
                    task,
                    { topic: '保留原始 JSON', nested: [null, true, 3] },
                    hash('scope'),
                ],
            );
            await client.query('UPDATE tasks SET current_version_id=$1 WHERE id=$2', [
                version,
                task,
            ]);
            await client.query(
                "INSERT INTO runs(id,user_id,task_id,task_version_id,comparison_scope_hash,mode,trigger,status,budget_json,coverage_json,outcome) VALUES($1,$2,$3,$4,$5,'demo','manual','succeeded',$6,$7,'baseline')",
                [
                    run,
                    user,
                    task,
                    version,
                    hash('scope'),
                    {},
                    { completeness: 'complete', gaps: [] },
                ],
            );
            await client.query(
                'INSERT INTO sources(id,user_id,canonical_url,canonical_url_hash) VALUES($1,$2,$3,$4)',
                [source, user, 'https://example.test/legacy', hash('url')],
            );
            await client.query(
                'INSERT INTO source_snapshots(id,user_id,source_id,content_hash,extractor_version,title,text_body) VALUES($1,$2,$3,$4,$5,$6,$7)',
                [snapshot, user, source, hash('legacy body'), 'reader-v1', 'legacy', 'legacy body'],
            );
            await client.query(
                "INSERT INTO run_sources(id,user_id,run_id,source_id,snapshot_id,requested_url,fetch_status,observed_at) VALUES($1,$2,$3,$4,$5,$6,'succeeded','2026-10-01T00:00:00.654321Z')",
                [observation, user, run, source, snapshot, 'https://example.test/legacy'],
            );
            await client.query(
                "INSERT INTO reports(id,user_id,run_id,task_id,task_version_id,title,summary,format,completeness) VALUES($1,$2,$3,$4,$5,'old report','old summary','brief','complete')",
                [report, user, run, task, version],
            );
            await client.query(
                'INSERT INTO evidence(id,user_id,run_id,snapshot_id,quote,selector_json,quote_hash) VALUES($1,$2,$3,$4,$5,$6,$7)',
                [
                    evidence,
                    user,
                    run,
                    snapshot,
                    'legacy body',
                    { type: 'text_offset', start: 0, end: 11 },
                    hash('legacy body'),
                ],
            );
            await client.query(
                "INSERT INTO claims(id,user_id,task_id,report_id,kind,text,confidence_label,\"order\") VALUES($1,$2,$3,$4,'fact','legacy body','high',0)",
                [claim, user, task, report],
            );
            const snapshotAll = async () => {
                const tables = (
                    await client.query(
                        "SELECT tablename FROM pg_tables WHERE schemaname=current_schema() AND tablename<>'_scova_migrations' ORDER BY tablename",
                    )
                ).rows;
                const result = [];
                for (const { tablename } of tables as { tablename: string }[])
                    result.push({
                        table: tablename,
                        data: (
                            await client.query(
                                `SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY id)::text,'[]')) AS hash,count(*)::int AS count FROM "${tablename}" t`,
                            )
                        ).rows[0],
                    });
                return result;
            };
            const before = await snapshotAll();
            expect(await migrateDatabase(item)).toEqual({ migrated: true, current: true });
            expect(await migrateDatabase(item)).toEqual({ migrated: false, current: true });
            expect(await snapshotAll()).toEqual(before);
            expect(
                (
                    await client.query(
                        "SELECT to_char(updated_at AT TIME ZONE 'UTC','SS.US') AS time FROM tasks WHERE id=$1",
                        [task],
                    )
                ).rows[0].time,
            ).toBe('00.123456');
            await verifyDatabase(item);
        } finally {
            await client.end();
        }
    });

    it.each([
        ['CHECK 缺失', 'ALTER TABLE runs DROP CONSTRAINT run_json_shapes_valid'],
        ['部分索引缺失', 'DROP INDEX tasks_due_active'],
        ['全文索引缺失', 'DROP INDEX source_snapshots_library_fts'],
        ['外键触发器禁用', 'ALTER TABLE tasks DISABLE TRIGGER ALL'],
        ['列默认值漂移', "ALTER TABLE tasks ALTER COLUMN status SET DEFAULT 'paused'"],
    ])('拒绝接管%s，失败不登记新迁移账本', async (_name, statement) => {
        const item = await legacyTarget();
        const client = new pg.Client({
            connectionString: baseUrl,
            options: `-c search_path=${item.namespace}`,
        });
        await client.connect();
        try {
            await client.query(statement);
        } finally {
            await client.end();
        }
        await expect(migrateDatabase(item)).rejects.toThrow('数据库结构');
        expect(await nativeLedgerExists(item.namespace)).toBe(false);
    });

    it.each([
        ["UPDATE _prisma_migrations SET checksum=repeat('0',64)"],
        ['UPDATE _prisma_migrations SET finished_at=NULL'],
        ['UPDATE _prisma_migrations SET rolled_back_at=now()'],
        ["UPDATE _prisma_migrations SET migration_name='unknown_migration'"],
        [
            'DELETE FROM _prisma_migrations WHERE migration_name=(SELECT max(migration_name) FROM _prisma_migrations)',
        ],
    ])('拒绝不可信或不完整的旧迁移历史：%s', async (statement) => {
        const item = await legacyTarget();
        const client = new pg.Client({
            connectionString: baseUrl,
            options: `-c search_path=${item.namespace}`,
        });
        await client.connect();
        try {
            await client.query(statement);
        } finally {
            await client.end();
        }
        await expect(migrateDatabase(item)).rejects.toThrow('旧数据库迁移历史');
        expect(await nativeLedgerExists(item.namespace)).toBe(false);
    });

    it('并发初始化串行完成，只有一个调用应用迁移', async () => {
        const item = target();
        const results = await Promise.all([
            migrateDatabase(item),
            migrateDatabase(item),
            migrateDatabase(item),
        ]);
        expect(results.filter((result) => result.migrated)).toHaveLength(1);
        await verifyDatabase(item);
    });

    it('接管 Windows CRLF Prisma 校验和时保留历史记录，不强迫修改原 SQL', async () => {
        const item = await legacyTarget();
        for (const migration of await readLegacyMigrations())
            await admin.query(
                `UPDATE "${item.namespace}"._prisma_migrations SET checksum=$1 WHERE migration_name=$2`,
                [migration.windowsHash, migration.name],
            );
        expect(await migrateDatabase(item)).toEqual({ migrated: true, current: true });
        expect(await migrateDatabase(item)).toEqual({ migrated: false, current: true });
        await verifyDatabase(item);
    });

    it('已升级库的未知迁移条目与后续结构损坏均被拒绝', async () => {
        const item = target();
        await migrateDatabase(item);
        await admin.query(
            `INSERT INTO "${item.namespace}"._scova_migrations(name,hash) VALUES('9999_unknown',$1)`,
            [hash('unknown')],
        );
        await expect(migrateDatabase(item)).rejects.toThrow('迁移账本');
        await admin.query(
            `DELETE FROM "${item.namespace}"._scova_migrations WHERE name='9999_unknown'`,
        );
        await admin.query(`DROP INDEX "${item.namespace}".tasks_due_active`);
        await expect(verifyDatabase(item)).rejects.toThrow('数据库结构');
    });
});
