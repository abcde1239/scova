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

/** Worker execution adapters report only stable, allowlisted failure codes. */
export class RunExecutionError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "RunExecutionError";
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
  AGENT_CONFIGURATION_INVALID: "真实研究服务配置不完整或模式不符，未切换演示服务",
  AGENT_DELIVERY_NOT_CONFIGURED: "研究候选已保存，但报告交付服务尚未接入",
};
