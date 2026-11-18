import { classifyToolFailure, modelFailureDiagnostic } from '@/utils/tool-failure.ts';
import {
    ConnectorError,
    isModelPreflightFailure,
    MODEL_CALL_TIMEOUT_MS,
    READ_CALL_TIMEOUT_MS,
    withDeadline,
    type CallContext,
    type StructuredInput,
    type ModelResponse,
    type SearchResponse,
} from '@scova/connectors';
import type { Usage } from '@scova/models';
import { AgentPersistenceError, type AgentReservation, type AgentTool } from '@/repo/agent.ts';
import { type AgentSessionOptions } from '@/service/agent/session.ts';
import { digest, emptyUsage } from '@/service/agent/tool-results.ts';

export function createToolCaller(
    { repository, context, bundle }: Pick<AgentSessionOptions, 'repository' | 'context' | 'bundle'>,
    currentUsage: Usage,
    guard: () => Promise<void>,
    invalidateBudget: () => void,
) {
    async function call<T>(
        operationKey: string,
        tool: AgentTool,
        input: unknown,
        reserved: Usage,
        invoke: (callContext: CallContext) => Promise<T>,
        validate: (value: T, reused?: boolean) => void,
    ): Promise<T> {
        await guard();
        // Same logical key with changed inputs is a different operation; epoch is deliberately absent.
        const keyInput =
            tool === 'model'
                ? {
                      prompt: (input as StructuredInput).prompt,
                      schema: (input as StructuredInput).schema,
                      untrustedSources: (input as StructuredInput).untrustedSources,
                  }
                : input;
        const key = `${operationKey}:${digest(JSON.stringify(keyInput))}`;
        let held: AgentReservation;
        try {
            held = await repository.reserve({
                operationKey: key,
                tool,
                reserved,
                ...(tool === 'search' && bundle.searchProvider
                    ? { searchProvider: bundle.searchProvider }
                    : {}),
            });
        } catch (error) {
            if (error instanceof AgentPersistenceError && error.code === 'BUDGET_EXCEEDED') {
                // No usage was committed: allow the graph to persist its bounded fallback.
                throw new ConnectorError('budget_exceeded', '执行预算不足');
            }
            if (error instanceof AgentPersistenceError && error.code === 'MODEL_QUOTA_EXCEEDED')
                throw new ConnectorError(
                    'model_quota_exceeded',
                    '模型服务额度不足，请补充额度后新建执行',
                );
            throw error;
        }
        Object.assign(currentUsage, held.usage);
        if (held.kind === 'reused') {
            const result = held.output as T;
            validate(result, true);
            return result;
        }
        let attempts = 0;
        try {
            const remaining = Math.min(
                tool === 'model' || (tool === 'search' && bundle.search.tokenReservation)
                    ? MODEL_CALL_TIMEOUT_MS
                    : tool === 'read' && bundle.searchProvider === 'api'
                      ? READ_CALL_TIMEOUT_MS
                      : 15_000,
                context.deadlineAt.getTime() - Date.now(),
            );
            if (remaining <= 0) throw new ConnectorError('timeout', '时间预算已耗尽');
            const result = await withDeadline(
                Math.max(1, Math.ceil(remaining)),
                context.signal,
                (signal) =>
                    invoke({
                        signal,
                        ...(tool === 'read' && process.env.SCOVA_READER_DIAGNOSTICS === '1'
                            ? {
                                  onReadDiagnostic: (diagnostic) => {
                                      console.info(
                                          JSON.stringify({
                                              type: 'reader.diagnostic',
                                              operationKey: key,
                                              toolCallId: held.toolCallId,
                                              ...diagnostic,
                                          }),
                                      );
                                  },
                              }
                            : {}),
                        timeoutMs: Math.max(1, Math.ceil(remaining)),
                        beforeDispatch: async () => {
                            await guard();
                        },
                        onSearchState: async (state) => {
                            await guard();
                            await context.emit({ type: 'research.updated', payload: { state } });
                        },
                        beforeAttempt: async (kind, previousFailure) => {
                            await guard();
                            if (signal.aborted) throw new ConnectorError('aborted', '调用已停止');
                            if (kind !== tool || attempts >= 3)
                                throw new AgentPersistenceError('INVALID_TOOL_CALL');
                            if (attempts > 0) {
                                await repository.fail({
                                    toolCallId: held.toolCallId,
                                    failureCode: classifyToolFailure(previousFailure),
                                });
                                held = await repository.reserve({
                                    operationKey: key,
                                    tool,
                                    reserved,
                                });
                                Object.assign(currentUsage, held.usage);
                                if (held.kind !== 'reserved')
                                    throw new AgentPersistenceError('INVALID_TOOL_CALL');
                            }
                            attempts++;
                            // Reservation may have waited on a DB lock while the outer timeout elapsed.
                            if (signal.aborted) throw new ConnectorError('aborted', '调用已停止');
                            await guard();
                        },
                    }),
            );
            await guard();
            if (attempts < 1) throw new AgentPersistenceError('INVALID_TOOL_CALL');
            validate(result);
            const actualUsage =
                tool === 'model'
                    ? { ...emptyUsage(), ...(result as ModelResponse).usage }
                    : tool === 'search' && bundle.search.tokenReservation
                      ? { ...reserved, ...(result as SearchResponse).usage }
                      : reserved;
            const settled = await repository.settle({
                toolCallId: held.toolCallId,
                output: result,
                actualUsage,
            });
            Object.assign(currentUsage, settled.usage);
            return result;
        } catch (error) {
            // Only the connector's private preflight identity proves no dispatch. Missing callbacks,
            // plain configuration errors and transport failures do not authorize a refund.
            const preflight = tool === 'model' && attempts === 0 && isModelPreflightFailure(error);
            if (!preflight && error instanceof ConnectorError && error.code === 'budget_exceeded')
                invalidateBudget();
            // A rejected generated result can still have confirmed usage; no rejected output
            // becomes a reusable receipt.
            const actual = preflight
                ? { inputTokens: 0, outputTokens: 0, estimated: false }
                : tool === 'model' && error instanceof ConnectorError
                  ? error.modelUsage
                  : undefined;
            if (
                actual &&
                actual.estimated === false &&
                Number.isSafeInteger(actual.inputTokens) &&
                actual.inputTokens >= 0 &&
                actual.inputTokens <= reserved.inputTokens &&
                Number.isSafeInteger(actual.outputTokens) &&
                actual.outputTokens >= 0 &&
                actual.outputTokens <= reserved.outputTokens
            ) {
                await repository.fail({
                    toolCallId: held.toolCallId,
                    failureCode: classifyToolFailure(error),
                    actualUsage: { ...emptyUsage(), ...actual },
                    ...modelFailureDiagnostic(error, operationKey),
                });
                Object.assign(currentUsage, await repository.usage());
            } else {
                await repository
                    .fail({
                        toolCallId: held.toolCallId,
                        failureCode: classifyToolFailure(error),
                        ...modelFailureDiagnostic(error, operationKey),
                    })
                    .catch(() => undefined);
            }
            if (error instanceof AgentPersistenceError && error.code === 'BUDGET_EXCEEDED')
                throw new ConnectorError('budget_exceeded', '执行预算不足');
            throw error;
        }
    }

    return call;
}
export type AgentToolCaller = ReturnType<typeof createToolCaller>;
