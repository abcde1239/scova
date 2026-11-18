import { selectedOutputFormats, type ReportArtifact } from '@scova/models';
import { supersededArtifactClaims } from '../../report/artifacts/index.ts';
import { buildReportValue } from '../../report/value.ts';
import type { AgentClaim, AgentContext } from '../../types.ts';
import type { ResearchState } from '../state.ts';
import { allSynthesisExtractions, partitionClaims } from '../claims.ts';
import { stateArtifactProjection } from '../artifacts.ts';

/** Bind fields, settle question coverage, then generate documents and summaries once. */
export function prepareCandidateArtifacts(
    context: AgentContext,
    state: ResearchState,
    claims: AgentClaim[],
) {
    const gaps: string[] = [];
    let reportValue = state.valuePolicy
        ? buildReportValue(context, state.questions, claims, state.pages, undefined, {
              gapKinds: !!state.gapKindPolicy,
          })
        : undefined;
    const projection = state.artifactPolicy
        ? stateArtifactProjection(
              context,
              state,
              claims,
              reportValue,
              state.questions,
              (state.coveragePolicy ?? 0) >= 2,
              state.coveragePolicy === 3,
          )
        : undefined;
    const artifacts: ReportArtifact[] =
        projection?.artifacts ??
        selectedOutputFormats(context.config).map((format) => ({
            format,
            claimIndexes: claims.flatMap((claim, index) =>
                (claim.outputFormat ?? selectedOutputFormats(context.config)[0]) === format
                    ? [index]
                    : [],
            ),
        }));
    if (state.artifactPolicy && reportValue) {
        const superseded = supersededArtifactClaims(
            claims,
            reportValue,
            artifacts,
            allSynthesisExtractions(state),
            (raw) => partitionClaims({ claims: [raw] }, state).accepted[0],
        );
        if (superseded.size)
            reportValue = buildReportValue(
                context,
                state.questions,
                claims,
                state.pages,
                superseded,
                { gapKinds: !!state.gapKindPolicy },
            );
    }
    const requirements = artifacts.flatMap((artifact) => artifact.coverage?.requirements ?? []);
    for (const requirement of requirements)
        if (requirement.required && requirement.status !== 'supported')
            gaps.push(
                `${requirement.status === 'model_answered' ? '所需信息缺少充分外部证据' : '所需信息尚未完整覆盖'}：${requirement.object} ${requirement.field}`,
            );
    if (reportValue && state.artifactPolicy) {
        for (const question of reportValue.questions) {
            const missing = requirements.filter(
                (r) =>
                    r.required && r.questionIds.includes(question.id) && r.status !== 'supported',
            );
            if (missing.length && question.status === 'supported') {
                question.status = 'provisional';
                question.gap = [...new Set(missing.map((r) => `${r.object} ${r.field}`.trim()))]
                    .join('；')
                    .slice(0, 1000);
            }
        }
    }
    projection?.finalize(reportValue);
    if (reportValue)
        for (const question of reportValue.questions)
            if (question.status !== 'supported')
                gaps.push(
                    `问题${question.status === 'unresolved' ? '尚无直接回答' : '仍有待核实项'}：${question.text}`,
                );
    return { artifacts, reportValue, gaps };
}
