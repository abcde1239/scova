export type ToolIssueLevel = 'warning' | 'error';

/** Severity describes this event's impact. A later terminal run.failed is always an error. */
export function toolIssueLevel(tool: 'read' | 'search' | 'model', code: string): ToolIssueLevel {
    if (
        [
            'TOOL_CONFIGURATION',
            'TOOL_UNSAFE_URL',
            'TOOL_MODEL_QUOTA_EXCEEDED',
            'TOOL_FAILED',
            'TOOL_RESULT_UNKNOWN',
        ].includes(code)
    )
        return 'error';
    if (['TOOL_ABORTED', 'TOOL_BUDGET_EXCEEDED', 'TOOL_OUTPUT_TRUNCATED'].includes(code))
        return 'warning';
    if (
        tool === 'read' &&
        [
            'TOOL_HTTP_FORBIDDEN',
            'TOOL_HTTP_NOT_FOUND',
            'TOOL_HTTP_UNAUTHORIZED',
            'TOOL_INVALID_RESPONSE',
            'TOOL_RESPONSE_TOO_LARGE',
            'TOOL_EXTRACTION_FAILED',
        ].includes(code)
    )
        return 'warning';
    if (
        [
            'TOOL_NETWORK',
            'TOOL_TIMEOUT',
            'TOOL_RATE_LIMITED',
            'TOOL_HTTP_ERROR',
            'TOOL_SEARCH_UNAVAILABLE',
        ].includes(code)
    )
        return 'warning';
    return 'error';
}

/** Fixed, safe guidance; never include upstream response bodies or credentials. */
export function toolIssueGuidance(tool: 'read' | 'search' | 'model', code: string): string {
    if (tool !== 'read') return '';
    switch (code) {
        case 'TOOL_HTTP_UNAUTHORIZED':
        case 'TOOL_HTTP_FORBIDDEN':
            return '使用无需登录的公开页面或替代来源；不会绕过登录或验证码。';
        case 'TOOL_HTTP_NOT_FOUND':
            return '检查链接是否已移动或失效，可将新的公开链接加入优先来源。';
        case 'TOOL_RATE_LIMITED':
            return '站点限流，本次跳过；稍后再执行或选用其他来源。';
        case 'TOOL_NETWORK':
        case 'TOOL_HTTP_ERROR':
            return '暂时性连接或服务故障会在剩余预算内有限重试，仍失败则继续其他来源。';
        case 'TOOL_TIMEOUT':
            return '网页连接、渲染或正文提取未在本次时限内完成；会在剩余预算内有限重试，仍失败则继续其他公开来源。';
        case 'TOOL_EXTRACTION_FAILED':
            return '页面可能是验证码、登录门或未完成加载的动态内容；请选用可直接读取的公开正文或替代来源。';
        case 'TOOL_INVALID_RESPONSE':
            return '当前读取器支持可解码的 HTML 网页；文件下载、PDF、纯文本附件或损坏的响应可能无法读取，请选用公开正文网页。';
        case 'TOOL_RESPONSE_TOO_LARGE':
            return '主文档大小、DOM 复杂度或页面资源数量/大小可能超过读取限制；可选用公开的正文版、打印版或其他来源，不一定是文章过长。';
        case 'TOOL_UNSAFE_URL':
            return '仅支持安全的公网地址，请检查链接及域名解析。';
        default:
            return '';
    }
}
