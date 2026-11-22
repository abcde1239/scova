import { createDatabaseClient, closeDatabase } from '@scova/db';
import { prepareTestCheckpointSchema } from './checkpoint-schema.ts';
import { testWorkerExecution } from './worker-execution.ts';
import { createWorkerApp } from '../../src/app/index.ts';
import { readWorkerConfig } from '../../src/app/config.ts';

// Test-only blocked executor: never used by production main/node and never fabricates delivery.
const databaseUrl = process.env.DATABASE_URL!;
const schema = new URL(databaseUrl).searchParams.get('schema')!;
const database = createDatabaseClient({ connectionString: databaseUrl });
await prepareTestCheckpointSchema(databaseUrl, schema);
const execution = await testWorkerExecution(database, {
    ...process.env,
    AGENT_CHECKPOINT_SCHEMA: schema,
});
const config = readWorkerConfig({
    ...process.env,
    WORKER_EXECUTION_URL: execution.url,
    WORKER_EXECUTION_TOKEN: execution.token,
});
const app = createWorkerApp({
    config,
    executor: {
        async execute(context) {
            process.send?.({
                type: 'executing',
                runId: context.runId,
                mode: context.mode,
                taskVersionId: context.taskVersionId,
            });
            await new Promise<void>((resolve) => {
                const finish = () => {
                    process.send?.({ type: 'aborted', runId: context.runId });
                    resolve();
                };
                context.signal.addEventListener('abort', finish, { once: true });
                if (context.signal.aborted) finish();
            });
        },
    },
});
let stopping: Promise<void> | undefined;
const stop = () =>
    (stopping ??= app.stop().then(async () => {
        await execution.stop();
        await closeDatabase(database);
        process.send?.({ type: 'stopped' });
        process.disconnect?.();
    }));
process.on('message', (message) => {
    if (message === 'scova:shutdown') void stop();
});
process.on('SIGTERM', () => {
    void stop();
});
process.on('SIGINT', () => {
    void stop();
});
await app.start();
process.send?.({ type: 'ready' });
