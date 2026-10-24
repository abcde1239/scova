/**
 * Worker 运行时边界。Issue #2 只建立入口；Redis、BullMQ、PostgreSQL 和
 * LangGraph 的真实连接与恢复协议分别在 Issue #3、#5、#12、#14 实现。
 */
export type WorkerDependency = "postgresql" | "redis" | "bullmq" | "langgraph";

export const workerDependencies: readonly WorkerDependency[] = [
  "postgresql",
  "redis",
  "bullmq",
  "langgraph",
];

if (process.env.SCOVA_WORKER_START === "1") {
  console.log(`Scova worker ready; dependencies reserved: ${workerDependencies.join(", ")}`);
  // 保持进程可运行并支持优雅退出；后续由队列连接替代心跳句柄。
  const heartbeat = setInterval(() => {}, 60_000);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      clearInterval(heartbeat);
    });
  }
}
