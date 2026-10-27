import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import pg from 'pg';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { outboxJobId } from '../src/utils/outbox.ts';
import { PrismaClient } from '@scova/models';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import {
    createConnectorBundle,
    createPageReader,
    type ConnectorBundle,
    type StructuredInput,
    type CallContext,
} from '@scova/connectors';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { operationConfig, operationPool } from '../src/app/operations.ts';
import { createOperationService } from '../src/service/operations.ts';
import { createOperationRepository } from '../src/repo/operations.ts';
import { parseOperation } from '../src/utils/operations.ts';
import { createAgentRepository } from '../src/repo/agent.ts';
import { createRunRepository } from '../src/repo/runs.ts';
import { createAgentSession, createAgentRuntime } from '../src/service/agent.ts';
import { RunService } from '../src/service/runs.ts';
import { createDeliveryService } from '../src/service/delivery.ts';
import { outboxDatabase } from './support/outbox-database.ts';
import { seedRun } from './support/run-database.ts';

const fixture = outboxDatabase();
const config = operationConfig({
    DATABASE_URL: fixture.databaseUrl,
    AGENT_CHECKPOINT_SCHEMA: fixture.checkpointSchema,
    SCOVA_MAINTENANCE: '1',
    REDIS_URL: fixture.redisUrl,
    WORKER_QUEUE_NAME: `scova-operations-${randomUUID()}`,
});
const pool = operationPool(config);
const service = createOperationService(pool, config);
const repo = createOperationRepository(pool, config);
const saver = new PostgresSaver(pool, undefined, { schema: fixture.checkpointSchema });
beforeAll(async () => {
    await fixture.setup();
    await service.execute(parseOperation(['migrate']));
}, 120_000);
afterAll(async () => {
    await pool.end();
    await fixture.cleanup();
});
// Deterministic live-mode connector fixture exercises complete delivery and genuine baseline promotion.
// It does not call a remote provider and is not a live-service acceptance result.
function completeBundle(): ConnectorBundle {
    const demo = createConnectorBundle();
    const url = 'https://example.com/operations-publication';
    const publication = new Date(Date.now() - 60_000).toISOString();
    return {
        mode: 'live',
        search: {
            async search(query, context) {
                const result = await demo.search.search(query, context);
                return {
                    ...result,
                    mode: 'live',
                    provider: 'searxng',
                    results: [
                        {
                            kind: 'search_snippet',
                            originalUrl: url,
                            url,
                            title: '保留测试公告',
                            snippet: '待核查摘要',
                        },
                    ],
                };
            },
        },
        reader: createPageReader({
            http: {
                async request(requestedUrl) {
                    return {
                        url: requestedUrl,
                        status: 200,
                        headers: { 'content-type': 'text/html; charset=utf-8' },
                        body: `<html><head><meta property="article:published_time" content="${publication}"></head><body><article>这是公开公告，申请截止日期为十一月十五日。</article></body></html>`,
                    };
                },
            },
        }),
        model: {
            async generateStructured<T>(input: StructuredInput, context?: CallContext) {
                await context?.beforeAttempt?.('model');
                const sources = input.untrustedSources as
                    | { pageId: string; text: string }[]
                    | undefined;
                const source = sources?.[0];
                const data = Object.hasOwn((input.schema.properties ?? {}) as object, 'pages')
                    ? {
                          pages: sources!.map((page) => ({
                              pageId: page.pageId,
                              facts: [
                                  {
                                      subject: '公开公告',
                                      predicate: '公告内容',
                                      value: page.text,
                                      quote: page.text,
                                      relevance: 'relevant',
                                      importance: 'important',
                                  },
                              ],
                          })),
                      }
                    : source
                      ? {
                            claims: [
                                {
                                    kind: 'fact',
                                    text: source.text,
                                    questionIds: ['q0', 'q1'],
                                    citations: [{ pageId: source.pageId, quote: source.text }],
                                },
                            ],
                        }
                      : { queries: [{ query: '公共公告', questionIds: ['q0', 'q1'] }] };
                return {
                    mode: 'live',
                    data: data as T,
                    usage: { inputTokens: 1, outputTokens: 1, estimated: false },
                };
            },
        },
    };
}
async function prepare(db: PrismaClient, checkpointer: PostgresSaver, complete = false) {
    const seed = await seedRun(db, { mode: complete ? 'live' : 'demo' });
    const runs = createRunRepository(db);
    const claimed = await runs.claim(seed.run.id, 'operations-test', 60_000);
    if (claimed.kind !== 'claimed') throw new Error('Expected claim');
    const session = createAgentSession({
        repository: createAgentRepository(db, claimed.token),
        saver: checkpointer,
        token: claimed.token,
        context: {
            runId: seed.run.id,
            userId: seed.user.id,
            taskId: seed.task.id,
            taskVersionId: seed.version.id,
            mode: seed.run.mode,
            config: claimed.config,
            budget: claimed.budget,
            usage: claimed.usage,
            startedAt: claimed.run.startedAt!,
            deadlineAt: claimed.run.deadlineAt!,
            signal: new AbortController().signal,
            assertActive: () => runs.assertActive(claimed.token),
            emit: (event) => runs.emit(claimed.token, event),
        },
        bundle: complete ? completeBundle() : createConnectorBundle(),
    });
    const candidate = await session.execute();
    await session.drain();
    return { ...seed, claimed, candidate, session };
}
async function deliver(db: PrismaClient, checkpointer: PostgresSaver, complete = false) {
    const prepared = await prepare(db, checkpointer, complete);
    const result = await createDeliveryService(db, checkpointer).deliver(
        prepared.claimed.token,
        prepared.candidate,
    );
    return { ...prepared, reportId: result.reportId };
}
async function threadCount(id: string) {
    let count = 0;
    for (const table of ['checkpoints', 'checkpoint_blobs', 'checkpoint_writes'])
        count += Number(
            (
                await pool.query(
                    `SELECT count(*) FROM "${fixture.checkpointSchema}".${table} WHERE thread_id LIKE $1`,
                    [`run-${id}-epoch-%`],
                )
            ).rows[0].count,
        );
    return count;
}

