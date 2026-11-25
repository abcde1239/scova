import { serve } from 'srvx';
import type { DatabaseClient } from '@scova/db';
import { readLocalSqlitePaths } from './sqlite-local.ts';
import { readSqliteStatePath } from '@scova/db/sqlite-state';
import { executionTokenPattern } from '@scova/execution/protocol';
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
    const localSqlite = readLocalSqlitePaths(env);
    const databaseUrl = env.DATABASE_URL || undefined;
    if (!databaseUrl && !localSqlite) throw new Error('缺少 DATABASE_URL');
    const port = Number(env.WORKER_EXECUTION_PORT ?? 3001);
    if (!Number.isSafeInteger(port) || port < 0 || port > 65535)
        throw new Error('WORKER_EXECUTION_PORT 无效');
    const service = createExecutionService({
        db,
        databaseUrl,
        checkpointSchema: env.AGENT_CHECKPOINT_SCHEMA ?? 'scova_agent',
        sqlitePath: localSqlite?.state ?? readSqliteStatePath(env),
        env,
    });
    const handle = createExecutionHandler(secret, service);
    let draining = false;
    const listener = serve({
        port,
        hostname: localSqlite ? '127.0.0.1' : (env.WORKER_EXECUTION_HOST ?? '127.0.0.1'),
        silent: true,
        gracefulShutdown: false,
        // The handler enforces per-operation limits and returns the protocol JSON error.
        // Allow the longest Worker delivery request (30s) to finish.
        bun: { maxRequestBodySize: Number.MAX_SAFE_INTEGER, idleTimeout: 60 },
        fetch(request) {
            // Bun can reuse an existing keep-alive socket after its listener stops accepting TCP.
            if (draining)
                return Response.json(
                    { code: 'EXECUTION_UNAVAILABLE' },
                    {
                        status: 503,
                        headers: { connection: 'close', 'cache-control': 'no-store' },
                    },
                );
            return handle(request);
        },
    });
    // Stop accepting new work, then drain accepted requests before closing the saver pools.
    return {
        listener,
        async stop() {
            draining = true;
            try {
                await listener.close();
            } finally {
                await service.close();
            }
        },
    };
}
