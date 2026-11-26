import {
    and,
    asc,
    claims,
    desc,
    eq,
    inArray,
    or,
    projectTasks,
    reports,
    runSources,
    sources,
    sourceSnapshots,
    sql,
    isSqliteDatabase,
    type DatabaseExecutor,
    type SQLWrapper,
} from '@scova/db';

const summaryLength = 1_700;
const sourceLimit = 12;
const titleLength = 200;
const excerptLength = 2_400;
const bounded = (field: SQLWrapper, limit: number) => sql<string>`substr(${field}, 1, ${limit})`;

const reportFields = {
    id: reports.id,
    taskId: reports.taskId,
    title: bounded(reports.title, titleLength),
    summary: bounded(reports.summary, summaryLength),
    publishedAt: reports.publishedAt,
};
const sourceFields = {
    sourceId: sources.id,
    snapshotId: sourceSnapshots.id,
    title: bounded(sourceSnapshots.title, titleLength),
    canonicalUrl: sources.canonicalUrl,
};

export function createProjectEvidenceStore(
    db: DatabaseExecutor,
    userId: string,
    projectId: string,
) {
    const sqlite = isSqliteDatabase(db);
    const includes = (field: SQLWrapper, query: string) =>
        sqlite
            ? sql`instr(lower(${field}), lower(${query})) > 0`
            : sql`strpos(lower(${field}), lower(${query})) > 0`;
    const membership = and(
        eq(projectTasks.userId, reports.userId),
        eq(projectTasks.taskId, reports.taskId),
        eq(projectTasks.projectId, projectId),
    );
    const owned = eq(reports.userId, userId);
    const observation = and(
        eq(runSources.userId, reports.userId),
        eq(runSources.runId, reports.runId),
        eq(runSources.fetchStatus, 'succeeded'),
    );
    const sourceOwner = and(
        eq(sources.userId, runSources.userId),
        eq(sources.id, runSources.sourceId),
    );
    const snapshot = and(
        eq(sourceSnapshots.userId, runSources.userId),
        eq(sourceSnapshots.sourceId, runSources.sourceId),
        eq(sourceSnapshots.id, runSources.snapshotId),
    );
    const scopedSources = () =>
        db
            .select(sourceFields)
            .from(reports)
            .innerJoin(projectTasks, membership)
            .innerJoin(runSources, observation)
            .innerJoin(sources, sourceOwner)
            .innerJoin(sourceSnapshots, snapshot)
            .$dynamic();

    return {
        async search(query: string | readonly string[], limit: number) {
            const terms = typeof query === 'string' ? [query] : query;
            const matches = (field: SQLWrapper) =>
                or(...terms.map((term) => includes(field, term)));
            const titleScore = sql.join(
                terms.map(
                    (term) => sql`CASE WHEN ${includes(reports.title, term)} THEN 1 ELSE 0 END`,
                ),
                sql` + `,
            );
            type Match = {
                sourceId: string;
                snapshotId: string;
                title: string;
                canonicalUrl: string;
            };
            const matchingClaim = db
                .select({
                    text: sql<string | null>`substr(${claims.text}, 1, 600)`.as('claim_text'),
                })
                .from(claims)
                .where(
                    and(
                        eq(claims.userId, reports.userId),
                        eq(claims.taskId, reports.taskId),
                        eq(claims.reportId, reports.id),
                        matches(claims.text),
                    ),
                )
                .orderBy(asc(claims.order))
                .limit(1);
            const matchingSource = db
                .select({
                    value: sql<Match | null>`${sqlite ? sql`json_object` : sql`jsonb_build_object`}(
                        'sourceId', ${sourceFields.sourceId}, 'snapshotId', ${sourceFields.snapshotId},
                        'title', ${sourceFields.title}, 'canonicalUrl', ${sourceFields.canonicalUrl}
                    )`.as('source_match'),
                })
                .from(runSources)
                .innerJoin(sources, sourceOwner)
                .innerJoin(sourceSnapshots, snapshot)
                .where(
                    and(
                        observation,
                        or(matches(sourceSnapshots.title), matches(sources.canonicalUrl)),
                    ),
                )
                .orderBy(desc(runSources.observedAt), desc(runSources.id))
                .limit(1);
            const claim = sql<string | null>`(${matchingClaim})`;
            const source = sql<Match | null>`(${matchingSource})`.mapWith({
                mapFromDriverValue(value: string | Match) {
                    return typeof value === 'string' ? (JSON.parse(value) as Match) : value;
                },
            });
            return db
                .select({ ...reportFields, matchingClaim: claim, matchingSource: source })
                .from(reports)
                .innerJoin(projectTasks, membership)
                .where(
                    and(
                        owned,
                        or(
                            matches(reports.title),
                            matches(reports.summary),
                            sql`${claim} IS NOT NULL`,
                            sql`${source} IS NOT NULL`,
                        ),
                    ),
                )
                .orderBy(
                    ...(terms.length > 1 ? [desc(titleScore)] : []),
                    desc(reports.publishedAt),
                    desc(reports.id),
                )
                .limit(limit);
        },
        report(reportId: string) {
            return db
                .select(reportFields)
                .from(reports)
                .innerJoin(projectTasks, membership)
                .where(and(owned, eq(reports.id, reportId)))
                .then(([row]) => row);
        },
        reports(reportIds: string[]) {
            return db
                .select(reportFields)
                .from(reports)
                .innerJoin(projectTasks, membership)
                .where(and(owned, inArray(reports.id, reportIds)));
        },
        listSources(reportId: string) {
            return scopedSources()
                .where(and(owned, eq(reports.id, reportId)))
                .orderBy(desc(runSources.observedAt), desc(runSources.id))
                .limit(sourceLimit);
        },
        source(reportId: string, snapshotId: string, now: Date) {
            return db
                .select({
                    ...sourceFields,
                    reportId: reports.id,
                    publishedAt: sourceSnapshots.publishedAt,
                    excerpt: sql<string | null>`CASE
                    WHEN ${sourceSnapshots.textExpiresAt} IS NULL OR ${sourceSnapshots.textExpiresAt} > ${sql.param(now, sourceSnapshots.textExpiresAt)}
                    THEN ${bounded(sourceSnapshots.textBody, excerptLength)}
                    ELSE NULL END`,
                })
                .from(reports)
                .innerJoin(projectTasks, membership)
                .innerJoin(runSources, observation)
                .innerJoin(sources, sourceOwner)
                .innerJoin(sourceSnapshots, snapshot)
                .where(and(owned, eq(reports.id, reportId), eq(sourceSnapshots.id, snapshotId)))
                .then(([row]) => row);
        },
    };
}
