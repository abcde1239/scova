import { createDatabaseClient, connectDatabase, closeDatabase } from '@scova/db';

import { Redis } from 'ioredis';
import { createWorkerApp } from '../../src/app/index.ts';
import { readWorkerConfig } from '../../src/app/config.ts';
import { createRunRepository } from '../../src/repo/runs.ts';
import { createOutboxRepository } from '../../src/repo/outbox.ts';
import { createRunHandler } from '../../src/handler/runs.ts';
import { createOutboxHandler } from '../../src/handler/outbox.ts';
import { createRunConsumer } from '../../src/queue/runs.ts';
import { createOutboxQueue } from '../../src/queue/outbox.ts';
import { RunService } from '../../src/service/runs.ts';
import { OutboxService } from '../../src/service/outbox.ts';
import { createAgentRuntime } from '../../src/service/agent.ts';
import {
    scenarioConnectors,
    scenarioNames,
    type ScenarioName,
    type ScenarioPhase,
} from './acceptance-scenario-fixtures.ts';

const config = readWorkerConfig();
const schema = new URL(config.databaseUrl).searchParams.get('schema');
const scenario = process.env.SCOVA_ACCEPTANCE_SCENARIO as ScenarioName;
const phase = process.env.SCOVA_ACCEPTANCE_PHASE as ScenarioPhase;
if (!schema || !/^scova_acceptance_[a-f0-9]{32}$/.test(schema))
    throw new Error('Acceptance worker requires its isolated test schema');
if (!scenarioNames.includes(scenario) || !['A', 'B', 'C'].includes(phase))
    throw new Error('Invalid acceptance scenario or phase');

const database = createDatabaseClient({ connectionString: config.databaseUrl });
const redis = new Redis(config.redisUrl, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
});
redis.on('error', () => undefined);
const agent = createAgentRuntime({
    database,
    databaseUrl: config.databaseUrl,
    checkpointSchema: schema,
    env: { ...process.env, AGENT_CHECKPOINT_MIGRATION: 'startup' },
    bundle: scenarioConnectors(scenario, phase, {
        queryForGoal: process.env.SCOVA_ACCEPTANCE_QUERY_FOR_GOAL === '1',
    }),
    enableDelivery: true,
});
let publisher: ReturnType<typeof createOutboxQueue> | undefined;
let dispatch: ReturnType<typeof createOutboxHandler> | undefined;
let consumer: ReturnType<typeof createRunConsumer> | undefined;
const app = createWorkerApp({
    config,
    resources: {
        async connect() {
            await connectDatabase(database);
            await redis.connect();
            publisher = createOutboxQueue(redis, config.queueName);
            await publisher.queue.waitUntilReady();
            dispatch = createOutboxHandler(
                new OutboxService({ repository: createOutboxRepository(database), publisher }),
                config.batchSize,
            );
            await agent.connect();
            consumer = createRunConsumer(
                config.redisUrl,
                config.queueName,
                createRunHandler(
                    new RunService({
                        repository: createRunRepository(database),
                        executorFactory: (token) => agent.executorFactory(token),
                        leaseMs: 30_000,
                        renewIntervalMs: 5_000,
                    }),
                ),
                1,
            );
            await consumer.start();
        },
        dispatch(signal) {
            if (!dispatch) throw new Error('Acceptance worker is not connected');
            return dispatch(signal);
        },
        stop: () => consumer?.stop() ?? Promise.resolve(),
        finished: () => consumer?.finished() ?? Promise.resolve(),
        async close() {
            try {
                await consumer?.stop();
            } finally {
                try {
                    await publisher?.close();
                } finally {
                    redis.disconnect();
                    try {
                        await agent.close();
                    } finally {
                        await closeDatabase(database);
                    }
                }
            }
        },
    },
});
let stopping: Promise<void> | undefined;
const stop = () => (stopping ??= app.stop().then(() => process.disconnect?.()));
process.on('message', (message) => {
    if (message === 'scova:shutdown') void stop();
});
for (const signal of ['SIGTERM', 'SIGINT'] as const)
    process.once(signal, () => {
        void stop();
    });
await app.start();
process.send?.({ type: 'ready', pid: process.pid, scenario, phase });
