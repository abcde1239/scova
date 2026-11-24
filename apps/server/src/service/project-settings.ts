import type { DatabaseExecutor } from '@scova/db';
import { PatchProjectSettingsSchema, parseContract, type ProjectSettings } from '@scova/models';
import type { ApiServices } from '@/app/services';
import { createProjectSettingsStore } from '@/repo/project-settings.ts';
import { createProjectStore } from '@/repo/projects.ts';
import { ApiError } from '@/utils/errors.ts';

export const projectResourceMissing = () => new ApiError(404, 'NOT_FOUND', '资源不存在');

function describe(
    projectId: string,
    row?: Awaited<ReturnType<ReturnType<typeof createProjectSettingsStore>['read']>>,
): ProjectSettings {
    return {
        projectId,
        goal: row?.goal ?? '',
        requirements: row?.requirements ?? '',
        preferredSources: row?.preferredSources ?? [],
        defaultAutonomy: row?.defaultAutonomy ?? 'budgeted',
        updatedAt: row?.updatedAt.toISOString() ?? null,
    };
}

export async function readProjectSettings(db: DatabaseExecutor, userId: string, projectId: string) {
    if (!(await createProjectStore(db).find(userId, projectId))) throw projectResourceMissing();
    return describe(projectId, await createProjectSettingsStore(db, userId, projectId).read());
}

export function createProjectSettingsService(services: ApiServices) {
    return {
        read: (userId: string, projectId: string) =>
            readProjectSettings(services.db(), userId, projectId),
        async update(userId: string, projectId: string, input: unknown) {
            const patch = parseContract(PatchProjectSettingsSchema, input);
            return services.db().transaction(async (tx) => {
                if (!(await createProjectStore(tx).lockProject(userId, projectId)))
                    throw projectResourceMissing();
                return describe(
                    projectId,
                    await createProjectSettingsStore(tx, userId, projectId).save(
                        patch,
                        services.clock(),
                    ),
                );
            });
        },
    };
}
