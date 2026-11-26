import { isSqliteDatabase } from '@scova/db';
import {
    and,
    desc,
    eq,
    exists,
    sql,
    workflowRuns,
    workflowTemplateExecutions,
    workflowTemplates,
    type DatabaseClient,
} from '@scova/db';
import type { WorkflowTemplate } from '@scova/models';
import { createWorkflowStore } from '@/repo/workflows.ts';
import { firstRow } from '@/utils/database.ts';

export function createWorkflowTemplateRepository(db: () => DatabaseClient) {
    return {
        list(userId: string) {
            return db()
                .select()
                .from(workflowTemplates)
                .where(eq(workflowTemplates.userId, userId))
                .orderBy(desc(workflowTemplates.createdAt), desc(workflowTemplates.id));
        },
        async find(userId: string, id: string, version: number) {
            const rows = await db()
                .select()
                .from(workflowTemplates)
                .where(
                    and(
                        eq(workflowTemplates.userId, userId),
                        eq(workflowTemplates.id, id),
                        eq(workflowTemplates.version, version),
                    ),
                );
            return rows[0] ?? null;
        },
        insert(data: typeof workflowTemplates.$inferInsert) {
            return db().insert(workflowTemplates).values(data).returning().then(firstRow);
        },
        listExecutions(userId: string) {
            const database = db();
            return database
                .select()
                .from(workflowTemplateExecutions)
                .where(
                    and(
                        eq(workflowTemplateExecutions.userId, userId),
                        exists(
                            database
                                .select({ id: workflowRuns.id })
                                .from(workflowRuns)
                                .where(
                                    and(
                                        eq(workflowRuns.userId, workflowTemplateExecutions.userId),
                                        eq(
                                            workflowRuns.workflowId,
                                            workflowTemplateExecutions.workflowId,
                                        ),
                                        eq(
                                            workflowRuns.versionId,
                                            workflowTemplateExecutions.versionId,
                                        ),
                                    ),
                                ),
                        ),
                    ),
                );
        },
        ensureExecution(userId: string, template: WorkflowTemplate, now: Date) {
            return db().transaction(async (tx) => {
                // Serialize first use across server processes before creating either backing row.
                const key = `scova:workflow-template:${userId}:${template.id}:${template.version}`;
                if (!isSqliteDatabase(tx))
                    await tx.execute(
                        sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
                    );
                const [existing] = await tx
                    .select()
                    .from(workflowTemplateExecutions)
                    .where(
                        and(
                            eq(workflowTemplateExecutions.userId, userId),
                            eq(workflowTemplateExecutions.templateId, template.id),
                            eq(workflowTemplateExecutions.templateVersion, template.version),
                        ),
                    );
                if (existing) return existing;

                const store = createWorkflowStore(tx);
                const workflow = await store.insert({
                    userId,
                    title: template.title,
                    draftJson: template.graph,
                    createdAt: now,
                    updatedAt: now,
                });
                const version = await store.publish({
                    userId,
                    workflowId: workflow.id,
                    version: 1,
                    draftRevision: workflow.revision,
                    title: workflow.title,
                    graphJson: template.graph,
                    bindingsJson: [],
                    publishedAt: now,
                });
                const [execution] = await tx
                    .insert(workflowTemplateExecutions)
                    .values({
                        userId,
                        templateId: template.id,
                        templateVersion: template.version,
                        workflowId: workflow.id,
                        versionId: version.id,
                    })
                    .returning();
                return execution!;
            });
        },
    };
}
