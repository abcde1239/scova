import { createApiApp } from "./app.ts";

/** 使用 Elysia 官方 Node 适配器，避免手工转换流、Cookie 和请求头。 */
let closeServer: (() => Promise<void>) | undefined;
createApiApp("node").listen(Number(process.env.PORT ?? 3000), (server) => {
  // adapter 1.4.5 通过回调暴露 server，尚未设置 app.server；使用其公开 stop。
  closeServer = async () => {
    await server.stop();
  };
});
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await closeServer?.();
  process.disconnect?.();
};
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void stop();
  });
}
if (process.connected)
  process.on("message", (message) => {
    if (message === "scova:shutdown") void stop();
  });
