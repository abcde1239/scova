import { createDatabaseClient, type PrismaClient } from "@scova/models";
import { Redis } from "ioredis";
import type { WorkerConfig } from "@/app/config.ts";
import { createOutboxHandler } from "@/handler/outbox.ts";
import { createOutboxRepository } from "@/repo/outbox.ts";
import { createOutboxQueue, type OutboxQueue } from "@/queue/outbox.ts";
import { OutboxService } from "@/service/outbox.ts";

export interface WorkerResources {
  connect(): Promise<void>;
  dispatch(signal: AbortSignal): Promise<number>;
  close(): Promise<void>;
}

/** 应用拥有资源；导入/构造不联网，关闭时依次释放队列、Redis、数据库。 */
export function createWorkerResources(config: WorkerConfig): WorkerResources {
  let database: PrismaClient | undefined;
  let redis: Redis | undefined;
  let publisher: OutboxQueue | undefined;
  let handler: ReturnType<typeof createOutboxHandler> | undefined;
  let connecting: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
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
      })()),
    dispatch: (signal) => {
      if (!handler) return Promise.reject(new Error("Worker 依赖尚未就绪"));
      return handler(signal);
    },
    close: () =>
      (closing ??= (async () => {
        const errors: unknown[] = [];
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
          await database?.$disconnect();
        } catch (error) {
          errors.push(error);
        }
        if (errors.length) throw new AggregateError(errors, "Worker 资源关闭失败");
      })()),
  };
}
