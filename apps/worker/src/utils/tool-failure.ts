import { ConnectorError } from '@scova/connectors';
import { ModelDiagnosticSchema, parseContract } from '@scova/models';

export function modelFailureDiagnostic(error: unknown, operation: string) {
    if (!(error instanceof ConnectorError) || !error.modelDiagnostic) return {};
    const stage = operation.startsWith('plan-')
        ? 'planning'
        : operation.startsWith('compare-facts')
          ? 'comparison'
          : operation.startsWith('synthesize-')
            ? 'synthesis'
            : 'other';
    try {
        return {
            modelDiagnostic: parseContract(ModelDiagnosticSchema, {
                ...error.modelDiagnostic,
                stage,
            }),
        };
    } catch {
        return {};
    }
}

/** 固定公开诊断；异常原文可能携带请求、供应商响应或凭据。 */
export const toolFailures = {
    TOOL_SEARCH_UNAVAILABLE: ['搜索引擎未返回可用来源，可能限流或要求验证码', true],
    TOOL_CONFIGURATION: ['工具配置无效', false],
    TOOL_UNSAFE_URL: ['地址或域名解析未通过公网安全校验', false],
    TOOL_NETWORK: ['连接外部服务失败', true],
    TOOL_TIMEOUT: ['外部调用超时', true],
    TOOL_ABORTED: ['外部调用已停止', false],
    TOOL_RESPONSE_TOO_LARGE: ['响应大小、页面结构或资源数量超过读取限制', false],
    TOOL_HTTP_FORBIDDEN: ['目标服务拒绝访问（HTTP 403）', false],
    TOOL_HTTP_UNAUTHORIZED: ['目标网页需要登录（HTTP 401）', false],
    TOOL_HTTP_NOT_FOUND: ['目标网页不存在（HTTP 404）', false],
    TOOL_RATE_LIMITED: ['目标服务限流（HTTP 429）', true],
    TOOL_HTTP_ERROR: ['目标服务返回 HTTP 错误', true],
    TOOL_INVALID_RESPONSE: ['响应内容类型不支持或内容无法解码', false],
    TOOL_MODEL_INVALID_JSON: ['模型生成内容不是有效 JSON', false],
    TOOL_MODEL_SCHEMA_MISMATCH: ['模型生成内容不符合报告结构要求', false],
    TOOL_MODEL_INVALID_RESPONSE: ['模型响应结构或完成状态无效', false],
    TOOL_MODEL_REFUSED: ['模型拒绝生成本次内容', false],
    TOOL_OUTPUT_TRUNCATED: ['模型输出达到长度上限，未完成生成', false],
    TOOL_MODEL_QUOTA_EXCEEDED: ['模型服务额度不足，请补充额度后新建执行', false],
    TOOL_BUDGET_EXCEEDED: ['剩余调用预算不足', false],
    TOOL_EXTRACTION_FAILED: ['未能提取可用网页正文', false],
} as const;
export type ToolFailureCode = keyof typeof toolFailures;
export function classifyToolFailure(error: unknown): ToolFailureCode | undefined {
    if (!(error instanceof ConnectorError)) return undefined;
    if (error.code === 'invalid_response' && error.modelFailure) {
        const codes = {
            json: 'TOOL_MODEL_INVALID_JSON',
            schema: 'TOOL_MODEL_SCHEMA_MISMATCH',
            envelope: 'TOOL_MODEL_INVALID_RESPONSE',
            refusal: 'TOOL_MODEL_REFUSED',
        } as const;
        return codes[error.modelFailure];
    }
    if (error.code === 'http') {
        if (error.status === 401) return 'TOOL_HTTP_UNAUTHORIZED';
        if (error.status === 404) return 'TOOL_HTTP_NOT_FOUND';
        if (error.status === 403) return 'TOOL_HTTP_FORBIDDEN';
        if (error.status === 429) return 'TOOL_RATE_LIMITED';
        return 'TOOL_HTTP_ERROR';
    }
    const code = `TOOL_${error.code.toUpperCase()}`;
    return Object.hasOwn(toolFailures, code) ? (code as ToolFailureCode) : undefined;
}

/** Retry recognized infrastructure failures, never programming or ledger integrity faults. */
export function isRetryableExecutionFailure(error: unknown): boolean {
    if (error instanceof TypeError || error instanceof SyntaxError || error instanceof RangeError)
        return false;
    const tool = classifyToolFailure(error);
    if (tool) return toolFailures[tool][1];
    let value = error;
    const seen = new Set<unknown>();
    while (value && typeof value === 'object' && !seen.has(value)) {
        seen.add(value);
        const record = value as { code?: unknown; cause?: unknown };
        if (
            value instanceof Error &&
            value.name === 'Error' &&
            [
                'Connection terminated unexpectedly',
                'Connection terminated',
                'Connection terminated due to connection timeout',
                'timeout exceeded when trying to connect',
                'Query read timeout',
            ].includes(value.message)
        )
            return true;
        if (
            typeof record.code === 'string' &&
            (/^(?:08[0-9A-Z]{3}|53[0-9A-Z]{3}|55P03|57P0[123]|57014|40001|40P01)$/.test(
                record.code,
            ) ||
                [
                    'ECONNRESET',
                    'ECONNREFUSED',
                    'ETIMEDOUT',
                    'EPIPE',
                    'ENETUNREACH',
                    'EHOSTUNREACH',
                    'EAI_AGAIN',
                    'UND_ERR_CONNECT_TIMEOUT',
                    'UND_ERR_SOCKET',
                ].includes(record.code))
        )
            return true;
        value = record.cause;
    }
    return false;
}
