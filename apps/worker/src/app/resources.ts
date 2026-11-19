import {
    createDatabaseClient,
    type DatabaseClient,
    connectDatabase,
    closeDatabase,
} from '@scova/db';
import type { WorkerConfig } from '@/app/config.ts';
import { createRunRepository } from '@/repo/runs.ts';
import { createRunHandler } from '@/handler/runs.ts';
import { RunService, type RunExecutor } from '@/service/runs.ts';
import { createRunConsumer } from '@/app/queue/runs.ts';
import { createAgentRuntime } from '@/service/agent.ts';

export interface WorkerResources {
    connect(): Promise<void>;
    isReady(): boolean;
    stop(): Promise<void>;
    finished(): Promise<void>;
    close(): Promise<void>;
}

/** Worker 仅装配 Run consumer 和当前执行所需的 Agent 依赖。 */
export function createWorkerResources(
    config: WorkerConfig,
    options: { executor?: RunExecutor } = {},
): WorkerResources {
    let database: DatabaseClient | undefined;
    let connecting: Promise<void> | undefined;
    let closing: Promise<void> | undefined;
    let consumer: ReturnType<typeof createRunConsumer> | undefined;
    let agent: ReturnType<typeof createAgentRuntime> | undefined;
    const stop = () => consumer?.stop() ?? Promise.resolve();
    return {
        connect: () =>
            (connecting ??= (async () => {
                database = createDatabaseClient({
                    connectionString: config.databaseUrl,
                    applicationName: 'scova-worker',
                });
                await connectDatabase(database);
                if (!options.executor) {
                    agent = createAgentRuntime({
                        databaseUrl: config.databaseUrl,
                        database,
                        env: { ...process.env, REDIS_URL: config.redisUrl },
                        enableDelivery: true,
                    });
                    await agent.connect();
                }
                const leaseMs = config.runLeaseSeconds * 1000;
                const runHandler = createRunHandler(
                    new RunService({
                        repository: createRunRepository(database),
                        executor: options.executor,
                        executorFactory: agent
                            ? (token) => agent!.executorFactory(token)
                            : undefined,
                        leaseMs,
                        renewIntervalMs: Math.min(10_000, Math.floor(leaseMs / 3)),
                    }),
                );
                consumer = createRunConsumer(
                    config.redisUrl,
                    config.queueName,
                    runHandler,
                    config.runConcurrency,
                );
                await consumer.start();
            })()),
        isReady: () => consumer?.isReady() ?? false,
        stop,
        finished: () => consumer?.finished() ?? Promise.resolve(),
        close: () =>
            (closing ??= (async () => {
                try {
                    await stop();
                } finally {
                    try {
                        await agent?.close();
                    } finally {
                        if (database) await closeDatabase(database);
                    }
                }
            })()),
    };
}
