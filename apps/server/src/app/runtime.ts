import { createApiApp } from "@/app/index.ts";
import { createDefaultServices } from "@/app/context.ts";

/** Bun 与 Node 共用生命周期；Node 的 server.stop 通过官方适配器回调获得。 */
export function startServer(runtime: "bun" | "node") {
  const services = createDefaultServices();
  const app = createApiApp(runtime, services);
  const port = Number(process.env.PORT ?? 3000);
  let closeHttp: (() => Promise<void>) | undefined;
  if (runtime === "node") {
    app.listen(port, (server) => {
      closeHttp = async () => {
        await server.stop();
      };
    });
  } else {
    app.listen(port);
    closeHttp = async () => {
      await app.stop();
    };
  }
  console.log(`Scova API listening on http://localhost:${port}`);
  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      try {
        await closeHttp?.();
      } finally {
        try {
          await services.close();
        } finally {
          process.disconnect?.();
        }
      }
    })());
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void stop();
    });
  }
  if (process.connected)
    process.on("message", (message) => {
      if (message === "scova:shutdown") void stop();
    });
  return { app, stop };
}
