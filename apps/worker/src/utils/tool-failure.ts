import { ConnectorError } from '@scova/connectors';

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
    TOOL_OUTPUT_TRUNCATED: ['模型输出达到长度上限，未完成生成', false],
    TOOL_MODEL_QUOTA_EXCEEDED: ['模型服务额度不足，请补充额度后新建执行', false],
    TOOL_BUDGET_EXCEEDED: ['剩余调用预算不足', false],
    TOOL_EXTRACTION_FAILED: ['未能提取可用网页正文', false],
} as const;
export type ToolFailureCode = keyof typeof toolFailures;
export function classifyToolFailure(error: unknown): ToolFailureCode | undefined {
    if (!(error instanceof ConnectorError)) return undefined;
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
