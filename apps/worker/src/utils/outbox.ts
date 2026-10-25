import type { Outbox } from "@scova/models";

/** 发布端只需要事件标识和负载，不接触数据库连接或租约写入。 */
export type OutboxMessage = Pick<Outbox, "id" | "eventType" | "payload">;

/** attempts 与精确租约共同标识一次成功领取，旧持有者不能据此覆盖新租约。 */
export type ClaimedOutbox = Outbox & { leaseExpiresAt: Date };

export function outboxJobId(item: OutboxMessage): string {
  const payload = item.payload as { runId?: unknown } | null;
  return item.eventType === "run.enqueue" && typeof payload?.runId === "string"
    ? `run-${payload.runId}`
    : `outbox-${item.eventType}-${item.id}`;
}

/** 保留已有指数退避策略，并限制单次等待上限。 */
export function outboxRetryDelayMilliseconds(attempts: number): number {
  return Math.min(300, 2 ** Math.min(attempts, 8)) * 1000;
}

/** 有限错误描述不包含资料负载、Redis 地址或数据库消息。 */
export class OutboxLeaseLostError extends Error {
  readonly code = "OUTBOX_LEASE_LOST";
  readonly operation: "ack" | "retry";

  constructor(operation: "ack" | "retry") {
    super("Outbox 租约已失效，当前投递结果未确认");
    this.name = "OutboxLeaseLostError";
    this.operation = operation;
  }
}
