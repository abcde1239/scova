import { selectedOutputFormats } from '@scova/models';
import { ConnectorError } from '@scova/connectors';
import { StateGraph, START, END } from '@langchain/langgraph';
import { type RunnableConfig } from '@langchain/core/runnables';
import { taskQuestions } from '../report/value.ts';
import {
    AgentError,
    type AgentCandidate,
    type AgentContext,
    type AgentDependencies,
} from '../types.ts';
import { feedbackDigest } from './feedback.ts';
import { type ResearchState, State, MAX_QUESTIONS, MAX_STEPS, expired, active } from './state.ts';
import { verifyIdentity } from './identity.ts';
import { routeAfterValidate } from './routing.ts';
import { candidate, candidateFromCheckpoint } from './candidate.ts';
import { createRuntime } from './runtime.ts';
import { loadContextNode } from './nodes/load-context.ts';
import { planNode } from './nodes/plan.ts';
import { searchNode } from './nodes/search.ts';
import { selectNode } from './nodes/select.ts';
import { readNode } from './nodes/read.ts';
import { verifyNode } from './nodes/verify.ts';
import { compareNode } from './nodes/compare.ts';
import { synthesizeNode } from './nodes/synthesize.ts';
import { answerSupplementNode } from './nodes/answer-supplement.ts';
import { conflictReviewNode } from './nodes/conflict-review.ts';
import { modelAnswerNode } from './nodes/model-answer.ts';
import { modelDraftNode } from './nodes/model-draft.ts';
import { gapLoopNode } from './nodes/gap-loop.ts';
import { validateNode } from './nodes/validate.ts';
import { checkpointWithoutPageText, hydrateCheckpointPages } from './pages.ts';
export { candidateFromCheckpoint, deterministicPartial } from './candidate.ts';

