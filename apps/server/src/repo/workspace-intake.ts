import {
    and,
    desc,
    eq,
    isNull,
    inArray,
    or,
    projectResearchDrafts,
    projects,
    projectThreadItems,
    projectThreads,
    sql,
    type DatabaseExecutor,
} from '@scova/db';

export function createWorkspaceIntakeStore(db: DatabaseExecutor, userId: string) {
    return {
        destinations() {
            return db
                .select({ id: projects.id, name: projects.name })
                .from(projects)
                .where(eq(projects.userId, userId))
                .orderBy(desc(projects.createdAt), desc(projects.id));
        },
        recentProjects() {
            const activity = db
                .select({
                    projectId: projectThreads.projectId,
                    latest: sql<Date>`max(${projectThreads.lastActivityAt})`.as('latest'),
                })
                .from(projectThreads)
                .where(eq(projectThreads.userId, userId))
                .groupBy(projectThreads.projectId)
                .as('workspace_project_activity');
            const lastActivityAt = sql`greatest(${projects.createdAt}, ${activity.latest})`.mapWith(
                projects.createdAt,
            );
            return db
                .select({
                    id: projects.id,
                    name: projects.name,
                    createdAt: projects.createdAt,
                    lastActivityAt,
                })
                .from(projects)
                .leftJoin(activity, eq(activity.projectId, projects.id))
                .where(eq(projects.userId, userId))
                .orderBy(desc(lastActivityAt), desc(projects.id))
                .limit(6);
        },
        pendingPlans() {
            return db
                .select({
                    id: projectThreadItems.id,
                    projectId: projects.id,
                    projectName: projects.name,
                    threadId: projectThreads.id,
                    threadTitle: projectThreads.title,
                })
                .from(projectThreadItems)
                .innerJoin(
                    projectThreads,
                    and(
                        eq(projectThreads.id, projectThreadItems.threadId),
                        eq(projectThreads.userId, projectThreadItems.userId),
                    ),
                )
                .innerJoin(
                    projects,
                    and(eq(projects.id, projectThreads.projectId), eq(projects.userId, userId)),
                )
                .leftJoin(
                    projectResearchDrafts,
                    and(
                        eq(projectResearchDrafts.threadId, projectThreads.id),
                        eq(projectResearchDrafts.userId, userId),
                        sql`${projectResearchDrafts.id}::text = ${projectThreadItems.payload}->>'draftId'`,
                        sql`${projectResearchDrafts.revision}::text = ${projectThreadItems.payload}->>'revision'`,
                    ),
                )
                .where(
                    and(
                        eq(projectThreadItems.userId, userId),
                        eq(projectThreadItems.status, 'pending'),
                        isNull(projectThreads.archivedAt),
                        or(
                            and(
                                eq(projectThreadItems.kind, 'plan'),
                                sql`${projectThreadItems.payload}->>'command' = 'start_run'`,
                                sql`${projectResearchDrafts.id} is not null`,
                                isNull(projectResearchDrafts.confirmedTaskId),
                            ),
                            and(
                                eq(projectThreadItems.kind, 'schedule'),
                                inArray(sql<string>`${projectThreadItems.payload}->>'command'`, [
                                    'create_schedule',
                                    'update_schedule',
                                    'pause_task',
                                ]),
                            ),
                        ),
                    ),
                )
                .orderBy(desc(projectThreadItems.createdAt), desc(projectThreadItems.id))
                .limit(8);
        },
    };
}
