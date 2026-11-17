import {
    searchConfigurations,
    agentProviders,
    users,
    eq,
    and,
    type DatabaseTransaction,
    type DatabaseClient,
} from '@scova/db';
import type { ApiServices } from '@/app/services';

export function createSearchConfigurationRepo(services: Pick<ApiServices, 'db'>) {
    return {
        async get(userId: string, tx: DatabaseClient | DatabaseTransaction = services.db()) {
            return (
                (
                    await tx
                        .select()
                        .from(searchConfigurations)
                        .where(eq(searchConfigurations.userId, userId))
                        .limit(1)
                )[0] ?? null
            );
        },
        async write<T>(userId: string, action: (tx: DatabaseTransaction) => Promise<T>) {
            return services.db().transaction(async (tx) => {
                await tx
                    .select({ id: users.id })
                    .from(users)
                    .where(eq(users.id, userId))
                    .for('update');
                return action(tx);
            });
        },
        async save(tx: DatabaseTransaction, data: typeof searchConfigurations.$inferInsert) {
            return (
                await tx
                    .insert(searchConfigurations)
                    .values(data)
                    .onConflictDoUpdate({
                        target: searchConfigurations.userId,
                        set: {
                            defaultMode: data.defaultMode,
                            protocol: data.protocol,
                            baseUrl: data.baseUrl,
                            contentMode: data.contentMode,
                            encryptedApiKey: data.encryptedApiKey,
                            revision: data.revision,
                            updatedAt: data.updatedAt,
                        },
                    })
                    .returning()
            )[0]!;
        },
        async legacy(tx: DatabaseTransaction, userId: string, id: string) {
            return (
                (
                    await tx
                        .select()
                        .from(agentProviders)
                        .where(and(eq(agentProviders.userId, userId), eq(agentProviders.id, id)))
                        .limit(1)
                )[0] ?? null
            );
        },
    };
}
