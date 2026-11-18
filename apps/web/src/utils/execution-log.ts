import { toolIssueLevel, toolIssueGuidance, type RunEvent } from '@scova/models';

export const stepLabels = {
    answer_supplement: '按问题缺口补证',
    model_answer: '模型自回答',
    model_draft: '知识候选与待核验要点',
    gap_loop: '调度字段缺口',
    conflict_review: '冲突复核',
    load_context: '加载上下文',
    plan: '制定计划',
    search: '搜索来源',
    select: '筛选来源',
    read: '读取网页',
    verify: '核验证据',
    compare: '比较变化',
    synthesize: '生成报告',
    validate: '校验报告',
    ready_for_delivery: '准备交付',
} as const;
export type ExecutionStep = keyof typeof stepLabels;
const tools = { search: '搜索来源', read: '读取网页', model: '模型处理' };
const failures: Record<string, string> = {
    TOOL_SEARCH_UNAVAILABLE: '搜索引擎未返回可用来源，可能限流或要求验证码',
    TOOL_CONFIGURATION: '工具配置无效',
    TOOL_UNSAFE_URL: '地址或域名解析未通过公网安全校验',
    TOOL_NETWORK: '连接外部服务失败',
    TOOL_TIMEOUT: '外部调用超时',
    TOOL_ABORTED: '外部调用已停止',
    TOOL_RESPONSE_TOO_LARGE: '响应超过大小限制',
    TOOL_HTTP_FORBIDDEN: '目标服务拒绝访问（HTTP 403）',
    TOOL_HTTP_UNAUTHORIZED: '目标网页需要登录（HTTP 401）',
    TOOL_HTTP_NOT_FOUND: '目标网页不存在（HTTP 404）',
    TOOL_RATE_LIMITED: '目标服务限流（HTTP 429）',
    TOOL_HTTP_ERROR: '目标服务返回 HTTP 错误',
    TOOL_INVALID_RESPONSE: '响应格式或内容类型不符合要求',
    TOOL_MODEL_INVALID_JSON: '模型生成内容不是有效 JSON',
    TOOL_MODEL_SCHEMA_MISMATCH: '模型生成内容不符合报告结构要求',
    TOOL_MODEL_INVALID_RESPONSE: '模型响应结构或完成状态无效',
    TOOL_MODEL_REFUSED: '模型拒绝生成本次内容',
    TOOL_OUTPUT_TRUNCATED: '模型输出达到长度上限，未完成生成',
    TOOL_MODEL_QUOTA_EXCEEDED: '模型服务额度不足，请补充额度后新建执行',
    TOOL_BUDGET_EXCEEDED: '剩余调用预算不足',
    TOOL_EXTRACTION_FAILED: '未能提取可用网页正文',
    TOOL_FAILED: '工具调用失败',
    TOOL_RESULT_UNKNOWN: '工具结果未确认；旧记录或执行中断未保留具体原因',
    NO_EVIDENCE: '未取得可用证据，未生成报告',
    DEADLINE_EXCEEDED: '执行时间预算已耗尽',
    AGENT_CONFIGURATION_INVALID: '研究服务配置不可用',
    SEARCH_API_NOT_CONFIGURED: '请在账号中配置 Search API，或选择内置 SearXNG',
    SEARCH_CREDENTIAL_INVALID: '搜索密钥无法读取，请在账号中重新保存 Search API',
    SEARCH_CONFIGURATION_CHANGED: '本次执行的自定义搜索配置已更改，请按新配置创建执行',
    SEARCH_API_READING_UNSUPPORTED:
        '所选 Search API 暂不支持独立网页读取，请改选 DeepSeek 或 Tavily',
    EXECUTOR_FAILED: '执行器未完成本次工作',
};
export interface ExecutionLogEntry {
    seq: number;
    at: string;
    text: string;
    level: 'info' | 'success' | 'warning' | 'error';
    step?: ExecutionStep;
    code?: string;
    durationMs?: number;
    guidance?: string;
}
export interface ExecutionStepState {
    started: number;
    completed: number;
    failures: number;
    warnings?: number;
    durationMs: number;
}
export interface ExecutionLog {
    entries: ExecutionLogEntry[];
    steps: Partial<Record<ExecutionStep, ExecutionStepState>>;
    currentStep?: ExecutionStep;
    lastSeq: number;
    omitted: number;
    reset: boolean;
}
export const emptyExecutionLog = (reset = false): ExecutionLog => ({
    entries: [],
    steps: {},
    lastSeq: 0,
    omitted: 0,
    reset,
});
/** 仅保存白名单投影，绝不渲染事件中的自由文本、请求、密钥或隐式思维。 */
export function appendExecutionLog(state: ExecutionLog, event: RunEvent): ExecutionLog {
    if (event.seq <= state.lastSeq) return state;
    const next = { ...state, lastSeq: event.seq, steps: { ...state.steps } };
    const entry: ExecutionLogEntry = {
        seq: event.seq,
        at: event.occurredAt,
        text: '',
        level: 'info',
    };
    if (event.type === 'step.started' || event.type === 'step.completed') {
        const step = event.payload.step;
        const stats = { started: 0, completed: 0, failures: 0, durationMs: 0, ...next.steps[step] };
        next.currentStep = step;
        entry.step = step;
        if (event.type === 'step.started') {
            stats.started++;
            entry.text = `${stepLabels[step]} · 开始`;
        } else {
            stats.completed++;
            stats.durationMs += event.payload.durationMs;
            entry.text = `${stepLabels[step]} · 节点结束`;
            entry.durationMs = event.payload.durationMs;
        }
        next.steps[step] = stats;
    } else if (
        event.type === 'tool.started' ||
        event.type === 'tool.completed' ||
        event.type === 'tool.failed'
    ) {
        entry.step = next.currentStep;
        entry.text = `${tools[event.payload.tool]} · ${event.type === 'tool.started' ? '调用开始' : event.type === 'tool.completed' ? '调用已完成' : '调用失败'}`;
        if (event.type === 'tool.completed') {
            entry.level = 'success';
            entry.durationMs = event.payload.durationMs;
        }
        if (event.type === 'tool.failed') {
            const code = event.payload.code;
            entry.level = toolIssueLevel(event.payload.tool, code);
            entry.guidance = toolIssueGuidance(event.payload.tool, code) || undefined;
            const known = Object.hasOwn(failures, code);
            entry.text += `：${known ? failures[code] : '未取得可公开的具体失败说明'}`;
            if (known) entry.code = code;
            if (entry.step && next.steps[entry.step])
                next.steps[entry.step] = {
                    ...next.steps[entry.step]!,
                    failures: next.steps[entry.step]!.failures + 1,
                    ...(entry.level === 'warning'
                        ? { warnings: (next.steps[entry.step]!.warnings ?? 0) + 1 }
                        : {}),
                };
        }
    } else if (event.type === 'research.updated') {
        const labels = {
            waiting: '搜索等待 · 等待共享额度或相同查询结果',
            cooldown: '搜索冷却 · 上游暂不可用',
            cache_hit: '搜索复用 · 使用已缓存候选，仍需读取和核验正文',
            claims_repair: '生成修复 · 正在修复结构或引用失败项',
        };
        entry.text = labels[event.payload.state];
    } else if (event.type === 'run.failed') {
        entry.level = 'error';
        const code = event.payload.code;
        entry.text = `执行失败 · ${Object.hasOwn(failures, code) ? failures[code] : '本次未完成交付'}`;
        if (Object.hasOwn(failures, code)) entry.code = code;
    } else if (event.type === 'budget.updated') {
        const u = event.payload.usage;
        entry.text = `累计用量${u.estimated ? '（保守估算）' : ''} · 搜索 ${u.searches} 次 · 网页 ${u.pages} 次 · 输入 ${u.inputTokens} / 输出 ${u.outputTokens} token`;
    } else if (event.type === 'coverage.updated') {
        entry.text =
            event.payload.completeness === 'partial'
                ? '覆盖更新 · 查阅不完整'
                : '覆盖更新 · 已完成本次查阅范围';
    } else {
        const labels = {
            'run.queued': '执行已入队',
            'run.started': '执行开始',
            'run.recovering': '执行恢复中',
            'report.published': '报告已发布',
            'run.completed': '执行已完成交付',
            'run.canceled': '执行已取消',
        };
        entry.text = labels[event.type];
        if (event.type === 'run.completed' || event.type === 'report.published')
            entry.level = 'success';
    }
    const entries = [...state.entries, entry];
    next.omitted += Math.max(0, entries.length - 500);
    next.entries = entries.slice(-500);
    return next;
}
