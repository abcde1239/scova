import pg from "pg";
import { databaseSettings, schemaName } from "@/utils/operations.ts";

export function operationConfig(env: NodeJS.ProcessEnv = process.env) {
  if (!env.DATABASE_URL) throw new Error("缺少 DATABASE_URL");
  return {
    ...databaseSettings(env.DATABASE_URL),
    databaseUrl: env.DATABASE_URL,
    checkpointSchema: schemaName(env.AGENT_CHECKPOINT_SCHEMA ?? "scova_agent"),
    backupDirectory: env.SCOVA_BACKUP_DIRECTORY ?? "/backups",
    offline: env.SCOVA_MAINTENANCE === "1",
    redisUrl: env.REDIS_URL,
    queueName: env.WORKER_QUEUE_NAME ?? "scova-runs",
    heartbeatPath: env.WORKER_HEARTBEAT_PATH ?? "/tmp/scova-worker-ready",
  };
}
export type OperationConfig = ReturnType<typeof operationConfig>;
export function operationPool(config: OperationConfig) {
  return new pg.Pool({
    connectionString: config.connectionString,
    max: 2,
    connectionTimeoutMillis: 5000,
    statement_timeout: 30_000,
    application_name: "scova-operations",
  });
}
