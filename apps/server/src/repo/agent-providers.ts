import { agentProviders, users, and, eq, desc, sql, type DatabaseTransaction } from '@scova/db';
import type { ApiServices } from '@/app/services';
import type { AgentProviderPurpose } from '@scova/models';

export function createAgentProviderRepo(services: Pick<ApiServices, 'db'>) {
    const owned = (userId: string, id: string) =>
        and(eq(agentProviders.userId, userId), eq(agentProviders.id, id));
    return {
        get: async (userId: string, id: string) =>
            (
                await services.db().select().from(agentProviders).where(owned(userId, id)).limit(1)
            )[0] ?? null,
        list: (userId: string) =>
            services
                .db()
                .select()
                .from(agentProviders)
                .where(eq(agentProviders.userId, userId))
                .orderBy(desc(agentProviders.updatedAt)),
        active: async (userId: string, purpose: AgentProviderPurpose = 'research') =>
            (
                await services
                    .db()
                    .select()
                    .from(agentProviders)
                    .where(
                        and(
                            eq(agentProviders.userId, userId),
                            eq(
                                purpose === 'task_draft'
                                    ? agentProviders.draftActive
                                    : agentProviders.active,
                                true,
                            ),
                        ),
                    )
                    .limit(1)
            )[0] ?? null,
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
        find: async (tx: DatabaseTransaction, userId: string, id: string) =>
            (await tx.select().from(agentProviders).where(owned(userId, id)).limit(1))[0] ?? null,
        insert: async (tx: DatabaseTransaction, data: typeof agentProviders.$inferInsert) =>
            (await tx.insert(agentProviders).values(data).returning())[0]!,
        update: async (
            tx: DatabaseTransaction,
            userId: string,
            id: string,
            data: Partial<typeof agentProviders.$inferInsert>,
        ) =>
            (
                await tx
                    .update(agentProviders)
                    .set({ ...data, revision: sql`${agentProviders.revision} + 1` })
                    .where(owned(userId, id))
                    .returning()
            )[0]!,
        deactivate: (
            tx: DatabaseTransaction,
            userId: string,
            now: Date,
            purpose: AgentProviderPurpose,
        ) =>
            tx
                .update(agentProviders)
                .set({
                    [purpose === 'task_draft' ? 'draftActive' : 'active']: false,
                    updatedAt: now,
                    revision: sql`${agentProviders.revision} + 1`,
                })
                .where(
                    and(
                        eq(agentProviders.userId, userId),
                        eq(
                            purpose === 'task_draft'
                                ? agentProviders.draftActive
                                : agentProviders.active,
                            true,
                        ),
                    ),
                ),
        remove: (tx: DatabaseTransaction, userId: string, id: string) =>
            tx.delete(agentProviders).where(owned(userId, id)),
    };
}
