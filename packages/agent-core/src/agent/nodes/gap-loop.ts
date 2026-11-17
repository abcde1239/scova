import { gapActions } from '../../research-loop.ts';
import {
    chooseGap,
    gapProgress,
    gained,
    MAX_GAP_ACTIONS,
    GAP_LOOP_PASSES,
} from '../../gap-loop.ts';
import { fieldSynthesisBatches } from '../../synthesis-batches.ts';
import { boundedRecoveryQuery } from '../../search-recovery.ts';
import { scopedQuery } from '../../research-context.ts';
import { frozenRequirements, needsConflictReview } from '../claims.ts';
import { candidate } from '../candidate.ts';
import type { ResearchState } from '../state.ts';
import type { AgentRuntime } from '../runtime.ts';

export function gapLoopNode(rt: AgentRuntime) {
    const { context, formats, now } = rt;
    return async (state: ResearchState): Promise<ResearchState> => {
        const memory = (state.gapLoop ??= { history: [], cursor: 0 });
        const progress = candidate(context, state);
        const snapshot = gapProgress(progress, state.synthesisExtractions ?? []);
        if (memory.pending !== undefined) {
            const previous = memory.history[memory.pending]!;
            previous.gain = gained(previous.before, snapshot);
            state.notes!.push(
                `缺口动作：${previous.requirementId} / ${previous.action}，${previous.gain ? '有增益' : '无新增有效证据或支持'}`,
            );
            delete memory.pending;
        }
        delete memory.target;
        delete memory.skipSynthesis;
        delete state.answerSupplement;
        const finish = (reason: string) => {
            memory.stopped = true;
            state.answerSupplementStopped = true;
            state.ready = true;
            state.notes!.push(`缺口循环停止：${reason}`);
            return state;
        };
        if (
            state.modelBlocked ||
            state.adaptiveSearchDisabled ||
            memory.history.length >= MAX_GAP_ACTIONS ||
            state.synthesisAttempts >= GAP_LOOP_PASSES ||
            context.deadlineAt.getTime() - now() < 20_000 ||
            context.budget.maxInputTokens - context.usage.inputTokens < 8000 ||
            context.budget.maxOutputTokens - context.usage.outputTokens < 1600
        )
            return finish('预算、期限或调用保护已到达');
        const requirements = frozenRequirements(state);
        const newBodiesFromSearch = memory.history.some(
            (h) =>
                h.action === 'search' &&
                h.gain &&
                snapshot.bodies.some((hash) => !h.before.bodies.includes(hash)),
        );
        const actions = gapActions(progress, requirements, state.synthesisExtractions ?? []).map(
            (a) => {
                const query = boundedRecoveryQuery(
                    scopedQuery(`${context.config.topic} ${a.query}`, context),
                );
                return a.action === 'search' &&
                    newBodiesFromSearch &&
                    state.queries.some((q) => q.query === query)
                    ? { ...a, action: 'rebind' as const, query: '' }
                    : a;
            },
        );
        const eligible = actions.filter((a) => {
            if (a.action === 'search') {
                const query = boundedRecoveryQuery(
                    scopedQuery(`${context.config.topic} ${a.query}`, context),
                );
                return (
                    !state.searchBlocked &&
                    context.deadlineAt.getTime() - now() >= 45_000 &&
                    state.queries.length < Math.min(10, context.budget.maxSearches) &&
                    context.usage.searches < context.budget.maxSearches &&
                    state.readIndex < Math.min(20, context.budget.maxPages) &&
                    context.usage.pages < context.budget.maxPages &&
                    !state.queries.some((q) => q.query === query)
                );
            }
            return a.action !== 'conflict' || !!state.conflictReviewPolicy;
        });
        const selected = chooseGap(
            eligible,
            memory,
            progress,
            (state.claimIssues ?? []).map((i) => i.code),
        );
        if (!selected)
            return finish(actions.length ? '所有缺口无新动作或已连续无增益' : '必答字段已有回答');
        const target = selected.action;
        memory.target = target;
        memory.pending = memory.history.length;
        memory.history.push({
            fingerprint: selected.fingerprint,
            requirementId: target.requirementId,
            action: target.action,
            before: snapshot,
        });
        const order = state.questions.map((q) => q.id);
        memory.cursor = (Math.max(0, order.indexOf(target.questionIds[0]!)) + 1) % order.length;
        state.ready = false;
        if (target.action === 'search') {
            const query = boundedRecoveryQuery(
                scopedQuery(`${context.config.topic} ${target.query}`, context),
            );
            state.answerSupplement = {
                basePages: state.pages.length,
                readLimit: Math.min(20, context.budget.maxPages, state.readIndex + 4),
                questionId: target.questionIds[0]!,
                query,
            };
            state.queries.push({ query, questionIds: target.questionIds });
            state.supplementalSearches = (state.supplementalSearches ?? 0) + 1;
        }
        if (target.action === 'conflict') {
            // Each selected conflict gets its own frozen pass identity and at most one repair.
            state.conflictReviewPass = state.synthesisAttempts;
            state.conflictReviewTargets = [target.requirementId];
            state.conflictReviewIndex = 0;
            state.conflictReviewAttempt = 0;
            if (!needsConflictReview(state)) return finish('冲突复核不可执行，保留原冲突');
        } else {
            state.synthesisBatchIndex = fieldSynthesisBatches(formats, requirements).findIndex(
                (b) => b.requirements.some((r) => r.id === target.requirementId),
            );
        }
        return state;
    };
}
