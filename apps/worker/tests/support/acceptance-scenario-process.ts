import { prepareTestCheckpointSchema } from './checkpoint-schema.ts';
import { createDatabaseClient, connectDatabase, closeDatabase } from '@scova/db';

import { createWorkerApp } from '../../src/app/index.ts';
import { readWorkerConfig } from '../../src/app/config.ts';
import { createRunRepository } from '../../src/repo/runs.ts';
import { createRunHandler } from '../../src/handler/runs.ts';
import { createRunConsumer } from '../../src/app/queue/runs.ts';
import { RunService } from '../../src/service/runs.ts';
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
const agent = createAgentRuntime({
    database,
    databaseUrl: config.databaseUrl,
    checkpointSchema: schema,
    bundle: scenarioConnectors(scenario, phase, {
        queryForGoal: process.env.SCOVA_ACCEPTANCE_QUERY_FOR_GOAL === '1',
    }),
    enableDelivery: true,
});
let consumer: ReturnType<typeof createRunConsumer> | undefined;
const app = createWorkerApp({
    config,
    resources: {
        async connect() {
            await connectDatabase(database);
            await prepareTestCheckpointSchema(config.databaseUrl, schema);
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
        isReady: () => consumer?.isReady() ?? false,
        stop: () => consumer?.stop() ?? Promise.resolve(),
        finished: () => consumer?.finished() ?? Promise.resolve(),
        async close() {
            try {
                await consumer?.stop();
            } finally {
                try {
                    await agent.close();
                } finally {
                    await closeDatabase(database);
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
