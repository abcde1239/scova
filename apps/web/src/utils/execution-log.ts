import type { RunEvent } from '@scova/models';

export const stepLabels = {
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
    TOOL_RATE_LIMITED: '目标服务限流（HTTP 429）',
    TOOL_HTTP_ERROR: '目标服务返回 HTTP 错误',
    TOOL_INVALID_RESPONSE: '响应格式或内容类型不符合要求',
    TOOL_OUTPUT_TRUNCATED: '模型输出达到长度上限，未完成生成',
    TOOL_BUDGET_EXCEEDED: '剩余调用预算不足',
    TOOL_EXTRACTION_FAILED: '未能提取可用网页正文',
    TOOL_FAILED: '工具调用失败',
    TOOL_RESULT_UNKNOWN: '工具结果未确认；旧记录或执行中断未保留具体原因',
    NO_EVIDENCE: '未取得可用证据，未生成报告',
    DEADLINE_EXCEEDED: '执行时间预算已耗尽',
    AGENT_CONFIGURATION_INVALID: '研究服务配置不可用',
    EXECUTOR_FAILED: '执行器未完成本次工作',
};
export interface ExecutionLogEntry {
    seq: number;
    at: string;
    text: string;
    level: 'info' | 'success' | 'error';
    step?: ExecutionStep;
    code?: string;
    durationMs?: number;
}
export interface ExecutionStepState {
    started: number;
    completed: number;
    failures: number;
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
            entry.level = 'error';
            const code = event.payload.code;
            const known = Object.hasOwn(failures, code);
            entry.text += `：${known ? failures[code] : '未取得可公开的具体失败说明'}`;
            if (known) entry.code = code;
            if (entry.step && next.steps[entry.step])
                next.steps[entry.step] = {
                    ...next.steps[entry.step]!,
                    failures: next.steps[entry.step]!.failures + 1,
                };
        }
    } else if (event.type === 'run.failed') {
        entry.level = 'error';
        const code = event.payload.code;
        entry.text = `执行失败 · ${Object.hasOwn(failures, code) ? failures[code] : '本次未完成交付'}`;
        if (Object.hasOwn(failures, code)) entry.code = code;
    } else if (event.type === 'budget.updated') {
        const u = event.payload.usage;
        entry.text = `累计用量 · 搜索 ${u.searches} 次 · 网页 ${u.pages} 次 · 输入 ${u.inputTokens} / 输出 ${u.outputTokens} token`;
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
