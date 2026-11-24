import { HttpError, InvalidResponseError, raceSignal } from 'requestlane';
import { PROJECT_THREAD_MAX_SEQ } from '@scova/models';
import { apiCredentials, apiUrl } from '@/api/config';
import { toApiError } from '@/api/errors';
import { parseThreadItem, type ThreadItem } from '@/api/project-threads';
import type { SessionLifecycle } from '@/api/session';
import { createSseFrameParser } from '@/api/sse-parser';

export type ThreadConnection = 'connecting' | 'open' | 'reconnecting' | 'error';

export async function streamThreadItems(
    scope: ReturnType<SessionLifecycle['capture']>,
    threadId: string,
    after: number,
    signal: AbortSignal,
    onItem: (item: ThreadItem) => void,
    onOpen: () => void,
) {
    const connection = new AbortController();
    const connectionSignal = AbortSignal.any([connection.signal, signal, scope.signal]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    function arm(ms: number) {
        clearTimeout(timer);
        timer = setTimeout(
            () => connection.abort(new DOMException('会话连接超时', 'TimeoutError')),
            ms,
        );
    }
    try {
        arm(15_000);
        const url = apiUrl(`/threads/${threadId}/events?after=${after}`);
        const pending = scope.transport.native(url, {
            method: 'GET',
            credentials: apiCredentials,
            cache: 'no-store',
            signal: connectionSignal,
            headers: { accept: 'text/event-stream' },
        });
        void pending.then(
            (response) => {
                if (connectionSignal.aborted) void response.body?.cancel().catch(() => {});
            },
            () => {},
        );
        const response = await raceSignal(pending, connectionSignal);
        if (!response.ok) {
            if (response.status === 401 && scope.isCurrent()) scope.replaceSession(null);
            const data = await raceSignal(response.json(), connectionSignal).catch(() => undefined);
            throw toApiError(
                new HttpError({
                    status: response.status,
                    statusText: response.statusText,
                    data,
                    headers: Object.fromEntries(response.headers),
                    url,
                }),
            );
        }
        if (
            !/^text\/event-stream(?:\s*;|\s*$)/i.test(response.headers.get('content-type') ?? '') ||
            !response.body
        )
            throw new InvalidResponseError('会话连接未返回事件流');
        const parser = createSseFrameParser((frame, fail) => {
            let item: ThreadItem;
            try {
                item = parseThreadItem(frame.data);
            } catch {
                return fail('INVALID_MESSAGE');
            }
            if (
                frame.event !== 'item' ||
                frame.id !== String(item.seq) ||
                item.seq > PROJECT_THREAD_MAX_SEQ ||
                item.threadId !== threadId
            )
                return fail('INVALID_ENVELOPE');
            // Apply valid frames immediately, including ones before an invalid frame in this chunk.
            if (!connectionSignal.aborted && scope.isCurrent()) onItem(item);
        });
        reader = response.body.getReader();
        onOpen();
        for (;;) {
            arm(45_000);
            const read = await raceSignal(reader.read(), connectionSignal);
            if (read.done) {
                parser.finish();
                return;
            }
            parser.push(read.value);
        }
    } finally {
        clearTimeout(timer);
        connection.abort();
        if (reader) {
            void reader.cancel().catch(() => {});
            reader.releaseLock();
        }
    }
}
