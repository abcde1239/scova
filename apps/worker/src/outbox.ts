import { PrismaClient, type Outbox } from "@scova/models";
import { Queue } from "bullmq";
import type { Redis } from "ioredis";

export interface OutboxDispatcherOptions {
  db: PrismaClient;
  redis: Redis;
  queueName?: string;
  clock?: () => Date;
  leaseSeconds?: number;
}

/**
 * 事务 Outbox 的最小投递器：先用数据库条件更新取得租约，再投递 BullMQ，最后标记 sentAt。
 * 发送成功后进程崩溃会留下未标记记录，租约过期后允许再次投递；业务 worker 必须按 runId 幂等。
 */
export class OutboxDispatcher {
  readonly queue: Queue;
  private readonly db: PrismaClient;
  private readonly clock: () => Date;
  private readonly leaseSeconds: number;

  constructor(options: OutboxDispatcherOptions) {
    this.db = options.db;
    this.clock = options.clock ?? (() => new Date());
    this.leaseSeconds = options.leaseSeconds ?? 30;
    this.queue = new Queue(options.queueName ?? "scova-runs", { connection: options.redis });
  }

  private async claim(now: Date): Promise<Outbox | null> {
    const candidate = await this.db.outbox.findFirst({
      where: {
        sentAt: null,
        availableAt: { lte: now },
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }],
      },
      orderBy: [{ availableAt: "asc" }, { id: "asc" }],
    });
    if (!candidate) return null;
    const leaseExpiresAt = new Date(now.getTime() + this.leaseSeconds * 1000);
    const updated = await this.db.outbox.updateMany({
      where: {
        id: candidate.id,
        sentAt: null,
        availableAt: { lte: now },
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }],
      },
      data: { leaseExpiresAt, attempts: { increment: 1 } },
    });
    if (updated.count !== 1) return null;
    return { ...candidate, leaseExpiresAt, attempts: candidate.attempts + 1 };
  }

  async dispatchOnce(limit = 50): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Outbox 投递上限必须为正整数");
    let delivered = 0;
    for (let index = 0; index < limit; index += 1) {
      const now = this.clock();
      const item = await this.claim(now);
      if (!item) break;
      try {
        const payload = item.payload as { runId?: unknown };
        const jobId =
          item.eventType === "run.enqueue" && typeof payload.runId === "string"
            ? `run-${payload.runId}`
            : `outbox-${item.eventType}-${item.id}`;
        await this.queue.add(item.eventType, item.payload, {
          jobId,
          removeOnComplete: { age: 86400, count: 1000 },
          removeOnFail: { age: 604800, count: 1000 },
        });
        await this.db.outbox.update({
          where: { id: item.id },
          data: { sentAt: this.clock(), leaseExpiresAt: null },
        });
        delivered += 1;
      } catch (error) {
        await this.db.outbox.update({
          where: { id: item.id },
          data: {
            leaseExpiresAt: null,
            availableAt: new Date(
              this.clock().getTime() + Math.min(300, 2 ** Math.min(item.attempts, 8)) * 1000,
            ),
          },
        });
        if (error instanceof Error) throw error;
        throw new Error("BullMQ 投递失败");
      }
    }
    return delivered;
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}