describe('真实维护数据库、保留与账号依赖', () => {
    it('业务/saver迁移可重复，ready核全部迁移，维护标志不可省略', async () => {
        await service.execute(parseOperation(['migrate']));
        await repo.readiness();
        const active = new pg.Client({
            connectionString: config.connectionString,
            application_name: 'scova-api',
        });
        await active.connect();
        try {
            expect(await service.execute(parseOperation(['migrate']))).toMatchObject({
                current: true,
            });
            await pool.query(
                `UPDATE "${fixture.checkpointSchema}".scova_schema_version SET version='bad'`,
            );
            await expect(service.execute(parseOperation(['migrate']))).rejects.toThrow(
                '仍连接数据库',
            );
        } finally {
            await active.end();
        }
        await service.execute(parseOperation(['migrate']));
        await expect(
            createOperationService(pool, { ...config, offline: false }).execute(
                parseOperation(['retention']),
            ),
        ).rejects.toThrow('SCOVA_MAINTENANCE');
        await pool.query(
            `UPDATE "${fixture.checkpointSchema}".scova_schema_version SET version='bad'`,
        );
        await expect(repo.readiness()).rejects.toThrow('版本不匹配');
        await service.execute(parseOperation(['migrate']));
        await repo.readiness();
    });
    it('30天清理含全部epoch原始正文，保报告/引用/基线与活跃观测；重复批次不占位', async () => {
        const old = await deliver(fixture.db, saver, true);
        const report = await fixture.db.report.findUniqueOrThrow({ where: { id: old.reportId } });
        const baseline = await fixture.db.baseline.findFirstOrThrow({
            where: { taskId: old.task.id },
        });
        const evidence = await fixture.db.evidence.findMany({ where: { runId: old.run.id } });
        const observation = await fixture.db.runSource.findFirstOrThrow({
            where: { runId: old.run.id },
        });
        const active = await fixture.db.run.create({
            data: {
                userId: old.user.id,
                taskId: old.task.id,
                taskVersionId: old.version.id,
                comparisonScopeHash: old.run.comparisonScopeHash,
                mode: 'demo',
                trigger: 'manual',
                budgetJson: old.config.budget,
                usageJson: {},
            },
        });
        await fixture.db.runSource.create({
            data: {
                userId: old.user.id,
                runId: active.id,
                sourceId: observation.sourceId,
                snapshotId: observation.snapshotId,
                requestedUrl: observation.requestedUrl,
                fetchStatus: 'succeeded',
            },
        });
        await fixture.db.run.update({
            where: { id: old.run.id },
            data: { finishedAt: new Date(Date.now() - 31 * 86400_000) },
        });
        await fixture.db.sourceSnapshot.update({
            where: { id: observation.snapshotId! },
            data: { textExpiresAt: new Date(0) },
        });
        await pool.query(
            `INSERT INTO "${fixture.checkpointSchema}".checkpoint_blobs (thread_id,checkpoint_ns,channel,version,type,blob) VALUES ($1,'','research','1','json',$2)`,
            [`run-${old.run.id}-epoch-99`, Buffer.from('"unpromoted-body"')],
        );
        expect(await threadCount(old.run.id)).toBeGreaterThan(1);
        expect((await repo.retention(false)).runs).toBeGreaterThan(0);
        expect(
            (await fixture.db.run.findUniqueOrThrow({ where: { id: old.run.id } })).checkpointRef,
        ).not.toBeNull();
        await repo.retention(true);
        expect(await threadCount(old.run.id)).toBe(0);
        expect(
            (await fixture.db.run.findUniqueOrThrow({ where: { id: old.run.id } })).checkpointRef,
        ).toBeNull();
        const retainedCalls = await fixture.db.toolCall.findMany({ where: { runId: old.run.id } });
        expect(retainedCalls.length).toBeGreaterThan(0);
        expect(retainedCalls.every((call) => call.outputRef === null)).toBe(true);
        expect(
            (
                await fixture.db.sourceSnapshot.findUniqueOrThrow({
                    where: { id: observation.snapshotId! },
                })
            ).textBody,
        ).not.toBeNull();
        expect(
            (await fixture.db.report.findUniqueOrThrow({ where: { id: old.reportId } }))
                .comparisonJson,
        ).toEqual(report.comparisonJson);
        expect(await fixture.db.evidence.findMany({ where: { runId: old.run.id } })).toEqual(
            evidence,
        );
        expect(await fixture.db.baseline.findUniqueOrThrow({ where: { id: baseline.id } })).toEqual(
            baseline,
        );
        await fixture.db.run.update({
            where: { id: active.id },
            data: { status: 'canceled', finishedAt: new Date() },
        });
        await repo.retention(true);
        expect(
            (
                await fixture.db.sourceSnapshot.findUniqueOrThrow({
                    where: { id: observation.snapshotId! },
                })
            ).textBody,
        ).toBeNull();
        expect((await repo.retention(false)).runs).toBe(0);
        expect(await fixture.db.inboxItem.count({ where: { reportId: old.reportId } })).toBe(1);
    });
    it('29天终态和活跃checkpoint/工具正文保持可恢复', async () => {
        const recent = await deliver(fixture.db, saver);
        await fixture.db.run.update({
            where: { id: recent.run.id },
            data: { finishedAt: new Date(Date.now() - 29 * 86400_000) },
        });
        const active = await seedRun(fixture.db);
        await fixture.db.run.update({
            where: { id: active.run.id },
            data: {
                status: 'recovering',
                startedAt: new Date(Date.now() - 31 * 86400_000),
            },
        });
        await pool.query(
            `INSERT INTO "${fixture.checkpointSchema}".checkpoint_blobs (thread_id,checkpoint_ns,channel,version,type,blob) VALUES ($1,'','research','1','json',$2)`,
            [`run-${active.run.id}-epoch-1`, Buffer.from('"active-body"')],
        );
        const count = await threadCount(recent.run.id);
        await repo.retention(true);
        expect(await threadCount(active.run.id)).toBe(1);
        expect(await threadCount(recent.run.id)).toBe(count);
        expect(
            (await fixture.db.run.findUniqueOrThrow({ where: { id: recent.run.id } }))
                .checkpointRef,
        ).not.toBeNull();
    });
    it('账号级联包括真实报告/引用/基线/收藏/笔记/问答和raw epoch，其他owner不受影响', async () => {
        const owned = await deliver(fixture.db, saver, true),
            other = await deliver(fixture.db, saver, true);
        const source = await fixture.db.source.findFirstOrThrow({
            where: { userId: owned.user.id },
        });
        const evidence = await fixture.db.evidence.findFirstOrThrow({
            where: { userId: owned.user.id },
        });
        await fixture.db.bookmark.create({ data: { userId: owned.user.id, sourceId: source.id } });
        await fixture.db.note.create({
            data: { userId: owned.user.id, reportId: owned.reportId, body: 'private note' },
        });
        const question = await fixture.db.reportQuestion.create({
            data: {
                userId: owned.user.id,
                reportId: owned.reportId,
                question: 'private question',
                followupRunId: owned.run.id,
            },
        });
        await fixture.db.questionEvidence.create({
            data: { userId: owned.user.id, questionId: question.id, evidenceId: evidence.id },
        });
        await fixture.db.notification.create({
            data: {
                userId: owned.user.id,
                runId: owned.run.id,
                reportId: owned.reportId,
                kind: 'run_issue',
            },
        });
        expect(await repo.deleteAccount(owned.user.id, false)).toMatchObject({
            found: true,
            applied: false,
        });
        await pool.query(
            `CREATE FUNCTION "${config.businessSchema}".reject_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$`,
        );
        await pool.query(
            `CREATE TRIGGER reject_delete BEFORE DELETE ON "${config.businessSchema}".users FOR EACH ROW EXECUTE FUNCTION "${config.businessSchema}".reject_delete()`,
        );
        try {
            await expect(repo.deleteAccount(owned.user.id, true)).rejects.toThrow();
            expect(await threadCount(owned.run.id)).toBeGreaterThan(0);
        } finally {
            await pool.query(`DROP TRIGGER reject_delete ON "${config.businessSchema}".users`);
            await pool.query(`DROP FUNCTION "${config.businessSchema}".reject_delete()`);
        }
        const redis = new Redis(fixture.redisUrl, {
            lazyConnect: true,
            enableOfflineQueue: false,
            maxRetriesPerRequest: 1,
        });
        redis.on('error', () => undefined);
        await redis.connect();
        const queue = new Queue(config.queueName, { connection: redis });
        queue.on('error', () => undefined);
        const cancellations = [];
        for (const account of [owned, other]) {
            const item = await fixture.db.outbox.create({
                data: {
                    userId: account.user.id,
                    aggregateId: account.run.id,
                    eventType: 'run.cancel_requested',
                    dedupeKey: `cancel-${randomUUID()}`,
                    payload: { runId: account.run.id },
                },
            });
            cancellations.push(item);
            await queue.add(item.eventType, item.payload, { jobId: outboxJobId(item) });
        }
        await queue.add('run.enqueue', { runId: owned.run.id }, { jobId: `run-${owned.run.id}` });
        await queue.add(
            'run.enqueue',
            { runId: owned.run.id },
            { jobId: `run-recover-${owned.run.id}-0` },
        );
        try {
            await service.execute(
                parseOperation(['delete-account', `--user-id=${owned.user.id}`, '--apply']),
            );
            expect(await queue.getJob(outboxJobId(cancellations[0]!))).toBeUndefined();
            expect(await queue.getJob(`run-${owned.run.id}`)).toBeUndefined();
            expect(await queue.getJob(`run-recover-${owned.run.id}-0`)).toBeUndefined();
            expect(await queue.getJob(outboxJobId(cancellations[1]!))).toBeDefined();
        } finally {
            await queue.obliterate({ force: true });
            await queue.close();
            redis.disconnect();
        }
        expect(await threadCount(owned.run.id)).toBe(0);
        expect(await fixture.db.user.findUnique({ where: { id: owned.user.id } })).toBeNull();
        expect(await fixture.db.report.count({ where: { userId: owned.user.id } })).toBe(0);
        expect(await fixture.db.note.count({ where: { userId: owned.user.id } })).toBe(0);
        expect(await fixture.db.baseline.count({ where: { userId: owned.user.id } })).toBe(0);
        expect(await fixture.db.baseline.count({ where: { userId: other.user.id } })).toBe(1);
        expect(
            await fixture.db.report.findUnique({ where: { id: other.reportId } }),
        ).not.toBeNull();
        expect(await threadCount(other.run.id)).toBeGreaterThan(0);
    });
});

