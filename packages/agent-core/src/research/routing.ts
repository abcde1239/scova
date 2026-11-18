import { END } from '@langchain/langgraph';
import { needsConflictReview } from './claims.ts';
import type { ResearchState } from './state.ts';

/** Route only on frozen policy and committed cursors; no source text or current feature flags. */
export function routeAfterValidate(state: ResearchState) {
    if (needsConflictReview(state)) return 'conflict_review';
    if (state.ready) {
        if (state.modelAnswerPolicy && !state.modelAnswerDone) return 'model_answer';
        return state.coveragePolicy === 3 ? 'compare' : END;
    }
    if (state.coveragePolicy) {
        if (state.gapLoopPolicy && state.synthesisAttempts >= 2) return 'gap_loop';
        if (
            state.synthesisAttempts === 2 &&
            !state.synthesisBatchIndex &&
            !state.answerSupplementStopped
        )
            return 'answer_supplement';
    } else if (
        state.answerSupplementEnabled &&
        !state.answerSupplementStopped &&
        state.synthesisAttempts === 1 &&
        !state.claimIssues?.length
    )
        return 'answer_supplement';
    return 'synthesize';
}
