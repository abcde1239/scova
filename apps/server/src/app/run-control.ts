import { setTimeout as delay } from 'node:timers/promises';
import { closeDatabase, createDatabaseClient, type DatabaseClient } from '@scova/db';
import { openSqliteRunQueue } from '@scova/db/sqlite-state';
import { outboxJobId, type OutboxMessage } from '@scova/execution/queue';
import { createOutboxHandler } from '../handler/outbox.ts';
import { createSchedulerHandler } from '../handler/scheduler.ts';
import { createOutboxQueue } from '../repo/queue/outbox.ts';
import { enqueueRecoverableRuns } from '../repo/queue/recoverable-runs.ts';
import { createOutboxRepository } from '../repo/outbox.ts';
import { listRecoverableRuns } from '../repo/recoverable-runs.ts';
import { createRedisConnection } from '../repo/redis.ts';
import { createSchedulerRepository } from '../repo/scheduler.ts';
import { OutboxService } from '../service/outbox.ts';
import { SchedulerService } from '../service/scheduler.ts';
import { createWorkflowBatch } from '../service/workflow-batch.ts';
import { readRunControlConfig, type RunControlConfig } from './run-control-config.ts';

/** Server 的后台控制面：定时落库、Outbox 发布、恢复回补；不执行 Agent。 */
export function createRunControl(config: RunControlConfig = readRunControlConfig()) {
    const controller = new AbortController();
    const { signal } = controller;
    let database: DatabaseClient | undefined;
    let redis: ReturnType<typeof createRedisConnection> | undefined;
    let localQueue: ReturnType<typeof openSqliteRunQueue> | undefined;
    let publisher: ReturnType<typeof createOutboxQueue> | undefined;
    let outbox: ReturnType<typeof createOutboxHandler> | undefined;
    let scheduler: ReturnType<typeof createSchedulerHandler> | undefined;
    let workflows: ReturnType<typeof createWorkflowBatch> | undefined;
    let loops: Promise<void>[] | undefined;
    let closing: Promise<void> | undefined;
    const db = () =>
        (database ??= createDatabaseClient({
            connectionString: config.databaseUrl,
            applicationName: 'scova-run-control',
        }));

    async function dispatchBatch() {
        if (config.sqliteStatePath) {
            const queue = (localQueue ??= openSqliteRunQueue(
                config.sqliteStatePath,
                config.queueName,
            ));
            outbox ??= outboxHandler({
                async publish(item) {
                    queue.publish(outboxJobId(item), item.eventType, item.payload);
                },
            });
            await outbox(signal);
            if (signal.aborted) return;
            for (const run of await listRecoverableRuns(db(), config.batchSize)) {
                if (signal.aborted) break;
                queue.publish(
                    `run-recover-${run.id}-${run.leaseEpoch}`,
                    'run.enqueue',
                    { runId: run.id },
                    true,
                );
            }
            return;
        }
        if (!config.redisUrl) throw new Error('缺少 REDIS_URL');
        if (!redis) {
            redis = createRedisConnection(config.redisUrl, {
                retryStrategy: (attempt) => Math.min(attempt * 200, 5000),
            });
            // 建连与后续断线由 ioredis 重试；不在 Redis 未就绪时领 Outbox 租约。
            await redis.connect();
        }
        if (signal.aborted) return;
        if (redis.status !== 'ready') throw new Error('Run 队列未就绪');
        publisher ??= createOutboxQueue(redis, config.queueName);
        outbox ??= outboxHandler(publisher);
        await outbox(signal);
        if (!signal.aborted) {
            const runs = await listRecoverableRuns(db(), config.batchSize);
            await enqueueRecoverableRuns(publisher.queue, runs, signal);
        }
    }

    function outboxHandler(target: { publish(item: OutboxMessage): Promise<void> }) {
        return createOutboxHandler(
            new OutboxService({
                repository: createOutboxRepository(db()),
                publisher: target,
                leaseSeconds: config.leaseSeconds,
            }),
            config.batchSize,
        );
    }

    async function scheduleBatch() {
        scheduler ??= createSchedulerHandler(
            new SchedulerService({
                repository: createSchedulerRepository(db()),
                concurrency: config.schedulerConcurrency,
            }),
            config.batchSize,
        );
        await scheduler(signal);
    }

    async function workflowBatch() {
        workflows ??= createWorkflowBatch(db(), {
            batchSize: config.batchSize,
            intervalMs: config.pollIntervalMs,
        });
        await workflows(signal);
    }

    async function poll(
        batch: () => Promise<void>,
        interval: number,
        failureDelay: number,
        label: string,
    ) {
        while (!signal.aborted) {
            let wait = interval;
            try {
                await batch();
            } catch {
                if (signal.aborted) break;
                console.error(`Server ${label}失败，将退避后重试`);
                wait = failureDelay;
            }
            await delay(wait, undefined, { signal }).catch(() => undefined);
        }
    }

    return {
        start() {
            if (signal.aborted) throw new Error('Server Run 控制面已停止');
            loops ??= [
                poll(workflowBatch, config.pollIntervalMs, config.failureDelayMs, '工作流推进批次'),
                poll(
                    dispatchBatch,
                    config.pollIntervalMs,
                    config.failureDelayMs,
                    'Run 投递/回补批次',
                ),
                poll(
                    scheduleBatch,
                    config.schedulerIntervalMs,
                    Math.max(config.schedulerIntervalMs, config.failureDelayMs),
                    'Run 调度批次',
                ),
            ];
        },
        stop() {
            controller.abort();
            return (closing ??= (async () => {
                await Promise.all(loops ?? []);
                try {
                    localQueue?.close();
                    await publisher?.close();
                } finally {
                    redis?.disconnect();
                    if (database) await closeDatabase(database);
                }
            })());
        },
    };
}
