import type { PrismaClient } from "@scova/models";
import type { Queue } from "bullmq";
import type { Redis } from "ioredis";
import { createOutboxRepository } from "@/repo/outbox.ts";
import { createOutboxQueue, type OutboxQueue } from "@/queue/outbox.ts";
import { OutboxService } from "@/service/outbox.ts";

export interface OutboxDispatcherOptions {
  db: PrismaClient;
  redis: Redis;
  queueName?: string;
  clock?: () => Date;
  leaseSeconds?: number;
}

/** 兼容旧调用的薄装配入口；业务、持久化与队列各只有一套实现。 */
export class OutboxDispatcher {
  private readonly publisher: OutboxQueue;
  private readonly service: OutboxService;

  constructor(options: OutboxDispatcherOptions) {
    this.publisher = createOutboxQueue(options.redis, options.queueName);
    this.service = new OutboxService({
      repository: createOutboxRepository(options.db),
      publisher: this.publisher,
      clock: options.clock,
      leaseSeconds: options.leaseSeconds,
    });
  }

  get queue(): Queue {
    return this.publisher.queue;
  }

  dispatchOnce(limit = 50, signal?: AbortSignal): Promise<number> {
    return this.service.dispatchOnce(limit, signal);
  }

  close(): Promise<void> {
    return this.publisher.close();
  }
}
