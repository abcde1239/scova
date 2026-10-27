import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { nodeScriptCommand } from "../../../../scripts/process-runtime.mjs";
import type {
  ScenarioName,
  ScenarioPhase,
} from "../../../worker/tests/support/acceptance-scenario-fixtures.ts";
export async function startAcceptanceWorker(options: {
  databaseUrl: string;
  redisUrl: string;
  name: ScenarioName;
  phase: ScenarioPhase;
  queueName: string;
  queryForGoal?: boolean;
}) {
  const { databaseUrl, redisUrl, name, phase, queueName } = options;
  const command = nodeScriptCommand("tests/support/acceptance-scenario-process.ts");
  const child = spawn(command.executable, command.args, {
    cwd: fileURLToPath(new URL("../../../worker/", import.meta.url)),
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      REDIS_URL: redisUrl,
      WORKER_QUEUE_NAME: queueName,
      WORKER_POLL_INTERVAL_MS: "25",
      WORKER_FAILURE_DELAY_MS: "25",
      SCOVA_ACCEPTANCE_SCENARIO: name,
      SCOVA_ACCEPTANCE_PHASE: phase,
      SCOVA_ACCEPTANCE_QUERY_FOR_GOAL: options.queryForGoal ? "1" : "0",
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  let output = "";
  for (const stream of [child.stdout!, child.stderr!])
    stream.on("data", (chunk) => {
      output = (output + String(chunk)).slice(-16_000);
    });
  const ended = new Promise<number | null>((resolve) => child.once("exit", resolve));
  const stop = async () => {
    if (child.exitCode === null && !child.killed) {
      if (child.connected) child.send("scova:shutdown");
      else child.kill();
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const code = await Promise.race([
        ended,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            child.kill();
            reject(new Error("Acceptance worker shutdown timed out: " + output));
          }, 15_000);
        }),
      ]);
      if (code !== 0) throw new Error("Acceptance worker exited: " + code + " " + output);
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    await ready(child, () => output);
  } catch (error) {
    await stop().catch(() => undefined);
    throw error;
  }
  return { stop, output: () => output };
}
function ready(child: ChildProcess, output: () => string) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Acceptance worker startup timed out: " + output()));
    }, 20_000);
    const message = (value: unknown) => {
      if ((value as { type?: string }).type === "ready") {
        cleanup();
        resolve();
      }
    };
    const exited = (code: number | null) => {
      cleanup();
      reject(new Error("Acceptance worker exited before ready: " + code + " " + output()));
    };
    const failed = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off("message", message);
      child.off("exit", exited);
      child.off("error", failed);
    };
    child.on("message", message);
    child.once("exit", exited);
    child.once("error", failed);
  });
}
