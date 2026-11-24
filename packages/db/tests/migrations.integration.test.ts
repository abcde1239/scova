import { randomUUID, createHash } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import {
    and,
    closeDatabase,
    createDatabaseClient,
    eq,
    projectConversationTurns,
    projectResearchDrafts,
    projects,
    projectThreadItems,
    projectThreadRunOrigins,
    projectThreads,
    projectTasks,
    runs,
    sql,
    tasks,
    taskVersions,
    users,
} from '../src/index.ts';
import {
    migrateDatabase,
    readDatabaseMigrations,
    readLegacyMigrations,
    scopeMigrationSql,
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

async function applyMigrationsBefore(client: pg.Client, namespace: string, stopBefore: string) {
    await client.query(`CREATE TABLE _scova_migrations (
        name text PRIMARY KEY, hash char(64) NOT NULL, applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )`);
    for (const migration of await readDatabaseMigrations()) {
        if (migration.name === stopBefore) return;
        await client.query(scopeMigrationSql(migration.sql, namespace));
        await client.query('INSERT INTO _scova_migrations(name,hash) VALUES($1,$2)', [
            migration.name,
            migration.hash,
        ]);
    }
    throw new Error(`Migration ${stopBefore} was not found`);
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

    it('已有供应商升级后保留研究用途并初始化需求整理用途，重复迁移不覆盖新选择', async () => {
        const item = target();
        const client = new pg.Client({
            connectionString: baseUrl,
            options: `-c search_path=${item.namespace}`,
        });
        await admin.query(`CREATE SCHEMA "${item.namespace}"`);
        await client.connect();
        try {
            await client.query(
                'CREATE TABLE _scova_migrations (name text PRIMARY KEY, hash char(64) NOT NULL, applied_at timestamptz NOT NULL DEFAULT clock_timestamp())',
            );
            const migrations = await readDatabaseMigrations();
            const providerUseMigration = migrations.findIndex(
                (migration) => migration.name === '0002_sharp_trauma',
            );
            expect(providerUseMigration).toBeGreaterThan(0);
            for (const migration of migrations.slice(0, providerUseMigration)) {
                await client.query(scopeMigrationSql(migration.sql, item.namespace));
                await client.query('INSERT INTO _scova_migrations(name,hash) VALUES($1,$2)', [
                    migration.name,
                    migration.hash,
                ]);
            }
            const owner = randomUUID(),
                enabled = randomUUID(),
                spare = randomUUID();
            await client.query(
                'INSERT INTO users(id,email,normalized_email,password_hash) VALUES($1,$2,$2,$3)',
                [owner, owner + '@test.dev', 'fixture-hash'],
            );
            for (const [id, active] of [
                [enabled, true],
                [spare, false],
            ])
                await client.query(
                    'INSERT INTO agent_providers(id,user_id,name,base_url,model,encrypted_api_key,active) VALUES($1,$2,$3,$4,$5,$6,$7)',
                    [
                        id,
                        owner,
                        'fixture',
                        'https://api.example.test/v1',
                        'model',
                        'encrypted-fixture-unchanged',
                        active,
                    ],
                );
            await migrateDatabase(item);
            expect(
                (
                    await client.query(
                        'SELECT active,draft_active,encrypted_api_key FROM agent_providers WHERE id=$1',
                        [enabled],
                    )
                ).rows[0],
            ).toEqual({
                active: true,
                draft_active: true,
                encrypted_api_key: 'encrypted-fixture-unchanged',
            });
            expect(
                (
                    await client.query('SELECT draft_active FROM agent_providers WHERE id=$1', [
                        spare,
                    ])
                ).rows[0].draft_active,
            ).toBe(false);
            await client.query('UPDATE agent_providers SET draft_active=false WHERE id=$1', [
                enabled,
            ]);
            await client.query('UPDATE agent_providers SET draft_active=true WHERE id=$1', [spare]);
            await migrateDatabase(item);
            expect(
                (await client.query('SELECT id FROM agent_providers WHERE draft_active')).rows,
            ).toEqual([{ id: spare }]);
            await verifyDatabase(item);
        } finally {
            await client.end();
        }
    });
    it('升级报告导出格式时保留现有 Markdown 字节与版本占位', async () => {
        const item = target();
        await admin.query(`CREATE SCHEMA "${item.namespace}"`);
        const client = new pg.Client({
            connectionString: baseUrl,
            options: `-c search_path=${item.namespace}`,
        });
        await client.connect();
        try {
            await client.query(`CREATE TABLE _scova_migrations (
                name text PRIMARY KEY, hash char(64) NOT NULL,
                applied_at timestamptz NOT NULL DEFAULT clock_timestamp())`);
            const migrations = await readDatabaseMigrations();
            const formatMigration = migrations.findIndex(
                ({ name }) => name === '0011_report_export_formats',
            );
            expect(formatMigration).toBeGreaterThan(0);
            for (const migration of migrations.slice(0, formatMigration)) {
                await client.query(scopeMigrationSql(migration.sql, item.namespace));
                await client.query('INSERT INTO _scova_migrations(name,hash) VALUES($1,$2)', [
                    migration.name,
                    migration.hash,
                ]);
            }
            const [owner, task, version, run, report, exportId] = Array.from({ length: 6 }, () =>
                randomUUID(),
            );
            await client.query(
                'INSERT INTO users(id,email,normalized_email,password_hash) VALUES($1,$2,$2,$3)',
                [owner, 'markdown@test.dev', 'fixture'],
            );
            await client.query(
                "INSERT INTO tasks(id,user_id,title,updated_at) VALUES($1,$2,'fixture',now())",
                [task, owner],
            );
            await client.query(
                "INSERT INTO task_versions(id,user_id,task_id,version,config_json,comparison_scope_hash) VALUES($1,$2,$3,1,'{}',$4)",
                [version, owner, task, hash('scope')],
            );
            await client.query(
                "INSERT INTO runs(id,user_id,task_id,task_version_id,comparison_scope_hash,mode,trigger,status,budget_json,coverage_json,outcome) VALUES($1,$2,$3,$4,$5,'demo','manual','succeeded','{}',$6,'baseline')",
                [run, owner, task, version, hash('scope'), { completeness: 'complete', gaps: [] }],
            );
            await client.query(
                "INSERT INTO reports(id,user_id,run_id,task_id,task_version_id,title,summary,format,completeness) VALUES($1,$2,$3,$4,$5,'fixture','fixture','brief','complete')",
                [report, owner, run, task, version],
            );
            const markdown = '# 已保存的 Markdown\n';
            const insert = `INSERT INTO report_exports(id,user_id,report_id,renderer_version,markdown,byte_length,sha256,created_at,expires_at)
                VALUES($1,$2,$3,1,$4,$5,$6,now(),now()+interval '1 day')`;
            await client.query(insert, [
                exportId,
                owner,
                report,
                markdown,
                Buffer.byteLength(markdown),
                hash(markdown),
            ]);
            const before = (await client.query('SELECT * FROM report_exports')).rows[0];
            expect(await migrateDatabase(item)).toEqual({ migrated: true, current: true });
            expect((await client.query('SELECT * FROM report_exports')).rows).toEqual([
                { ...before, format: 'markdown' },
            ]);
            const content = '{}';
            const insertJson = `INSERT INTO report_exports(id,user_id,report_id,renderer_version,markdown,byte_length,sha256,created_at,expires_at,format)
                VALUES($1,$2,$3,1,$4,$5,$6,now(),now()+interval '1 day','json')`;
            const values = [
                randomUUID(),
                owner,
                report,
                content,
                Buffer.byteLength(content),
                hash(content),
            ];
            await client.query(insertJson, values);
            await expect(
                client.query(insertJson, [randomUUID(), ...values.slice(1)]),
            ).rejects.toMatchObject({ code: '23505' });
            await verifyDatabase(item);
        } finally {
            await client.end();
        }
    });

    it('从 0015 按稳定顺序回填默认会话、报告引用和草案，保留历史到期时间', async () => {
        const item = target();
        await admin.query(`CREATE SCHEMA "${item.namespace}"`);
        const client = new pg.Client({
            connectionString: baseUrl,
            options: `-c search_path=${item.namespace}`,
        });
        await client.connect();
        try {
            await applyMigrationsBefore(client, item.namespace, '0016_project_threads');
            const owner = randomUUID();
            const project = randomUUID();
            const emptyProject = randomUUID();
            const report = randomUUID();
            const draft = randomUUID();
            const first = '00000000-0000-4000-8000-000000000001';
            const second = '00000000-0000-4000-8000-000000000002';
            const third = '00000000-0000-4000-8000-000000000003';
            const tiedAt = '2026-10-02 00:00:00.123456+00';
            const laterAt = '2026-10-03 00:00:00.654321+00';
            const projectAt = '2026-10-01 00:00:00.123456+00';
            await client.query(
                `INSERT INTO users(id,email,normalized_email,password_hash)
                 VALUES($1,'threads@test.dev','threads@test.dev','test')`,
                [owner],
            );
            await client.query(
                `INSERT INTO projects(id,user_id,name,created_at)
                 VALUES($1,$3,'History',$4),($2,$3,'Empty',$4)`,
                [project, emptyProject, owner, projectAt],
            );
            await client.query(
                `INSERT INTO project_research_drafts(id,user_id,project_id,config) VALUES($1,$2,$3,'{}')`,
                [draft, owner, project],
            );
            await client.query(
                `INSERT INTO project_conversation_turns(id,user_id,project_id,input,status,answer,draft_id,created_at,expires_at)
                 VALUES($1,$4,$5,$6,'completed','draft answer',$9,$10,'2026-10-04T00:00:00Z'),
                       ($2,$4,$5,$7,'completed','report answer',NULL,$10,'2026-10-04T00:00:00Z'),
                       ($3,$4,$5,$8,'canceled',NULL,NULL,$11,'2026-10-05T00:00:00Z')`,
                [
                    second,
                    first,
                    third,
                    owner,
                    project,
                    { kind: 'draft', message: 'make draft' },
                    { kind: 'ask', message: 'ask report', reportId: report.toUpperCase() },
                    { kind: 'ask', message: 'cancel request' },
                    draft,
                    tiedAt,
                    laterAt,
                ],
            );
            const { rows: legacyTurns } = await client.query(
                'SELECT to_jsonb(t) AS data FROM project_conversation_turns AS t ORDER BY id',
            );

            expect(await migrateDatabase(item)).toEqual({ migrated: true, current: true });
            expect(await migrateDatabase(item)).toEqual({ migrated: false, current: true });
            await verifyDatabase(item);
            const { rows: defaults } = await client.query(
                `SELECT id,project_id,created_at=$3 AS starts_at_first,last_activity_at=$4 AS ends_at_last,
                        created_at=$5 AND last_activity_at=$5 AS starts_at_project
                 FROM project_threads WHERE user_id=$1 AND project_id=ANY($2::uuid[]) AND is_default`,
                [owner, [project, emptyProject], tiedAt, laterAt, projectAt],
            );
            expect(defaults).toHaveLength(2);
            const thread = defaults.find((row) => row.project_id === project)!;
            const emptyThread = defaults.find((row) => row.project_id === emptyProject)!;
            expect(thread).toMatchObject({ starts_at_first: true, ends_at_last: true });
            expect(emptyThread).toMatchObject({ starts_at_project: true });
            expect(
                (
                    await client.query(
                        `SELECT to_jsonb(t) - 'thread_id' - 'execution_deadline_at' AS data FROM project_conversation_turns AS t
                     WHERE thread_id=$1 ORDER BY id`,
                        [thread.id],
                    )
                ).rows,
            ).toEqual(legacyTurns);
            const { rows: timeline } = await client.query(
                `SELECT i.seq,i.kind,i.payload,i.refs,i.status,i.created_at=t.created_at AS keeps_timestamp
                 FROM project_thread_items AS i JOIN project_conversation_turns AS t ON t.id=i.turn_id
                 WHERE i.thread_id=$1 ORDER BY i.seq`,
                [thread.id],
            );
            expect(timeline).toEqual(
                [
                    {
                        seq: 1,
                        kind: 'message',
                        payload: { role: 'user', text: 'ask report' },
                        refs: [],
                    },
                    {
                        seq: 2,
                        kind: 'message',
                        payload: { role: 'assistant', text: 'report answer' },
                        refs: [{ kind: 'report', id: report }],
                    },
                    {
                        seq: 3,
                        kind: 'message',
                        payload: { role: 'user', text: 'make draft' },
                        refs: [],
                    },
                    {
                        seq: 4,
                        kind: 'message',
                        payload: { role: 'assistant', text: 'draft answer' },
                        refs: [],
                    },
                    { seq: 5, kind: 'plan', payload: { draftId: draft }, refs: [] },
                    {
                        seq: 6,
                        kind: 'message',
                        payload: { role: 'user', text: 'cancel request' },
                        refs: [],
                    },
                ].map((row) => ({ ...row, status: null, keeps_timestamp: true })),
            );
            expect(
                (
                    await client.query(
                        'SELECT count(*)::int AS count FROM project_thread_items WHERE thread_id=$1',
                        [emptyThread.id],
                    )
                ).rows[0],
            ).toEqual({ count: 0 });
            expect(
                (
                    await client.query(
                        'DELETE FROM project_conversation_turns WHERE id=$1 AND expires_at < $2',
                        [first, '2026-10-06T00:00:00Z'],
                    )
                ).rowCount,
            ).toBe(1);
            expect(
                (
                    await client.query(
                        'SELECT user_id,thread_id,turn_id FROM project_thread_items WHERE thread_id=$1 AND seq<=2 ORDER BY seq',
                        [thread.id],
                    )
                ).rows,
            ).toEqual(
                Array.from({ length: 2 }, () => ({
                    user_id: owner,
                    thread_id: thread.id,
                    turn_id: null,
                })),
            );
        } finally {
            await client.end();
        }
    });

    it('按账号、项目和会话约束写入，并发追加以行锁递增序号', async () => {
        const item = target();
        await migrateDatabase(item);
        const db = createDatabaseClient(item);
        try {
            const [owner, other] = await db
                .insert(users)
                .values([
                    {
                        email: 'owner@test.dev',
                        normalizedEmail: 'owner@test.dev',
                        passwordHash: 'test',
                    },
                    {
                        email: 'other@test.dev',
                        normalizedEmail: 'other@test.dev',
                        passwordHash: 'test',
                    },
                ])
                .returning();
            const [project, sibling] = await db
                .insert(projects)
                .values([
                    { userId: owner!.id, name: 'Project' },
                    { userId: owner!.id, name: 'Sibling project' },
                ])
                .returning();
            const threadInput = { userId: owner!.id, projectId: project!.id, title: 'Default' };
            const [thread, siblingThread] = await db
                .insert(projectThreads)
                .values([
                    { ...threadInput, isDefault: true, archivedAt: new Date() },
                    { ...threadInput, title: 'Sibling thread' },
                ])
                .returning();
            await expect(
                db.insert(projectThreads).values({ ...threadInput, isDefault: true }),
            ).rejects.toMatchObject({ cause: { code: '23505' } });
            await expect(
                db.insert(projectThreads).values({ ...threadInput, userId: other!.id }),
            ).rejects.toMatchObject({ cause: { code: '23503' } });

            const now = new Date();
            const turnInput = {
                userId: owner!.id,
                projectId: project!.id,
                input: { kind: 'ask', message: 'legacy' } as const,
                status: 'completed' as const,
                createdAt: now,
            };
            const [oldTurn, scopedTurn] = await db
                .insert(projectConversationTurns)
                .values([
                    { ...turnInput, id: randomUUID(), threadId: siblingThread!.id, expiresAt: now },
                    { ...turnInput, id: randomUUID(), threadId: thread!.id },
                ])
                .returning();
            expect(oldTurn).toMatchObject({ threadId: siblingThread!.id, expiresAt: now });
            expect(scopedTurn).toMatchObject({ threadId: thread!.id, expiresAt: null });
            await expect(
                db.insert(projectConversationTurns).values({
                    ...turnInput,
                    id: randomUUID(),
                    projectId: sibling!.id,
                    threadId: thread!.id,
                }),
            ).rejects.toMatchObject({ cause: { code: '23503' } });

            const appendInput = {
                userId: owner!.id,
                threadId: thread!.id,
                turnId: scopedTurn!.id,
                kind: 'message' as const,
                payload: { role: 'user', text: 'append' },
            };
            await expect(
                db
                    .insert(projectThreadItems)
                    .values({ ...appendInput, seq: 1, userId: other!.id, turnId: null }),
            ).rejects.toMatchObject({ cause: { code: '23503' } });
            await expect(
                db
                    .insert(projectThreadItems)
                    .values({ ...appendInput, seq: 1, threadId: siblingThread!.id }),
            ).rejects.toMatchObject({ cause: { code: '23503' } });
            await expect(
                db
                    .insert(projectThreadItems)
                    .values({ ...appendInput, seq: 1, turnId: oldTurn!.id }),
            ).rejects.toMatchObject({ cause: { code: '23503' } });

            await Promise.all(
                Array.from({ length: 8 }, () =>
                    db.transaction(async (tx) => {
                        await tx
                            .select({ id: projectThreads.id })
                            .from(projectThreads)
                            .where(
                                and(
                                    eq(projectThreads.userId, owner!.id),
                                    eq(projectThreads.id, thread!.id),
                                ),
                            )
                            .for('update');
                        const [next] = await tx
                            .select({
                                seq: sql<number>`coalesce(max(${projectThreadItems.seq}), 0) + 1`,
                            })
                            .from(projectThreadItems)
                            .where(eq(projectThreadItems.threadId, thread!.id));
                        await tx
                            .insert(projectThreadItems)
                            .values({ ...appendInput, seq: next!.seq });
                    }),
                ),
            );
            const timeline = await db
                .select({ seq: projectThreadItems.seq, refs: projectThreadItems.refs })
                .from(projectThreadItems)
                .where(eq(projectThreadItems.threadId, thread!.id))
                .orderBy(projectThreadItems.seq);
            expect(timeline).toEqual(
                Array.from({ length: 8 }, (_, index) => ({ seq: index + 1, refs: [] })),
            );
            await expect(
                db.insert(projectThreadItems).values({ ...appendInput, seq: 8 }),
            ).rejects.toMatchObject({ cause: { code: '23505' } });

            await db.delete(projects).where(eq(projects.id, project!.id));
            expect(await db.select().from(projectThreads)).toEqual([]);
            expect(await db.select().from(projectThreadItems)).toEqual([]);
            expect(await db.select().from(projectConversationTurns)).toEqual([]);
        } finally {
            await closeDatabase(db);
        }
    });

    it('从 0016 升级时回填草案与执行截止时间并保留既有会话条目', async () => {
        const item = target();
        await admin.query(`CREATE SCHEMA "${item.namespace}"`);
        const client = new pg.Client({
            connectionString: baseUrl,
            options: `-c search_path=${item.namespace}`,
        });
        await client.connect();
        try {
            await applyMigrationsBefore(client, item.namespace, '0017_project_thread_execution');
            const owner = randomUUID();
            const project = randomUUID();
            const draftOnlyProject = randomUUID();
            const thread = randomUUID();
            const siblingThread = randomUUID();
            const turn = randomUUID();
            const draft = randomUUID();
            const draftOnly = randomUUID();
            const timestamp = '2026-10-02 00:00:00.123456+00';
            const deadline = '2026-10-02 00:03:00.654321+00';
            await client.query(
                `INSERT INTO users(id,email,normalized_email,password_hash) VALUES($1,'turns@test.dev','turns@test.dev','test')`,
                [owner],
            );
            await client.query(
                `INSERT INTO projects(id,user_id,name,created_at) VALUES($1,$3,'Existing thread',$4),($2,$3,'Draft only',$4)`,
                [project, draftOnlyProject, owner, timestamp],
            );
            await client.query(
                `INSERT INTO project_threads(id,user_id,project_id,title,is_default)
                 VALUES($1,$3,$4,'Default thread',true),($2,$3,$4,'Sibling thread',false)`,
                [thread, siblingThread, owner, project],
            );
            await client.query(
                `INSERT INTO project_research_drafts(id,user_id,project_id,revision,config)
                 VALUES($1,$3,$4,7,'{}'),($2,$3,$5,2,'{}')`,
                [draft, draftOnly, owner, project, draftOnlyProject],
            );
            await client.query(
                `INSERT INTO project_conversation_turns(id,user_id,project_id,thread_id,input,status,created_at,expires_at)
                 VALUES($1,$2,$3,$4,'{"kind":"ask","message":"active"}','running',$5,$6)`,
                [turn, owner, project, siblingThread, timestamp, deadline],
            );
            await client.query(
                `INSERT INTO project_thread_items(id,user_id,thread_id,turn_id,seq,kind,payload,created_at)
                 VALUES($1,$2,$3,$4,1,'message','{"role":"user","text":"active"}',$5)`,
                [randomUUID(), owner, siblingThread, turn, timestamp],
            );

            expect(await migrateDatabase(item)).toEqual({ migrated: true, current: true });
            expect(await migrateDatabase(item)).toEqual({ migrated: false, current: true });
            const { rows: drafts } = await client.query(
                `SELECT d.id,d.revision,d.thread_id,t.is_default,t.created_at=p.created_at AS uses_project_time
                 FROM project_research_drafts d
                 JOIN project_threads t ON (t.user_id,t.project_id,t.id)=(d.user_id,d.project_id,d.thread_id)
                 JOIN projects p ON (p.user_id,p.id)=(d.user_id,d.project_id)`,
            );
            expect(drafts).toHaveLength(2);
            expect(drafts.find((row) => row.id === draft)).toMatchObject({
                revision: 7,
                thread_id: thread,
                is_default: true,
            });
            expect(drafts.find((row) => row.id === draftOnly)).toMatchObject({
                revision: 2,
                is_default: true,
                uses_project_time: true,
            });
            expect(
                (
                    await client.query(
                        `SELECT t.thread_id,t.status,t.expires_at=$2 AND t.execution_deadline_at=$2 AS keeps_deadline,
                                i.seq,i.created_at=$3 AS keeps_item_time
                         FROM project_conversation_turns t JOIN project_thread_items i ON i.turn_id=t.id WHERE t.id=$1`,
                        [turn, deadline, timestamp],
                    )
                ).rows,
            ).toEqual([
                {
                    thread_id: siblingThread,
                    status: 'running',
                    keeps_deadline: true,
                    seq: 1,
                    keeps_item_time: true,
                },
            ]);
        } finally {
            await client.end();
        }
    });

    it('按会话限制活动轮次，并在任务移出后保留 Run 来源', async () => {
        const item = target();
        await migrateDatabase(item);
        const db = createDatabaseClient(item);
        try {
            const [owner, other] = await db
                .insert(users)
                .values(
                    ['owner', 'other'].map((name) => ({
                        email: `${name}@test.dev`,
                        normalizedEmail: `${name}@test.dev`,
                        passwordHash: 'test',
                    })),
                )
                .returning();
            const [project, destination, otherProject] = await db
                .insert(projects)
                .values([
                    { userId: owner!.id, name: 'Origin' },
                    { userId: owner!.id, name: 'Destination' },
                    { userId: other!.id, name: 'Other account' },
                ])
                .returning();
            const scope = { userId: owner!.id, projectId: project!.id };
            const [thread, sibling, otherThread] = await db
                .insert(projectThreads)
                .values([
                    { ...scope, title: 'First thread' },
                    { ...scope, title: 'Sibling thread' },
                    {
                        userId: other!.id,
                        projectId: otherProject!.id,
                        title: 'Other account thread',
                    },
                ])
                .returning();
            const proposedDeadline = new Date();
            const turnInput = {
                ...scope,
                input: {
                    kind: 'auto',
                    message: 'research',
                    refs: [{ kind: 'report', id: randomUUID() }],
                } satisfies typeof projectConversationTurns.$inferInsert.input,
                status: 'running' as const,
                createdAt: proposedDeadline,
                executionDeadlineAt: proposedDeadline,
            };
            const attempts = await Promise.allSettled(
                [thread!.id, thread!.id, sibling!.id].map((threadId) =>
                    db
                        .insert(projectConversationTurns)
                        .values({ ...turnInput, id: randomUUID(), threadId })
                        .returning(),
                ),
            );
            const sameThread = attempts.slice(0, 2);
            expect(sameThread.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
            expect(sameThread.find((result) => result.status === 'rejected')).toMatchObject({
                reason: {
                    cause: { code: '23505', constraint: 'project_conversation_turns_running_key' },
                },
            });
            expect(attempts[2]).toMatchObject({
                status: 'fulfilled',
                value: [
                    {
                        threadId: sibling!.id,
                        executionDeadlineAt: proposedDeadline,
                        expiresAt: null,
                    },
                ],
            });
            await db
                .update(projectConversationTurns)
                .set({ status: 'canceled' })
                .where(eq(projectConversationTurns.threadId, thread!.id));
            await db
                .insert(projectConversationTurns)
                .values({ ...turnInput, id: randomUUID(), threadId: thread!.id });

            const draftInput = {
                ...scope,
                threadId: thread!.id,
                config: {} as typeof projectResearchDrafts.$inferInsert.config,
            };
            const [draft] = await db.insert(projectResearchDrafts).values(draftInput).returning();
            await expect(
                db
                    .insert(projectResearchDrafts)
                    .values({ ...draftInput, threadId: otherThread!.id }),
            ).rejects.toMatchObject({ cause: { code: '23503' } });
            await expect(
                db
                    .insert(projectResearchDrafts)
                    .values({ ...draftInput, projectId: destination!.id }),
            ).rejects.toMatchObject({ cause: { code: '23503' } });

            const [task] = await db
                .insert(tasks)
                .values({ userId: owner!.id, title: 'Research' })
                .returning();
            const membership = { ...scope, taskId: task!.id };
            await db.insert(projectTasks).values(membership);
            const comparisonScopeHash = 'a'.repeat(64);
            const [version] = await db
                .insert(taskVersions)
                .values({
                    userId: owner!.id,
                    taskId: task!.id,
                    version: 1,
                    configJson: {},
                    comparisonScopeHash,
                })
                .returning();
            const [run] = await db
                .insert(runs)
                .values({
                    userId: owner!.id,
                    taskId: task!.id,
                    taskVersionId: version!.id,
                    comparisonScopeHash,
                    mode: 'demo',
                    trigger: 'manual',
                    budgetJson: {},
                })
                .returning();
            const origin = {
                ...scope,
                threadId: thread!.id,
                runId: run!.id,
                draftId: draft!.id,
                draftRevision: draft!.revision,
            };
            await expect(
                db.insert(projectThreadRunOrigins).values({
                    ...origin,
                    userId: other!.id,
                    projectId: otherProject!.id,
                    threadId: otherThread!.id,
                }),
            ).rejects.toMatchObject({ cause: { code: '23503' } });
            await expect(
                db
                    .insert(projectThreadRunOrigins)
                    .values({ ...origin, projectId: destination!.id }),
            ).rejects.toMatchObject({ cause: { code: '23503' } });
            await db.insert(projectThreadRunOrigins).values(origin);
            await expect(
                db.insert(projectThreadRunOrigins).values({ ...origin, threadId: sibling!.id }),
            ).rejects.toMatchObject({ cause: { code: '23505' } });
            await db
                .update(projectTasks)
                .set({ projectId: destination!.id })
                .where(eq(projectTasks.taskId, task!.id));
            await db
                .update(projectThreads)
                .set({ archivedAt: new Date() })
                .where(eq(projectThreads.id, thread!.id));
            expect(await db.select().from(projectThreadRunOrigins)).toEqual([origin]);
            await db.delete(runs).where(eq(runs.id, run!.id));
            expect(await db.select().from(projectThreadRunOrigins)).toEqual([]);
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
                                `SELECT md5(coalesce(jsonb_agg(${tablename === 'users' ? "to_jsonb(t) - 'avatar_version'" : tablename === 'runs' ? "to_jsonb(t) - 'conversation_context_json' - 'search_configuration_hash'" : tablename === 'report_questions' ? "to_jsonb(t) - 'revision_run_id' - 'context_json'" : 'to_jsonb(t)'} ORDER BY to_jsonb(t)->>'id', to_jsonb(t)::text)::text,'[]')) AS hash,count(*)::int AS count FROM "${tablename}" t`,
                            )
                        ).rows[0],
                    });
                return result;
            };
            const before = await snapshotAll();
            expect(await migrateDatabase(item)).toEqual({ migrated: true, current: true });
            expect(await migrateDatabase(item)).toEqual({ migrated: false, current: true });
            const after = await snapshotAll();
            expect(
                after.filter((row) => before.some((previous) => previous.table === row.table)),
            ).toEqual(before);
            expect(
                (await client.query('SELECT avatar_version FROM users WHERE id=$1', [user])).rows[0]
                    .avatar_version,
            ).toBeNull();
            expect(
                (
                    await client.query('SELECT conversation_context_json FROM runs WHERE id=$1', [
                        run,
                    ])
                ).rows[0].conversation_context_json,
            ).toBeNull();
            expect(
                (
                    await client.query('SELECT search_configuration_hash FROM runs WHERE id=$1', [
                        run,
                    ])
                ).rows[0].search_configuration_hash,
            ).toBeNull();
            // Original column values remain identical; new optional fields start at NULL.
            expect(
                after.filter((row) => !before.some((previous) => previous.table === row.table)),
            ).toEqual(
                [
                    'agent_providers',
                    'project_conversation_turns',
                    'project_research_drafts',
                    'project_settings',
                    'project_tasks',
                    'project_thread_attachments',
                    'project_thread_items',
                    'project_thread_run_origins',
                    'project_threads',
                    'projects',
                    'report_exports',
                    'report_resources',
                    'run_graph_snapshots',
                    'search_configurations',
                    'workflow_notifications',
                    'workflow_runs',
                    'workflow_template_executions',
                    'workflow_templates',
                    'workflow_versions',
                    'workflows',
                ].map((table) => ({
                    table,
                    data: { count: 0, hash: createHash('md5').update('[]').digest('hex') },
                })),
            );
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
