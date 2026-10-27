import { randomUUID } from "node:crypto";
import type { Budget, TaskConfig, Usage } from "@scova/contracts";
import type { RunRepository } from "@/repo/runs.ts";
import {
  RunExecutionError,
  RunFenceError,
  type RunProgressEvent,
  type RunLeaseToken,
} from "@/utils/runs.ts";
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
  readonly startedAt?: Date;
  readonly signal: AbortSignal;
  assertActive(): Promise<void>;
  emit(event: RunProgressEvent): Promise<void>;
}

export interface RunExecutor {
  /** #14 注入持久化 Agent；#16 交付事务负责成功，返回 void 本身不是成功。 */
  execute(context: RunExecutionContext): Promise<void>;
  /** Trusted worker adapter: persisted evidence only, still fenced against cancel/lost lease. */
  onDeadline?(context: RunExecutionContext): Promise<void>;
  /** Wait only for already-started persistence work, never external provider promises. */
  drain?(): Promise<void>;
}

export interface RunServiceOptions {
  repository: RunRepository;
  executor?: RunExecutor;
  /** Trusted worker factory receives the lease; agent-core never receives it. */
  executorFactory?: (token: RunLeaseToken) => RunExecutor;
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
  private readonly executorFactory: RunServiceOptions["executorFactory"];
  private readonly workerId: string;
  private readonly leaseMs: number;
  private readonly renewIntervalMs: number;

  constructor(options: RunServiceOptions) {
    this.repository = options.repository;
    this.executor = options.executor;
    this.executorFactory = options.executorFactory;
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
    const claimed = await this.repository.claim(runId, this.workerId, this.leaseMs, {
      allowDeadlineRecovery: !!(this.executor?.onDeadline || this.executorFactory),
    });
    if (claimed.kind !== "claimed") return claimed.kind;
    const { token, run } = claimed;
    const executor = this.executor ?? this.executorFactory?.(token);
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
      controller.abort(next);
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
    // 用 PG 返回的剩余时长和单调时钟独立计时；慢续期不能推迟外部调用中断。
    const deadlineDelayMs = run.deadlineAt!.getTime() - claimed.now.getTime();
    const deadlineStartedAt = performance.now();
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleDeadline = () => {
      const remainingMs = deadlineDelayMs - (performance.now() - deadlineStartedAt);
      if (remainingMs <= 0) {
        abort("deadline");
        return;
      }
      // 正常预算只需一次定时；极长的已有快照分段，避免 Node 定时器整数溢出。
      deadlineTimer = setTimeout(scheduleDeadline, Math.min(Math.ceil(remainingMs), 2_147_483_647));
    };
    scheduleDeadline();
    const heartbeat = (async () => {
      while (!controller.signal.aborted) {
        await waitForPoll(this.renewIntervalMs, controller.signal);
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
    let context: RunExecutionContext | undefined;
    let deadlineHandled = false;
    const handleDeadline = async () => {
      if (reason !== "deadline" || deadlineHandled || !context || !executor?.onDeadline) return;
      deadlineHandled = true;
      await track(() => executor.onDeadline!(context!)).catch(() => undefined);
    };
    try {
      if (!executor) {
        await assertActive();
        await this.repository.finish(token, { code: "EXECUTOR_NOT_CONFIGURED" });
        return "processed";
      }
      context = {
        runId: run.id,
        userId: run.userId,
        taskId: run.taskId,
        taskVersionId: run.taskVersionId,
        mode: run.mode,
        config: claimed.config,
        budget: claimed.budget,
        usage: claimed.usage,
        deadlineAt: run.deadlineAt!,
        startedAt: run.startedAt!,
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
      await assertActive();
      // 不合作的执行器也不能阻止停止或租约失效；迟到返回只被丢弃。
      const execution = Promise.resolve()
        .then(async () => {
          await assertActive();
          return executor.execute(context!);
        })
        .then(
          () => ({ kind: "returned" as const }),
          (error: unknown) => ({
            kind: "failed" as const,
            code: error instanceof RunExecutionError ? error.code : "EXECUTOR_FAILED",
          }),
        );
      const result = await Promise.race([execution, aborted]);
      if (reason === "stop" || reason === "lost") return reason === "stop" ? "stopped" : "ignored";
      if (reason === "deadline") {
        // This callback has no external tools; its domain read/delivery validates current lease and cancellation.
        await handleDeadline();
      }
      await this.repository.finish(token, {
        code:
          reason === "deadline"
            ? "DEADLINE_EXCEEDED"
            : result !== "aborted" && result.kind === "returned"
              ? "EXECUTOR_RETURNED_WITHOUT_DELIVERY"
              : result !== "aborted"
                ? result.code
                : "EXECUTOR_FAILED",
      });
      return "processed";
    } catch (error) {
      if (reason === "stop" || reason === "lost") return reason === "stop" ? "stopped" : "ignored";
      if (error instanceof RunFenceError && error.code === "LEASE_LOST") return "ignored";
      await handleDeadline();
      await this.repository.finish(token, {
        code: reason === "deadline" ? "DEADLINE_EXCEEDED" : "EXECUTOR_FAILED",
      });
      return "processed";
    } finally {
      abort("finished");
      clearTimeout(deadlineTimer);
      signal?.removeEventListener("abort", stopping);
      if (wakeAbort) controller.signal.removeEventListener("abort", wakeAbort);
      await heartbeat;
      // 停止后拒绝新领域操作，已发起的短数据库事务收敛后才能释放连接。
      await Promise.allSettled(pending);
      await executor?.drain?.();
    }
  }
}
