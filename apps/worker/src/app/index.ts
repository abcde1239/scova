import { writeFile, unlink } from "node:fs/promises";
import { readWorkerConfig, type WorkerConfig } from "@/app/config.ts";
import { createWorkerResources, type WorkerResources } from "@/app/resources.ts";
import { waitForPoll } from "@/utils/wait.ts";
import type { RunExecutor } from "@/service/runs.ts";

export interface WorkerLogger {
  info(message: string): void;
  error(message: string): void;
}

export interface WorkerAppOptions {
  config?: WorkerConfig;
  resources?: WorkerResources;
  logger?: WorkerLogger;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  executor?: RunExecutor;
}

/** 串行轮询、启动失败清理与幂等停止；构造时不连接任何外部服务。 */
export function createWorkerApp(options: WorkerAppOptions = {}) {
  const config = options.config ?? readWorkerConfig();
  const resources =
    options.resources ?? createWorkerResources(config, { executor: options.executor });
  const logger = options.logger ?? console;
  const wait = options.wait ?? waitForPoll;
  const controller = new AbortController();
  let starting: Promise<void> | undefined;
  let loop: Promise<void> | undefined;
  let polling: Promise<void> | undefined;
  let scheduling: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  const close = () => (closing ??= resources.close());

  const heartbeatPath = process.env.WORKER_HEARTBEAT_PATH;
  const heartbeat = () =>
    heartbeatPath ? writeFile(heartbeatPath, "ready\n", { mode: 0o600 }) : Promise.resolve();
  async function poll() {
    while (!controller.signal.aborted) {
      let delay = config.pollIntervalMs;
      try {
        await resources.dispatch(controller.signal);
        if (!controller.signal.aborted) await heartbeat();
      } catch {
        delay = config.failureDelayMs;
        logger.error("Worker Outbox 批次失败，将退避后重试");
      }
      if (!controller.signal.aborted) await wait(delay, controller.signal);
    }
  }

  async function schedule() {
    if (!resources.schedule) return;
    while (!controller.signal.aborted) {
      let delay = config.schedulerIntervalMs;
      try {
        await resources.schedule(controller.signal);
      } catch {
        delay = Math.max(config.schedulerIntervalMs, config.failureDelayMs);
        logger.error("Worker 调度批次失败，将退避后重试");
      }
      if (!controller.signal.aborted) await wait(delay, controller.signal);
    }
  }

  const start = () => {
    if (controller.signal.aborted) return Promise.reject(new Error("Worker 已停止，不能重新启动"));
    return (starting ??= (async () => {
      try {
        await resources.connect();
        if (controller.signal.aborted) return;
        await heartbeat();
        logger.info("Scova worker ready; Outbox dispatcher running; Run consumer running");
        polling = poll();
        scheduling = schedule();
        loop = Promise.all([polling, scheduling, resources.finished?.()]).then(() => undefined);
        // 捕获后台循环自身故障；正常单批错误已由 poll 退避处理。
        void loop.catch(() => controller.abort());
      } catch (error) {
        controller.abort();
        try {
          await close();
        } catch {
          throw new AggregateError([error], "Worker 启动失败且资源清理失败");
        }
        throw error;
      }
    })());
  };

  const stop = () =>
    (stopping ??= (async () => {
      controller.abort();
      // 启动失败已经报告给 start 调用方；仍完成所有已创建资源的清理。
      await starting?.catch(() => undefined);
      try {
        const settled = await Promise.allSettled([resources.stop?.(), polling, scheduling, loop]);
        const failures = settled.filter((result) => result.status === "rejected");
        if (failures.length)
          throw new AggregateError(
            failures.map((result) => result.reason),
            "Worker 在途操作停止失败",
          );
      } finally {
        if (heartbeatPath) await unlink(heartbeatPath).catch(() => undefined);
        await close();
      }
    })());

  const finished = async () => {
    if (!starting) throw new Error("Worker 尚未启动");
    await starting;
    await loop;
  };
  return { start, stop, finished };
}
