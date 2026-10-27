import { createApiApp } from "../../src/app/index.ts";
import { createDefaultServices } from "../../src/app/context.ts";
import { acceptanceQuestionModel } from "./acceptance-question-model.ts";

// Isolated socket probe uses the production router, session service and database transport.
const services = createDefaultServices({
  production: false,
  ...(process.env.SCOVA_ACCEPTANCE_QUESTION_FIXTURE === "1"
    ? { reportQuestionModel: () => acceptanceQuestionModel }
    : {}),
  reportQuestionPolicy: {
    keyPrefix: process.env.SCOVA_ACCEPTANCE_RATE_PREFIX! + "questions:",
  },
  rateLimit: {
    keyPrefix: process.env.SCOVA_ACCEPTANCE_RATE_PREFIX!,
    registerAttempts: 1000,
    loginAttempts: 1000,
    globalAttempts: 10000,
  },
});
const app = createApiApp("node", services);
let closeHttp: (() => Promise<void>) | undefined;
let stopping: Promise<void> | undefined;
const stop = () =>
  (stopping ??= (async () => {
    try {
      await services.streams.stop();
      await closeHttp?.();
    } finally {
      await services.close();
      process.disconnect?.();
    }
  })());
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    void stop();
  });
process.on("message", (message) => {
  if (message === "scova:shutdown") void stop();
});
app.listen(Number(process.env.PORT), (server) => {
  closeHttp = async () => {
    await server.stop();
  };
  process.send?.({ type: "ready", pid: process.pid });
});
