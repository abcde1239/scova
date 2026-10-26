import { PrismaClient } from "@scova/models";
import {
  createConnectorBundle,
  type ConnectorBundle,
  type StructuredInput,
  type CallContext,
} from "@scova/connectors";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import pg from "pg";
import { createRunRepository } from "../../src/repo/runs.ts";
import { createAgentRepository } from "../../src/repo/agent.ts";
import { createAgentSession } from "../../src/service/agent.ts";

// Test-only process fault boundary. Production has no pause or checkpoint bypass hook.
const [phase, runId, boundary = "search"] = process.argv.slice(2);
if (
  !["crash", "resume"].includes(phase ?? "") ||
  !["search", "read"].includes(boundary) ||
  !/^[a-f0-9-]{36}$/.test(runId ?? "")
) {
  throw new Error("Invalid recovery fixture arguments");
}
const databaseUrl = process.env.DATABASE_URL!;
const schema = new URL(databaseUrl).searchParams.get("schema");
if (!schema || !/^scova_worker_[a-f0-9]{32}$/.test(schema))
  throw new Error("Invalid recovery schema");
const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const never = new Promise<void>(() => {});
let blocked = false;
async function beforeCheckpointWrite() {
  if (phase !== "crash") return;
  if (blocked) return never;
  const succeeded = await db.toolCall.findFirst({
    where: { runId, tool: boundary, status: "succeeded" },
  });
  if (!succeeded) return;
  blocked = true;
  process.send?.({ type: "settled-before-checkpoint", toolCallId: succeeded.id, pid: process.pid });
  await never;
}
class FaultBoundarySaver extends PostgresSaver {
  override async put(...args: Parameters<PostgresSaver["put"]>) {
    await beforeCheckpointWrite();
    return super.put(...args);
  }
  override async putWrites(...args: Parameters<PostgresSaver["putWrites"]>) {
    await beforeCheckpointWrite();
    return super.putWrites(...args);
  }
}
const saver = new FaultBoundarySaver(pool, undefined, { schema });
const base = createConnectorBundle();
async function count(kind: string, input: string) {
  await db.$executeRaw`INSERT INTO recovery_external_calls (run_id, kind, input) VALUES (${runId}::uuid, ${kind}, ${input})`;
}
const bundle: ConnectorBundle = {
  ...base,
  search: {
    async search(query, context) {
      await count("search", query);
      return base.search.search(query, context);
    },
  },
  reader: {
    async read(url, context) {
      await count("read", url);
      return base.reader.read(url, context);
    },
  },
  model: {
    async generateStructured<T>(input: StructuredInput, context?: CallContext) {
      await count("model", input.prompt);
      return base.model.generateStructured<T>(input, context);
    },
  },
};
try {
  await db.$connect();
  await saver.setup();
  const runs = createRunRepository(db);
  const claimed = await runs.claim(runId!, `agent-${phase}-${process.pid}`, 60_000);
  if (claimed.kind !== "claimed") throw new Error(`Cannot claim recovery run: ${claimed.kind}`);
  const { run, token } = claimed;
  const session = createAgentSession({
    repository: createAgentRepository(db, token),
    saver,
    token,
    bundle,
    context: {
      runId: run.id,
      userId: run.userId,
      taskId: run.taskId,
      taskVersionId: run.taskVersionId,
      mode: run.mode,
      config: claimed.config,
      budget: claimed.budget,
      usage: claimed.usage,
      deadlineAt: run.deadlineAt!,
      signal: new AbortController().signal,
      assertActive: () => runs.assertActive(token),
      emit: (event) => runs.emit(token, event),
    },
  });
  const candidate = await session.execute();
  process.send?.({ type: "candidate", candidate, pid: process.pid });
} catch (error) {
  process.send?.({ type: "error", message: error instanceof Error ? error.message : "unknown" });
  console.error(error);
  process.exitCode = 1;
} finally {
  await saver.end();
  await db.$disconnect();
  process.disconnect?.();
}
