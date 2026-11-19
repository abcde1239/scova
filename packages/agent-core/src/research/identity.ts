import {
    conflictReviewOperation,
    isConflictReviewOperation,
    validConflictReview,
} from './conflict-review.ts';
import { selectedOutputFormats } from '@scova/models';
import { isDeepStrictEqual } from 'node:util';
import { isSynthesisOperation, COVERAGE_PASSES } from './synthesis-batches.ts';
import { isModelAnswerOperation, isModelDraftOperation } from './model-answer.ts';
import { taskQuestions } from '../report/value.ts';
import { isComparisonSourceCoverage } from '../report/comparison/extraction.ts';
import { AgentError, type AgentContext } from '../types.ts';
import { feedbackDigest } from './feedback.ts';
import {
    type ResearchState,
    MAX_QUESTIONS,
    MAX_QUERIES,
    MAX_PAGES,
    object,
    strings,
} from './state.ts';
import { frozenRequirements, fieldConflicts } from './claims.ts';
import { GAP_LOOP_PASSES, validGapLoop } from './gap-loop.ts';
import { observedSelections } from '../search/navigation.ts';
import { isSearchLanguage } from '@scova/connectors';

export function verifyIdentity(state: ResearchState, context: AgentContext): void {
    if (!state || typeof state !== 'object')
        throw new AgentError('INVALID_STATE', '检查点缺少研究状态');
    if (state.pagePolicy !== undefined && state.pagePolicy !== 1)
        throw new AgentError('INVALID_STATE', '正文引用策略无效');
    const policy = state.planningExtraction?.response.researchPolicy;
    if (
        (state.collectionPolicy !== undefined &&
            (state.collectionPolicy !== 1 ||
                context.config.researchMode !== 'collection' ||
                state.modelAnswerPolicy ||
                state.knowledgeFirstPolicy)) ||
        (state.baselinePolicy !== undefined && state.baselinePolicy !== 1) ||
        (state.outputFormats !== undefined &&
            !isDeepStrictEqual(state.outputFormats, selectedOutputFormats(context.config)))
    )
        throw new AgentError('INVALID_STATE', '冻结任务类型或交付形式不合法');
    if (
        policy &&
        (policy.pagePolicy !== state.pagePolicy ||
            policy.collectionPolicy !== state.collectionPolicy ||
            policy.baselinePolicy !== state.baselinePolicy ||
            policy.answerCompletionPolicy !== state.answerCompletionPolicy ||
            policy.gapKindPolicy !== state.gapKindPolicy ||
            policy.knowledgeFirstPolicy !== state.knowledgeFirstPolicy ||
            policy.gapLoopPolicy !== state.gapLoopPolicy ||
            policy.loopQualityPolicy !== state.loopQualityPolicy ||
            policy.searchDirectionPolicy !== state.searchDirectionPolicy)
    )
        throw new AgentError('INVALID_STATE', '检查点策略与规划回执不一致');
    if (
        (state.searchDirectionPolicy !== undefined &&
            (![1, 2, 3].includes(state.searchDirectionPolicy) || !state.gapLoopPolicy)) ||
        (state.loopQualityPolicy !== undefined &&
            (state.loopQualityPolicy !== 1 || !state.gapLoopPolicy)) ||
        (state.verificationStopReason !== undefined &&
            (!state.loopQualityPolicy ||
                ![
                    'verified',
                    'no_progress',
                    'budget',
                    'deadline',
                    'provider_unavailable',
                    'iteration_limit',
                    'source_limited',
                ].includes(state.verificationStopReason) ||
                (!state.gapLoop?.stopped &&
                    !state.modelBlocked &&
                    !(
                        state.adaptiveSearchDisabled &&
                        state.verificationStopReason === 'source_limited'
                    )))) ||
        (state.gapLoopPolicy !== undefined &&
            (state.gapLoopPolicy !== 1 ||
                state.researchLoopPolicy !== 1 ||
                state.coveragePolicy !== 3)) ||
        (state.gapLoop !== undefined &&
            (!state.gapLoopPolicy ||
                !validGapLoop(
                    state.gapLoop,
                    frozenRequirements(state),
                    state.questions.length,
                    !!state.loopQualityPolicy,
                ))) ||
        (state.knowledgeFirstPolicy !== undefined &&
            (state.knowledgeFirstPolicy !== 1 ||
                state.researchLoopPolicy !== 1 ||
                state.modelAnswerPolicy !== 1)) ||
        (state.modelDraftDone !== undefined &&
            (!state.knowledgeFirstPolicy || typeof state.modelDraftDone !== 'boolean')) ||
        (state.modelDraftTargets !== undefined &&
            (!state.knowledgeFirstPolicy ||
                !strings(state.modelDraftTargets, 60, 80) ||
                new Set(state.modelDraftTargets).size !== state.modelDraftTargets.length ||
                state.modelDraftTargets.some(
                    (id) => !frozenRequirements(state).some((r) => r.id === id),
                ))) ||
        (state.modelDraftIndex !== undefined &&
            (!Number.isSafeInteger(state.modelDraftIndex) ||
                state.modelDraftIndex < 0 ||
                state.modelDraftIndex > 20)) ||
        (state.modelDraftAttempt !== undefined && ![0, 1].includes(state.modelDraftAttempt)) ||
        (state.modelDraftExtractions !== undefined &&
            (!state.knowledgeFirstPolicy ||
                !Array.isArray(state.modelDraftExtractions) ||
                state.modelDraftExtractions.length > 40 ||
                new Set(state.modelDraftExtractions.map((r) => r.operationKey)).size !==
                    state.modelDraftExtractions.length ||
                state.modelDraftExtractions.some(
                    (r) =>
                        !object(r) ||
                        !isModelDraftOperation(r.operationKey) ||
                        !object(r.response) ||
                        r.response.mode !== state.mode,
                ))) ||
        (state.gapKindPolicy !== undefined &&
            (state.gapKindPolicy !== 1 || state.researchLoopPolicy !== 1)) ||
        (state.answerCompletionPolicy !== undefined &&
            (state.answerCompletionPolicy !== 1 || state.researchLoopPolicy !== 1)) ||
        (state.conflictReviewPolicy !== undefined &&
            (state.conflictReviewPolicy !== 1 || state.researchLoopPolicy !== 1)) ||
        (state.conflictReviewPass !== undefined &&
            (!state.conflictReviewPolicy ||
                !(state.gapLoopPolicy
                    ? Number.isInteger(state.conflictReviewPass) &&
                      state.conflictReviewPass >= 2 &&
                      state.conflictReviewPass <= GAP_LOOP_PASSES
                    : [2, 4].includes(state.conflictReviewPass)))) ||
        (state.conflictReviewTargets !== undefined &&
            (!state.conflictReviewPolicy ||
                !strings(state.conflictReviewTargets, 8, 80) ||
                new Set(state.conflictReviewTargets).size !==
                    state.conflictReviewTargets.length)) ||
        (state.conflictReviewIndex !== undefined &&
            (!Number.isSafeInteger(state.conflictReviewIndex) ||
                state.conflictReviewIndex < 0 ||
                state.conflictReviewIndex > 8)) ||
        (state.conflictReviewAttempt !== undefined &&
            ![0, 1].includes(state.conflictReviewAttempt)) ||
        (state.researchLoopPolicy !== undefined &&
            (state.researchLoopPolicy !== 1 || state.evidencePolicy !== 1)) ||
        (state.evidencePolicy !== undefined &&
            (state.evidencePolicy !== 1 ||
                state.coveragePolicy !== 3 ||
                state.mode !== 'live' ||
                context.conversation?.operation === 'revise')) ||
        (state.modelAnswerPolicy !== undefined &&
            (state.modelAnswerPolicy !== 1 ||
                state.coveragePolicy !== 3 ||
                state.mode !== 'live' ||
                context.conversation?.operation === 'revise')) ||
        (state.modelAnswerFormats !== undefined &&
            (!state.modelAnswerPolicy ||
                !isDeepStrictEqual(
                    state.modelAnswerFormats,
                    selectedOutputFormats(context.config),
                ))) ||
        (state.modelAnswerDone !== undefined && typeof state.modelAnswerDone !== 'boolean') ||
        (state.modelAnswerTargets !== undefined &&
            (!state.modelAnswerPolicy || !strings(state.modelAnswerTargets, 60, 80))) ||
        (state.modelAnswerIndex !== undefined &&
            (!Number.isSafeInteger(state.modelAnswerIndex) ||
                state.modelAnswerIndex < 0 ||
                state.modelAnswerIndex > 20)) ||
        (state.modelAnswerAttempt !== undefined && ![0, 1].includes(state.modelAnswerAttempt)) ||
        (state.modelAnswerExtractions !== undefined &&
            (!state.modelAnswerPolicy ||
                !Array.isArray(state.modelAnswerExtractions) ||
                state.modelAnswerExtractions.length > 40 ||
                new Set(state.modelAnswerExtractions.map((r) => r.operationKey)).size !==
                    state.modelAnswerExtractions.length ||
                state.modelAnswerExtractions.some(
                    (r) =>
                        !object(r) ||
                        !isModelAnswerOperation(r.operationKey) ||
                        !object(r.response) ||
                        r.response.mode !== state.mode,
                )))
    )
        throw new AgentError('INVALID_STATE', '模型自回答检查点无效');
    const expectedQuestions = taskQuestions(context);
    if (state.gapLoop?.target?.action === 'read') {
        const target = state.gapLoop.target;
        const selected = state.selections.find((s) => s.url === target.url);
        if (
            !selected ||
            !observedSelections(state).some(
                (s) =>
                    s.url === target.url && isDeepStrictEqual(s.questionIds, selected.questionIds),
            )
        )
            throw new AgentError('INVALID_STATE', '定向读取目标不属于已发现来源');
    }
    if (
        (state.coveragePolicy !== undefined &&
            (![1, 2, 3].includes(state.coveragePolicy) || state.synthesisPolicy !== 1)) ||
        (state.synthesisPolicy !== undefined && state.synthesisPolicy !== 1) ||
        (state.synthesisBatchIndex !== undefined &&
            (!Number.isSafeInteger(state.synthesisBatchIndex) ||
                state.synthesisBatchIndex < 0 ||
                state.synthesisBatchIndex > (state.coveragePolicy === 3 ? 59 : 7))) ||
        (state.synthesisBatchIssues !== undefined &&
            (!state.synthesisPolicy ||
                !Array.isArray(state.synthesisBatchIssues) ||
                state.synthesisBatchIssues.length > (state.coveragePolicy === 3 ? 60 : 8) ||
                new Set(state.synthesisBatchIssues.map((b) => b.batch)).size !==
                    state.synthesisBatchIssues.length ||
                state.synthesisBatchIssues.some(
                    (b) =>
                        !object(b) ||
                        !Number.isSafeInteger(b.batch) ||
                        b.batch < 0 ||
                        b.batch > (state.coveragePolicy === 3 ? 59 : 7) ||
                        !Array.isArray(b.issues) ||
                        b.issues.length > 30 ||
                        b.issues.some(
                            (issue) =>
                                !object(issue) ||
                                !Number.isSafeInteger(issue.index) ||
                                issue.index < 0 ||
                                issue.index > 29 ||
                                typeof issue.code !== 'string' ||
                                !/^[a-z_]{1,60}$/.test(issue.code) ||
                                !strings(issue.questionIds, 20, 50) ||
                                (issue.hint !== undefined &&
                                    (typeof issue.hint !== 'string' || issue.hint.length > 1000)),
                        ),
                )))
    )
        throw new AgentError('INVALID_STATE', '综合批次状态不合法');
    if (
        !state ||
        state.schemaVersion !== 1 ||
        state.runId !== context.runId ||
        state.userId !== context.userId ||
        state.taskVersionId !== context.taskVersionId ||
        state.mode !== context.mode ||
        state.feedbackDigest !== feedbackDigest(context) ||
        !Array.isArray(state.pages) ||
        !Array.isArray(state.questions) ||
        JSON.stringify(state.questions) !== JSON.stringify(expectedQuestions) ||
        !Array.isArray(state.queries) ||
        (state.softEvidence !== undefined && typeof state.softEvidence !== 'boolean') ||
        (state.valuePolicy !== undefined && state.valuePolicy !== 1) ||
        (state.artifactPolicy !== undefined && state.artifactPolicy !== 1) ||
        (state.planningExtraction !== undefined &&
            (!object(state.planningExtraction) ||
                !['plan-0', 'plan-1'].includes(state.planningExtraction.operationKey) ||
                !object(state.planningExtraction.response) ||
                state.planningExtraction.response.mode !== state.mode)) ||
        (state.answerSupplementEnabled !== undefined &&
            typeof state.answerSupplementEnabled !== 'boolean') ||
        (state.answerSupplementStopped !== undefined &&
            typeof state.answerSupplementStopped !== 'boolean') ||
        (state.answerSupplement !== undefined &&
            (!object(state.answerSupplement) ||
                !Number.isSafeInteger(state.answerSupplement.basePages) ||
                state.answerSupplement.basePages < (state.gapLoopPolicy ? 0 : 1) ||
                state.answerSupplement.basePages > state.pages.length ||
                !Number.isSafeInteger(state.answerSupplement.readLimit) ||
                state.answerSupplement.readLimit < 1 ||
                state.answerSupplement.readLimit > 20 ||
                !state.questions.some((q) => q.id === state.answerSupplement!.questionId) ||
                typeof state.answerSupplement.query !== 'string' ||
                state.answerSupplement.query.length > 2000)) ||
        (state.synthesisExtractions !== undefined &&
            (!Array.isArray(state.synthesisExtractions) ||
                state.synthesisExtractions.length >
                    (state.coveragePolicy === 3
                        ? 256
                        : state.coveragePolicy
                          ? 32
                          : state.synthesisPolicy
                            ? 16
                            : 2) ||
                new Set(state.synthesisExtractions.map((e) => e.operationKey)).size !==
                    state.synthesisExtractions.length ||
                state.synthesisExtractions.some(
                    (e) =>
                        !object(e) ||
                        !(state.synthesisPolicy
                            ? isSynthesisOperation(
                                  e.operationKey,
                                  state.gapLoopPolicy
                                      ? GAP_LOOP_PASSES
                                      : state.coveragePolicy
                                        ? COVERAGE_PASSES
                                        : 2,
                                  state.coveragePolicy === 3 ? 60 : 8,
                              ) ||
                              (!!state.conflictReviewPolicy &&
                                  isConflictReviewOperation(e.operationKey) &&
                                  (state.gapLoopPolicy ||
                                      [2, 4].includes(Number(e.operationKey.split('-')[2]))))
                            : ['synthesize-0', 'synthesize-1'].includes(e.operationKey)) ||
                        !object(e.response) ||
                        e.response.mode !== state.mode,
                ))) ||
        (state.providerPageUrls !== undefined && !strings(state.providerPageUrls, 200, 4096)) ||
        (state.notes !== undefined && !strings(state.notes, 1200, 4000)) ||
        (state.comparisonExtractions !== undefined &&
            (!Array.isArray(state.comparisonExtractions) ||
                state.comparisonExtractions.length > 14 ||
                state.comparisonExtractions.some(
                    (e) =>
                        !object(e) ||
                        typeof e.operationKey !== 'string' ||
                        !object(e.response) ||
                        (e.sourceCoverage !== undefined &&
                            !isComparisonSourceCoverage(e.sourceCoverage)),
                ))) ||
        (state.planningRetried !== undefined && typeof state.planningRetried !== 'boolean') ||
        (state.supplementalSearches !== undefined &&
            (!Number.isSafeInteger(state.supplementalSearches) ||
                state.supplementalSearches < 0 ||
                state.supplementalSearches > (state.coveragePolicy ? 10 : 2))) ||
        (state.claimIssues !== undefined &&
            (!Array.isArray(state.claimIssues) ||
                state.claimIssues.length > 30 ||
                state.claimIssues.some(
                    (issue) =>
                        !object(issue) ||
                        !Number.isSafeInteger(issue.index) ||
                        issue.index < 0 ||
                        issue.index > 29 ||
                        typeof issue.code !== 'string' ||
                        !/^[a-z_]{1,60}$/.test(issue.code) ||
                        (issue.hint !== undefined &&
                            (typeof issue.hint !== 'string' || issue.hint.length > 1000)) ||
                        !strings(issue.questionIds, 20, 50),
                ))) ||
        (state.failedSearchNetworkAttempts !== undefined &&
            (!Number.isSafeInteger(state.failedSearchNetworkAttempts) ||
                state.failedSearchNetworkAttempts < 0 ||
                state.failedSearchNetworkAttempts > 30)) ||
        (state.adaptiveSearchDisabled !== undefined &&
            typeof state.adaptiveSearchDisabled !== 'boolean') ||
        (state.searchBlocked !== undefined && typeof state.searchBlocked !== 'boolean') ||
        (state.modelBlocked !== undefined && typeof state.modelBlocked !== 'boolean') ||
        (state.comparisonRetried !== undefined && typeof state.comparisonRetried !== 'boolean') ||
        state.queries.length > MAX_QUERIES ||
        state.queries.some(
            (q) =>
                !object(q) ||
                typeof q.query !== 'string' ||
                !q.query.trim() ||
                q.query.length > 2000 ||
                (q.language !== undefined && !isSearchLanguage(q.language)) ||
                !strings(q.questionIds, MAX_QUESTIONS, 50),
        ) ||
        !Array.isArray(state.searches) ||
        state.searches.length > MAX_QUERIES ||
        !Array.isArray(state.selections) ||
        state.selections.length > MAX_PAGES ||
        !Array.isArray(state.claims) ||
        state.claims.length > (state.coveragePolicy ? 192 : 30) ||
        !strings(state.gaps, 1200, 4000) ||
        !Array.isArray(state.exhausted) ||
        state.exhausted.length > 5 ||
        !Number.isSafeInteger(state.synthesisAttempts) ||
        state.synthesisAttempts < 0 ||
        state.synthesisAttempts >
            (state.gapLoopPolicy ? GAP_LOOP_PASSES : state.coveragePolicy ? COVERAGE_PASSES : 2) ||
        !Number.isSafeInteger(state.searchIndex) ||
        state.searchIndex < 0 ||
        !Number.isSafeInteger(state.readIndex) ||
        state.readIndex < 0 ||
        state.questions.length > MAX_QUESTIONS ||
        state.pages.length > MAX_PAGES ||
        state.searchIndex > MAX_QUERIES ||
        state.readIndex > MAX_PAGES
    ) {
        throw new AgentError('INVALID_STATE', 'checkpoint 身份或状态不合法');
    }
    if (
        state.conflictReviewTargets?.some(
            (id) => !frozenRequirements(state).some((r) => r.id === id),
        )
    )
        throw new AgentError('INVALID_STATE', '冲突复核目标不属于冻结计划');
    for (const [receiptIndex, receipt] of (state.synthesisExtractions ?? []).entries()) {
        if (!isConflictReviewOperation(receipt.operationKey)) continue;
        const data = receipt.response.data;
        const review =
            object(data) && object(data.conflictReview) ? data.conflictReview : undefined;
        const requirement = frozenRequirements(state).find((r) => r.id === review?.requirementId);
        if (
            !requirement ||
            !validConflictReview(
                data,
                requirement,
                fieldConflicts(
                    {
                        ...state,
                        synthesisExtractions: state.synthesisExtractions!.slice(0, receiptIndex),
                    },
                    requirement,
                ),
            ) ||
            ![0, 1].some(
                (attempt) =>
                    receipt.operationKey ===
                    conflictReviewOperation(
                        Number(receipt.operationKey.split('-')[2]),
                        requirement.id,
                        attempt,
                    ),
            )
        )
            throw new AgentError('INVALID_STATE', '冲突复核回执不匹配冻结字段或原始冲突');
    }
}
