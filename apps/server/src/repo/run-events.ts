import {
    sql as querySql,
    and,
    eq,
    gt,
    isNull,
    asc,
    getTableColumns,
    type DatabaseClient,
    type Run,
    type RunEvent,
} from '@scova/db';
import * as tables from '@scova/db';
import { ApiError } from '@/utils/errors.ts';

export interface EventSession {
    id: string;
    userId: string;
    expiresAt: Date;
}
export interface EventPage {
    run: Run;
    events: RunEvent[];
    cursor: number;
    latest: number;
    reset: boolean;
}

const pageSize = 100;

/** 短快照同时读取终态与事件上界；不持有跨网络等待的事务或 Run 锁。 */
export function createRunEventRepository(database: () => DatabaseClient, clock: () => Date) {
    return {
        readPage(
            session: EventSession,
            runId: string,
            after?: number,
            lastEventId?: string,
        ): Promise<EventPage> {
            return database().transaction(
                async (tx) => {
                    const eventScope = and(
                        eq(tables.runEvents.runId, tables.runs.id),
                        eq(tables.runEvents.userId, tables.runs.userId),
                    );
                    // A nullable Run distinguishes a valid session without access (404) from
                    // an expired/revoked session (401). Correlate event lookups to that Run.
                    const [head] = await tx
                        .select({
                            run: getTableColumns(tables.runs),
                            projectionSeq: tables.runGraphSnapshots.seq,
                            retainedSeq: querySql<number | null>`(
                                select max(${tables.runEvents.seq})
                                from ${tables.runEvents}
                                where ${eventScope}
                            )`,
                            previousSeq: lastEventId
                                ? querySql<number | null>`(
                                    select ${tables.runEvents.seq}
                                    from ${tables.runEvents}
                                    where ${and(eventScope, eq(tables.runEvents.id, lastEventId))}
                                )`
                                : querySql<null>`null`,
                        })
                        .from(tables.sessions)
                        .leftJoin(
                            tables.runs,
                            and(
                                eq(tables.runs.id, runId),
                                eq(tables.runs.userId, tables.sessions.userId),
                            ),
                        )
                        .leftJoin(
                            tables.runGraphSnapshots,
                            and(
                                eq(tables.runGraphSnapshots.runId, tables.runs.id),
                                eq(tables.runGraphSnapshots.userId, tables.runs.userId),
                            ),
                        )
                        .where(
                            and(
                                eq(tables.sessions.id, session.id),
                                eq(tables.sessions.userId, session.userId),
                                isNull(tables.sessions.revokedAt),
                                gt(tables.sessions.expiresAt, clock()),
                            ),
                        );
                    if (!head) throw new ApiError(401, 'SESSION_REQUIRED', '请先登录');
                    if (!head.run) throw new ApiError(404, 'NOT_FOUND', '资源不存在');
                    const { run, previousSeq } = head;
                    const retained = head.retainedSeq ?? 0;
                    const latest = Math.max(retained, head.projectionSeq ?? 0);
                    if (lastEventId && previousSeq === null)
                        return { run, latest, cursor: latest, reset: true, events: [] };
                    if (previousSeq !== null && after !== undefined && after !== previousSeq)
                        throw new ApiError(
                            400,
                            'EVENT_CURSOR_MISMATCH',
                            'after 与 Last-Event-ID 必须指向同一事件',
                        );
                    const cursor = previousSeq ?? after ?? 0;
                    if (cursor > latest)
                        throw new ApiError(400, 'INVALID_EVENT_CURSOR', '事件游标超出当前执行范围');
                    const events =
                        cursor < retained
                            ? await tx.query.runEvents.findMany({
                                  where: and(
                                      eq(tables.runEvents.runId, runId),
                                      eq(tables.runEvents.userId, session.userId),
                                      gt(tables.runEvents.seq, cursor),
                                  ),
                                  orderBy: [asc(tables.runEvents.seq)],
                                  limit: pageSize,
                              })
                            : [];
                    // A discontinuity detects a pruned prefix or interior. A short page below
                    // the durable projection detects a pruned tail, including an empty table.
                    const reset =
                        events.some((event, index) => event.seq !== cursor + index + 1) ||
                        (events.length < pageSize && (events.at(-1)?.seq ?? cursor) < latest);
                    return {
                        run,
                        latest,
                        cursor: reset ? latest : cursor,
                        reset,
                        events: reset ? [] : events,
                    };
                },
                { isolationLevel: 'repeatable read' },
            );
        },
    };
}
