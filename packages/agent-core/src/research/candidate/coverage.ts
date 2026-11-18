import { baselineEligibility } from '../baseline.ts';
import { collectionDateScreening } from '../collection.ts';
import { compactCoverageGaps } from '../../report/coverage-gaps.ts';
import { researchCoverageMetrics, classifyReportDelivery } from '@scova/models';
import { propositionEvidence } from '../loop.ts';
import { searchRelevance } from '@scova/connectors';
import { type AgentCandidate, type AgentContext } from '../../types.ts';
import { explainFeedback } from '../feedback.ts';
import { type ResearchState, unique, allowed } from '../state.ts';
import { prepareCandidateArtifacts } from './artifacts.ts';
import type { PreparedCandidateEvidence } from './evidence.ts';
import { researchCompletion } from '../completion.ts';

export function buildCandidateCoverage(
    context: AgentContext,
    state: ResearchState,
    evidence: PreparedCandidateEvidence,
    feedback: ReturnType<typeof explainFeedback>,
    allGaps: string[],
): AgentCandidate {
    const { comparison, extracted, manifest, claims } = evidence;
    const exhausted = [...state.exhausted];
    const { artifacts, reportValue, gaps } = prepareCandidateArtifacts(
        context,
        state,
        feedback.claims,
    );
    allGaps.push(...gaps);
    if (context.usage.searches >= context.budget.maxSearches) exhausted.push('searches');
    if (context.usage.pages >= context.budget.maxPages) exhausted.push('pages');
    if (context.usage.inputTokens >= context.budget.maxInputTokens) exhausted.push('input_tokens');
    if (context.usage.outputTokens >= context.budget.maxOutputTokens)
        exhausted.push('output_tokens');
    const delivered = classifyReportDelivery(reportValue, feedback.claims, artifacts);
    const allAnswered =
        delivered.questionCount > 0 && delivered.answeredQuestions === delivered.questionCount;
    const completion = state.loopQualityPolicy
        ? researchCompletion(
              { delivery: delivered, artifacts, reportValue },
              state.modelBlocked
                  ? 'provider_unavailable'
                  : exhausted.includes('time')
                    ? 'deadline'
                    : state.verificationStopReason,
          )
        : undefined;
    // Answered and external support are separate measures. Remaining items describe support or
    // process limits, not a missing answer; an unresolved dispute still blocks completion.
    const answerComplete =
        !!state.answerCompletionPolicy &&
        !!state.softEvidence &&
        allAnswered &&
        (!state.collectionPolicy || !!completion?.externalEvidenceComplete) &&
        (!completion || completion.verificationDone) &&
        !reportValue?.questions.some((q) => q.status === 'disputed');
    const reportedGaps = compactCoverageGaps(
        state.researchLoopPolicy && allAnswered
            ? allGaps.filter((gap) => !gap.startsWith('覆盖验收'))
            : allGaps,
    );
    // Initial research answers need no historical comparison; monitoring still requires proof.
    const strictComparison = !!context.baselineRunId || context.config.researchMode === undefined;
    const comparisonBlockers = strictComparison
        ? compactCoverageGaps([
              ...(comparison?.gaps ?? []).filter(
                  (gap) => context.baselineRunId || !gap.startsWith('来源未提取可验证事实，'),
              ),
              ...(extracted?.gaps ?? []),
              ...(context.baselineRunId && !manifest ? ['连续比较尚未执行，不能推进已有基线'] : []),
          ])
        : [];
    const finalGaps = answerComplete ? comparisonBlockers : reportedGaps;
    const result: AgentCandidate = {
        schemaVersion: 1,
        runId: context.runId,
        userId: context.userId,
        taskVersionId: context.taskVersionId,
        mode: context.mode,
        ...(context.mode === 'demo'
            ? { demoReason: context.demoReason ?? '固定演示资料，未验证互联网事实' }
            : {}),
        title: context.config.title,
        claims: feedback.claims,
        ...(context.feedback?.items.length ? { feedbackEffects: feedback.effects } : {}),
        pages: state.pages,
        coverage: {
            artifacts,
            ...(state.collectionPolicy
                ? { dateScreening: collectionDateScreening(context, state.dateScreening ?? []) }
                : {}),
            ...(state.baselinePolicy
                ? {
                      sourceRestrictions: unique(
                          state.searches.flatMap((search) =>
                              search.response.results.flatMap((result) => {
                                  if (allowed(context, result.url)) return [];
                                  try {
                                      return [new URL(result.url).hostname];
                                  } catch {
                                      return [];
                                  }
                              }),
                          ),
                      ).slice(0, 50),
                  }
                : {}),
            delivery: delivered,
            ...(completion ? { completion } : {}),
            ...(state.researchLoopPolicy
                ? {
                      metrics: researchCoverageMetrics(reportValue, feedback.claims, artifacts),
                      propositions: propositionEvidence(feedback.claims, state.pages, artifacts),
                  }
                : {}),
            ...(reportValue ? { reportValue } : {}),
            ...(state.softEvidence
                ? {
                      notes: unique([
                          ...(state.notes ?? []),
                          ...(answerComplete ? reportedGaps : []),
                          ...(context.config.researchMode === 'collection' &&
                          !state.collectionPolicy
                              ? [
                                    '资料收集按本次读取的来源内容整理，不认定为查阅窗口内新发布信息；来源时间和适用条件保留供核对。',
                                ]
                              : []),
                          ...(claims.some((c) => c.kind === 'inference')
                              ? [
                                    '带引用的模型归纳已计入问题回答覆盖，仍属于推断，不等同于原文事实或独立核验',
                                ]
                              : []),
                          ...(claims.some((c) => c.uncertainty?.length)
                              ? [
                                    '未能定位原文或证据不齐的结论已保留并标为待核实；失配引用未作为证据保存',
                                ]
                              : []),
                      ]),
                  }
                : {}),
            completeness: finalGaps.length ? 'partial' : 'complete',
            searchedQueries: unique(state.searches.map((entry) => entry.query.query)),
            research: {
                candidates: state.searches.reduce(
                    (sum, s) => sum + s.response.coverage.receivedResults,
                    0,
                ),
                selected: state.selections.length,
                readAttempts: context.usage.pages,
                readSuccess: state.pages.length,
                relatedPages: state.pages.filter(
                    (p) =>
                        searchRelevance(context.config.topic, {
                            title: p.title,
                            snippet: p.text.slice(0, 3000),
                            url: p.url,
                        }) > 0,
                ).length,
                supplementalSearches: state.supplementalSearches ?? 0,
                acceptedClaims: claims.length,
                ...(state.softEvidence
                    ? { uncertainClaims: claims.filter((c) => c.kind === 'insufficient').length }
                    : {}),
                rejectedClaims: state.claimIssues?.length ?? 0,
                cacheHits: state.searches.filter((s) => s.response.coverage.diagnostics?.cacheHit)
                    .length,
                networkAttempts: state.searches.reduce(
                    (sum, s) => sum + (s.response.coverage.diagnostics?.networkAttempts ?? 0),
                    state.failedSearchNetworkAttempts ?? 0,
                ),
            },
            gaps: finalGaps,
            exhausted: unique(exhausted),
        },
        comparison: manifest ? 'completed' : 'not_performed',
        ...(manifest && comparison ? { manifest, changes: comparison.changes } : {}),
    };
    if (state.baselinePolicy) result.coverage.baseline = baselineEligibility(result.coverage);
    return result;
}
