import type { RunEvent } from "@scova/contracts";

export interface RunLeaseToken {
  readonly runId: string;
  readonly userId: string;
  readonly leaseOwner: string;
  readonly leaseEpoch: number;
}

type EventInput<T> = T extends RunEvent ? Pick<T, "type" | "payload"> : never;
export type RunEventInput = EventInput<RunEvent>;
export type RunProgressEvent = Exclude<
  RunEventInput,
  { type: `run.${string}` | "report.published" }
>;

export type RunFenceCode = "LEASE_LOST" | "RUN_CANCELED" | "DEADLINE_EXCEEDED";
export class RunFenceError extends Error {
  constructor(readonly code: RunFenceCode) {
    super(code);
    this.name = "RunFenceError";
  }
}

export const RUN_ACTIVE_STATUSES = ["queued", "running", "recovering", "cancel_requested"] as const;
export const RUN_FAILURE_MESSAGES: Readonly<Record<string, string>> = {
  EXECUTOR_NOT_CONFIGURED: "Agent 执行器尚未配置，未生成报告",
  EXECUTOR_FAILED: "执行器失败，未完成报告交付",
  EXECUTOR_RETURNED_WITHOUT_DELIVERY: "执行器已返回，但未完成报告交付",
  DEADLINE_EXCEEDED: "执行时间预算已耗尽，未完成报告交付",
  RECOVERY_LIMIT_EXCEEDED: "执行恢复次数已达到上限",
  INVALID_RUN_CONFIGURATION: "执行配置快照无效，未启动外部调用",
};
