import { randomBytes } from 'node:crypto';
import type { DatabaseClient } from '@scova/db';
import { startWorkerExecution } from '../../../server/src/app/worker-execution.ts';

export async function testWorkerExecution(db: DatabaseClient, env: NodeJS.ProcessEnv) {
    const token = randomBytes(32).toString('hex');
    const listener = startWorkerExecution(() => db, {
        ...env,
        WORKER_EXECUTION_TOKEN: token,
        WORKER_EXECUTION_PORT: '0',
    })!;
    await listener.listener.ready();
    return { token, url: listener.listener.url!, stop: () => listener.stop() };
}
