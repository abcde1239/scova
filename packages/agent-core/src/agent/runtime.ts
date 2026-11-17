import { withReportConversation } from '../conversation-input.ts';
import { outputInstructions } from '../output-instructions.ts';
import { artifactSynthesisSchema, plannedRequirements } from '../report-artifacts.ts';
import { selectedOutputFormats, researchOutputStages, researchInputLimits } from '@scova/models';
import { type StructuredInput, ConnectorError } from '@scova/connectors';
import { comparisonOutputLimits } from '../comparison-extraction.ts';
import { AgentError, type AgentContext, type AgentDependencies } from '../types.ts';
import { type ResearchState, MAX_QUERIES, expired, active } from './state.ts';
import { claimSchema } from './claims.ts';

/** Shared per-run values captured by every graph node. */
export function createRuntime(
    context: AgentContext,
    deps: AgentDependencies,
    questions: ResearchState['questions'],
    initial: ResearchState,
) {
    const now = () => deps.now?.() ?? Date.now();
    const guard = async () => {
        await active(context);
        if (expired(context, deps)) throw new AgentError('ABORTED', '已到执行期限');
    };
    const blockQuotaFailure = (state: ResearchState, error: unknown) => {
        if (error instanceof ConnectorError && error.code === 'model_quota_exceeded') {
            state.modelBlocked = true;
            state.gaps.push('模型服务额度不足，本次执行停止后续模型调用；补充额度后请新建执行');
        }
    };
    const initialSearchLimit = Math.min(
        MAX_QUERIES,
        context.budget.maxSearches >= 4
            ? context.budget.maxSearches - 2
            : context.budget.maxSearches,
    );
    const { planning: planningOutputTokens, comparison: comparisonOutputTokens } =
        researchOutputStages(context.budget.maxOutputTokens);
    const formats = selectedOutputFormats(context.config);
    const synthesisSchema = structuredClone(claimSchema) as typeof claimSchema;
    const synthesisClaimLimit = formats.length > 1 || formats.includes('research_report') ? 30 : 24;
    (
        (synthesisSchema.properties as Record<string, unknown>).claims as Record<string, unknown>
    ).maxItems = synthesisClaimLimit;
    if (initial.artifactPolicy) {
        (synthesisSchema.required as string[]).push('artifacts');
        (synthesisSchema.properties as Record<string, unknown>).artifacts =
            artifactSynthesisSchema(formats);
    }
    if (formats.length > 1) {
        const items = (
            synthesisSchema.properties as {
                claims: { items: { required: string[]; properties: Record<string, unknown> } };
            }
        ).claims.items;
        items.required.push('outputFormat');
        items.properties.outputFormat = { type: 'string', enum: formats };
    }
    const comparisonReservation = (state: ResearchState) =>
        state.coveragePolicy
            ? (state.comparisonExtractions ?? []).reduce(
                  (n, r) => n + (r.response.usage?.outputTokens ?? 0),
                  0,
              )
            : comparisonOutputLimits(
                  state.answerSupplement?.basePages ?? state.pages.length,
                  comparisonOutputTokens,
              ).reduce(
                  (sum, limits) =>
                      sum + limits.initial + (state.comparisonRetried ? limits.repair : 0),
                  0,
              );
    const modelInput = (
        prompt: string,
        schema: Record<string, unknown>,
        untrustedSources?: unknown[],
        writingFormats = formats,
        claimLimit?: number,
        coverageDriven = false,
    ): StructuredInput =>
        withReportConversation(
            {
                prompt: Object.hasOwn(schema.properties ?? {}, 'claims')
                    ? `${prompt}\nTask mode: ${context.config.researchMode === 'collection' ? 'Collection: directly assemble source information, data, conditions and citations. Do not require unrequested causal analysis, predictions or independent corroboration. Unknown publication dates remain unknown.' : 'Research: analyze support, scope, conditions and timing for the requested questions; do not expand into unrequested investigations.'}${outputInstructions({ ...context.config, outputFormats: writingFormats, outputFormat: writingFormats[0]! }, 'write')}${claimLimit ? ` Response capacity: choose N=1..${claimLimit} claims before writing. Paragraphs share these N slots, overriding section/count targets. Every claimIndexes value must be 0..N-1, never above ${claimLimit - 1}. Count claims and check all indexes.` : ' Answer with available findings first. Record only specific missing material that affects the requested answer in assessment.gap. Length follows evidence and questions; preserve material uncertainty, conditions and conflicts without repeating generic caveats.'}`
                    : `${prompt}\n${outputInstructions(context.config, 'collect')}`,
                ...(coverageDriven
                    ? {
                          prompt: `${prompt}\nTask mode: ${context.config.researchMode === 'collection' ? 'Assemble source information and conditions directly; do not require unrequested analysis or corroboration.' : 'Analyze only requested questions and their conditions.'}${outputInstructions({ ...context.config, outputFormats: writingFormats, outputFormat: writingFormats[0]! }, 'write')} Response capacity: choose N=1..${claimLimit} claims before writing; never above ${claimLimit! - 1} for local indexes. Answer ONLY this batch's frozen requirements, not the entire task. Each claim answers ONE question. Choose its questionId, then cite ONLY pages eligible for that question; split multi-question findings. A requirement may bind several narrower claims whose questions jointly cover it. Prefer one sufficient source per claim. Paragraphs share claim slots. Preserve exact original-language quotations, essential conditions and all schema keys.`,
                      }
                    : {}),
                schema,
                // Stable per-stage inputs allow committed tool results to be reused after checkpoint loss.
                // The worker ledger enforces remaining cumulative usage before any new external request.
                maxInputTokens: researchInputLimits(context.budget.maxInputTokens, 0)[
                    Object.hasOwn(schema.properties ?? {}, 'claims') ? 'synthesis' : 'planning'
                ],
                maxOutputTokens: planningOutputTokens,
                ...(untrustedSources ? { untrustedSources } : {}),
            },
            context.conversation,
        );
    const sourceFocus = (state: ResearchState) => [
        ...(
            plannedRequirements(
                state.planningExtraction?.response.data,
                formats,
                questions,
                false,
                (state.coveragePolicy ?? 0) >= 2,
            ) ?? []
        )
            .filter((requirement) => requirement.required)
            .map((requirement) => `${requirement.object} ${requirement.field}`),
        context.config.topic,
        context.config.goal,
        ...context.config.focusPoints,
    ];
    return {
        context,
        deps,
        questions,
        now,
        guard,
        blockQuotaFailure,
        initialSearchLimit,
        planningOutputTokens,
        comparisonOutputTokens,
        formats,
        synthesisSchema,
        synthesisClaimLimit,
        comparisonReservation,
        modelInput,
        sourceFocus,
    };
}
export type AgentRuntime = ReturnType<typeof createRuntime>;
