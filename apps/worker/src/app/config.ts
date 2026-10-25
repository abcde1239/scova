export interface WorkerConfig {
  databaseUrl: string;
  redisUrl: string;
  queueName: string;
  pollIntervalMs: number;
  failureDelayMs: number;
  batchSize: number;
  leaseSeconds: number;
  runLeaseSeconds: number;
  runConcurrency: number;
}

function integerSetting(env: NodeJS.ProcessEnv, name: string, fallback: number, maximum: number) {
  const value = env[name] === undefined ? fallback : Number(env[name]);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new Error(`${name} 必须为 1 至 ${maximum} 的整数`);
  return value;
}

function connectionUrl(env: NodeJS.ProcessEnv, name: string, protocols: string[]) {
  try {
    const input = env[name];
    if (!input) throw new Error();
    const url = new URL(input);
    if (!protocols.includes(url.protocol) || !url.hostname) throw new Error();
    return input;
  } catch {
    throw new Error(`${name} 缺失或连接地址无效`);
  }
}

/** 缺配置明确失败，错误仅指出变量名，不包含连接凭据。 */
export function readWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const queueName = env.WORKER_QUEUE_NAME ?? "scova-runs";
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(queueName))
    throw new Error("WORKER_QUEUE_NAME 仅允许 1 至 100 位字母、数字、下划线或连字符");
  return {
    databaseUrl: connectionUrl(env, "DATABASE_URL", ["postgresql:", "postgres:"]),
    redisUrl: connectionUrl(env, "REDIS_URL", ["redis:", "rediss:"]),
    queueName,
    pollIntervalMs: integerSetting(env, "WORKER_POLL_INTERVAL_MS", 1000, 300_000),
    failureDelayMs: integerSetting(env, "WORKER_FAILURE_DELAY_MS", 5000, 300_000),
    batchSize: integerSetting(env, "WORKER_BATCH_SIZE", 50, 1000),
    leaseSeconds: integerSetting(env, "WORKER_LEASE_SECONDS", 30, 3600),
    runLeaseSeconds: integerSetting(env, "WORKER_RUN_LEASE_SECONDS", 30, 3600),
    runConcurrency: integerSetting(env, "WORKER_RUN_CONCURRENCY", 2, 32),
  };
}
