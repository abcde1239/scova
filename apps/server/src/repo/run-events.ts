import { Prisma, type PrismaClient, type Run, type RunEvent } from "@scova/models";
import { ApiError } from "@/utils/errors.ts";

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
export function createRunEventRepository(database: () => PrismaClient, clock: () => Date) {
  return {
    readPage(
      session: EventSession,
      runId: string,
      after?: number,
      lastEventId?: string,
    ): Promise<EventPage> {
      return database().$transaction(
        async (tx) => {
          const current = await tx.session.findFirst({
            where: {
              id: session.id,
              userId: session.userId,
              revokedAt: null,
              expiresAt: { gt: clock() },
            },
            select: { id: true },
          });
          if (!current) throw new ApiError(401, "SESSION_REQUIRED", "请先登录");
          const run = await tx.run.findFirst({ where: { id: runId, userId: session.userId } });
          if (!run) throw new ApiError(404, "NOT_FOUND", "资源不存在");
          const bounds = await tx.runEvent.aggregate({
            where: { runId, userId: session.userId },
            _min: { seq: true },
            _max: { seq: true },
          });
          const latest = bounds._max.seq ?? 0;
          let cursor = after ?? 0;
          let reset = false;
          if (lastEventId) {
            const previous = await tx.runEvent.findFirst({
              where: { id: lastEventId, runId, userId: session.userId },
              select: { seq: true },
            });
            if (!previous) reset = true;
            else {
              if (after !== undefined && after !== previous.seq)
                throw new ApiError(
                  400,
                  "EVENT_CURSOR_MISMATCH",
                  "after 与 Last-Event-ID 必须指向同一事件",
                );
              cursor = previous.seq;
            }
          }
          if (!reset && cursor > latest)
            throw new ApiError(400, "INVALID_EVENT_CURSOR", "事件游标超出当前执行范围");
          if (bounds._min.seq !== null && cursor < bounds._min.seq - 1) reset = true;
          const events = reset
            ? []
            : await tx.runEvent.findMany({
                where: { runId, userId: session.userId, seq: { gt: cursor } },
                orderBy: { seq: "asc" },
                take: 100,
              });
          if (
            events.some(
              (event, index) => event.seq !== (index === 0 ? cursor : events[index - 1]!.seq) + 1,
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
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 5000 },
      );
    },
  };
}
