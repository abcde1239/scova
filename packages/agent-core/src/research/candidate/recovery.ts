import { createHash } from 'node:crypto';
import { PAGE_TEXT_CHAR_LIMIT } from '@scova/connectors';
import { taskQuestions } from '../../report/value.ts';
import { AgentError, type AgentCandidate, type AgentContext, type AgentPage } from '../../types.ts';
import { feedbackDigest } from '../feedback.ts';
import { type ResearchState, MAX_PAGES, allowed } from '../state.ts';
import { verifyIdentity } from '../identity.ts';
import { candidate } from './build.ts';
import { assertPageText } from '../pages.ts';

/** Pure deadline projection. The worker must authorize cancellation/owner/lease before using it. */
export function candidateFromCheckpoint(
    context: AgentContext,
    value: unknown,
    reason?: 'deadline',
): AgentCandidate {
    const state = structuredClone(value) as ResearchState;
    verifyIdentity(state, context);
    assertPageText(state);
    if (reason === 'deadline') {
        state.exhausted = [...new Set([...state.exhausted, 'time' as const])];
        const message = '执行时间预算耗尽，保留已合法提升的结论与证据';
        if (
            !state.claims.length &&
            !state.pages.length &&
            !(state.collectionPolicy && state.dateScreening?.length)
        )
            throw new AgentError('NO_EVIDENCE', '截止时没有已提升的结论或可用正文');
        // The generic reason path intentionally falls back to excerpts. A deadline must instead
        // revalidate and retain promoted synthesis/model claims, then mark the delivery partial.
        const projected = candidate(context, state, state.claims.length ? undefined : message);
        projected.coverage.completeness = 'partial';
        projected.coverage.gaps = [...new Set([...projected.coverage.gaps, message])];
        if (projected.coverage.baseline)
            projected.coverage.baseline = {
                ...projected.coverage.baseline,
                eligible: false,
                reason: 'incomplete',
            };
        return projected;
    }
    if (state.ready !== true) throw new AgentError('INVALID_STATE', 'checkpoint 尚未完成引用校验');
    return candidate(context, state);
}

export function deterministicPartial(context: AgentContext, pages: AgentPage[]): AgentCandidate {
    const questions = taskQuestions(context);
    if (
        pages.length > MAX_PAGES ||
        pages.some(
            (page) =>
                !page.id ||
                page.mode !== context.mode ||
                page.kind !== 'read_page' ||
                typeof page.text !== 'string' ||
                !page.text.trim() ||
                page.text.length > PAGE_TEXT_CHAR_LIMIT ||
                !allowed(context, page.url) ||
                !allowed(context, page.fetchedUrl) ||
                page.contentHash !== createHash('sha256').update(page.text, 'utf8').digest('hex'),
        )
    )
        throw new AgentError('INVALID_STATE', '持久化正文不符合当前执行的证据约束');
    const state: ResearchState = {
        valuePolicy: 1,
        artifactPolicy: 1,
        feedbackDigest: feedbackDigest(context),
        schemaVersion: 1,
        runId: context.runId,
        userId: context.userId,
        taskVersionId: context.taskVersionId,
        mode: context.mode,
        questions,
        queries: [],
        searchIndex: 0,
        searches: [],
        selections: [],
        readIndex: 0,
        pages,
        claims: [],
        synthesisAttempts: 0,
        gaps: pages.some((page) => page.truncated) ? ['存在已截断正文'] : [],
        exhausted: ['time'],
        ready: false,
    };
    return candidate(
        context,
        state,
        '执行时间预算耗尽，仅保留已持久化的原文摘录，未完成综合和查证',
    );
}
