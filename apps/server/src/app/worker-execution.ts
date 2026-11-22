import { serve } from 'srvx/node';
import type { DatabaseClient } from '@scova/db';
import { readSqliteStatePath } from '@scova/db/sqlite-state';
import { executionTokenPattern } from '@scova/shared/execution/protocol';
import { createExecutionService } from '../service/execution/protocol.ts';
import { createExecutionHandler } from '../handler/worker-execution.ts';

export function startWorkerExecution(
    db: () => DatabaseClient,
    env: NodeJS.ProcessEnv = process.env,
) {
    const secret = env.WORKER_EXECUTION_TOKEN;
    if (!secret) {
        if (env.WORKER_EXECUTION_PORT) throw new Error('缺少 WORKER_EXECUTION_TOKEN');
        return;
    }
    if (!executionTokenPattern.test(secret)) throw new Error('WORKER_EXECUTION_TOKEN 无效');
    const databaseUrl = env.DATABASE_URL;
    if (!databaseUrl) throw new Error('缺少 DATABASE_URL');
    const port = Number(env.WORKER_EXECUTION_PORT ?? 3001);
    if (!Number.isSafeInteger(port) || port < 0 || port > 65535)
        throw new Error('WORKER_EXECUTION_PORT 无效');
    const service = createExecutionService({
        db,
        databaseUrl,
        checkpointSchema: env.AGENT_CHECKPOINT_SCHEMA ?? 'scova_agent',
        sqlitePath: readSqliteStatePath(env),
        env,
    });
    const listener = serve({
        port,
        hostname: env.WORKER_EXECUTION_HOST ?? '127.0.0.1',
        silent: true,
        gracefulShutdown: false,
        fetch: createExecutionHandler(secret, service),
    });
    // Stop accepting new work, then drain accepted requests before closing the saver pools.
    return {
        listener,
        async stop() {
            try {
                await listener.close();
            } finally {
                await service.close();
            }
        },
    };
}
