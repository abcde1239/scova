import { prepareTestCheckpointSchema } from './checkpoint-schema.ts';
import { ConnectorError } from '@scova/connectors';
import { createDatabaseClient, connectDatabase, closeDatabase } from '@scova/db';

import { createWorkerApp } from '../../src/app/index.ts';
import { readWorkerConfig } from '../../src/app/config.ts';
import { createRunRepository } from '../../../server/src/repo/execution/runs.ts';
import { createRunHandler } from '../../src/handler/runs.ts';
import { createRunConsumer } from '../../src/app/queue/runs.ts';
import { RunService } from '../../src/service/runs.ts';
import { createLocalAgentRuntime as createAgentRuntime } from './local-agent-runtime.ts';
import {
    scenarioConnectors,
    scenarioNames,
    type ScenarioName,
    type ScenarioPhase,
} from './acceptance-scenario-fixtures.ts';

const config = readWorkerConfig({ ...process.env, WORKER_EXECUTION_TOKEN: 'fixture'.repeat(5) });
const databaseUrl = process.env.DATABASE_URL!;
const schema = new URL(databaseUrl).searchParams.get('schema');
const scenario: ScenarioName = 'english';
const phase: ScenarioPhase = 'A';
if (!schema || !/^scova_worker_[a-f0-9]{32}$/.test(schema))
    throw new Error('Acceptance worker requires its isolated test schema');
if (!scenarioNames.includes(scenario) || !['A', 'B', 'C'].includes(phase))
    throw new Error('Invalid acceptance scenario or phase');

const database = createDatabaseClient({ connectionString: databaseUrl });
const fixtureBundle = scenarioConnectors(scenario, phase);
const agent = createAgentRuntime({
    database,
    databaseUrl,
    checkpointSchema: process.env.AGENT_CHECKPOINT_SCHEMA,
    bundle: {
        ...fixtureBundle,
        reader: {
            async read(...args) {
                // The task deliberately includes a preferred source outside the controlled catalog.
                // This is a supplier/source failure, not a fixture implementation fault.
                if (!args[0].startsWith('https://acceptance.example.org/english/'))
                    throw new ConnectorError(
                        'extraction_failed',
                        'Controlled preferred source has no readable body',
                    );
                const page = await fixtureBundle.reader.read(...args);
                return { ...page, truncated: true };
            },
        },
    },
    enableDelivery: true,
});
let consumer: ReturnType<typeof createRunConsumer> | undefined;
const app = createWorkerApp({
    config,
    resources: {
        async connect() {
            await connectDatabase(database);
            await prepareTestCheckpointSchema(databaseUrl, process.env.AGENT_CHECKPOINT_SCHEMA);
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
