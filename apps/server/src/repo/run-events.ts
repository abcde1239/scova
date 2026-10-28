import {
    sql as querySql,
    and,
    eq,
    gt,
    isNull,
    asc,
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
                    const current = await tx.query.sessions
                        .findFirst({
                            where: and(
                                eq(tables.sessions.id, session.id),
                                eq(tables.sessions.userId, session.userId),
                                isNull(tables.sessions.revokedAt),
                                gt(tables.sessions.expiresAt, clock()),
                            ),
                            columns: { id: true },
                        })
                        .then((row) => row ?? null);
                    if (!current) throw new ApiError(401, 'SESSION_REQUIRED', '请先登录');
                    const run = await tx.query.runs
                        .findFirst({
                            where: and(
                                eq(tables.runs.id, runId),
                                eq(tables.runs.userId, session.userId),
                            ),
                        })
                        .then((row) => row ?? null);
                    if (!run) throw new ApiError(404, 'NOT_FOUND', '资源不存在');
                    const [bounds] = await tx
                        .select({
                            minimum: querySql<number | null>`min(${tables.runEvents.seq})`,
                            maximum: querySql<number | null>`max(${tables.runEvents.seq})`,
                        })
                        .from(tables.runEvents)
                        .where(
                            and(
                                eq(tables.runEvents.runId, runId),
                                eq(tables.runEvents.userId, session.userId),
                            ),
                        );
                    const latest = bounds!.maximum ?? 0;
                    let cursor = after ?? 0;
                    let reset = false;
                    if (lastEventId) {
                        const previous = await tx.query.runEvents
                            .findFirst({
                                where: and(
                                    eq(tables.runEvents.id, lastEventId),
                                    eq(tables.runEvents.runId, runId),
                                    eq(tables.runEvents.userId, session.userId),
                                ),
                                columns: { seq: true },
                            })
                            .then((row) => row ?? null);
                        if (!previous) reset = true;
                        else {
                            if (after !== undefined && after !== previous.seq)
                                throw new ApiError(
                                    400,
                                    'EVENT_CURSOR_MISMATCH',
                                    'after 与 Last-Event-ID 必须指向同一事件',
                                );
                            cursor = previous.seq;
                        }
                    }
                    if (!reset && cursor > latest)
                        throw new ApiError(400, 'INVALID_EVENT_CURSOR', '事件游标超出当前执行范围');
                    if (bounds!.minimum !== null && cursor < bounds!.minimum - 1) reset = true;
                    const events = reset
                        ? []
                        : await tx.query.runEvents.findMany({
                              where: and(
                                  eq(tables.runEvents.runId, runId),
                                  eq(tables.runEvents.userId, session.userId),
                                  gt(tables.runEvents.seq, cursor),
                              ),
                              orderBy: [asc(tables.runEvents.seq)],
                              limit: 100,
                          });
                    if (
                        events.some(
                            (event, index) =>
                                event.seq !== (index === 0 ? cursor : events[index - 1]!.seq) + 1,
                        )
                    )
                        reset = true;
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
