import { fallbackRequirements, plannedRequirements } from '../../report/artifacts/index.ts';
import {
    synthesisBatches,
    coverageBatchLimits,
    fieldSynthesisBatches,
} from '../synthesis-batches.ts';
import { gapActions } from '../loop.ts';
import { scopedQuery } from '../context.ts';
import { boundedRecoveryQuery } from '../../search/recovery.ts';
import { buildReportValue } from '../../report/value.ts';
import { researchSynthesisOutputLimits, researchInputLimits } from '@scova/models';
import { answerSupplementDecision } from '../answer-supplement.ts';
import { type ResearchState, MAX_QUERIES, object, strings } from '../state.ts';
import { frozenRequirements } from '../claims.ts';
import { candidate } from '../candidate.ts';
import type { AgentRuntime } from '../runtime.ts';

export function answerSupplementNode(rt: AgentRuntime) {
    const { context, questions, now, planningOutputTokens, formats, comparisonReservation } = rt;
    return async (state: ResearchState): Promise<ResearchState> => {
        state.answerSupplementStopped = true;
        const outputBudget =
            context.budget.maxOutputTokens -
            planningOutputTokens * (state.planningRetried ? 3 : 1) -
            comparisonReservation(state);
        const progressCandidate = state.coveragePolicy ? candidate(context, state) : undefined;
        const progress = progressCandidate?.coverage;
        const searchActions =
            state.researchLoopPolicy && progressCandidate
                ? gapActions(
                      progressCandidate,
                      frozenRequirements(state),
                      state.synthesisExtractions ?? [],
                  )
                      .filter((a) => a.action === 'search')
                      .sort(
                          (a, b) =>
                              Number(b.questionIds.includes('q0')) -
                              Number(a.questionIds.includes('q0')),
                      )
                : [];
        const searchAction = searchActions.find(
            (a) =>
                !state.queries.some(
                    (q) =>
                        q.query ===
                        boundedRecoveryQuery(
                            scopedQuery(`${context.config.topic} ${a.query}`, context),
                        ),
                ),
        );
        const count = (state.coveragePolicy === 3 ? fieldSynthesisBatches : synthesisBatches)(
            formats,
            plannedRequirements(
                state.planningExtraction?.response.data,
                formats,
                questions,
                false,
                (state.coveragePolicy ?? 0) >= 2,
            ) ?? fallbackRequirements(formats, questions),
        ).length;
        const decision = answerSupplementDecision(context, {
            value: state.researchLoopPolicy
                ? {
                      ...progress!.reportValue!,
                      questions: (progress!.reportValue?.questions ?? []).filter((q) =>
                          searchAction?.questionIds.includes(q.id),
                      ),
                  }
                : (progress?.reportValue ??
                  buildReportValue(context, state.questions, state.claims, state.pages)),
            coverageDriven: !!state.coveragePolicy,
            supplementalSearches: state.supplementalSearches ?? 0,
            queryCount: state.queries.length,
            readIndex: state.readIndex,
            synthesisAttempts: state.synthesisAttempts,
            modelBlocked: !!state.modelBlocked,
            searchBlocked: !!state.searchBlocked,
            finalInput: state.coveragePolicy
                ? coverageBatchLimits(context.budget.maxInputTokens, outputBudget, count).input
                : researchInputLimits(context.budget.maxInputTokens, 0).synthesis,
            finalOutput: state.coveragePolicy
                ? Math.min(32_000, Math.max(1, Math.floor(outputBudget / 4)))
                : researchSynthesisOutputLimits(outputBudget).repair,
            now: now(),
        });
        if (state.researchLoopPolicy && !searchAction)
            decision.reason = '没有新的、经合法字段诊断确认的缺资料查询；保留待修复或未解决字段';
        state.notes!.push(`定向补证：${decision.reason}`);
        if (!decision.target) {
            if (state.coveragePolicy)
                state.gaps.push(
                    `覆盖验收${progress?.delivery?.answeredQuestions === 0 ? '失败' : '未通过'}：${decision.reason}`,
                );
            state.ready = true;
            return state;
        }
        const query = boundedRecoveryQuery(
            scopedQuery(
                state.researchLoopPolicy
                    ? `${context.config.topic} ${searchAction!.query}`
                    : `${context.config.topic} ${decision.target.text} 原始资料 具体依据`,
                context,
            ),
        );
        if (state.queries.some((q) => q.query === query)) {
            state.ready = true;
            return state;
        }
        state.answerSupplement = {
            basePages: state.pages.length,
            readLimit: Math.min(
                20,
                context.budget.maxPages,
                state.readIndex + (state.coveragePolicy ? 4 : 2),
            ),
            questionId: decision.target.id,
            query,
        };
        state.supplementalSearches = (state.supplementalSearches ?? 0) + 1;
        state.queries.push({ query, questionIds: [decision.target.id] });
        if (state.coveragePolicy) {
            // Use a complementary unused planned query before inventing another variant.
            const plan = state.planningExtraction?.response.data;
            const pending = new Set(
                progress?.reportValue?.questions
                    .filter((q) => q.status !== 'supported')
                    .map((q) => q.id),
            );
            const next =
                !state.researchLoopPolicy && object(plan) && Array.isArray(plan.queries)
                    ? plan.queries.find(
                          (q: unknown) =>
                              object(q) &&
                              typeof q.query === 'string' &&
                              strings(q.questionIds, 20, 50) &&
                              q.questionIds.some((id) => pending.has(id)) &&
                              !state.queries.some(
                                  (old) => old.query === scopedQuery(q.query as string, context),
                              ),
                      )
                    : undefined;
            if (
                object(next) &&
                typeof next.query === 'string' &&
                strings(next.questionIds, 20, 50) &&
                state.queries.length < Math.min(MAX_QUERIES, context.budget.maxSearches)
            ) {
                state.queries.push({
                    query: scopedQuery(next.query, context),
                    questionIds: next.questionIds,
                });
                state.supplementalSearches++;
            }
            state.synthesisBatchIndex = 0;
            state.notes!.push(
                '按未覆盖问题启动第二组证据循环；各批最多再综合和修复一次，所有调用继续计入原Run预算',
            );
        }
        return state;
    };
}
