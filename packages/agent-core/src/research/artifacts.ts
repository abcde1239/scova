import type { ReportValue } from '@scova/models';
import type { AgentClaim, AgentContext } from '../types.ts';
import { createReportArtifacts } from '../report/artifacts/index.ts';
import { allSynthesisExtractions, partitionClaims } from './claims.ts';
import type { ResearchState } from './state.ts';

/** Execution and recovery project the same frozen plan, receipts and support policy. */
export function stateArtifactProjection(
    context: AgentContext,
    state: ResearchState,
    claims: AgentClaim[],
    value: ReportValue | undefined,
    questions = state.questions,
    completePlan = (state.coveragePolicy ?? 0) >= 2,
    fieldPatches = state.coveragePolicy === 3,
) {
    return createReportArtifacts(
        context,
        questions,
        claims,
        value,
        state.planningExtraction,
        allSynthesisExtractions(state),
        (raw) => partitionClaims({ claims: [raw] }, state).accepted[0],
        completePlan,
        fieldPatches,
        !!state.conflictReviewPolicy,
        {
            gapKinds: !!state.gapKindPolicy,
            pages: state.pages,
            strictFields: !!state.loopQualityPolicy,
        },
    );
}

/** Complete projection for graph nodes whose question coverage is already fixed. */
export function stateArtifacts(...args: Parameters<typeof stateArtifactProjection>) {
    return stateArtifactProjection(...args).finalize(args[3]);
}
