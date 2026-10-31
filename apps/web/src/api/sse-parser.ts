import { SseMessageSchema, UuidSchema, parseContract, type SseMessage } from '@scova/models';

export type SseParseErrorCode =
    | 'FRAME_TOO_LARGE'
    | 'INVALID_UTF8'
    | 'INVALID_JSON'
    | 'INVALID_MESSAGE'
    | 'INVALID_ENVELOPE'
    | 'INCOMPLETE_FRAME'
    | 'PARSER_CLOSED';

export class SseParseError extends Error {
    readonly code: SseParseErrorCode;
    /** 当前调用在错误帧之前已经完成校验的消息，供调用方按顺序处理。 */
    readonly completedMessages: readonly SseMessage[];

    constructor(code: SseParseErrorCode, completedMessages: SseMessage[] = []) {
        super(`SSE 解析失败：${code}`);
        this.name = 'SseParseError';
        this.code = code;
        this.completedMessages = completedMessages;
    }
}

export interface SseParserOptions {
    runId: string;
    /** 每帧原始字节上限，包含字段、注释与换行，默认与服务端一致。 */
    maxFrameBytes?: number;
}

/**
 * 只解析完整空行分隔的数据帧，不持有连接或游标。
 * CRLF 可跨 chunk；按完整行解码，保留跨 chunk 的 UTF-8 字节。
 * finish 拒绝未完成尾帧，不将 EOF 当分帧符，也不输出部分消息。
 * 失败调用中的完整消息由 SseParseError.completedMessages 返回，避免因分片不同丢失有效帧。
 * 解析错误后实例不可复用；重连应新建实例，游标只由已处理业务事件推进。
 */
export function createSseParser({ runId, maxFrameBytes = 65_536 }: SseParserOptions) {
    parseContract(UuidSchema, runId);
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1)
        throw new RangeError('SSE 帧上限必须为正安全整数');

    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    let lineBytes: number[] = [];
    let frameBytes = 0;
    let pendingCr = false;
    let firstLine = true;
    let closed = false;
    let data: string[] = [];
    let event: string | undefined;
    let id: string | undefined;
    let completedMessages: SseMessage[] = [];

    const fail = (code: SseParseErrorCode): never => {
        closed = true;
        throw new SseParseError(code, completedMessages);
    };
    const checkOpen = () => {
        if (closed) throw new SseParseError('PARSER_CLOSED');
    };
    const countByte = () => {
        if (++frameBytes > maxFrameBytes) fail('FRAME_TOO_LARGE');
    };
    const decodeLine = () => {
        try {
            return decoder.decode(Uint8Array.from(lineBytes));
        } catch {
            return fail('INVALID_UTF8');
        }
    };
    const dispatch = (messages: SseMessage[]) => {
        if (data.length) {
            let input: unknown;
            try {
                input = JSON.parse(data.join('\n'));
            } catch {
                fail('INVALID_JSON');
            }
            let message: SseMessage;
            try {
                message = parseContract(SseMessageSchema, input);
            } catch {
                return fail('INVALID_MESSAGE');
            }
            if (message.runId !== runId || event !== message.type) fail('INVALID_ENVELOPE');
            if (message.type === 'stream.reset') {
                if (id !== undefined || message.payload.snapshot.id !== runId)
                    fail('INVALID_ENVELOPE');
            } else if (id !== message.eventId) fail('INVALID_ENVELOPE');
            messages.push(message);
        }
        data = [];
        event = undefined;
        id = undefined;
        frameBytes = 0;
    };
    const endLine = (messages: SseMessage[]) => {
        let line = decodeLine();
        lineBytes = [];
        if (firstLine) {
            firstLine = false;
            if (line.startsWith('\uFEFF')) line = line.slice(1);
        }
        if (!line) {
            dispatch(messages);
            return;
        }
        if (line.startsWith(':')) return;
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? '' : line.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        if (field === 'data') data.push(value);
        else if (field === 'event') event = value;
        else if (field === 'id') {
            if (value.includes('\0')) fail('INVALID_ENVELOPE');
            id = value;
        }
        // retry 和未知字段不属于业务消息，也不改变本模块以外的连接策略。
    };

    return {
        push(chunk: Uint8Array): SseMessage[] {
            checkOpen();
            const messages: SseMessage[] = (completedMessages = []);
            for (const byte of chunk) {
                if (pendingCr) {
                    pendingCr = false;
                    if (byte === 10) {
                        countByte();
                        endLine(messages);
                        continue;
                    }
                    endLine(messages);
                }
                countByte();
                if (byte === 13) pendingCr = true;
                else if (byte === 10) endLine(messages);
                else lineBytes.push(byte);
            }
            return messages;
        },
        finish(): SseMessage[] {
            checkOpen();
            const messages: SseMessage[] = (completedMessages = []);
            if (pendingCr) {
                pendingCr = false;
                endLine(messages);
            }
            // 校验截断的 UTF-8；完整 JSON 但没有空行的尾帧同样不能交付。
            if (lineBytes.length) decodeLine();
            if (frameBytes) fail('INCOMPLETE_FRAME');
            closed = true;
            return messages;
        },
    };
}
