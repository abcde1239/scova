import { createDatabaseClient, type PrismaClient } from "@scova/models";
import { Redis } from "ioredis";
import type { WorkerConfig } from "@/app/config.ts";
import { createOutboxHandler } from "@/handler/outbox.ts";
import { createOutboxRepository } from "@/repo/outbox.ts";
import { createOutboxQueue, type OutboxQueue } from "@/queue/outbox.ts";
import { OutboxService } from "@/service/outbox.ts";
import { createRunRepository } from "@/repo/runs.ts";
import { createRunHandler } from "@/handler/runs.ts";
import { RunService, type RunExecutor } from "@/service/runs.ts";
import { createRunConsumer, enqueueRecoverableRuns } from "@/queue/runs.ts";
import { createAgentRuntime } from "@/service/agent.ts";

export interface WorkerResources {
  connect(): Promise<void>;
  dispatch(signal: AbortSignal): Promise<number>;
  stop?(): Promise<void>;
  finished?(): Promise<void>;
  close(): Promise<void>;
}

/** 应用拥有资源；导入/构造不联网，关闭时依次释放队列、Redis、数据库。 */
export function createWorkerResources(
  config: WorkerConfig,
  options: { executor?: RunExecutor } = {},
): WorkerResources {
  let database: PrismaClient | undefined;
  let redis: Redis | undefined;
  let publisher: OutboxQueue | undefined;
  let handler: ReturnType<typeof createOutboxHandler> | undefined;
  let connecting: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let consumer: ReturnType<typeof createRunConsumer> | undefined;
  let runRepository: ReturnType<typeof createRunRepository> | undefined;
  let agent: ReturnType<typeof createAgentRuntime> | undefined;
  return {
    connect: () =>
      (connecting ??= (async () => {
        database = createDatabaseClient({ datasources: { db: { url: config.databaseUrl } } });
        await database.$connect();
        redis = new Redis(config.redisUrl, {
          lazyConnect: true,
          enableOfflineQueue: false,
          maxRetriesPerRequest: 1,
          connectTimeout: 5000,
          commandTimeout: 5000,
          retryStrategy: (attempt) => Math.min(attempt * 200, 5000),
        });
        redis.on("error", () => undefined);
        await redis.connect();
        publisher = createOutboxQueue(redis, config.queueName);
        await publisher.queue.waitUntilReady();
        handler = createOutboxHandler(
          new OutboxService({
            repository: createOutboxRepository(database),
            publisher,
            leaseSeconds: config.leaseSeconds,
          }),
          config.batchSize,
        );
        runRepository = createRunRepository(database);
        if (!options.executor) {
          agent = createAgentRuntime({ databaseUrl: config.databaseUrl, database });
          await agent.connect();
        }
        const leaseMs = config.runLeaseSeconds * 1000;
        const runHandler = createRunHandler(
          new RunService({
            repository: runRepository,
            executor: options.executor,
            executorFactory: agent ? (token) => agent!.executorFactory(token) : undefined,
            leaseMs,
            renewIntervalMs: Math.min(10_000, Math.floor(leaseMs / 3)),
          }),
        );
        consumer = createRunConsumer(
          config.redisUrl,
          config.queueName,
          runHandler,
          config.runConcurrency,
        );
        await consumer.start();
      })()),
    dispatch: async (signal) => {
      if (!handler || !runRepository || !publisher) throw new Error("Worker 依赖尚未就绪");
      const delivered = await handler(signal);
      if (!signal.aborted) {
        const runs = await runRepository.listRecoverable(config.batchSize);
        await enqueueRecoverableRuns(publisher.queue, runs, signal);
      }
      return delivered;
    },
    stop: () => consumer?.stop() ?? Promise.resolve(),
    finished: () => consumer?.finished() ?? Promise.resolve(),
    close: () =>
      (closing ??= (async () => {
        const errors: unknown[] = [];
        try {
          await consumer?.stop();
        } catch (error) {
          errors.push(error);
        }
        try {
          await publisher?.close();
        } catch (error) {
          errors.push(error);
        }
        if (redis) {
          try {
            if (redis.status === "ready") await redis.quit();
          } catch (error) {
            errors.push(error);
          } finally {
            redis.disconnect();
          }
        }
        try {
          await agent?.close();
        } catch (error) {
          errors.push(error);
        }
        try {
          await database?.$disconnect();
        } catch (error) {
          errors.push(error);
        }
        if (errors.length) throw new AggregateError(errors, "Worker 资源关闭失败");
      })()),
  };
}
