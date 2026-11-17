import { GAP_LOOP_PASSES } from '../../gap-loop.ts';
import { fallbackRequirements, plannedRequirements } from '../../report-artifacts.ts';
import {
    synthesisBatches,
    synthesisBatchLimits,
    synthesisOperation,
    coverageBatchLimits,
    fieldSynthesisBatches,
    COVERAGE_PASSES,
} from '../../synthesis-batches.ts';
import { gapActions } from '../../research-loop.ts';
import { ConnectorError } from '@scova/connectors';
import { buildReportValue } from '../../report-value.ts';
import { type ResearchState, modelRepairHint } from '../state.ts';
import { deterministicClaims } from '../claims.ts';
import { candidate } from '../candidate.ts';
import type { AgentRuntime } from '../runtime.ts';
import { stateArtifacts } from '../artifacts.ts';
import { createSynthesisRequest, createSynthesisInput } from './synthesis/request.ts';
import { acceptSynthesisResponse } from './synthesis/accept.ts';

export function synthesizeNode(rt: AgentRuntime) {
    const {
        context,
        deps,
        questions,
        guard,
        blockQuotaFailure,
        planningOutputTokens,
        formats,
        comparisonReservation,
    } = rt;
    return async (state: ResearchState): Promise<ResearchState> => {
        const passLimit = state.gapLoopPolicy
            ? GAP_LOOP_PASSES
            : state.coveragePolicy
              ? COVERAGE_PASSES
              : 2;
        const localTarget = state.gapLoopPolicy ? state.gapLoop?.target : undefined;
        if (localTarget && state.gapLoop?.skipSynthesis) {
            state.synthesisAttempts = Math.min(passLimit, state.synthesisAttempts + 1);
            state.synthesisBatchIndex = 0;
            return state;
        }
        if (state.synthesisAttempts >= passLimit) return state;
        if (state.modelBlocked) {
            state.synthesisAttempts = passLimit;
            return state;
        }
        if (context.mode === 'demo') {
            state.claims = deterministicClaims(state).map((claim) => ({
                ...claim,
                outputFormat: formats[0],
            }));
            state.gaps.push(
                context.mode === 'demo'
                    ? '固定演示内容，不代表真实互联网研究'
                    : '综合模型预算不足，只返回已采集原文',
            );
            state.synthesisAttempts = 2;
            return state;
        }
        const requirements =
            plannedRequirements(
                state.planningExtraction?.response.data,
                formats,
                questions,
                false,
                (state.coveragePolicy ?? 0) >= 2,
            ) ?? fallbackRequirements(formats, questions);
        const batches = state.synthesisPolicy
            ? state.coveragePolicy === 3
                ? fieldSynthesisBatches(formats, requirements)
                : synthesisBatches(formats, requirements, !!state.coveragePolicy)
            : [];
        let batchIndex = state.synthesisBatchIndex ?? 0;
        const attempt = state.synthesisAttempts;
        const fieldCoverage =
            state.coveragePolicy === 3
                ? stateArtifacts(
                      context,
                      state,
                      state.claims,
                      buildReportValue(context, questions, state.claims, state.pages, undefined, {
                          gapKinds: !!state.gapKindPolicy,
                      }),
                      questions,
                      true,
                      true,
                  ).flatMap((a) => a.coverage?.requirements ?? [])
                : [];
        const fieldActions =
            state.researchLoopPolicy && (attempt % 2 || localTarget) && state.claims.length
                ? gapActions(
                      candidate(context, state),
                      requirements,
                      state.synthesisExtractions ?? [],
                  )
                : [];
        const pending = (index: number) =>
            batches[index]!.requirements.filter(
                (r) =>
                    (!localTarget || r.id === localTarget.requirementId) &&
                    !fieldCoverage.some(
                        (saved) => saved.id === r.id && saved.status === 'supported',
                    ) &&
                    (!!localTarget ||
                        !state.researchLoopPolicy ||
                        !(attempt % 2) ||
                        !state.claims.length ||
                        fieldActions.some(
                            (action) =>
                                action.requirementId === r.id &&
                                ['rebind', 'repair'].includes(action.action),
                        )),
            );
        if (
            state.coveragePolicy === 3 ||
            (state.synthesisPolicy && attempt && !state.answerSupplement)
        ) {
            while (
                batchIndex < batches.length &&
                (state.coveragePolicy === 3
                    ? !pending(batchIndex).length
                    : state.synthesisBatchIssues?.find((b) => b.batch === batchIndex)?.issues
                          .length === 0)
            )
                batchIndex++;
            if (batchIndex === batches.length) {
                // No failed batch remains in this evidence set.
                state.synthesisAttempts =
                    state.coveragePolicy === 3
                        ? Math.min(passLimit, attempt + 1)
                        : state.coveragePolicy
                          ? attempt < 2
                              ? 2
                              : passLimit
                          : 2;
                state.synthesisBatchIndex = 0;
                return state;
            }
        }
        const batch =
            state.coveragePolicy === 3 && batches[batchIndex]
                ? {
                      ...batches[batchIndex]!,
                      requirements: pending(batchIndex),
                      ...(localTarget
                          ? {
                                maxClaims: Math.min(
                                    24,
                                    Math.max(2, localTarget.questionIds.length * 2),
                                ),
                            }
                          : {}),
                  }
                : batches[batchIndex];
        const claimCapacity = state.coveragePolicy
            ? (state.coveragePolicy ?? 0) >= 2
                ? 192
                : batches.reduce((n, b) => n + b.maxClaims, 0)
            : 30;
        const batchFormats = batch ? [batch.format] : formats;
        const synthesisClaimLimit =
            batch?.maxClaims ??
            (formats.length > 1 || formats.includes('research_report') ? 30 : 24);
        if (state.synthesisPolicy)
            state.claimIssues =
                state.synthesisBatchIssues?.find((b) => b.batch === batchIndex)?.issues ?? [];
        else state.synthesisAttempts++;
        if (attempt && state.claimIssues?.length) await deps.onClaimsRepair?.();
        if (state.researchLoopPolicy && attempt % 2)
            state.notes!.push(
                `按字段缺口处理：${fieldActions
                    .filter((a) => batch?.requirements.some((r) => r.id === a.requirementId))
                    .map(
                        (a) =>
                            `${a.object} ${a.field} → ${a.action === 'rebind' ? '复用正文重绑' : '修复综合结构'}`,
                    )
                    .join('；')}`,
            );
        // Stable stage limits reserve both attempts even when the failed plan was billed.
        const synthesisOutputBudget =
            context.budget.maxOutputTokens -
            planningOutputTokens * (state.planningRetried ? 3 : 1) -
            comparisonReservation(state);
        const batchLimits = state.coveragePolicy
            ? coverageBatchLimits(
                  context.budget.maxInputTokens,
                  synthesisOutputBudget,
                  batches.length || 1,
                  (state.synthesisExtractions ?? []).reduce(
                      (n, r) => n + (r.response.usage?.outputTokens ?? 0),
                      0,
                  ),
                  localTarget ? 1 : batches.length - batchIndex,
              )
            : synthesisBatchLimits(
                  context.budget.maxInputTokens,
                  synthesisOutputBudget,
                  batches.length || 1,
              );
        const requestOptions = {
            batch,
            requirements,
            attempt,
            batchLimits,
            synthesisOutputBudget,
            synthesisClaimLimit,
            fieldActions,
            localTarget,
        };
        const request = createSynthesisRequest(rt, state, requestOptions);
        try {
            const prepared = createSynthesisInput(rt, state, requestOptions, request);
            if (prepared.clipped)
                state.gaps.push('综合输入受预算限制，仅查阅任务相关正文片段，未完整覆盖来源原文');
            const response = await deps.tools.model(
                batch ? synthesisOperation(batchIndex, attempt) : `synthesize-${attempt}`,
                prepared.input,
            );
            await guard();
            acceptSynthesisResponse(rt, state, response, {
                batch,
                attempt,
                batchIndex,
                claimCapacity,
                batchFormats,
                batchQuestions: request.batchQuestions,
            });
        } catch (error) {
            await guard();
            blockQuotaFailure(state, error);
            if (state.modelBlocked) state.synthesisAttempts = passLimit;
            if (error instanceof ConnectorError && error.code === 'output_truncated')
                state.gaps.push('模型输出达到长度上限，未完成的内容已丢弃并尝试重新归纳');
            state.claimIssues = [
                {
                    index: 0,
                    code:
                        error instanceof ConnectorError && error.modelFailure
                            ? `model_${error.modelFailure}_failed`
                            : 'model_failed',
                    questionIds: [],
                    ...(error instanceof ConnectorError && error.modelFailure
                        ? {
                              hint: modelRepairHint(error),
                          }
                        : {}),
                },
            ];
        }
        if (batch) {
            state.synthesisBatchIssues = [
                ...(state.synthesisBatchIssues ?? []).filter((b) => b.batch !== batchIndex),
                { batch: batchIndex, issues: state.claimIssues ?? [] },
            ].sort((a, b) => a.batch - b.batch);
            state.claimIssues = state.synthesisBatchIssues.flatMap((b) => b.issues).slice(0, 30);
            state.synthesisBatchIndex = batchIndex + 1;
            if (localTarget || state.synthesisBatchIndex === batches.length) {
                state.synthesisAttempts = state.modelBlocked
                    ? passLimit
                    : Math.min(passLimit, attempt + 1);
                state.synthesisBatchIndex = 0;
            }
        }
        return state;
    };
}
