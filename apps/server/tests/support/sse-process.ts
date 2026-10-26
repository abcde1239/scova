import { PrismaClient } from "@scova/models";
import { createDefaultServices } from "../../src/app/context.ts";
import { createStreamRegistry } from "../../src/app/streams.ts";
import { startServer } from "../../src/app/runtime.ts";

// Only this test entry injects short timing and telemetry; production uses fixed default policy.
const database = new PrismaClient();
let reads = 0,
  opened = 0,
  closed = 0;
const observed = database.$extends({
  query: {
    session: {
      async findFirst({ args, query }) {
        reads += 1;
        return query(args);
      },
    },
  },
});
const registry = createStreamRegistry();
const services = createDefaultServices({
  db: () => observed as unknown as PrismaClient,
  close: () => database.$disconnect(),
  streams: {
    register(abort, done) {
      opened += 1;
      registry.register(abort, done);
      void done.then(() => {
        closed += 1;
      });
    },
    stop: () => registry.stop(),
  },
  sse: { pollIntervalMs: 20, heartbeatMs: 100, slowClientMs: 500 },
});
startServer(process.env.SCOVA_SSE_TEST_RUNTIME === "bun" ? "bun" : "node", { services });
process.on("message", (message) => {
  if (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    message.type === "sse:stats"
  )
    process.send?.({ type: "sse:stats", reads, opened, closed });
});
