import type { DatabaseClient } from '@scova/db';
import type { RunLeaseToken } from '@/utils/runs.ts';
import type { AgentRepository } from '@/repo/agent/types.ts';
import { createAgentRepositoryScope } from '@/repo/agent/scope.ts';
import { createReservationsMethods } from '@/repo/agent/reservations.ts';
import { createSettlementMethods } from '@/repo/agent/settlement.ts';
import { createRecoveryMethods } from '@/repo/agent/recovery.ts';

/** Only trusted workers receive the database and lease-bound domain methods. */
export function createAgentRepository(db: DatabaseClient, token: RunLeaseToken): AgentRepository {
    const scope = createAgentRepositoryScope(db, token);
    return {
        ...createReservationsMethods(scope),
        ...createSettlementMethods(scope),
        ...createRecoveryMethods(scope),
    };
}
