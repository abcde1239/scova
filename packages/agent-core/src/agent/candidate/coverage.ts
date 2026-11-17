import { compactCoverageGaps } from '../../coverage-gaps.ts';
import { buildArtifactDocument, supersededArtifactClaims } from '../../report-artifacts.ts';
import {
    selectedOutputFormats,
    researchCoverageMetrics,
    classifyReportDelivery,
    primaryArtifactSummary,
    type ReportArtifact,
} from '@scova/models';
import { propositionEvidence } from '../../research-loop.ts';
import { searchRelevance } from '@scova/connectors';
import { buildReportValue } from '../../report-value.ts';
import { type AgentCandidate, type AgentContext } from '../../types.ts';
import { explainFeedback } from '../../feedback.ts';
import { type ResearchState, unique } from '../state.ts';
import { allSynthesisExtractions, partitionClaims } from '../claims.ts';
import { stateArtifacts } from '../artifacts.ts';
import type { PreparedCandidateEvidence } from './evidence.ts';

export function buildCandidateCoverage(
    context: AgentContext,
    state: ResearchState,
    evidence: PreparedCandidateEvidence,
    feedback: ReturnType<typeof explainFeedback>,
    allGaps: string[],
): AgentCandidate {
    const { comparison, extracted, manifest, claims } = evidence;
    const exhausted = [...state.exhausted];
    let reportValue = state.valuePolicy
        ? buildReportValue(context, state.questions, feedback.claims, state.pages, undefined, {
              gapKinds: !!state.gapKindPolicy,
          })
        : undefined;
    const artifacts: ReportArtifact[] = state.artifactPolicy
        ? stateArtifacts(
              context,
              state,
              feedback.claims,
              reportValue,
              state.questions,
              (state.coveragePolicy ?? 0) >= 2,
              state.coveragePolicy === 3,
          )
        : selectedOutputFormats(context.config).map((format) => ({
              format,
              claimIndexes: feedback.claims.flatMap((claim, index) =>
                  (claim.outputFormat ?? selectedOutputFormats(context.config)[0]) === format
                      ? [index]
                      : [],
              ),
          }));
    if (state.artifactPolicy && reportValue) {
        const superseded = supersededArtifactClaims(
            feedback.claims,
            reportValue,
            artifacts,
            allSynthesisExtractions(state),
            (raw) => partitionClaims({ claims: [raw] }, state).accepted[0],
        );
        if (superseded.size)
            reportValue = buildReportValue(
                context,
                state.questions,
                feedback.claims,
                state.pages,
                superseded,
                { gapKinds: !!state.gapKindPolicy },
            );
    }
    for (const artifact of artifacts)
        if ('coverage' in artifact && artifact.coverage)
            for (const requirement of artifact.coverage.requirements)
                if (requirement.required && requirement.status !== 'supported')
                    allGaps.push(
                        `${requirement.status === 'model_answered' ? '所需信息缺少充分外部证据' : '所需信息尚未完整覆盖'}：${requirement.object} ${requirement.field}`,
                    );
    if (reportValue && state.artifactPolicy) {
        for (const question of reportValue.questions) {
            const missing = artifacts
                .flatMap((artifact) => artifact.coverage?.requirements ?? [])
                .filter(
                    (r) =>
                        r.required &&
                        r.questionIds.includes(question.id) &&
                        r.status !== 'supported',
                );
            if (missing.length && question.status === 'supported') {
                question.status = 'provisional';
                question.gap = [...new Set(missing.map((r) => `${r.object} ${r.field}`.trim()))]
                    .join('；')
                    .slice(0, 1000);
            }
        }
        for (const artifact of artifacts) {
            const document = buildArtifactDocument(
                artifact.format,
                feedback.claims,
                reportValue,
                allSynthesisExtractions(state),
                (raw) => partitionClaims({ claims: [raw] }, state).accepted[0],
            );
            if (artifact.content?.document) delete artifact.content.document;
            if (document) artifact.content = { ...artifact.content, version: 1, document };
            delete artifact.summary;
            artifact.summary = primaryArtifactSummary(feedback.claims, {
                artifacts: [artifact],
                reportValue,
            });
            const missing =
                artifact.coverage?.requirements.filter(
                    (r) => r.required && !['supported', 'model_answered'].includes(r.status),
                ) ?? [];
            if (missing.length)
                artifact.summary =
                    `${artifact.summary}\n\n尚有${missing.length}项所需信息未完整取得，详见覆盖说明。`.slice(
                        0,
                        2000,
                    );
        }
    }
    if (reportValue)
        for (const question of reportValue.questions)
            if (question.status !== 'supported')
                allGaps.push(
                    `问题${question.status === 'unresolved' ? '尚无直接回答' : '仍有待核实项'}：${question.text}`,
                );
    if (context.usage.searches >= context.budget.maxSearches) exhausted.push('searches');
    if (context.usage.pages >= context.budget.maxPages) exhausted.push('pages');
    if (context.usage.inputTokens >= context.budget.maxInputTokens) exhausted.push('input_tokens');
    if (context.usage.outputTokens >= context.budget.maxOutputTokens)
        exhausted.push('output_tokens');
    const delivered = classifyReportDelivery(reportValue, feedback.claims, artifacts);
    const allAnswered =
        delivered.questionCount > 0 && delivered.answeredQuestions === delivered.questionCount;
    // Answered and external support are separate measures. Remaining items describe support or
    // process limits, not a missing answer; an unresolved dispute still blocks completion.
    const answerComplete =
        !!state.answerCompletionPolicy &&
        !!state.softEvidence &&
        allAnswered &&
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
    return {
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
            delivery: delivered,
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
                          ...(context.config.researchMode === 'collection'
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
}
