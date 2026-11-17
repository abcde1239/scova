import { researchPrompt } from '../../prompts.ts';
import { initialSearchLimit as gapInitialSearchLimit } from '../../gap-loop.ts';
import { fitPlanningInput } from '../../planning-input.ts';
import { plannedRequirements, requirementPlanSchema } from '../../report-artifacts.ts';
import { knowledgePlanSchema, knowledgePlanInstructions } from '../../knowledge-plan.ts';
import { verificationInstructions } from '../../research-loop.ts';
import { researchWindow, scopedQuery } from '../../research-context.ts';
import { diversifyQueries, retrievalTargets } from '../../search-recovery.ts';
import { AgentError } from '../../types.ts';
import type { AgentModelInput } from '../../types.ts';
import { expandFeedbackQueries } from '../../feedback.ts';
import {
    type Query,
    type ResearchState,
    MAX_QUESTIONS,
    MAX_QUERIES,
    repairableModelOutput,
    modelRepairHint,
    object,
    strings,
    unique,
} from '../state.ts';
import { planSchema } from '../claims.ts';
import type { AgentRuntime } from '../runtime.ts';

export function planNode(rt: AgentRuntime) {
    const {
        context,
        deps,
        questions,
        guard,
        blockQuotaFailure,
        initialSearchLimit: legacyInitialSearchLimit,
        formats,
        modelInput,
    } = rt;
    return async (state: ResearchState): Promise<ResearchState> => {
        if (context.conversation?.operation === 'revise') {
            state.queries = [];
            state.adaptiveSearchDisabled = true;
            state.gaps.push('仅基于原报告已保存的证据生成新版，未联网更新或完整重读来源');
            return state;
        }
        const initialSearchLimit = state.gapLoopPolicy
            ? gapInitialSearchLimit(context.budget.maxSearches)
            : legacyInitialSearchLimit;
        const fallback = () =>
            questions.slice(0, initialSearchLimit).map((question) => ({
                query: `${context.config.topic} ${question.text}`.slice(0, 2000),
                questionIds: [question.id],
            }));
        if (context.mode === 'demo') {
            state.queries = expandFeedbackQueries(context, fallback(), questions);
            return state;
        }
        try {
            const planningSchema = planSchema(questions.map((question) => question.id));
            if (state.evidencePolicy) {
                (planningSchema.required as string[]).push('knowledgePlan');
                (planningSchema.properties as Record<string, unknown>).knowledgePlan =
                    knowledgePlanSchema(questions.map((q) => q.id));
            }
            if (state.artifactPolicy) {
                (planningSchema.required as string[]).push('requirements');
                (planningSchema.properties as Record<string, unknown>).requirements =
                    requirementPlanSchema(
                        formats,
                        questions.map((q) => q.id),
                        !!state.researchLoopPolicy,
                    );
            }
            const planningData = {
                window: researchWindow(context),
                task: {
                    topic: context.config.topic,
                    questions,
                    exclusions: context.config.exclusions,
                    timeRange: context.config.timeRange,
                },
                ...(context.conversation ? { conversation: context.conversation } : {}),
            };
            const input: AgentModelInput = fitPlanningInput(
                modelInput(
                    `${researchPrompt('planning', planningData)}${state.evidencePolicy ? `\n${knowledgePlanInstructions}` : ''}${state.researchLoopPolicy ? `\n${verificationInstructions}` : ''}`,
                    planningSchema,
                ),
                planningData,
                formats,
            );
            if (
                state.answerCompletionPolicy ||
                state.gapKindPolicy ||
                state.knowledgeFirstPolicy ||
                state.gapLoopPolicy
            )
                input.researchPolicy = {
                    ...(state.answerCompletionPolicy ? { answerCompletionPolicy: 1 } : {}),
                    ...(state.gapKindPolicy ? { gapKindPolicy: 1 } : {}),
                    ...(state.knowledgeFirstPolicy ? { knowledgeFirstPolicy: 1 } : {}),
                    ...(state.gapLoopPolicy ? { gapLoopPolicy: 1 } : {}),
                };
            let response;
            try {
                response = await deps.tools.model('plan-0', input);
            } catch (error) {
                await guard();
                if (!repairableModelOutput(error)) throw error;
                state.planningRetried = true;
                response = await deps.tools.model(
                    'plan-1',
                    fitPlanningInput(
                        {
                            ...input,
                            prompt: `${input.prompt}\n${modelRepairHint(error)} Reduce query count when necessary.`,
                            maxOutputTokens: input.maxOutputTokens * 2,
                        },
                        planningData,
                        formats,
                    ),
                );
            }
            await guard();
            if (state.artifactPolicy && state.coveragePolicy) {
                // Preserve the actual receipt even when its semantic plan is incomplete.
                state.planningExtraction = {
                    operationKey: state.planningRetried ? 'plan-1' : 'plan-0',
                    response,
                };
                if (
                    !state.planningRetried &&
                    !plannedRequirements(response.data, formats, questions)
                ) {
                    state.planningRetried = true;
                    response = await deps.tools.model(
                        'plan-1',
                        fitPlanningInput(
                            {
                                ...input,
                                prompt: `${input.prompt}\nThe previous coverage plan failed validation. Every question must have a required item in EVERY selected format. Comparison objects must have the identical complete field grid, with no duplicate object/field pairs. Include remaining questions as object-empty requirements. Keep at most 60 requirements across formats. Regenerate the full plan, not an answer.`,
                                maxOutputTokens: input.maxOutputTokens * 2,
                            },
                            planningData,
                            formats,
                        ),
                    );
                    await guard();
                    state.planningExtraction = { operationKey: 'plan-1', response };
                }
            }
            const data = response.data;
            if (
                response.mode !== context.mode ||
                !object(data) ||
                !Array.isArray(data.queries) ||
                !data.queries.length ||
                data.queries.length > MAX_QUERIES
            )
                throw new AgentError('INVALID_OUTPUT', '规划输出无效');
            state.queries = diversifyQueries(
                data.queries.map((item): Query => {
                    if (
                        !object(item) ||
                        typeof item.query !== 'string' ||
                        !item.query.trim() ||
                        item.query.length > 2000 ||
                        !strings(item.questionIds, MAX_QUESTIONS, 50) ||
                        !item.questionIds.length ||
                        item.questionIds.some(
                            (id) => !questions.some((question) => question.id === id),
                        )
                    )
                        throw new AgentError('INVALID_OUTPUT', '查询计划不合法');
                    return { query: item.query, questionIds: unique(item.questionIds) };
                }),
                retrievalTargets(
                    plannedRequirements(
                        data,
                        formats,
                        questions,
                        false,
                        (state.coveragePolicy ?? 0) >= 2,
                    ) ?? [],
                ),
            ).slice(0, initialSearchLimit);
            if (state.artifactPolicy)
                state.planningExtraction = {
                    operationKey: state.planningRetried ? 'plan-1' : 'plan-0',
                    response,
                };
            const missing = questions.filter(
                (question) =>
                    !state.queries.some((query) => query.questionIds.includes(question.id)),
            );
            for (const question of missing) {
                if (state.queries.length < initialSearchLimit)
                    state.queries.push({
                        query: `${context.config.topic} ${question.text}`.slice(0, 2000),
                        questionIds: [question.id],
                    });
                else state.gaps.push(`搜索预算无法覆盖子问题：${question.text}`);
            }
        } catch (error) {
            await guard();
            blockQuotaFailure(state, error);
            state.gaps.push('模型规划失败，使用任务原文的确定性查询');
            state.queries = fallback();
        }
        state.queries = expandFeedbackQueries(context, state.queries, questions)
            .slice(0, initialSearchLimit)
            .map((query) => ({ ...query, query: scopedQuery(query.query, context) }));
        return state;
    };
}
