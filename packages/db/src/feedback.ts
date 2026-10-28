import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { readFeedbackSnapshot, type FeedbackSnapshot } from '@scova/models';
import { queryRows, type DatabaseTransaction } from './client.ts';
import { claimEvidence, feedback, runSources, runs } from './schema.ts';

/** 调用方须已持有Task NO KEY UPDATE锁；仅投影事务中的持久化数据，不连接外部服务。 */
export async function captureFeedbackSnapshot(
    tx: DatabaseTransaction,
    userId: string,
    taskId: string,
): Promise<FeedbackSnapshot> {
    const rows = await tx.query.feedback.findMany({
        where: and(
            eq(feedback.userId, userId),
            eq(feedback.taskId, taskId),
            eq(feedback.active, true),
        ),
        orderBy: asc(feedback.id),
        limit: 201,
        with: {
            source: {
                with: {
                    observations: {
                        where: and(
                            eq(runSources.userId, userId),
                            inArray(
                                runSources.runId,
                                tx
                                    .select({ id: runs.id })
                                    .from(runs)
                                    .where(and(eq(runs.taskId, taskId), eq(runs.userId, userId))),
                            ),
                        ),
                        orderBy: [desc(runSources.observedAt), desc(runSources.id)],
                        limit: 1,
                        columns: { id: true },
                    },
                },
            },
            claim: {
                with: {
                    citations: {
                        orderBy: asc(claimEvidence.id),
                        limit: 10,
                        with: {
                            evidence: {
                                with: {
                                    observation: {
                                        with: {
                                            source: { columns: { canonicalUrl: true } },
                                            snapshot: { columns: { contentHash: true } },
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            },
        },
    });
    if (rows.length > 200) throw new Error('生效反馈超过200条，必须先撤销已有反馈');
    // 已了解只针对标记当时已经观测的内容；不能在下一Run把后来出现的新值自动记为已了解。
    const historical = await queryRows<{ feedbackId: string; contentHash: string | null }>(
        tx,
        sql`
    SELECT DISTINCT ON (f.id) f.id AS "feedbackId", s.content_hash AS "contentHash"
    FROM feedback f
    JOIN run_sources rs ON rs.source_id=f.source_id AND rs.user_id=f.user_id
    JOIN runs r ON r.id=rs.run_id AND r.user_id=f.user_id AND r.task_id=f.task_id
    LEFT JOIN source_snapshots s ON s.id=rs.snapshot_id AND s.user_id=f.user_id
    WHERE f.user_id=${userId}::uuid AND f.task_id=${taskId}::uuid AND f.active=true
      AND rs.observed_at<=f.updated_at
    ORDER BY f.id, rs.observed_at DESC, rs.id DESC
  `,
    );
    const hashes = new Map(historical.map((row) => [row.feedbackId, row.contentHash]));
    const items = rows.map((row) => {
        if (row.source && !row.source.observations.length) throw new Error('反馈资料不属于本任务');
        const sources = row.source
            ? [
                  {
                      url: row.source.canonicalUrl,
                      contentHash: hashes.get(row.id) ?? null,
                      quote: null,
                  },
              ]
            : (row.claim?.citations ?? []).map(({ evidence }) => ({
                  url: evidence.observation.source.canonicalUrl,
                  contentHash: evidence.observation.snapshot?.contentHash ?? null,
                  quote: evidence.quote,
              }));
        return {
            id: row.id,
            sourceId: row.sourceId,
            claimId: row.claimId,
            kind: row.kind,
            updatedAt: row.updatedAt.toISOString(),
            text: row.claim?.text ?? null,
            sources,
        };
    });
    return readFeedbackSnapshot({ schemaVersion: 1, userId, taskId, items }, userId, taskId);
}
