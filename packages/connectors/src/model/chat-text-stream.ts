import { parseJson, record } from '../http/provider.ts';
import { ConnectorError, type ModelResponse, type TextModelInput } from '../types.ts';

export function createChatTextStream(input: TextModelInput, publish: (text: string) => undefined) {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const parts: string[] = [];
    let length = 0;
    let line = '';
    let afterCr = false;
    let event = '';
    let data: string[] = [];
    let finishReason: string | undefined;
    let usage: ModelResponse['usage'] | undefined;
    let result: string | undefined;

    function invalid(message = '模型流响应结构无效'): never {
        throw new ConnectorError('invalid_response', message);
    }

    function frame(payload: string, type: string) {
        if (type === 'error') invalid('模型服务返回流式错误');
        if (type && type !== 'message') invalid();
        if (payload.trim() === '[DONE]') {
            if (finishReason === 'length')
                throw new ConnectorError('output_truncated', '模型输出达到长度上限，未完成生成');
            const text = parts.join('');
            if (finishReason !== 'stop' || !text.trim()) invalid('模型正文缺失或未正常完成');
            result = text;
            return;
        }
        const parsed = parseJson(payload);
        if (!record(parsed)) invalid();
        if (parsed.error != null) invalid('模型服务返回流式错误');
        if (!Array.isArray(parsed.choices) || parsed.choices.length > 1) invalid();
        let delta: string | undefined;
        if (parsed.choices.length) {
            const choice: unknown = parsed.choices[0];
            if (finishReason || !record(choice) || choice.index !== 0 || !record(choice.delta))
                invalid();
            const { role, content, refusal } = choice.delta;
            if (refusal != null && refusal !== '') invalid('模型拒绝生成正文');
            if (
                (role != null && role !== 'assistant') ||
                (content != null && typeof content !== 'string') ||
                (choice.finish_reason != null &&
                    (typeof choice.finish_reason !== 'string' || !choice.finish_reason))
            )
                invalid();
            if (typeof choice.finish_reason === 'string') finishReason = choice.finish_reason;
            if (typeof content === 'string' && (!finishReason || finishReason === 'stop'))
                delta = content;
        } else if (parsed.usage == null) invalid();
        if (parsed.usage != null) {
            const value = parsed.usage;
            if (!finishReason || usage || !record(value)) invalid('模型 usage 无效');
            const { prompt_tokens: inputTokens, completion_tokens: outputTokens } = value;
            if (
                typeof inputTokens !== 'number' ||
                typeof outputTokens !== 'number' ||
                !Number.isSafeInteger(inputTokens) ||
                !Number.isSafeInteger(outputTokens) ||
                inputTokens < 0 ||
                outputTokens < 0
            )
                invalid('模型 usage 无效');
            if (inputTokens > input.maxInputTokens || outputTokens > input.maxOutputTokens)
                throw new ConnectorError('budget_exceeded', '模型返回用量超过调用预算');
            usage = { inputTokens, outputTokens, estimated: false };
        }
        if (delta) {
            length += delta.length;
            if (input.maxOutputChars !== undefined && length > input.maxOutputChars)
                throw new ConnectorError('output_truncated', '模型正文超过长度上限');
            parts.push(delta);
            publish(delta);
        }
    }

    function acceptLine(value: string) {
        if (value === '') {
            if (data.length) frame(data.join('\n'), event);
            data = [];
            event = '';
        } else if (value === 'data' || value.startsWith('data:')) {
            data.push(value.slice(5).replace(/^ /, ''));
        } else if (value === 'event' || value.startsWith('event:')) {
            event = value.slice(6).replace(/^ /, '');
        }
    }

    return {
        push(this: void, chunk: Uint8Array, contentType: string | undefined, signal: AbortSignal) {
            if (contentType?.split(';', 1)[0]?.trim().toLowerCase() !== 'text/event-stream')
                invalid('模型服务未返回 SSE');
            let text: string;
            try {
                text = decoder.decode(chunk, { stream: true });
            } catch {
                invalid('模型流不是有效 UTF-8 文本');
            }
            if (!text) return;
            let start = afterCr && text.startsWith('\n') ? 1 : 0;
            afterCr = text.endsWith('\r');
            const breaks = /\r\n?|\n/g;
            breaks.lastIndex = start;
            for (let match = breaks.exec(text); match; match = breaks.exec(text)) {
                signal.throwIfAborted();
                acceptLine(line + text.slice(start, match.index));
                if (result !== undefined) return true as const;
                line = '';
                start = breaks.lastIndex;
            }
            line += text.slice(start);
        },
        finish(): string {
            if (result === undefined) invalid('模型流缺少结束标记');
            return result;
        },
        get usage() {
            return usage;
        },
    };
}
