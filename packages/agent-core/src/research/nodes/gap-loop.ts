import { gapActions } from '../loop.ts';
import { chooseGap, gapProgress, gained, MAX_GAP_ACTIONS, GAP_LOOP_PASSES } from '../gap-loop.ts';
import { fieldSynthesisBatches } from '../synthesis-batches.ts';
import { boundedRecoveryQuery } from '../../search/recovery.ts';
import { scopedQuery } from '../context.ts';
import { frozenRequirements, needsConflictReview } from '../claims.ts';
import { candidate } from '../candidate.ts';
import type { ResearchState } from '../state.ts';
import type { AgentRuntime } from '../runtime.ts';
import { observedReadTarget } from '../../search/navigation.ts';

export function gapLoopNode(rt: AgentRuntime) {
    const { context, formats, now, deps } = rt;
    return async (state: ResearchState): Promise<ResearchState> => {
        const memory = (state.gapLoop ??= { history: [], cursor: 0 });
        const progress = candidate(context, state);
        const snapshot = gapProgress(progress, state.synthesisExtractions ?? []);
        if (memory.pending !== undefined) {
            const previous = memory.history[memory.pending]!;
            previous.gain = gained(
                previous.before,
                gapProgress(
                    progress,
                    state.synthesisExtractions ?? [],
                    state.loopQualityPolicy ? previous.requirementId : undefined,
                ),
                state.loopQualityPolicy ? previous.requirementId : undefined,
            );
            state.notes!.push(
                `缺口动作：${previous.requirementId} / ${previous.action}，${previous.gain ? '有增益' : '无新增有效证据或支持'}`,
            );
            delete memory.pending;
        }
        delete memory.target;
        delete memory.skipSynthesis;
        delete state.answerSupplement;
        const finish = (reason: string, stopReason: ResearchState['verificationStopReason']) => {
            memory.stopped = true;
            state.answerSupplementStopped = true;
            state.ready = true;
            if (state.loopQualityPolicy) state.verificationStopReason = stopReason;
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
            return finish(
                '预算、期限或调用保护已到达',
                state.modelBlocked
                    ? 'provider_unavailable'
                    : context.deadlineAt.getTime() - now() < 20_000
                      ? 'deadline'
                      : memory.history.length >= MAX_GAP_ACTIONS ||
                          state.synthesisAttempts >= GAP_LOOP_PASSES
                        ? 'iteration_limit'
                        : state.adaptiveSearchDisabled
                          ? 'source_limited'
                          : 'budget',
            );
        const requirements = frozenRequirements(state);
        const discoveryIndex = memory.history.findLastIndex(
            (h) =>
                (h.action === 'search' || h.action === 'read') &&
                (!!state.loopQualityPolicy || !!h.gain) &&
                snapshot.bodies.some((hash) => !h.before.bodies.includes(hash)),
        );
        const actions = gapActions(
            progress,
            requirements,
            state.synthesisExtractions ?? [],
            !!state.loopQualityPolicy,
        ).map((a) => {
            const query = boundedRecoveryQuery(
                scopedQuery(`${context.config.topic} ${a.query}`, context),
            );
            const reuseBody = state.loopQualityPolicy
                ? discoveryIndex >= 0 &&
                  memory.history[discoveryIndex]!.requirementId !== a.requirementId &&
                  !memory.history
                      .slice(discoveryIndex + 1)
                      .some((h) => h.requirementId === a.requirementId && h.action === 'rebind')
                : discoveryIndex >= 0 && state.queries.some((q) => q.query === query);
            if (a.action === 'search' && reuseBody)
                return { ...a, action: 'rebind' as const, query: '' };
            if (state.loopQualityPolicy && a.action === 'search') {
                const observed = observedReadTarget(context, state, a, deps.tools.providerReads);
                if (observed) return { ...a, action: 'read' as const, url: observed.url };
            }
            return a;
        });
        const eligible = actions.filter((a) => {
            if (a.action === 'read')
                return (
                    context.deadlineAt.getTime() - now() >= 20_000 &&
                    state.readIndex < Math.min(20, context.budget.maxPages) &&
                    context.usage.pages < context.budget.maxPages
                );
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
        if (!selected) {
            const retrievalBudget =
                !eligible.length &&
                actions.length > 0 &&
                actions.every((a) => a.action === 'read' || a.action === 'search') &&
                (context.usage.pages >= context.budget.maxPages ||
                    state.readIndex >= Math.min(20, context.budget.maxPages) ||
                    context.usage.searches >= context.budget.maxSearches);
            return finish(
                actions.length ? '所有缺口无新动作或已连续无增益' : '必答字段已有回答',
                actions.length ? (retrievalBudget ? 'budget' : 'no_progress') : 'verified',
            );
        }
        const target = selected.action;
        memory.target = target;
        memory.pending = memory.history.length;
        memory.history.push({
            fingerprint: selected.fingerprint,
            requirementId: target.requirementId,
            action: target.action,
            before: state.loopQualityPolicy
                ? gapProgress(progress, state.synthesisExtractions ?? [], target.requirementId)
                : snapshot,
        });
        const order = state.questions.map((q) => q.id);
        memory.cursor = (Math.max(0, order.indexOf(target.questionIds[0]!)) + 1) % order.length;
        state.ready = false;
        if (target.action === 'read') {
            const selection = observedReadTarget(context, state, target, deps.tools.providerReads);
            if (!selection || selection.url !== target.url)
                return finish('已发现来源不可执行', 'source_limited');
            state.selections = [...state.selections.slice(0, state.readIndex), selection];
            state.answerSupplement = {
                basePages: state.pages.length,
                readLimit: state.readIndex + 1,
                questionId: target.questionIds[0]!,
                query: target.query,
            };
        }
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
            if (!needsConflictReview(state))
                return finish('冲突复核不可执行，保留原冲突', 'no_progress');
        } else {
            const batchIndex = fieldSynthesisBatches(formats, requirements).findIndex((b) =>
                b.requirements.some((r) => r.id === target.requirementId),
            );
            if (batchIndex < 0) {
                delete memory.target;
                delete memory.pending;
                memory.history.pop();
                return finish('目标字段不在冻结综合批次中', 'source_limited');
            }
            state.synthesisBatchIndex = batchIndex;
        }
        return state;
    };
}
