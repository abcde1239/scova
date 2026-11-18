import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import {
    runResearchAgent,
    deterministicPartial,
    candidateFromCheckpoint,
    AgentError,
    type AgentPageRef,
    type AgentCandidate,
    type AgentContext,
} from '@scova/agent-core';
import { ConnectorError, type ConnectorBundle } from '@scova/connectors';
import { type AgentRepository } from '@/repo/agent.ts';
import type { RunExecutionContext } from '@/service/runs.ts';
import { RunExecutionError, type RunLeaseToken, type RunProgressEvent } from '@/utils/runs.ts';
import { within } from '@/utils/timeout.ts';
import { digest, readPage } from '@/service/agent/tool-results.ts';
import { createSessionCheckpoints } from '@/service/agent/checkpoints.ts';
import { createSessionPersistence } from '@/service/agent/persistence.ts';
import { createToolCaller } from '@/service/agent/tool-call.ts';
import { createAgentTools } from '@/service/agent/tools.ts';

export interface AgentSessionOptions {
    answerSupplementEnabled?: boolean;
    adaptiveSearchDisabled?: boolean;
    repository: AgentRepository;
    saver: PostgresSaver;
    token: RunLeaseToken;
    context: RunExecutionContext;
    bundle: ConnectorBundle;
}

/** Trusted worker adapter; only bound tools and graph state reach agent-core. */
export function createAgentSession({
    answerSupplementEnabled,
    adaptiveSearchDisabled: optionsAdaptiveSearchDisabled,
    repository: rawRepository,
    saver: rawSaver,
    token,
    context,
    bundle,
}: AgentSessionOptions) {
    const { repository, saver, trackDomain, drain } = createSessionPersistence(
        rawRepository,
        rawSaver,
        context,
    );
    const currentUsage = { ...context.usage };
    let tokenBudgetInvalid = false;
    const guard = async () => {
        if (context.controlSignal?.aborted || context.signal.aborted)
            throw new ConnectorError('aborted', '执行已停止');
        await context.assertActive();
        if (tokenBudgetInvalid)
            throw new ConnectorError('budget_exceeded', '模型预算已失效，停止后续调用');
    };

    const { promote, openCheckpoint, readDeadlineCheckpoint } = createSessionCheckpoints(
        { repository, saver, token },
        guard,
        (config) => trackDomain(() => rawSaver.getTuple(config), true),
    );
    const call = createToolCaller({ repository, context, bundle }, currentUsage, guard, () => {
        tokenBudgetInvalid = true;
    });
    const tools = createAgentTools({ repository, context, bundle }, currentUsage, call);
    const agentContext: AgentContext = {
        conversation: context.conversation,
        coverageDriven: true,
        fieldDriven: true,
        modelAnswerFallback: true,
        evidenceReasoning: true,
        gapDriven: true,
        conflictResolution: true,
        answerCompletion: true,
        gapKinds: true,
        knowledgeFirst: true,
        gapLoop: true,
        answerSupplementEnabled,
        adaptiveSearchDisabled:
            optionsAdaptiveSearchDisabled || context.conversation?.operation === 'revise',
        runId: context.runId,
        userId: context.userId,
        taskVersionId: context.taskVersionId,
        mode: context.mode,
        config: context.config,
        budget: context.budget,
        usage: currentUsage,
        deadlineAt: context.deadlineAt,
        startedAt: context.startedAt,
        signal: context.signal,
        assertActive: () => context.assertActive(),
        demoReason: bundle.reason,
    };
    return {
        tools,
        openCheckpoint,
        persist: trackDomain,
        drain: async () => {
            const results = await Promise.allSettled([
                within(
                    Promise.resolve().then(() => bundle.reader.close?.()),
                    5_000,
                    'Reader 停止超时',
                ),
                within(drain(), 6_000, 'Agent 持久化停止超时'),
            ]);
            const failed = results.find((result) => result.status === 'rejected');
            if (failed?.status === 'rejected') throw failed.reason;
        },
        async execute(): Promise<AgentCandidate> {
            if (bundle.mode !== context.mode)
                throw new RunExecutionError('AGENT_CONFIGURATION_INVALID');
            Object.assign(agentContext, await repository.comparison());
            const opened = await openCheckpoint();
            const startedSteps = new Map<string, number>();
            const candidate = await runResearchAgent(agentContext, {
                ...opened,
                tools,
                loadPages: (refs) => repository.readCheckpointPages(refs),
                checkpointer: saver,
                promote,
                onClaimsRepair: () =>
                    context.emit({ type: 'research.updated', payload: { state: 'claims_repair' } }),
                onStep: async (step, phase) => {
                    const name = step as Extract<
                        RunProgressEvent,
                        { type: 'step.started' }
                    >['payload']['step'];
                    if (phase === 'started') {
                        startedSteps.set(step, performance.now());
                        await context.emit({ type: 'step.started', payload: { step: name } });
                    } else {
                        await context.emit({
                            type: 'step.completed',
                            payload: {
                                step: name,
                                durationMs: Math.max(
                                    0,
                                    Math.floor(
                                        performance.now() -
                                            (startedSteps.get(step) ?? performance.now()),
                                    ),
                                ),
                            },
                        });
                    }
                },
            });
            await guard();
            await context.emit({ type: 'coverage.updated', payload: candidate.coverage });
            return candidate;
        },
        async partial(): Promise<AgentCandidate | null> {
            if (
                context.controlSignal?.aborted ||
                (context.signal.aborted && context.signal.reason !== 'deadline')
            )
                throw new ConnectorError('aborted', '执行已停止');
            // A fresh post-deadline session never executes the graph. Load the same frozen context
            // used by delivery while retaining owner, lease and cancellation checks; no external calls.
            Object.assign(agentContext, await repository.comparison({ allowDeadline: true }));
            const checkpoint = await readDeadlineCheckpoint();
            if (checkpoint && typeof checkpoint === 'object') {
                const state = structuredClone(checkpoint) as {
                    pagePolicy?: number;
                    pages: AgentPageRef[];
                };
                if (state.pagePolicy === 1)
                    state.pages = await repository.readCheckpointPages(state.pages, {
                        allowDeadline: true,
                    });
                try {
                    return candidateFromCheckpoint(agentContext, state, 'deadline');
                } catch (error) {
                    if (error instanceof AgentError && error.code === 'NO_EVIDENCE') return null;
                    throw error;
                }
            }
            // This bound domain read still validates lease and cancellation. No network/model operation.
            const pages = (await repository.readPages({ allowDeadline: true })).map((value) =>
                readPage(value, context.mode),
            );
            if (!pages.length) return null;
            const uniquePages = [
                ...new Map(pages.map((page) => [`${page.url}:${page.contentHash}`, page])).values(),
            ];
            return deterministicPartial(
                agentContext,
                uniquePages.map((page) => ({
                    ...page,
                    id: `page-${digest(`${page.url}:${page.contentHash}`)}`,
                    questionIds: [],
                })),
            );
        },
    };
}
