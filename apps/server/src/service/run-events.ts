import { parseContract, RunEventSchema, SseResetControlSchema } from '@scova/models';
import type { ApiServices } from '@/app/context.ts';
import { createRunEventRepository, type EventSession, type EventPage } from '@/repo/run-events.ts';
import { ApiError } from '@/utils/errors.ts';
import { isUuid } from '@/utils/security.ts';
import { toRun } from '@/service/runs.ts';

export function parseEventCursor(after: string | null, lastEventId: string | null) {
    if (after !== null && (!/^(0|[1-9]\d*)$/.test(after) || !Number.isSafeInteger(Number(after))))
        throw new ApiError(400, 'INVALID_EVENT_CURSOR', '事件游标必须为非负安全整数');
    if (lastEventId !== null && !isUuid(lastEventId))
        throw new ApiError(400, 'INVALID_EVENT_CURSOR', 'Last-Event-ID 必须为合法事件标识');
    return {
        after: after === null ? undefined : Number(after),
        lastEventId: lastEventId ?? undefined,
    };
}

export function eventMessage(event: EventPage['events'][number]) {
    return parseContract(RunEventSchema, {
        schemaVersion: event.schemaVersion,
        eventId: event.id,
        runId: event.runId,
        seq: event.seq,
        occurredAt: event.occurredAt.toISOString(),
        type: event.type,
        payload: event.payload,
    });
}
export function resetMessage(page: EventPage) {
    return parseContract(SseResetControlSchema, {
        schemaVersion: 1,
        type: 'stream.reset',
        runId: page.run.id,
        payload: { reason: 'cursor_expired', snapshot: toRun(page.run), resumeAfter: page.latest },
    });
}

export function createRunEventService(services: ApiServices) {
    const repository = createRunEventRepository(
        () => services.db(),
        () => services.clock(),
    );
    return {
        async prepare(
            session: EventSession,
            runId: string,
            after: string | null,
            lastEventId: string | null,
        ) {
            if (!isUuid(runId)) throw new ApiError(404, 'NOT_FOUND', '资源不存在');
            const cursor = parseEventCursor(after, lastEventId);
            const page = await repository.readPage(
                session,
                runId,
                cursor.after,
                cursor.lastEventId,
            );
            return page;
        },
        next(session: EventSession, runId: string, after: number) {
            return repository.readPage(session, runId, after);
        },
    };
}
