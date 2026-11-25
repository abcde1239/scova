import type { DatabaseClient } from '@scova/db';
import type { RunLeaseToken } from '@scova/execution/runs';
import { createAgentRepositoryScope } from './scope.ts';
import { createReservationsMethods } from './reservations.ts';
import { createSettlementMethods } from './settlement.ts';
import { createRecoveryMethods } from './recovery.ts';

/** Only trusted workers receive the database and lease-bound domain methods. */
export function createAgentRepository(db: DatabaseClient, token: RunLeaseToken) {
    const scope = createAgentRepositoryScope(db, token);
    return {
        ...createReservationsMethods(scope),
        ...createSettlementMethods(scope),
        ...createRecoveryMethods(scope),
    };
}
