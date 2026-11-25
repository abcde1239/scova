import { and, eq, projectSettings, type DatabaseExecutor } from '@scova/db';
import type { PatchProjectSettings } from '@scova/models';

export function createProjectSettingsStore(
    db: DatabaseExecutor,
    userId: string,
    projectId: string,
) {
    return {
        read() {
            return db
                .select()
                .from(projectSettings)
                .where(
                    and(
                        eq(projectSettings.userId, userId),
                        eq(projectSettings.projectId, projectId),
                    ),
                )
                .then(([row]) => row);
        },
        save(patch: PatchProjectSettings, updatedAt: Date) {
            return db
                .insert(projectSettings)
                .values({ userId, projectId, ...patch, updatedAt })
                .onConflictDoUpdate({
                    target: [projectSettings.userId, projectSettings.projectId],
                    set: { ...patch, updatedAt },
                })
                .returning()
                .then(([row]) => row!);
        },
    };
}
