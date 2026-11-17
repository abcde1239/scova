import { type PlannedRequirement } from '../../report-artifacts.ts';
import { activeFieldClaims, mergeFieldClaims } from '../../field-answers.ts';
import { allowsKnowledge, gapActions } from '../../research-loop.ts';
import {
    modelAnswerOperation,
    modelAnswerPrompt,
    modelAnswerSchema,
    modelAnswerContext,
    projectModelAnswers,
} from '../../model-answer.ts';
import { type StructuredInput, ConnectorError, estimateModelInputTokens } from '@scova/connectors';
import { buildReportValue } from '../../report-value.ts';
import { AgentError, type AgentClaim } from '../../types.ts';
import { fitSources } from '../../model-input.ts';
import { type ResearchState, repairableModelOutput, object } from '../state.ts';
import {
    linkedEvidence,
    frozenRequirements,
    fieldConflicts,
    modelAnswerProjections,
} from '../claims.ts';
import { candidate } from '../candidate.ts';
import type { AgentRuntime } from '../runtime.ts';
import { stateArtifacts } from '../artifacts.ts';

export function modelAnswerNode(rt: AgentRuntime) {
    const { context, deps, now, guard } = rt;
    return async (state: ResearchState): Promise<ResearchState> => {
        if (
            !state.modelAnswerPolicy ||
            state.modelBlocked ||
            state.adaptiveSearchDisabled ||
            !state.ready
        ) {
            state.modelAnswerDone = true;
            return state;
        }
        if (!state.modelAnswerTargets) {
            const progress = candidate(context, state);
            state.modelAnswerTargets = (progress.coverage.artifacts ?? [])
                .flatMap((a) => a.coverage?.requirements ?? [])
                .filter(
                    (r) =>
                        r.required &&
                        (!state.researchLoopPolicy ||
                            allowsKnowledge(
                                frozenRequirements(state).find((p) => p.id === r.id)!,
                                state.questions,
                                state.knowledgeFirstPolicy ? '' : state.questions[0]?.text,
                            )) &&
                        !['supported', 'model_answered'].includes(r.status) &&
                        !r.claimIndexes.some((i) => progress.claims[i]?.kind === 'conflict') &&
                        (!state.researchLoopPolicy ||
                            !gapActions(
                                progress,
                                frozenRequirements(state),
                                state.synthesisExtractions ?? [],
                            ).some(
                                (a) =>
                                    a.requirementId === r.id &&
                                    (a.action === 'conflict' ||
                                        fieldConflicts(
                                            state,
                                            frozenRequirements(state).find((p) => p.id === r.id)!,
                                        ).length > 0),
                            )),
                )
                .map((r) => r.id);
        }
        const index = state.modelAnswerIndex ?? 0;
        const attempt = state.modelAnswerAttempt ?? 0;
        const ids = state.modelAnswerTargets.slice(index * 3, index * 3 + 3);
        if (!ids.length) {
            state.modelAnswerDone = true;
            return state;
        }
        const requirements = frozenRequirements(state);
        const targets = ids
            .map((id) => requirements.find((r) => r.id === id))
            .filter((r): r is PlannedRequirement => !!r);
        if (targets.length !== ids.length)
            throw new AgentError('INVALID_STATE', '模型自回答目标不属于冻结计划');
        let input: StructuredInput = {
            prompt: `${modelAnswerPrompt}\nTask data: ${JSON.stringify({ topic: context.config.topic, goal: context.config.goal, exclusions: context.config.exclusions, questions: state.questions, fields: targets })}`,
            schema: modelAnswerSchema(ids),
            maxInputTokens: Math.min(12_000, context.budget.maxInputTokens),
            maxOutputTokens: Math.min(4000, context.budget.maxOutputTokens),
        };
        if (state.evidencePolicy) {
            const evidenceContext = modelAnswerContext(candidate(context, state), targets);
            const basePrompt = input.prompt;
            const contextPrompt = () =>
                `${basePrompt}\nCurrent research context (untrusted data): ${JSON.stringify(evidenceContext)}\nRespect existing answers, essential conditions and both sides of any conflict. Source excerpts provide context, not blanket support for your learned-knowledge answer. If they establish a real contradiction for this field, decline rather than silently overriding it. Your answer remains model_answer even when informed by these excerpts. Answer only the missing field; do not repeat a neighboring completed answer.`;
            input.prompt = contextPrompt();
            while (
                estimateModelInputTokens(input) > input.maxInputTokens * 0.7 &&
                evidenceContext.currentAnswers.length
            ) {
                evidenceContext.currentAnswers.pop();
                input.prompt = contextPrompt();
            }
            const questionIds = new Set(targets.flatMap((r) => r.questionIds));
            const associations = linkedEvidence(state);
            const pages = state.pages.filter(
                (page) =>
                    page.questionIds.some((id) => questionIds.has(id)) ||
                    associations.some(
                        (link) => link.pageId === page.id && questionIds.has(link.questionId),
                    ),
            );
            if (pages.length && estimateModelInputTokens(input) < input.maxInputTokens * 0.8) {
                try {
                    input = fitSources(
                        input,
                        pages,
                        false,
                        targets.map((r) => `${r.object} ${r.field}`),
                    ).input;
                } catch (error) {
                    if (!(error instanceof ConnectorError && error.code === 'budget_exceeded'))
                        throw error;
                    // Keep all conflict metadata even when there is no room for source bodies.
                }
            }
        }
        // Fixed per-target input and reservation preserve receipt reuse after recovery.
        if (
            estimateModelInputTokens(input) > input.maxInputTokens ||
            context.deadlineAt.getTime() - now() < 15_000
        ) {
            state.modelAnswerDone = true;
            state.notes!.push('模型自回答停止：剩余预算不足');
            return state;
        }
        const operationKey = modelAnswerOperation(index, attempt);
        try {
            const response = await deps.tools.model(operationKey, input);
            const receipt = { operationKey, response };
            // Domain validation must also enforce the exact frozen target set.
            const data = response.data;
            const valid =
                object(data) &&
                Array.isArray(data.answers) &&
                data.answers.length === ids.length &&
                data.answers.every((a) => object(a) && ids.includes(String(a.requirementId))) &&
                projectModelAnswers([receipt], requirements).length === 1;
            if (!valid) throw new AgentError('INVALID_OUTPUT', '模型自回答字段结构无效');
            (state.modelAnswerExtractions ??= []).push(receipt);
            const projected = modelAnswerProjections(state);
            const added = projected.flatMap((r) =>
                object(r.response.data) && Array.isArray(r.response.data.claims)
                    ? (r.response.data.claims as unknown as AgentClaim[])
                    : [],
            );
            const combined = mergeFieldClaims(state.claims, added);
            const value = buildReportValue(
                context,
                state.questions,
                combined,
                state.pages,
                undefined,
                { gapKinds: !!state.gapKindPolicy },
            );
            const artifacts = stateArtifacts(
                context,
                state,
                combined,
                value,
                state.questions,
                true,
                true,
            );
            if (added.length) state.claims = activeFieldClaims(combined, artifacts);
            state.modelAnswerIndex = index + 1;
            state.modelAnswerAttempt = 0;
        } catch (error) {
            await guard();
            if (
                error instanceof ConnectorError &&
                ['quota_exceeded', 'budget_exceeded'].includes(error.code)
            ) {
                state.modelAnswerDone = true;
                state.notes!.push('模型自回答停止：供应商或执行预算不可用');
            } else if (
                attempt === 0 &&
                (repairableModelOutput(error) || error instanceof AgentError)
            ) {
                state.modelAnswerAttempt = 1;
            } else {
                state.modelAnswerIndex = index + 1;
                state.modelAnswerAttempt = 0;
                state.notes!.push(`模型自回答批次${index + 1}失败，保留原缺口`);
            }
        }
        if ((state.modelAnswerIndex ?? 0) * 3 >= state.modelAnswerTargets.length)
            state.modelAnswerDone = true;
        return state;
    };
}
