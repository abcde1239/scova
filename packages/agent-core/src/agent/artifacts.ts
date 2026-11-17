import type { ReportValue } from '@scova/models';
import type { AgentClaim, AgentContext } from '../types.ts';
import { buildReportArtifacts } from '../report-artifacts.ts';
import { allSynthesisExtractions, partitionClaims } from './claims.ts';
import type { ResearchState } from './state.ts';

/** Execution and recovery project the same frozen plan, receipts and support policy. */
export function stateArtifacts(
    context: AgentContext,
    state: ResearchState,
    claims: AgentClaim[],
    value: ReportValue | undefined,
    questions = state.questions,
    completePlan = (state.coveragePolicy ?? 0) >= 2,
    fieldPatches = state.coveragePolicy === 3,
) {
    return buildReportArtifacts(
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
        { gapKinds: !!state.gapKindPolicy, pages: state.pages },
    );
}
