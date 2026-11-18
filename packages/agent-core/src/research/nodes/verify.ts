import { COVERAGE_PASSES } from '../synthesis-batches.ts';
import { AgentError } from '../../types.ts';
import { type ResearchState } from '../state.ts';
import type { AgentRuntime } from '../runtime.ts';

export function verifyNode(rt: AgentRuntime) {
    const { formats } = rt;
    return async (state: ResearchState): Promise<ResearchState> => {
        if (
            !state.pages.length &&
            !state.modelAnswerPolicy &&
            !state.gapLoopPolicy &&
            !state.collectionPolicy
        )
            throw new AgentError('NO_EVIDENCE', '没有可用的已采集正文，搜索摘要不能代替证据');
        if (
            !state.pages.length &&
            (state.modelAnswerPolicy || state.gapLoopPolicy || state.collectionPolicy)
        ) {
            if (!state.gapLoopPolicy) {
                state.synthesisAttempts = state.coveragePolicy ? COVERAGE_PASSES : 2;
                state.answerSupplementStopped = true;
            }
            state.claims = [
                ...(state.knowledgeFirstPolicy ? state.claims : []),
                ...formats.map((outputFormat) => ({
                    outputFormat,
                    kind: 'insufficient' as const,
                    text: '外部检索未取得可用正文。',
                    citations: [],
                    questionIds: [],
                })),
            ];
            return state;
        }
        if (state.coveragePolicy === 3 && state.answerSupplement) {
            const hashes = new Set(
                state.pages.slice(0, state.answerSupplement.basePages).map((p) => p.contentHash),
            );
            if (
                !state.pages
                    .slice(state.answerSupplement.basePages)
                    .some((p) => !hashes.has(p.contentHash))
            ) {
                if (state.gapLoopPolicy) state.gapLoop!.skipSynthesis = true;
                else state.synthesisAttempts = COVERAGE_PASSES;
                state.notes!.push('定向补证未取得新增正文信息，停止追加模型调用，保留已有回答');
            }
        }
        return state;
    };
}
