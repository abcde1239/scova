import type { DatabaseClient } from '@scova/db';
import type { RunLeaseToken } from '@scova/shared/execution/runs';
import type { AgentRepository } from '@scova/shared/execution/agent';
import { createAgentRepositoryScope } from './scope.ts';
import { createReservationsMethods } from './reservations.ts';
import { createSettlementMethods } from './settlement.ts';
import { createRecoveryMethods } from './recovery.ts';

/** Only trusted workers receive the database and lease-bound domain methods. */
export function createAgentRepository(db: DatabaseClient, token: RunLeaseToken): AgentRepository {
    const scope = createAgentRepositoryScope(db, token);
    return {
        ...createReservationsMethods(scope),
        ...createSettlementMethods(scope),
        ...createRecoveryMethods(scope),
    };
}
