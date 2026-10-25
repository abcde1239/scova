import { createApiApp } from "./app.ts";

const port = Number(process.env.PORT ?? 3000);
const app = createApiApp().listen(port);
console.log(`Scova API listening on http://localhost:${port}`);
const stop = async () => {
  await app.stop();
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
