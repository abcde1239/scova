import { createWorkerApp } from "@/app/index.ts";

/** Bun 和 Node 共享信号/IPC处理；只向日志输出固定的脱敏消息。 */
export async function startWorker() {
  let app: ReturnType<typeof createWorkerApp> | undefined;
  let stopping: Promise<void> | undefined;
  const shutdown = () =>
    (stopping ??= (async () => {
      try {
        await app?.stop();
      } catch {
        console.error("Worker 关闭失败");
        process.exitCode = 1;
      } finally {
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
        process.off("message", onMessage);
        process.disconnect?.();
      }
    })());
  const onSignal = () => {
    void shutdown();
  };
  const onMessage = (message: unknown) => {
    if (message === "scova:shutdown") void shutdown();
  };
  try {
    app = createWorkerApp();
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    if (process.connected) process.on("message", onMessage);
    await app.start();
    await app.finished();
    await shutdown();
  } catch {
    console.error("Worker 启动或运行失败，请检查数据库、Redis 与 Worker 配置");
    process.exitCode = 1;
    await shutdown();
  }
}
