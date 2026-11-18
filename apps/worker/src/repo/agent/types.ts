import { type Usage, type FeedbackSnapshot } from '@scova/models';
import { type ToolFailureCode } from '@/utils/tool-failure.ts';
import type { AgentPage, AgentPageRef, AgentBaseline } from '@scova/agent-core';

export type AgentTool = 'search' | 'read' | 'model';

export type AgentJson =
    | null
    | boolean
    | number
    | string
    | AgentJson[]
    | { [key: string]: AgentJson };

export interface AgentCheckpointRef {
    threadId: string;
    namespace: '';
    checkpointId: string;
    leaseEpoch: number;
}

export interface AgentReservationInput {
    operationKey: string;
    tool: AgentTool;
    reserved: Usage;
    searchProvider?: 'searxng' | 'api';
    /** 只接受接口兼容；数据库始终使用固定工具摘要，不保存调用方文本。 */
    inputSummary?: string;
}

export type AgentReservation = {
    toolCallId: string;
    attemptNo: number;
    usage: Usage;
} & ({ kind: 'reserved' } | { kind: 'reused'; output: AgentJson });

export interface AgentRepository {
    comparison(options?: { allowDeadline?: boolean }): Promise<{
        comparisonScopeHash: string;
        baselineRunId: string | null;
        baseline: AgentBaseline | null;
        feedback: FeedbackSnapshot;
    }>;
    reserve(input: AgentReservationInput): Promise<AgentReservation>;
    settle(input: {
        toolCallId: string;
        output: unknown;
        actualUsage?: Usage;
    }): Promise<{ usage: Usage }>;
    fail(input: {
        toolCallId: string;
        unknown?: boolean;
        failureCode?: ToolFailureCode;
        actualUsage?: Usage;
        modelDiagnostic?: import('@scova/models').ModelDiagnostic;
    }): Promise<void>;
    markInterruptedUnknown(): Promise<number>;
    usage(): Promise<Usage>;
    readCheckpointPages(
        refs: AgentPageRef[],
        options?: { allowDeadline?: boolean },
    ): Promise<AgentPage[]>;
    readAuthorizedCheckpoint(options?: {
        allowDeadline?: boolean;
    }): Promise<AgentCheckpointRef | null>;
    promoteCheckpoint(ref: AgentCheckpointRef): Promise<void>;
    readPages(options?: { allowDeadline?: boolean }): Promise<AgentJson[]>;
    searchPage?(url: string): Promise<AgentJson | null>;
}

export class AgentPersistenceError extends Error {
    constructor(
        readonly code:
            | 'BUDGET_EXCEEDED'
            | 'INVALID_TOOL_CALL'
            | 'TOOL_CALL_BUSY'
            | 'INVALID_TOOL_RESULT'
            | 'MODEL_QUOTA_EXCEEDED'
            | 'INVALID_CHECKPOINT',
    ) {
        super(code);
        this.name = 'AgentPersistenceError';
    }
}
