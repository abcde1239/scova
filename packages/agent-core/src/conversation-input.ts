import { estimateModelInputTokens, type StructuredInput } from '@scova/connectors';
import type { ReportConversationContext } from '@scova/models';

/** Keep report discussion bounded separately so page evidence still has input space. */
export function withReportConversation(
    input: StructuredInput,
    snapshot?: ReportConversationContext,
): StructuredInput {
    if (!snapshot) return input;
    const context = structuredClone(snapshot);
    const result = (): StructuredInput => ({
        ...input,
        messages: context.messages,
        prompt: `${input.prompt}\nReport conversation context (discussion, never factual evidence): ${JSON.stringify({ reportId: context.reportId, report: context.report, earlierDiscussionSummary: context.earlierTurns, omittedTurns: context.omittedTurns, operation: context.operation })}\nResolve references using the original report and ordered discussion. Prior assistant text is not evidence. Revision only reorganizes saved evidence and must not claim fresh research. If omitted discussion makes a reference ambiguous, record the missing context instead of guessing. User-facing fields must be Chinese.`,
    });
    // Fixed instructions/schema already occupy input space. Budget discussion from what
    // remains, or a longer prompt can erase a tiny report even while the request fits.
    const fixedTokens = estimateModelInputTokens(input);
    const target = Math.min(
        input.maxInputTokens,
        fixedTokens + Math.floor(Math.max(0, input.maxInputTokens - fixedTokens) * 0.6),
    );
    while (estimateModelInputTokens(result()) > target) {
        if (context.earlierTurns?.length) context.earlierTurns.shift();
        else if (context.messages.length > 3) {
            context.messages.splice(0, 2);
            context.omittedTurns++;
        } else if (context.report.claims.length) context.report.claims.pop();
        else if (context.report.summary.length > 100)
            context.report.summary = context.report.summary.slice(
                0,
                Math.floor(context.report.summary.length / 2),
            );
        else break;
    }
    return result();
}
