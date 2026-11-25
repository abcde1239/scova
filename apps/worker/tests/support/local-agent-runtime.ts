import type { DatabaseClient } from '@scova/db';
import type { AgentRuntimeOptions } from '../../src/service/agent.ts';
import { createAgentRuntime } from '../../src/service/agent.ts';
import { createPostgresCheckpointStorage } from '../../../server/src/service/execution/checkpoints.ts';
import { executionCredentials } from '../../../server/src/service/execution/credentials.ts';
import { createDeliveryService } from '../../../server/src/service/execution/delivery.ts';
import { createAgentRepository } from '../../../server/src/repo/execution/agent.ts';

/** Domain fixtures inject real persistence to test failure and recovery boundaries without HTTP. */
export function createLocalAgentRuntime({
    database,
    databaseUrl,
    checkpointSchema,
    enableDelivery,
    ...options
}: Omit<AgentRuntimeOptions, 'persistence'> & {
    database: DatabaseClient;
    databaseUrl: string;
    checkpointSchema?: string;
    enableDelivery?: boolean;
}) {
    const env = options.env ?? process.env;
    const checkpoints = createPostgresCheckpointStorage(
        databaseUrl,
        checkpointSchema ?? env.AGENT_CHECKPOINT_SCHEMA ?? 'scova_agent',
    );
    const delivery = enableDelivery
        ? createDeliveryService(database, checkpoints.saver)
        : undefined;
    return createAgentRuntime({
        ...options,
        persistence: {
            ready: () => checkpoints.ready(),
            close: checkpoints.close,
            repository: (token) => createAgentRepository(database, token),
            checkpoints: () => checkpoints.saver,
            credentials: (token, confirmationOnly) =>
                executionCredentials(database, token, env, confirmationOnly),
            deliver: delivery?.deliver.bind(delivery),
        },
    });
}