async function dropDisconnectedDatabases(admin: pg.Pool, names: string[]) {
    // pg Pool.end() can resolve before its ending sockets disappear on the server.
    // Observe every connection (including the recovered runtime's pool) before DDL;
    // FORCE would turn that short close race into unhandled FATAL errors in clients.
    const closeDeadline = Date.now() + 5000;
    while (
        (await admin.query('SELECT 1 FROM pg_stat_activity WHERE datname=ANY($1::text[])', [names]))
            .rowCount
    ) {
        if (Date.now() >= closeDeadline) throw new Error('临时数据库连接未在清理期限内自然关闭');
        await delay(25);
    }
    for (const name of names) await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
}

it('真实pg_dump/pg_restore恢复报告和checkpoint，并从备份恢复未交付Run，拒绝覆盖非空库', async () => {
    const admin = new pg.Pool({ connectionString: config.connectionString });
    const names = [
        `scova_backup_${randomUUID().replaceAll('-', '')}`,
        `scova_restore_${randomUUID().replaceAll('-', '')}`,
    ];
    const directory = await mkdtemp(join(tmpdir(), 'scova-backup-'));
    const databases: PrismaClient[] = [],
        pools: pg.Pool[] = [];
    try {
        for (const name of names) await admin.query(`CREATE DATABASE "${name}"`);
        const configs = names.map((name) => {
            const url = new URL(config.connectionString);
            url.pathname = '/' + name;
            return operationConfig({
                DATABASE_URL: url.toString(),
                SCOVA_MAINTENANCE: '1',
                SCOVA_BACKUP_DIRECTORY: directory,
            });
        });
        const services = configs.map((value) => {
            const pool = operationPool(value);
            pools.push(pool);
            return createOperationService(pool, value);
        });
        await services[0]!.execute(parseOperation(['migrate']));
        const source = new PrismaClient({ datasources: { db: { url: configs[0]!.databaseUrl } } });
        databases.push(source);
        const sourceSaver = new PostgresSaver(pools[0]!, undefined, { schema: 'scova_agent' });
        const owned = await deliver(source, sourceSaver);
        const unfinished = await prepare(source, sourceSaver);
        await source.run.update({
            where: { id: unfinished.run.id },
            data: { leaseExpiresAt: new Date(0) },
        });
        const beforeCalls = await source.toolCall.count({ where: { runId: unfinished.run.id } });
        const beforeUsage = (
            await source.run.findUniqueOrThrow({ where: { id: unfinished.run.id } })
        ).usageJson;
        expect(await source.report.count({ where: { runId: unfinished.run.id } })).toBe(0);
        const run = await source.run.findUniqueOrThrow({ where: { id: owned.run.id } });
        await services[0]!.execute(parseOperation(['backup', '--name=roundtrip.dump']));
        await services[1]!.execute(parseOperation(['restore', '--name=roundtrip.dump', '--apply']));
        const target = new PrismaClient({ datasources: { db: { url: configs[1]!.databaseUrl } } });
        databases.push(target);
        expect(await target.report.findUniqueOrThrow({ where: { id: owned.reportId } })).toEqual(
            await source.report.findUniqueOrThrow({ where: { id: owned.reportId } }),
        );
        expect(
            (await target.run.findUniqueOrThrow({ where: { id: owned.run.id } })).checkpointRef,
        ).toEqual(run.checkpointRef);
        const ref = run.checkpointRef as {
            threadId: string;
            namespace: string;
            checkpointId: string;
        };
        const restored = new PostgresSaver(pools[1]!, undefined, { schema: 'scova_agent' });
        const checkpointConfig = {
            configurable: {
                thread_id: ref.threadId,
                checkpoint_ns: ref.namespace,
                checkpoint_id: ref.checkpointId,
            },
        };
        const sourceTuple = await sourceSaver.getTuple(checkpointConfig);
        const restoredTuple = await restored.getTuple(checkpointConfig);
        expect(sourceTuple).toBeDefined();
        expect(restoredTuple).toBeDefined();
        expect(restoredTuple!.checkpoint.channel_values).toEqual(
            sourceTuple!.checkpoint.channel_values,
        );
        const noNewCalls = async (): Promise<never> => {
            throw new Error('Restored checkpoint must avoid provider replay');
        };
        const runtime = createAgentRuntime({
            database: target,
            databaseUrl: configs[1]!.databaseUrl,
            checkpointSchema: 'scova_agent',
            env: { AGENT_CHECKPOINT_MIGRATION: 'external' },
            enableDelivery: true,
            bundle: {
                mode: 'demo',
                search: { search: noNewCalls },
                reader: { read: noNewCalls },
                model: { generateStructured: noNewCalls },
            },
        });
        try {
            await runtime.connect();
            const restoredRun = new RunService({
                repository: createRunRepository(target),
                executorFactory: (token) => runtime.executorFactory(token),
            });
            expect(await restoredRun.execute(unfinished.run.id)).toBe('processed');
            expect(await target.report.count({ where: { runId: unfinished.run.id } })).toBe(1);
            const delivered = await target.run.findUniqueOrThrow({
                where: { id: unfinished.run.id },
            });
            expect(delivered.status).toBe('partial');
            expect(delivered.usageJson).toEqual(beforeUsage);
            expect(await target.toolCall.count({ where: { runId: unfinished.run.id } })).toBe(
                beforeCalls,
            );
            expect(await restoredRun.execute(unfinished.run.id)).toBe('ignored');
        } finally {
            await runtime.close();
        }
        await expect(
            services[1]!.execute(parseOperation(['restore', '--name=roundtrip.dump', '--apply'])),
        ).rejects.toThrow('空数据库');
    } finally {
        try {
            await Promise.all(databases.map((db) => db.$disconnect()));
            await Promise.all(pools.map((pool) => pool.end()));
            await dropDisconnectedDatabases(admin, names);
        } finally {
            await admin.end();
            await rm(directory, { recursive: true, force: true });
        }
    }
}, 180_000);