/** One graph, one promoted checkpoint per node. No SQL, queue, arbitrary script or delivery tool. */
export async function runResearchAgent(
    context: AgentContext,
    deps: AgentDependencies,
): Promise<AgentCandidate> {
    const questions = taskQuestions(context);
    if (
        !questions.length ||
        questions.length > MAX_QUESTIONS ||
        !Number.isFinite(context.deadlineAt.getTime())
    )
        throw new AgentError('INVALID_STATE', '任务问题范围或期限无效');
    if (
        !deps.config.configurable?.thread_id ||
        (deps.resume && !deps.config.configurable.checkpoint_id)
    )
        throw new AgentError('INVALID_STATE', '恢复必须指定已合法提升的 checkpoint');
    const collection = context.config.researchMode === 'collection';
    const initial: ResearchState = {
        ...(deps.loadPages ? { pagePolicy: 1 as const } : {}),
        ...(context.mode === 'live' && context.conversation?.operation !== 'revise'
            ? {
                  baselinePolicy: 1 as const,
                  ...(collection ? { collectionPolicy: 1 as const } : {}),
                  outputFormats: selectedOutputFormats(context.config),
              }
            : {}),
        ...(context.mode === 'live'
            ? {
                  ...(context.evidenceReasoning &&
                  context.fieldDriven &&
                  context.coverageDriven &&
                  !context.adaptiveSearchDisabled &&
                  context.conversation?.operation !== 'revise'
                      ? {
                            evidencePolicy: 1 as const,
                            ...(context.gapDriven
                                ? {
                                      researchLoopPolicy: 1 as const,
                                      ...(context.conflictResolution
                                          ? { conflictReviewPolicy: 1 as const }
                                          : {}),
                                      ...(context.answerCompletion
                                          ? { answerCompletionPolicy: 1 as const }
                                          : {}),
                                      ...(context.gapKinds ? { gapKindPolicy: 1 as const } : {}),
                                      ...(context.gapLoop
                                          ? {
                                                gapLoopPolicy: 1 as const,
                                                loopQualityPolicy: 1 as const,
                                                searchDirectionPolicy: 3 as const,
                                            }
                                          : {}),
                                      ...(!collection &&
                                      context.knowledgeFirst &&
                                      context.modelAnswerFallback
                                          ? { knowledgeFirstPolicy: 1 as const }
                                          : {}),
                                  }
                                : {}),
                        }
                      : {}),
                  ...(!collection &&
                  context.modelAnswerFallback &&
                  context.fieldDriven &&
                  context.coverageDriven &&
                  !context.adaptiveSearchDisabled &&
                  context.conversation?.operation !== 'revise'
                      ? {
                            modelAnswerPolicy: 1 as const,
                            modelAnswerFormats: selectedOutputFormats(context.config),
                        }
                      : {}),
                  ...(context.coverageDriven
                      ? { coveragePolicy: context.fieldDriven ? (3 as const) : (2 as const) }
                      : {}),
                  synthesisPolicy: 1 as const,
                  synthesisBatchIndex: 0,
              }
            : {}),
        answerSupplementEnabled: context.answerSupplementEnabled === true,
        valuePolicy: 1,
        artifactPolicy: 1,
        softEvidence: true,
        notes: [],
        adaptiveSearchDisabled: context.adaptiveSearchDisabled,
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
        pages: [],
        claims: [],
        synthesisAttempts: 0,
        gaps: [],
        exhausted: [],
        ready: false,
    };
    const rt = createRuntime(context, deps, questions, initial);
    const { now, guard } = rt;
    const node =
        (operation: (state: ResearchState) => Promise<ResearchState>) =>
        async (input: typeof State.State) => {
            await guard();
            const hydrated = await hydrateCheckpointPages(context, input.research, deps.loadPages);
            verifyIdentity(hydrated, context);
            return { research: checkpointWithoutPageText(await operation(hydrated)) };
        };
    const graph = new StateGraph(State)
        .addNode('load_context', node(loadContextNode(rt)))
        .addNode('plan', node(planNode(rt)))
        .addNode('search', node(searchNode(rt)))
        .addNode('select', node(selectNode(rt)))
        .addNode('read', node(readNode(rt)))
        .addNode('verify', node(verifyNode(rt)))
        .addNode('compare', node(compareNode(rt)))
        .addNode('synthesize', node(synthesizeNode(rt)))
        .addNode('answer_supplement', node(answerSupplementNode(rt)))
        .addNode('conflict_review', node(conflictReviewNode(rt)))
        .addNode('model_answer', node(modelAnswerNode(rt)))
        .addNode('model_draft', node(modelDraftNode(rt)))
        .addNode('gap_loop', node(gapLoopNode(rt)))
        .addNode('validate', node(validateNode(rt)))
        .addEdge(START, 'load_context')
        .addEdge('load_context', 'plan')
        .addConditionalEdges(
            'plan',
            (input) => (input.research.knowledgeFirstPolicy ? 'model_draft' : 'search'),
            ['model_draft', 'search'],
        )
        .addConditionalEdges(
            'model_draft',
            (input) => (input.research.modelDraftDone ? 'search' : 'model_draft'),
            ['search', 'model_draft'],
        )
        .addConditionalEdges(
            'search',
            (input) =>
                input.research.searchIndex < input.research.queries.length ? 'search' : 'select',
            ['search', 'select'],
        )
        .addConditionalEdges(
            'select',
            (input) =>
                input.research.searchIndex < input.research.queries.length
                    ? 'search'
                    : input.research.readIndex < input.research.selections.length
                      ? 'read'
                      : 'verify',
            ['search', 'read', 'verify'],
        )
        .addConditionalEdges(
            'read',
            (input) =>
                input.research.readIndex < input.research.selections.length
                    ? input.research.readIndex % 3 === 0
                        ? 'select'
                        : 'read'
                    : 'select',
            ['read', 'select'],
        )
        .addConditionalEdges(
            'verify',
            (input) => (input.research.coveragePolicy === 3 ? 'synthesize' : 'compare'),
            ['synthesize', 'compare'],
        )
        .addConditionalEdges(
            'compare',
            (input) => (input.research.coveragePolicy === 3 ? END : 'synthesize'),
            [END, 'synthesize'],
        )
        .addEdge('synthesize', 'validate')
        .addEdge('conflict_review', 'validate')
        .addConditionalEdges(
            'gap_loop',
            (input) => {
                const state = input.research;
                if (state.ready)
                    return state.modelAnswerPolicy && !state.modelAnswerDone
                        ? 'model_answer'
                        : 'compare';
                return state.gapLoop?.target?.action === 'search'
                    ? 'search'
                    : state.gapLoop?.target?.action === 'read'
                      ? 'read'
                      : state.gapLoop?.target?.action === 'conflict'
                        ? 'conflict_review'
                        : 'synthesize';
            },
            ['model_answer', 'compare', 'search', 'read', 'conflict_review', 'synthesize'],
        )
        .addConditionalEdges(
            'model_answer',
            (input) => (input.research.modelAnswerDone ? 'compare' : 'model_answer'),
            ['model_answer', 'compare'],
        )
        .addConditionalEdges(
            'answer_supplement',
            (input) =>
                input.research.ready
                    ? input.research.modelAnswerPolicy && !input.research.modelAnswerDone
                        ? 'model_answer'
                        : input.research.coveragePolicy === 3
                          ? 'compare'
                          : END
                    : 'search',
            [END, 'compare', 'model_answer', 'search'],
        )
        .addConditionalEdges('validate', (input) => routeAfterValidate(input.research), [
            END,
            'compare',
            'model_answer',
            'conflict_review',
            'synthesize',
            'answer_supplement',
            'gap_loop',
        ])
        .compile({ checkpointer: deps.checkpointer, interruptAfter: '*' });

    let config: RunnableConfig = deps.config;
    let promoted = initial;
    let nextStep = 'load_context';
    if (deps.resume) {
        const snapshot = await graph.getState(config);
        if (!snapshot.values?.research || !snapshot.config.configurable?.checkpoint_id)
            throw new AgentError('INVALID_STATE', '指定 checkpoint 不存在');
        promoted = snapshot.values.research;
        verifyIdentity(await hydrateCheckpointPages(context, promoted, deps.loadPages), context);
        nextStep = snapshot.next[0] ?? 'validate';
    }
    for (let step = 0; step < MAX_STEPS; step++) {
        await active(context, true);
        if (now() >= context.deadlineAt.getTime()) {
            // Worker hosts interrupt work and use their fenced onDeadline adapter. This path also
            // supports hosts whose active guard permits a pure in-process deadline projection.
            return candidateFromCheckpoint(
                context,
                await hydrateCheckpointPages(context, promoted, deps.loadPages),
                'deadline',
            );
        }
        if (
            promoted.ready &&
            !(
                promoted.coveragePolicy === 3 &&
                ['compare', 'model_answer', 'conflict_review'].includes(nextStep)
            )
        )
            return candidate(
                context,
                await hydrateCheckpointPages(context, promoted, deps.loadPages),
            );
        const execution = {
            sourceCheckpoint: String(config.configurable?.checkpoint_id ?? 'initial'),
        };
        await deps.onStep?.(nextStep, 'started', execution);
        try {
            await graph.invoke(!deps.resume && step === 0 ? { research: initial } : null, {
                ...config,
                recursionLimit: MAX_STEPS,
                signal: context.signal,
            });
        } catch (error) {
            const deadlineInterruption =
                (error instanceof ConnectorError &&
                    (error.code === 'aborted' || error.code === 'timeout')) ||
                (error instanceof AgentError && error.code === 'ABORTED') ||
                (context.signal.aborted && error instanceof Error && error.name === 'AbortError');
            if (!deadlineInterruption) throw error;
            await active(context, true);
            if (expired(context, deps)) {
                return candidateFromCheckpoint(
                    context,
                    await hydrateCheckpointPages(context, promoted, deps.loadPages),
                    'deadline',
                );
            }
            throw error;
        }
        const snapshot = await graph.getState({
            ...config,
            configurable: { ...config.configurable, checkpoint_id: undefined },
        });
        if (!snapshot.values?.research || !snapshot.config.configurable?.checkpoint_id)
            throw new AgentError('INVALID_STATE', '节点执行未保存 checkpoint');
        await active(context, true);
        await deps.promote(snapshot.config);
        await deps.onStep?.(nextStep, 'completed', execution);
        config = snapshot.config;
        promoted = snapshot.values.research;
        verifyIdentity(await hydrateCheckpointPages(context, promoted, deps.loadPages), context);
        nextStep = snapshot.next[0] ?? 'validate';
        if (!snapshot.next.length && !promoted.ready)
            throw new AgentError('INVALID_STATE', '图提前结束，未产生合法候选成果');
    }
    return candidate(
        context,
        await hydrateCheckpointPages(context, promoted, deps.loadPages),
        '达到有限图步数上限，结果不完整',
    );
}
