import { type AgentCandidate, type AgentContext } from '../../types.ts';
import { explainFeedback } from '../../feedback.ts';
import { type ResearchState, unique, within, allowed } from '../state.ts';
import { prepareCandidateEvidence } from './evidence.ts';
import { buildCandidateCoverage } from './coverage.ts';

export function candidate(
    context: AgentContext,
    state: ResearchState,
    reason?: string,
): AgentCandidate {
    const evidence = prepareCandidateEvidence(context, state, reason);
    const { gaps, comparison, claims } = evidence;
    for (const question of state.questions) {
        if (
            !state.valuePolicy &&
            !claims.some(
                (claim) =>
                    (claim.kind === 'fact' || (state.softEvidence && claim.kind === 'inference')) &&
                    claim.questionIds.includes(question.id),
            )
        )
            gaps.push(
                `${state.softEvidence ? '子问题尚无有引用的回答' : '子问题尚无已核验事实'}：${question.text}`,
            );
    }
    if (
        !state.valuePolicy &&
        claims.some((claim) => claim.kind === 'conflict' || claim.kind === 'insufficient')
    )
        gaps.push('存在冲突或证据不足，尚未完成查证');
    for (const preferred of context.config.sourcePreferences.preferredUrls) {
        if (!state.pages.some((page) => within(page.url, preferred)))
            gaps.push('优先来源未完成正文采集');
    }
    const allGaps = unique(gaps);
    const feedback = explainFeedback(
        context,
        state,
        claims,
        (url) => allowed(context, url),
        comparison?.changes,
    );
    return buildCandidateCoverage(context, state, evidence, feedback, allGaps);
}
