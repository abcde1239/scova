import type { WorkerConfig } from '@/app/config.ts';
import { createExecutionClient } from '@/repo/execution.ts';
import { createRunHandler } from '@/handler/runs.ts';
import { RunService, type RunExecutor } from '@/service/runs.ts';
import { createRunConsumer } from '@/app/queue/runs.ts';
import { createSqliteRunConsumer } from '@/app/queue/sqlite-runs.ts';
import { createAgentRuntime } from '@/service/agent.ts';
import type { ConnectorBundle } from '@scova/connectors';

export interface WorkerResources {
    connect(signal?: AbortSignal): Promise<void>;
    isReady(): boolean;
    stop(): Promise<void>;
    finished(): Promise<void>;
    close(): Promise<void>;
}

export function createWorkerResources(
    config: WorkerConfig,
    options: { executor?: RunExecutor; bundle?: ConnectorBundle } = {},
): WorkerResources {
    const execution = createExecutionClient(config.executionUrl, config.executionToken);
    let connecting: Promise<void> | undefined;
    let closing: Promise<void> | undefined;
    let consumer: ReturnType<typeof createRunConsumer | typeof createSqliteRunConsumer> | undefined;
    let agent: ReturnType<typeof createAgentRuntime> | undefined;
    const stop = () => consumer?.stop() ?? Promise.resolve();
    return {
        connect: (signal) =>
            (connecting ??= (async () => {
                const { queue, queueName } = await execution.waitUntilReady(signal);
                if (config.queueName !== queueName)
                    throw new Error('Worker 与 Server 的队列名称不一致');
                if (queue === 'bullmq' && !config.redisUrl) throw new Error('缺少 REDIS_URL');
                if (!options.executor) {
                    agent = createAgentRuntime({
                        persistence: { ...execution.persistence, ready: async () => undefined },
                        env: { ...process.env, REDIS_URL: config.redisUrl },
                        localSearch: queue === 'sqlite' ? execution.sqliteSearch : undefined,
                        bundle: options.bundle,
                    });
                    await agent.connect();
                }
                const leaseMs = config.runLeaseSeconds * 1000;
                const runHandler = createRunHandler(
                    new RunService({
                        repository: execution.runs,
                        executor: options.executor,
                        executorFactory: agent?.executorFactory.bind(agent),
                        leaseMs,
                        renewIntervalMs: Math.min(10_000, Math.floor(leaseMs / 3)),
                    }),
                );
                consumer =
                    queue === 'sqlite'
                        ? createSqliteRunConsumer(
                              execution.sqliteQueue,
                              runHandler,
                              config.runConcurrency,
                          )
                        : createRunConsumer(
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
                    await agent?.close();
                }
            })()),
    };
}
