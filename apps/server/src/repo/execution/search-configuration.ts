import { searchConfigurations, eq, type DatabaseClient } from '@scova/db';

export async function accountSearchConfiguration(database: DatabaseClient, userId: string) {
    return (
        (
            await database
                .select()
                .from(searchConfigurations)
                .where(eq(searchConfigurations.userId, userId))
                .limit(1)
        )[0] ?? null
    );
}
