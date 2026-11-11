import { estimateModelInputTokens, type StructuredInput } from '@scova/connectors';
import {
    type Report,
    type ReportQuestion,
    type ReportConversationContext,
    type QuestionAnswer,
} from '@scova/models';

export function conversationAnswer(answer: QuestionAnswer): string {
    return JSON.stringify({
        statements: answer.statements,
        needsResearch: answer.needsResearch,
        reason: answer.reason,
    }).slice(0, 16000);
}

/** Select a bounded, ordered transcript. Never turn assistant prose into source evidence. */
export function conversationContext(
    report: Report,
    questionId: string,
    question: string,
    history: ReportQuestion[],
): ReportConversationContext {
    const recent = history.slice(-12);
    return {
        version: 1,
        reportId: report.id,
        questionId,
        operation: 'research',
        report: {
            title: report.title.slice(0, 1000),
            summary: report.summary.slice(0, 16000),
            claims: report.claims.slice(0, 30).map((claim) => claim.text.slice(0, 4000)),
        },
        messages: [
            ...recent.flatMap((turn) => [
                { role: 'user' as const, content: turn.question },
                {
                    role: 'assistant' as const,
                    content: conversationAnswer(turn.answer),
                },
            ]),
            { role: 'user', content: question },
        ],
        sources: report.evidence.slice(0, 24).map((item) => ({
            id: item.id,
            url: item.url,
            title: item.title.slice(0, 1000),
            text: item.quote.slice(0, 4000),
            observedAt: item.observedAt,
        })),
        omittedTurns: history.length - recent.length,
        earlierTurns: history.slice(-28, -12).map((turn) => ({
            questionId: turn.id,
            question: turn.question.slice(0, 256),
            answer: turn.answer.statements
                .map((s) => s.text)
                .join('\n')
                .slice(0, 512),
        })),
    };
}

export function questionContextInput(
    context: ReportConversationContext,
    prompt: string,
    schema: Record<string, unknown>,
    maxInputTokens: number,
    maxOutputTokens: number,
) {
    const input = (): StructuredInput => ({
        prompt: `${prompt}\n当前问题：${context.messages.at(-1)?.content ?? ''}。更早的${context.omittedTurns}轮未包含；如指代不明确，请要求用户指明，禁止猜测。`,
        messages: context.messages.slice(0, -1),
        schema,
        maxInputTokens,
        maxOutputTokens,
        untrustedSources: [
            {
                report: context.report,
                earlierDiscussionSummary: context.earlierTurns,
                question: context.messages.at(-1)?.content,
                evidence: context.sources.map((s) => ({ id: s.id, quote: s.text })),
            },
        ],
    });
    // Bound the entire request, including native history roles, schema and source data.
    while (estimateModelInputTokens(input()) > maxInputTokens) {
        if (context.earlierTurns?.length) context.earlierTurns.shift();
        else if (context.messages.length > 1) {
            context.messages.splice(0, 2);
            context.omittedTurns++;
        } else if (context.report.claims.length) context.report.claims.pop();
        else if (context.report.summary.length > 500)
            context.report.summary = context.report.summary.slice(
                0,
                Math.floor(context.report.summary.length / 2),
            );
        else if (context.sources.length > 1) context.sources.pop();
        else if (context.sources[0]?.text.length > 100)
            context.sources[0].text = context.sources[0].text.slice(
                0,
                Math.floor(context.sources[0].text.length / 2),
            );
        else break;
    }
    return input();
}
