import type { ModelProvider, StructuredInput, CallContext } from '@scova/connectors';

/** Explicit supplier fixture. Production still authorizes and validates every quoted evidence ID. */
export const acceptanceQuestionModel: ModelProvider = {
    async generateStructured<T>(input: StructuredInput, context?: CallContext) {
        await context?.beforeAttempt?.('model');
        const source = input.untrustedSources?.[0] as
            | {
                  evidence?: { id: string; quote: string }[];
              }
            | undefined;
        const evidence = source?.evidence?.[0];
        const quote = evidence?.quote.slice(0, 2000);
        return {
            mode: 'live',
            usage: { inputTokens: 1, outputTokens: 1, estimated: false },
            data: {
                statements:
                    evidence && quote
                        ? [{ text: quote, citations: [{ evidenceId: evidence.id, quote }] }]
                        : [],
                needsResearch: true,
            } as T,
        };
    },
};
