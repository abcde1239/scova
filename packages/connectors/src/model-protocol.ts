import { ConnectorError, type StructuredInput } from './types.ts';

export type ModelProtocol =
    | 'openai_chat_completions'
    | 'openai_json'
    | 'anthropic_messages'
    | 'gemini';
type Message = { role: string; content: string };
const record = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);
function invalid(): never {
    throw new ConnectorError('invalid_response', '模型响应结构、完成状态或用量无效');
}
function tokens(value: unknown) {
    if (!Number.isSafeInteger(value) || (value as number) < 0) invalid();
    return value as number;
}

/** These official models enable thinking by default. Bounded JSON calls need
 * their output allowance for the response; never send provider options to a proxy. */
function boundedJsonOptions(protocol: ModelProtocol, base: string, model: string) {
    if (protocol !== 'openai_json' || !['deepseek-flash', 'deepseek-v4-pro'].includes(model))
        return {};
    try {
        const url = new URL(base);
        if (
            url.origin === 'https://api.deepseek.com' &&
            ['', '/', '/v1'].includes(url.pathname) &&
            !url.username &&
            !url.password &&
            !url.search &&
            !url.hash
        )
            return { thinking: { type: 'disabled' } };
    } catch {
        /* Endpoint validation retains its existing error path. */
    }
    return {};
}

export function modelRequest(
    protocol: ModelProtocol,
    baseUrl: string | undefined,
    model: string,
    apiKey: string,
    input: StructuredInput,
    messages: Message[],
): { endpoint: string; headers: Record<string, string>; body: Record<string, unknown> } {
    const base = (
        baseUrl ??
        (protocol === 'anthropic_messages'
            ? 'https://api.anthropic.com/v1'
            : protocol === 'gemini'
              ? 'https://generativelanguage.googleapis.com/v1beta'
              : 'https://api.openai.com/v1')
    ).replace(/\/$/, '');
    if (protocol === 'anthropic_messages')
        return {
            endpoint: `${base}/messages`,
            headers: {
                'content-type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
            },
            body: {
                model,
                max_tokens: input.maxOutputTokens,
                system: messages[0]?.content ?? '',
                messages: messages.slice(1).map(({ role, content }) => ({ role, content })),
                tools: [
                    {
                        name: 'scova_output',
                        description: 'Return the structured research result.',
                        input_schema: input.schema,
                    },
                ],
                tool_choice: { type: 'tool', name: 'scova_output' },
            },
        };
    if (protocol === 'gemini')
        return {
            endpoint: `${base}/models/${encodeURIComponent(model.replace(/^models\//, ''))}:generateContent`,
            headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
            body: {
                systemInstruction: { parts: [{ text: messages[0]?.content ?? '' }] },
                contents: messages.slice(1).map((message) => ({
                    role: message.role === 'assistant' ? 'model' : 'user',
                    parts: [{ text: message.content }],
                })),
                generationConfig: {
                    maxOutputTokens: input.maxOutputTokens,
                    responseMimeType: 'application/json',
                    responseJsonSchema: input.schema,
                },
            },
        };
    if (protocol !== 'openai_chat_completions' && protocol !== 'openai_json')
        throw new ConnectorError('configuration', '模型协议不受支持');
    return {
        endpoint: `${base}/chat/completions`,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: {
            model,
            ...boundedJsonOptions(protocol, base, model),
            messages:
                protocol === 'openai_json'
                    ? messages.map((message, index) =>
                          index === 0
                              ? {
                                    ...message,
                                    content: `${message.content}\nJSON schema: ${JSON.stringify(input.schema)}`,
                                }
                              : message,
                      )
                    : messages,
            max_tokens: input.maxOutputTokens,
            response_format:
                protocol === 'openai_json'
                    ? { type: 'json_object' }
                    : {
                          type: 'json_schema',
                          json_schema: { name: 'scova_output', strict: true, schema: input.schema },
                      },
        },
    };
}

/** Normalize native responses while preserving refusal/truncation and provider usage accounting. */
export function normalizeModelResponse(protocol: ModelProtocol, parsed: unknown): unknown {
    if (protocol === 'openai_chat_completions' || protocol === 'openai_json') return parsed;
    if (!record(parsed)) invalid();
    let content: string, usage: { prompt_tokens: number; completion_tokens: number } | undefined;
    if (protocol === 'anthropic_messages') {
        if (parsed.stop_reason === 'max_tokens')
            throw new ConnectorError('output_truncated', '模型输出达到长度上限，未完成生成');
        if (parsed.stop_reason !== 'tool_use' || !Array.isArray(parsed.content)) invalid();
        const tools = parsed.content.filter((value) => record(value) && value.type === 'tool_use');
        if (
            tools.length !== 1 ||
            !record(tools[0]) ||
            tools[0].name !== 'scova_output' ||
            !record(tools[0].input)
        )
            invalid();
        content = JSON.stringify(tools[0].input);
        if (parsed.usage !== undefined) {
            if (!record(parsed.usage)) invalid();
            usage = {
                prompt_tokens:
                    tokens(parsed.usage.input_tokens) +
                    tokens(parsed.usage.cache_creation_input_tokens ?? 0) +
                    tokens(parsed.usage.cache_read_input_tokens ?? 0),
                completion_tokens: tokens(parsed.usage.output_tokens),
            };
        }
    } else {
        if (
            protocol !== 'gemini' ||
            !Array.isArray(parsed.candidates) ||
            parsed.candidates.length !== 1 ||
            !record(parsed.candidates[0])
        )
            invalid();
        const candidate = parsed.candidates[0];
        if (candidate.finishReason === 'MAX_TOKENS')
            throw new ConnectorError('output_truncated', '模型输出达到长度上限，未完成生成');
        if (
            candidate.finishReason !== 'STOP' ||
            !record(candidate.content) ||
            !Array.isArray(candidate.content.parts)
        )
            invalid();
        const parts = candidate.content.parts;
        if (
            parts.some(
                (part) => !record(part) || typeof part.text !== 'string' || part.thought === true,
            )
        )
            invalid();
        content = parts.map((part) => (part as { text: string }).text).join('');
        if (parsed.usageMetadata !== undefined) {
            if (!record(parsed.usageMetadata)) invalid();
            usage = {
                prompt_tokens: tokens(parsed.usageMetadata.promptTokenCount),
                completion_tokens:
                    tokens(parsed.usageMetadata.candidatesTokenCount) +
                    tokens(parsed.usageMetadata.thoughtsTokenCount ?? 0),
            };
        }
    }
    return {
        choices: [{ finish_reason: 'stop', message: { content } }],
        ...(usage ? { usage } : {}),
    };
}
