import { agentProviders, and, eq, type DatabaseClient } from '@scova/db';

export async function activeAgentProvider(database: DatabaseClient, userId: string) {
    return (
        (
            await database
                .select()
                .from(agentProviders)
                .where(and(eq(agentProviders.userId, userId), eq(agentProviders.active, true)))
                .limit(1)
        )[0] ?? null
    );
}
