import { COVERAGE_PASSES } from '../synthesis-batches.ts';
import { type ResearchState } from '../state.ts';
import { deterministicClaims } from '../claims.ts';
import { candidate } from '../candidate.ts';
import type { AgentRuntime } from '../runtime.ts';
import { researchCompletion } from '../completion.ts';

export function validateNode(rt: AgentRuntime) {
    const { context, questions, formats } = rt;
    return async (state: ResearchState): Promise<ResearchState> => {
        if (state.coveragePolicy) {
            // Finish the whole pass before judging global coverage. A receipt succeeds
            // structurally without necessarily answering any frozen requirement.
            if (state.synthesisBatchIndex && !state.modelBlocked) {
                state.ready = false;
                return state;
            }
            if (!state.claims.length)
                state.claims = deterministicClaims(state).map((claim) => ({
                    ...claim,
                    outputFormat: formats[0],
                }));
            const progress = candidate(context, state).coverage;
            const delivery = progress.delivery;
            const complete =
                !!delivery &&
                delivery.questionCount > 0 &&
                delivery.answeredQuestions === delivery.questionCount;
            state.notes!.push(
                `覆盖检查：${delivery?.answeredQuestions ?? 0}/${delivery?.questionCount ?? questions.length} 个问题完整；第 ${state.synthesisAttempts} 轮综合结束`,
            );
            if (state.loopQualityPolicy) {
                if (state.modelBlocked) state.verificationStopReason = 'provider_unavailable';
                else if (state.adaptiveSearchDisabled)
                    state.verificationStopReason = 'source_limited';
                const completion = researchCompletion(progress, state.verificationStopReason);
                state.ready = state.gapLoop?.pending === undefined && completion.verificationDone;
            } else
                state.ready = state.gapLoopPolicy
                    ? (state.gapLoop?.pending === undefined &&
                          (complete || !!state.modelBlocked)) ||
                      !!state.gapLoop?.stopped ||
                      !!state.adaptiveSearchDisabled
                    : complete ||
                      !!state.modelBlocked ||
                      state.synthesisAttempts >= COVERAGE_PASSES ||
                      (state.synthesisAttempts === 2 &&
                          (state.answerSupplementStopped || state.adaptiveSearchDisabled === true));
            if (state.ready && !complete)
                state.gaps.push(
                    delivery?.answeredQuestions === 0
                        ? '覆盖验收失败：没有完整回答任何请求问题；仅保存部分材料，不能视为任务完成'
                        : '覆盖验收未通过：仍有请求问题或必要字段未完整回答',
                );
            return state;
        }
        if (!state.claims.length && state.synthesisAttempts >= 2) {
            state.claims = deterministicClaims(state).map((claim) => ({
                ...claim,
                outputFormat: formats[0],
            }));
            state.gaps.push('模型综合或引用校验失败，未完成报告；仅保留来源证据供核对');
        }
        state.ready =
            state.claims.length > 0 &&
            (!state.synthesisPolicy ||
                (state.synthesisAttempts > 0 &&
                    (!state.synthesisBatchIndex || !!state.modelBlocked))) &&
            (!state.claimIssues?.length || state.synthesisAttempts >= 2);
        if (
            state.ready &&
            state.valuePolicy &&
            state.answerSupplementEnabled &&
            !state.adaptiveSearchDisabled &&
            !state.answerSupplementStopped &&
            context.mode === 'live' &&
            state.synthesisAttempts === 1 &&
            state.claims.some((c) => c.assessment)
        )
            state.ready = false;
        if (state.ready) candidate(context, state);
        return state;
    };
}
