import type { ReportValue } from '@scova/models';
import type { AgentContext } from './types.ts';

/** One optional round uses the already-reserved synthesis repair slot, never a third call. */
export function answerSupplementDecision(
    context: AgentContext,
    input: {
        value: ReportValue;
        supplementalSearches: number;
        queryCount: number;
        readIndex: number;
        synthesisAttempts: number;
        modelBlocked: boolean;
        searchBlocked: boolean;
        finalInput: number;
        finalOutput: number;
        now: number;
    },
) {
    const target = input.value.questions.find(
        (q) => q.priority === 'core' && q.status !== 'supported',
    );
    if (!target) return { reason: '核心问题已有材料支持的回答，未发现需要补证的关键缺口' };
    if (input.modelBlocked || input.searchBlocked)
        return { reason: '模型或搜索已受阻，使用已有材料交付' };
    if (input.synthesisAttempts !== 1)
        return { reason: '综合修复次数已使用，不新增第三次模型调用' };
    if (
        input.supplementalSearches >= 2 ||
        input.queryCount >= 10 ||
        context.usage.searches >= context.budget.maxSearches
    )
        return { reason: '原Run补搜或搜索预算已用尽' };
    if (
        input.readIndex >= Math.min(20, context.budget.maxPages) ||
        context.usage.pages >= context.budget.maxPages
    )
        return { reason: '没有剩余正文尝试预算' };
    if (
        context.budget.maxInputTokens - context.usage.inputTokens < input.finalInput ||
        context.budget.maxOutputTokens - context.usage.outputTokens < input.finalOutput
    )
        return { reason: '需为最终综合保留输入与输出预算' };
    // One search (15s), at most two reads (30s), one model attempt (120s).
    if (context.deadlineAt.getTime() - input.now < 165_000)
        return { reason: '剩余时间不足以完成补证及最终综合' };
    return { target, reason: `针对核心问题补证：${target.text}` };
}
