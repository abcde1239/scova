import { migrateDatabase, readDatabaseMigrations } from '@scova/db/migrate';
import { createDatabaseClient, connectDatabase, closeDatabase, and, eq, count } from '@scova/db';
import * as tables from '@scova/db';
import { createHash, randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { firstRow, requireRow } from '../src/utils/database.ts';

const baseUrl =
    process.env.SCOVA_TEST_DATABASE_URL ??
    process.env.RUNTIME_DATABASE_URL ??
    'postgresql://scova_test:scova_test@127.0.0.1:55432/scova_test';
const schema = `scova_db_${randomUUID().replaceAll('-', '')}`;
const scopedUrl = new URL(baseUrl);
scopedUrl.searchParams.set('schema', schema);
const db = createDatabaseClient({ connectionString: scopedUrl.toString() });
const admin = new pg.Client({ connectionString: baseUrl });
const sql = new pg.Pool({ connectionString: baseUrl, options: `-c search_path=${schema}`, max: 4 });
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
let schemaCreated = false;
let migrationSecondOutput: Awaited<ReturnType<typeof migrateDatabase>>;
const budget = {
    maxSearches: 10,
    maxPages: 20,
    maxDurationSeconds: 300,
    maxInputTokens: 40000,
    maxOutputTokens: 8000,
};

async function fixture() {
    const suffix = randomUUID();
    const user = await db
        .insert(tables.users)
        .values({
            email: `${suffix}@example.test`,
            normalizedEmail: `${suffix}@example.test`,
            passwordHash: 'argon2id-test-placeholder',
        })
        .returning()
        .then(firstRow);
    const task = await db
        .insert(tables.tasks)
        .values({ userId: user.id, title: '数据库约束测试' })
        .returning()
        .then(firstRow);
    const version = await db
        .insert(tables.taskVersions)
        .values({
            userId: user.id,
            taskId: task.id,
            version: 1,
            configJson: { topic: 'test' },
            comparisonScopeHash: hash('scope'),
        })
        .returning()
        .then(firstRow);
    await db
        .update(tables.tasks)
        .set({ currentVersionId: version.id })
        .where(and(eq(tables.tasks.id, task.id)))
        .returning()
        .then(firstRow);
    const run = await db
        .insert(tables.runs)
        .values({
            userId: user.id,
            taskId: task.id,
            taskVersionId: version.id,
            comparisonScopeHash: hash('scope-live'),
            mode: 'live',
            trigger: 'manual',
            status: 'succeeded',
            budgetJson: budget,
            coverageJson: { completeness: 'complete', gaps: [] },
            outcome: 'baseline',
            startedAt: new Date(),
            finishedAt: new Date(),
        })
        .returning()
        .then(firstRow);
    const source = await db
        .insert(tables.sources)
        .values({
            userId: user.id,
            canonicalUrl: `https://example.test/${suffix}`,
            canonicalUrlHash: hash(suffix),
        })
        .returning()
        .then(firstRow);
    const snapshot = await db
        .insert(tables.sourceSnapshots)
        .values({
            userId: user.id,
            sourceId: source.id,
            contentHash: hash('content'),
            extractorVersion: 'readability-v1',
            title: '原始资料',
            textBody: '原文内容',
        })
        .returning()
        .then(firstRow);
    const observation = await db
        .insert(tables.runSources)
        .values({
            userId: user.id,
            runId: run.id,
            sourceId: source.id,
            snapshotId: snapshot.id,
            requestedUrl: source.canonicalUrl,
            fetchedUrl: source.canonicalUrl,
            fetchStatus: 'succeeded',
        })
        .returning()
        .then(firstRow);
    const evidence = await db
        .insert(tables.evidence)
        .values({
            userId: user.id,
            runId: run.id,
            snapshotId: snapshot.id,
            quote: '原文内容',
            selectorJson: { paragraph: 1 },
            quoteHash: hash('原文内容'),
        })
        .returning()
        .then(firstRow);
    const report = await db
        .insert(tables.reports)
        .values({
            userId: user.id,
            runId: run.id,
            taskId: task.id,
            taskVersionId: version.id,
            title: '报告',
            summary: '概要',
            format: 'brief',
            completeness: 'complete',
        })
        .returning()
        .then(firstRow);
    const claim = await db
        .insert(tables.claims)
        .values({
            userId: user.id,
            taskId: task.id,
            reportId: report.id,
            kind: 'fact',
            text: '来源事实',
            confidenceLabel: '原文',
            order: 0,
        })
        .returning()
        .then(firstRow);
    await db
        .insert(tables.claimEvidence)
        .values({
            userId: user.id,
            claimId: claim.id,
            evidenceId: evidence.id,
            relation: 'supports',
        })
        .returning()
        .then(firstRow);
    return { user, task, version, run, source, snapshot, observation, evidence, report, claim };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
let first: Fixture;
let second: Fixture;

function activeRun(owner: Fixture) {
    return db
        .insert(tables.runs)
        .values({
            userId: owner.user.id,
            taskId: owner.task.id,
            taskVersionId: owner.version.id,
            comparisonScopeHash: hash('scope-live'),
            mode: 'live',
            trigger: 'manual',
            budgetJson: budget,
        })
        .returning()
        .then(firstRow);
}
function rejected(query: string, values: unknown[], code: string) {
    return expect(sql.query(query, values)).rejects.toMatchObject({ code });
}

describe('真实 PostgreSQL 业务模型与一致性约束', () => {
    beforeAll(async () => {
        await admin.connect();
        await admin.query(`CREATE SCHEMA "${schema}"`);
        schemaCreated = true;
        await migrateDatabase({ connectionString: scopedUrl.toString() });
        migrationSecondOutput = await migrateDatabase({ connectionString: scopedUrl.toString() });
        await connectDatabase(db);
    }, 120000);

    beforeEach(async () => {
        first = await fixture();
        second = await fixture();
    });

    afterAll(async () => {
        await closeDatabase(db);
        await sql.end();
        // 只清理本次随机生成、已校验命名边界的测试 schema，绝不 reset 用户库。
        if (schemaCreated && /^scova_db_[0-9a-f]{32}$/.test(schema))
            await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.end();
    });

    it('空 schema 部署迁移成功，再次 deploy 没有重复变更', async () => {
        expect(migrationSecondOutput).toEqual({ migrated: false, current: true });
        const result = await sql.query('SELECT name, hash, applied_at FROM _scova_migrations');
        const migrations = await readDatabaseMigrations();
        expect(
            result.rows
                .map((row) => row.name)
                .sort((left: string, right: string) => left.localeCompare(right)),
        ).toEqual(migrations.map((row) => row.name).sort());
        for (const row of result.rows) {
            expect(row.applied_at).toBeInstanceOf(Date);
            expect(row.hash).toBe(
                migrations.find((migration) => migration.name === row.name)!.hash,
            );
        }
        const task = await db.query.tasks
            .findFirst({
                where: and(eq(tables.tasks.id, first.task.id)),
                with: { currentVersion: true },
            })
            .then(requireRow);
        expect(task.currentVersion?.id).toBe(first.version.id);
    });

    it('拒绝跨账号和同账号跨任务配置版本引用', async () => {
        await rejected(
            'UPDATE runs SET task_version_id = $1 WHERE id = $2',
            [second.version.id, first.run.id],
            '23503',
        );
        await rejected(
            'UPDATE tasks SET current_version_id = $1 WHERE id = $2',
            [second.version.id, first.task.id],
            '23503',
        );
        const otherTask = await db
            .insert(tables.tasks)
            .values({ userId: first.user.id, title: '另一个任务' })
            .returning()
            .then(firstRow);
        const otherVersion = await db
            .insert(tables.taskVersions)
            .values({
                userId: first.user.id,
                taskId: otherTask.id,
                version: 1,
                configJson: {},
                comparisonScopeHash: hash('other'),
            })
            .returning()
            .then(firstRow);
        await rejected(
            'UPDATE runs SET task_version_id = $1 WHERE id = $2',
            [otherVersion.id, first.run.id],
            '23503',
        );
        await rejected(
            'UPDATE tasks SET current_version_id = $1 WHERE id = $2',
            [otherVersion.id, first.task.id],
            '23503',
        );
    });

    it('数据库互斥使同任务并发触发只能保存一个活动 Run', async () => {
        const attempts = await Promise.allSettled([activeRun(first), activeRun(first)]);
        expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
        const failure = attempts.find(
            (attempt) => attempt.status === 'rejected',
        ) as PromiseRejectedResult;
        expect(failure.reason).toMatchObject({ cause: { code: '23505' } });
        expect(
            await db
                .select({ count: count() })
                .from(tables.runs)
                .where(and(eq(tables.runs.taskId, first.task.id), eq(tables.runs.status, 'queued')))
                .then(([row]) => row!.count),
        ).toBe(1);
    });

    it('不同任务可以同时活动，恢复和等待取消也占用活动名额', async () => {
        const [left, right] = await Promise.all([activeRun(first), activeRun(second)]);
        expect(left.taskId).not.toBe(right.taskId);
        for (const status of ['running', 'recovering', 'cancel_requested']) {
            await sql.query('UPDATE runs SET status = $1 WHERE id = $2', [status, left.id]);
            await expect(activeRun(first)).rejects.toMatchObject({ cause: { code: '23505' } });
        }
        await db
            .update(tables.runs)
            .set({ status: 'canceled' })
            .where(and(eq(tables.runs.id, left.id)))
            .returning()
            .then(firstRow);
        await expect(activeRun(first)).resolves.toMatchObject({ taskId: first.task.id });
    });

    it('来源、快照和观测必须绑定同账号同来源，证据须来自本执行观测', async () => {
        await rejected(
            'UPDATE run_sources SET source_id = $1 WHERE id = $2',
            [second.source.id, first.observation.id],
            '23503',
        );
        await rejected(
            'UPDATE run_sources SET snapshot_id = $1 WHERE id = $2',
            [second.snapshot.id, first.observation.id],
            '23503',
        );
        const anotherSource = await db
            .insert(tables.sources)
            .values({
                userId: first.user.id,
                canonicalUrl: 'https://example.test/another',
                canonicalUrlHash: hash(randomUUID()),
            })
            .returning()
            .then(firstRow);
        const anotherSnapshot = await db
            .insert(tables.sourceSnapshots)
            .values({
                userId: first.user.id,
                sourceId: anotherSource.id,
                extractorVersion: 'readability-v1',
                contentHash: hash('other source'),
                title: '其他来源',
            })
            .returning()
            .then(firstRow);
        await rejected(
            'UPDATE run_sources SET snapshot_id = $1 WHERE id = $2',
            [anotherSnapshot.id, first.observation.id],
            '23503',
        );
        const unobserved = await db
            .insert(tables.sourceSnapshots)
            .values({
                userId: first.user.id,
                sourceId: first.source.id,
                extractorVersion: 'readability-v1',
                contentHash: hash('unobserved'),
                title: '未读版本',
            })
            .returning()
            .then(firstRow);
        await rejected(
            'UPDATE evidence SET snapshot_id = $1 WHERE id = $2',
            [unobserved.id, first.evidence.id],
            '23503',
        );
        await rejected(
            'UPDATE evidence SET run_id = $1 WHERE id = $2',
            [second.run.id, first.evidence.id],
            '23503',
        );
    });

    it('结论与引用复合外键独立阻止其他账号证据或结论', async () => {
        const citation = await db.query.claimEvidence
            .findFirst({ where: and(eq(tables.claimEvidence.claimId, first.claim.id)) })
            .then(requireRow);
        await rejected(
            'UPDATE claim_evidence SET evidence_id = $1 WHERE id = $2',
            [second.evidence.id, citation.id],
            '23503',
        );
        await rejected(
            'UPDATE claim_evidence SET claim_id = $1 WHERE id = $2',
            [second.claim.id, citation.id],
            '23503',
        );
        await rejected(
            'UPDATE claims SET report_id = $1, "order" = 9 WHERE id = $2',
            [second.report.id, first.claim.id],
            '23503',
        );
    });

    it('报告必须与 Run 的任务及配置版本一致，同执行不能重复交付', async () => {
        await rejected(
            'UPDATE reports SET run_id = $1 WHERE id = $2',
            [second.run.id, first.report.id],
            '23503',
        );
        await rejected(
            'UPDATE reports SET task_version_id = $1 WHERE id = $2',
            [second.version.id, first.report.id],
            '23503',
        );
        await rejected(
            "INSERT INTO reports (id,user_id,run_id,task_id,task_version_id,title,summary,format,completeness) VALUES ($1,$2,$3,$4,$5,'重复','重复','brief','complete')",
            [randomUUID(), first.user.id, first.run.id, first.task.id, first.version.id],
            '23505',
        );
    });

    it('收件箱和每执行每种提醒均唯一，提醒不能关联别的 Run 报告', async () => {
        await db
            .insert(tables.inboxItems)
            .values({ userId: first.user.id, reportId: first.report.id })
            .returning()
            .then(firstRow);
        await rejected(
            'INSERT INTO inbox_items (id,user_id,report_id) VALUES ($1,$2,$3)',
            [randomUUID(), first.user.id, first.report.id],
            '23505',
        );
        const notice = await db
            .insert(tables.notifications)
            .values({
                userId: first.user.id,
                runId: first.run.id,
                reportId: first.report.id,
                kind: 'summary',
            })
            .returning()
            .then(firstRow);
        await rejected(
            "INSERT INTO notifications (id,user_id,run_id,report_id,kind) VALUES ($1,$2,$3,$4,'summary')",
            [randomUUID(), first.user.id, first.run.id, first.report.id],
            '23505',
        );
        await rejected(
            'UPDATE notifications SET report_id = $1 WHERE id = $2',
            [second.report.id, notice.id],
            '23503',
        );
        await rejected(
            "INSERT INTO notifications (id,user_id,run_id,kind) VALUES ($1,$2,$3,'important_change')",
            [randomUUID(), first.user.id, first.run.id],
            '23514',
        );
    });

    it('持久化事件序号唯一且为正、版本固定，不允许保存 reset 控制帧', async () => {
        const event = await db
            .insert(tables.runEvents)
            .values({
                userId: first.user.id,
                runId: first.run.id,
                seq: 1,
                type: 'run.started',
                payload: { status: 'running' },
            })
            .returning()
            .then(firstRow);
        await rejected(
            "INSERT INTO run_events (id,user_id,run_id,seq,type,payload) VALUES ($1,$2,$3,1,'run.started','{}')",
            [randomUUID(), first.user.id, first.run.id],
            '23505',
        );
        for (const [column, value] of [
            ['seq', 0],
            ['schema_version', 2],
            ['type', 'stream.reset'],
        ] as const)
            await rejected(
                `UPDATE run_events SET ${column} = $1 WHERE id = $2`,
                [value, event.id],
                '23514',
            );
        await rejected(
            'UPDATE run_events SET run_id = $1 WHERE id = $2',
            [second.run.id, event.id],
            '23503',
        );
    });

    it('基线引用绑定同账号、同任务和有效比较范围', async () => {
        await db
            .insert(tables.baselines)
            .values({
                userId: first.user.id,
                taskId: first.task.id,
                comparisonScopeHash: first.run.comparisonScopeHash,
                completeRunId: first.run.id,
            })
            .returning()
            .then(firstRow);
        await rejected(
            'INSERT INTO baselines (id,user_id,task_id,comparison_scope_hash,complete_run_id,updated_at) VALUES ($1,$2,$3,$4,$5,now())',
            [randomUUID(), first.user.id, first.task.id, hash('different-mode'), first.run.id],
            '23503',
        );
        await rejected(
            'UPDATE runs SET baseline_run_id = $1 WHERE id = $2',
            [second.run.id, first.run.id],
            '23503',
        );
    });

    it('反馈必须恰有一个目标，目标唯一且 claim 绑定同任务', async () => {
        await rejected(
            "INSERT INTO feedback (id,user_id,task_id,kind,updated_at) VALUES ($1,$2,$3,'known',now())",
            [randomUUID(), first.user.id, first.task.id],
            '23514',
        );
        await rejected(
            "INSERT INTO feedback (id,user_id,task_id,source_id,claim_id,kind,updated_at) VALUES ($1,$2,$3,$4,$5,'known',now())",
            [randomUUID(), first.user.id, first.task.id, first.source.id, first.claim.id],
            '23514',
        );
        const feedback = await db
            .insert(tables.feedback)
            .values({
                userId: first.user.id,
                taskId: first.task.id,
                sourceId: first.source.id,
                kind: 'known',
            })
            .returning()
            .then(firstRow);
        await expect(
            db
                .insert(tables.feedback)
                .values({
                    userId: first.user.id,
                    taskId: first.task.id,
                    sourceId: first.source.id,
                    kind: 'deeper',
                })
                .returning()
                .then(firstRow),
        ).rejects.toMatchObject({ cause: { code: '23505' } });
        await expect(
            db
                .update(tables.feedback)
                .set({ kind: 'deeper', active: false })
                .where(and(eq(tables.feedback.id, feedback.id)))
                .returning()
                .then(firstRow),
        ).resolves.toMatchObject({ active: false });
        await rejected(
            'UPDATE feedback SET source_id = $1 WHERE id = $2',
            [second.source.id, feedback.id],
            '23503',
        );
        const anotherTask = await db
            .insert(tables.tasks)
            .values({ userId: first.user.id, title: '其他任务' })
            .returning()
            .then(firstRow);
        await expect(
            db
                .insert(tables.feedback)
                .values({
                    userId: first.user.id,
                    taskId: anotherTask.id,
                    claimId: first.claim.id,
                    kind: 'known',
                })
                .returning()
                .then(firstRow),
        ).rejects.toMatchObject({ cause: { code: '23503' } });
    });

    it('笔记恰有一种所属资源且支持正修订，收藏拒绝跨账号和重复', async () => {
        await rejected(
            "INSERT INTO notes (id,user_id,body,updated_at) VALUES ($1,$2,'内容',now())",
            [randomUUID(), first.user.id],
            '23514',
        );
        await rejected(
            "INSERT INTO notes (id,user_id,source_id,report_id,body,updated_at) VALUES ($1,$2,$3,$4,'内容',now())",
            [randomUUID(), first.user.id, first.source.id, first.report.id],
            '23514',
        );
        const note = await db
            .insert(tables.notes)
            .values({ userId: first.user.id, sourceId: first.source.id, body: '内容' })
            .returning()
            .then(firstRow);
        await rejected('UPDATE notes SET revision = 0 WHERE id = $1', [note.id], '23514');
        await rejected(
            'UPDATE notes SET source_id = $1 WHERE id = $2',
            [second.source.id, note.id],
            '23503',
        );
        await db
            .insert(tables.bookmarks)
            .values({ userId: first.user.id, sourceId: first.source.id })
            .returning()
            .then(firstRow);
        await expect(
            db
                .insert(tables.bookmarks)
                .values({ userId: first.user.id, sourceId: first.source.id })
                .returning()
                .then(firstRow),
        ).rejects.toMatchObject({ cause: { code: '23505' } });
        await expect(
            db
                .insert(tables.bookmarks)
                .values({ userId: first.user.id, sourceId: second.source.id })
                .returning()
                .then(firstRow),
        ).rejects.toMatchObject({ cause: { code: '23503' } });
    });

    it('变化的旧快照来源必须完整声明，双方快照和证据不可跨账号', async () => {
        const change = await db
            .insert(tables.changeRecords)
            .values({
                userId: first.user.id,
                reportId: first.report.id,
                sourceId: first.source.id,
                kind: 'changed',
                oldSourceId: first.source.id,
                oldSnapshotId: first.snapshot.id,
                newSnapshotId: first.snapshot.id,
                factKey: 'deadline',
                oldValue: '24',
                newValue: '25',
                importance: 'important',
                reason: '截止延期',
            })
            .returning()
            .then(firstRow);
        await rejected(
            'UPDATE change_records SET old_source_id = NULL WHERE id = $1',
            [change.id],
            '23514',
        );
        await rejected(
            'UPDATE change_records SET new_snapshot_id = $1 WHERE id = $2',
            [second.snapshot.id, change.id],
            '23503',
        );
        await expect(
            db
                .insert(tables.changeEvidence)
                .values({
                    userId: first.user.id,
                    changeRecordId: change.id,
                    evidenceId: second.evidence.id,
                    side: 'new',
                })
                .returning()
                .then(firstRow),
        ).rejects.toMatchObject({ cause: { code: '23503' } });
        await expect(
            db
                .insert(tables.changeEvidence)
                .values({
                    userId: first.user.id,
                    changeRecordId: change.id,
                    evidenceId: first.evidence.id,
                    side: 'new',
                })
                .returning()
                .then(firstRow),
        ).resolves.toHaveProperty('id');
    });

    it('已有成果问答与后续研究、证据列表均受 owner 外键约束', async () => {
        const question = await db
            .insert(tables.reportQuestions)
            .values({ userId: first.user.id, reportId: first.report.id, question: '来源是什么' })
            .returning()
            .then(firstRow);
        await rejected(
            'UPDATE report_questions SET followup_run_id = $1 WHERE id = $2',
            [second.run.id, question.id],
            '23503',
        );
        await expect(
            db
                .insert(tables.questionEvidence)
                .values({
                    userId: first.user.id,
                    questionId: question.id,
                    evidenceId: second.evidence.id,
                })
                .returning()
                .then(firstRow),
        ).rejects.toMatchObject({ cause: { code: '23503' } });
        await expect(
            db
                .insert(tables.questionEvidence)
                .values({
                    userId: first.user.id,
                    questionId: question.id,
                    evidenceId: first.evidence.id,
                })
                .returning()
                .then(firstRow),
        ).resolves.toHaveProperty('id');
    });

    it('Outbox 只能引用当前账号 Run，投递键与幂等请求键具有数据库唯一性', async () => {
        const outbox = await db
            .insert(tables.outbox)
            .values({
                userId: first.user.id,
                aggregateId: first.run.id,
                eventType: 'run.requested',
                dedupeKey: randomUUID(),
                payload: { runId: first.run.id },
            })
            .returning()
            .then(firstRow);
        await rejected(
            'UPDATE outbox SET aggregate_id = $1 WHERE id = $2',
            [second.run.id, outbox.id],
            '23503',
        );
        await expect(
            db
                .insert(tables.outbox)
                .values({
                    userId: first.user.id,
                    aggregateId: first.run.id,
                    eventType: 'run.requested',
                    dedupeKey: outbox.dedupeKey,
                    payload: {},
                })
                .returning()
                .then(firstRow),
        ).rejects.toMatchObject({ cause: { code: '23505' } });
        const key = {
            scope: '/tasks/x/runs',
            keyHash: hash('key'),
            payloadHash: hash('payload'),
            expiresAt: new Date(Date.now() + 60000),
        };
        await db
            .insert(tables.idempotencyRecords)
            .values({ userId: first.user.id, ...key })
            .returning()
            .then(firstRow);
        await expect(
            db
                .insert(tables.idempotencyRecords)
                .values({ userId: first.user.id, ...key })
                .returning()
                .then(firstRow),
        ).rejects.toMatchObject({ cause: { code: '23505' } });
        await expect(
            db
                .insert(tables.idempotencyRecords)
                .values({ userId: second.user.id, ...key })
                .returning()
                .then(firstRow),
        ).resolves.toHaveProperty('id');
    });

    it('调度时点只保存一次且关联执行须属于同账号同任务', async () => {
        const slot = {
            userId: first.user.id,
            taskId: first.task.id,
            scheduleRevision: 1,
            scheduledAt: new Date('2026-10-24T00:00:00Z'),
            runId: first.run.id,
        };
        const occurrence = await db
            .insert(tables.scheduleOccurrences)
            .values(slot)
            .returning()
            .then(firstRow);
        await expect(
            db.insert(tables.scheduleOccurrences).values(slot).returning().then(firstRow),
        ).rejects.toMatchObject({
            cause: { code: '23505' },
        });
        await rejected(
            'UPDATE schedule_occurrences SET run_id = $1 WHERE id = $2',
            [second.run.id, occurrence.id],
            '23503',
        );
    });

    it('计数与完整性 CHECK 拒绝无效状态，部分结果不伪装完整无变化', async () => {
        await rejected('UPDATE tasks SET revision = 0 WHERE id = $1', [first.task.id], '23514');
        await rejected('UPDATE runs SET lease_epoch = -1 WHERE id = $1', [first.run.id], '23514');
        await rejected("UPDATE runs SET status = 'partial' WHERE id = $1", [first.run.id], '23514');
        await rejected(
            'UPDATE runs SET coverage_json = \'{"completeness":"partial"}\' WHERE id = $1',
            [first.run.id],
            '23514',
        );
    });

    it('删除测试账号级联清理所属资料，另一个账号保持可访问', async () => {
        await db
            .delete(tables.users)
            .where(and(eq(tables.users.id, first.user.id)))
            .returning()
            .then(firstRow);
        expect(
            await db
                .select({ count: count() })
                .from(tables.tasks)
                .where(and(eq(tables.tasks.userId, first.user.id)))
                .then(([row]) => row!.count),
        ).toBe(0);
        expect(
            await db
                .select({ count: count() })
                .from(tables.reports)
                .where(and(eq(tables.reports.userId, first.user.id)))
                .then(([row]) => row!.count),
        ).toBe(0);
        expect(
            await db
                .select({ count: count() })
                .from(tables.evidence)
                .where(and(eq(tables.evidence.userId, first.user.id)))
                .then(([row]) => row!.count),
        ).toBe(0);
        expect(
            await db
                .select({ count: count() })
                .from(tables.runEvents)
                .where(and(eq(tables.runEvents.userId, first.user.id)))
                .then(([row]) => row!.count),
        ).toBe(0);
        expect(
            await db.query.users
                .findFirst({ where: and(eq(tables.users.id, second.user.id)) })
                .then((row) => row ?? null),
        ).not.toBeNull();
    });

    it('所有非 User 外键的两侧都显式包含 owner，避免遗漏的单列关联', async () => {
        const result = await sql.query<{
            target: string;
            source_columns: string[];
            target_columns: string[];
        }>(
            `
      SELECT target.relname AS target,
        ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(attnum,ord) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum ORDER BY k.ord) AS source_columns,
        ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(attnum,ord) JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.attnum ORDER BY k.ord) AS target_columns
      FROM pg_constraint c JOIN pg_class target ON target.oid=c.confrelid
      WHERE c.contype='f' AND c.connamespace=(SELECT oid FROM pg_namespace WHERE nspname=$1)
    `,
            [schema],
        );
        expect(result.rows.length).toBeGreaterThan(50);
        for (const relation of result.rows) {
            expect(relation.source_columns).toContain('user_id');
            if (relation.target !== 'users') expect(relation.target_columns).toContain('user_id');
            else expect(relation.target_columns).toEqual(['id']);
        }
    });
});
