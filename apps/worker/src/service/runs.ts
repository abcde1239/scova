import { randomUUID } from "node:crypto";
import type { Budget, TaskConfig, Usage } from "@scova/contracts";
import type { RunRepository } from "@/repo/runs.ts";
import { RunFenceError, type RunProgressEvent } from "@/utils/runs.ts";
import { waitForPoll } from "@/utils/wait.ts";

export interface RunExecutionContext {
  readonly runId: string;
  readonly userId: string;
  readonly taskId: string;
  readonly taskVersionId: string;
  readonly mode: "demo" | "live";
  readonly config: TaskConfig;
  readonly budget: Budget;
  readonly usage: Usage;
  readonly deadlineAt: Date;
  readonly signal: AbortSignal;
  assertActive(): Promise<void>;
  emit(event: RunProgressEvent): Promise<void>;
}

export interface RunExecutor {
  /** #14 注入持久化 Agent；#16 交付事务负责成功，返回 void 本身不是成功。 */
  execute(context: RunExecutionContext): Promise<void>;
}

export interface RunServiceOptions {
  repository: RunRepository;
  executor?: RunExecutor;
  workerId?: string;
  leaseMs?: number;
  renewIntervalMs?: number;
}

export type RunExecutionResult = "processed" | "ignored" | "busy" | "stopped";
type AbortReason = "stop" | "lost" | "canceled" | "deadline" | "finished";

/** 外部执行不持数据库锁；续期、控制终结与所有进度写入均使用 PG fencing。 */
export class RunService {
  private readonly repository: RunRepository;
  private readonly executor: RunExecutor | undefined;
  private readonly workerId: string;
  private readonly leaseMs: number;
  private readonly renewIntervalMs: number;

  constructor(options: RunServiceOptions) {
    this.repository = options.repository;
    this.executor = options.executor;
    this.workerId = options.workerId ?? `worker-${randomUUID()}`;
    this.leaseMs = options.leaseMs ?? 30_000;
    this.renewIntervalMs = options.renewIntervalMs ?? Math.max(1, Math.floor(this.leaseMs / 3));
    if (!Number.isSafeInteger(this.leaseMs) || this.leaseMs < 3 || this.leaseMs > 3_600_000)
      throw new Error("Run 租约毫秒数必须为 3 至 3600000 的整数");
    if (
      !Number.isSafeInteger(this.renewIntervalMs) ||
      this.renewIntervalMs < 1 ||
      this.renewIntervalMs >= this.leaseMs
    )
      throw new Error("Run 续期间隔必须为小于租约的正整数毫秒数");
  }

  async execute(runId: string, signal?: AbortSignal): Promise<RunExecutionResult> {
    if (signal?.aborted) return "stopped";
    const claimed = await this.repository.claim(runId, this.workerId, this.leaseMs);
    if (claimed.kind !== "claimed") return claimed.kind;
    const { token, run } = claimed;
    if (signal?.aborted) return "stopped";
    const controller = new AbortController();
    const pending = new Set<Promise<unknown>>();
    const track = <T>(operation: () => Promise<T>): Promise<T> => {
      const task = operation();
      pending.add(task);
      void task.then(
        () => pending.delete(task),
        () => pending.delete(task),
      );
      return task;
    };
    let reason: AbortReason | undefined;
    const abort = (next: AbortReason) => {
      if (controller.signal.aborted) return;
      reason = next;
      controller.abort();
    };
    const stopping = () => abort("stop");
    signal?.addEventListener("abort", stopping, { once: true });
    let wakeAbort: (() => void) | undefined;
    const aborted = new Promise<"aborted">((resolve) => {
      wakeAbort = () => resolve("aborted");
      controller.signal.addEventListener("abort", wakeAbort, { once: true });
    });
    const handleFenceError = (error: unknown) => {
      if (error instanceof RunFenceError)
        abort(
          error.code === "RUN_CANCELED"
            ? "canceled"
            : error.code === "DEADLINE_EXCEEDED"
              ? "deadline"
              : "lost",
        );
    };
    const assertActive = async () => {
      if (controller.signal.aborted) throw new Error("Run 执行已停止");
      try {
        await track(() => this.repository.assertActive(token));
      } catch (error) {
        handleFenceError(error);
        throw error;
      }
      if (controller.signal.aborted) throw new Error("Run 执行已停止");
    };
    // 使用数据库返回的剩余时长调度检查，不把宿主机与 PG 的绝对时钟作比较。
    let remainingMs = run.deadlineAt!.getTime() - claimed.now.getTime();
    const heartbeat = (async () => {
      while (!controller.signal.aborted) {
        const interval = Math.max(1, Math.min(this.renewIntervalMs, remainingMs));
        const started = performance.now();
        await waitForPoll(interval, controller.signal);
        remainingMs -= performance.now() - started;
        if (controller.signal.aborted) return;
        try {
          const result = await this.repository.renew(token, this.leaseMs);
          if (result !== "renewed") {
            abort(result);
            return;
          }
        } catch {
          // DB 不可用时停止外部动作；不能猜测仍持有租约或写失败覆盖接管者。
          abort("lost");
          return;
        }
      }
    })();
    try {
      await assertActive();
      if (!this.executor) {
        await this.repository.finish(token, { code: "EXECUTOR_NOT_CONFIGURED" });
        return "processed";
      }
      const context: RunExecutionContext = {
        runId: run.id,
        userId: run.userId,
        taskId: run.taskId,
        taskVersionId: run.taskVersionId,
        mode: run.mode,
        config: claimed.config,
        budget: claimed.budget,
        usage: claimed.usage,
        deadlineAt: run.deadlineAt!,
        signal: controller.signal,
        assertActive,
        emit: async (event) => {
          if (controller.signal.aborted) throw new Error("Run 执行已停止");
          try {
            await track(() => this.repository.emit(token, event));
          } catch (error) {
            handleFenceError(error);
            throw error;
          }
        },
      };
      // 不合作的执行器也不能阻止停止或租约失效；迟到返回只被丢弃。
      const execution = Promise.resolve()
        .then(async () => {
          await assertActive();
          return this.executor!.execute(context);
        })
        .then(
          () => "returned" as const,
          () => "failed" as const,
        );
      const result = await Promise.race([execution, aborted]);
      if (reason === "stop" || reason === "lost") return reason === "stop" ? "stopped" : "ignored";
      await this.repository.finish(token, {
        code:
          reason === "deadline"
            ? "DEADLINE_EXCEEDED"
            : result === "returned"
              ? "EXECUTOR_RETURNED_WITHOUT_DELIVERY"
              : "EXECUTOR_FAILED",
      });
      return "processed";
    } catch (error) {
      if (reason === "stop" || reason === "lost") return reason === "stop" ? "stopped" : "ignored";
      if (error instanceof RunFenceError && error.code === "LEASE_LOST") return "ignored";
      await this.repository.finish(token, {
        code: reason === "deadline" ? "DEADLINE_EXCEEDED" : "EXECUTOR_FAILED",
      });
      return "processed";
    } finally {
      abort("finished");
      signal?.removeEventListener("abort", stopping);
      if (wakeAbort) controller.signal.removeEventListener("abort", wakeAbort);
      await heartbeat;
      // 停止后拒绝新领域操作，已发起的短数据库事务收敛后才能释放连接。
      await Promise.allSettled(pending);
    }
  }
}
