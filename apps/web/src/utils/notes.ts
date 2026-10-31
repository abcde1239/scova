import {
    ContractValidationError,
    NoteInputSchema,
    NotePatchInputSchema,
    parseContract,
    parseRevisionEtag,
    type LibraryTarget,
    type NoteInput,
} from '@scova/models';
import { CommunicationError } from 'requestlane';
import type { ApiResponse } from '@/api/client';
import type { Note } from '@/api/notes';
import { toApiError } from '@/api/errors';

export function invalidNote(message: string): never {
    throw new ContractValidationError([{ path: '/notes', message }]);
}
export const noteTargetKey = (target: LibraryTarget) => `${target.kind}:${target.id.toLowerCase()}`;
export const sameNoteTarget = (left: LibraryTarget, right: LibraryTarget) =>
    noteTargetKey(left) === noteTargetKey(right);
export function noteTextError(body: string) {
    try {
        parseContract(NotePatchInputSchema, { body });
    } catch {
        return '请输入非空白纯文本，最多 20000 个 UTF-16 码元。';
    }
    for (let index = 0; index < body.length; index++) {
        const code = body.charCodeAt(index);
        if ((code < 32 && ![9, 10, 13].includes(code)) || code === 127)
            return '正文不能含 TAB、换行和回车以外的控制字符。';
    }
    if (new TextEncoder().encode(body).byteLength > 80_000)
        return '正文不能超过 80000 UTF-8 字节。';
    return '';
}
export function noteAttempt(
    target: LibraryTarget,
    body: string,
    key: string = crypto.randomUUID(),
) {
    const issue = noteTextError(body);
    if (issue) throw new TypeError(issue);
    const input = parseContract(NoteInputSchema, {
        target: { kind: target.kind, id: target.id },
        body,
    });
    return Object.freeze({
        key,
        input: Object.freeze({ ...input, target: Object.freeze({ ...input.target }) }),
    });
}
export type NoteAttempt = ReturnType<typeof noteAttempt>;
export function noteResponse(
    response: ApiResponse<Note>,
    expected?: { id?: string; target: LibraryTarget },
) {
    const note = response.data;
    const tag = response.headers.etag;
    if (
        response.status !== 200 ||
        !tag ||
        parseRevisionEtag(tag) !== note.revision ||
        (expected?.id && expected.id.toLowerCase() !== note.id.toLowerCase()) ||
        (expected && !sameNoteTarget(expected.target, note.target))
    )
        invalidNote('笔记响应、目标或修订 ETag 不一致');
    return response;
}
export function createdNoteResponse(
    response: ApiResponse<{ note: Note; reused: boolean }>,
    attempt: { input: NoteInput },
) {
    const { note, reused } = response.data;
    if (
        response.status !== (reused ? 200 : 201) ||
        (!reused && (note.body !== attempt.input.body || note.revision !== 1))
    )
        invalidNote('笔记创建响应不一致');
    noteResponse({ ...response, status: 200, data: note }, { target: attempt.input.target });
    return response;
}
export function notePage(
    page: { items: Note[]; nextCursor: string | null },
    cursor?: string,
    target?: LibraryTarget,
) {
    if (
        new Set(page.items.map((item) => item.id.toLowerCase())).size !== page.items.length ||
        (target && page.items.some((item) => !sameNoteTarget(item.target, target))) ||
        (page.nextCursor !== null && (page.nextCursor === cursor || page.nextCursor.length > 1024))
    )
        invalidNote('笔记分页、目标或游标不一致');
    return page;
}
export function noteRetryAt(cause: unknown, now = Date.now()) {
    const error = toApiError(cause);
    const original = error.cause;
    const value =
        original instanceof CommunicationError
            ? original.response?.headers['retry-after']
            : undefined;
    if (error.status !== 429 || !value) return undefined;
    if (/^\d+$/u.test(value)) {
        const seconds = Number(value);
        return Number.isSafeInteger(seconds) && Number.isSafeInteger(now + seconds * 1000)
            ? now + seconds * 1000
            : undefined;
    }
    const time = Date.parse(value);
    return Number.isFinite(time) && new Date(time).toUTCString() === value
        ? Math.max(now, time)
        : undefined;
}
export function noteReadError(cause: unknown) {
    const error = toApiError(cause);
    if ([401, 403, 404].includes(error.status ?? 0)) return '笔记不存在或当前账号无法访问。';
    if (['validation', 'protocol'].includes(error.kind)) return '笔记数据校验失败，请重新读取。';
    if (error.status === 400) return '分页位置已失效，请从第一页重新读取。';
    return '笔记暂时无法读取，请重试。';
}
export function unsafeNoteRead(cause: unknown) {
    const error = toApiError(cause);
    return (
        [401, 403, 404].includes(error.status ?? 0) ||
        ['validation', 'protocol'].includes(error.kind)
    );
}
