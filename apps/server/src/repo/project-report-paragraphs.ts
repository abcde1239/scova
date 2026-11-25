import { and, claims, eq, projectTasks, reports, type DatabaseExecutor } from '@scova/db';
import type { ProjectReportParagraphAnchor } from '@scova/models';

export async function readProjectReportParagraph(
    db: DatabaseExecutor,
    userId: string,
    projectId: string,
    reportId: string,
    anchor: ProjectReportParagraphAnchor,
) {
    const scope = and(eq(reports.userId, userId), eq(reports.id, reportId));
    const membership = and(
        eq(projectTasks.userId, reports.userId),
        eq(projectTasks.taskId, reports.taskId),
        eq(projectTasks.projectId, projectId),
    );
    if (anchor.kind === 'claim') {
        const [claim] = await db
            .select({ text: claims.text })
            .from(reports)
            .innerJoin(projectTasks, membership)
            .innerJoin(
                claims,
                and(
                    eq(claims.userId, reports.userId),
                    eq(claims.reportId, reports.id),
                    eq(claims.id, anchor.claimId),
                ),
            )
            .where(scope);
        return claim?.text
            .split(/\r?\n[\t ]*\r?\n/)
            [anchor.paragraphIndex]?.trim()
            .slice(0, 1200);
    }
    const [report] = await db
        .select({ summary: reports.summary, limitations: reports.limitationsJson })
        .from(reports)
        .innerJoin(projectTasks, membership)
        .where(scope);
    if (anchor.kind === 'summary')
        return report?.summary
            .split(/\r?\n[\t ]*\r?\n/)
            [anchor.paragraphIndex]?.trim()
            .slice(0, 1200);
    const limitation = Array.isArray(report?.limitations)
        ? report.limitations[anchor.paragraphIndex]
        : undefined;
    return typeof limitation === 'string' ? limitation.trim().slice(0, 1200) : undefined;
}
