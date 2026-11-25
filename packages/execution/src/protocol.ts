import type { AgentCandidate, AgentPageRef } from '@scova/agent-core';
import type { SearchApiOptions } from '@scova/connectors';
import type { RunLeaseToken } from './runs.ts';

export interface ExecutionCredentials {
    modelApiKey?: string;
    model?: string;
    modelBaseUrl?: string;
    modelProtocol?: 'openai_chat_completions' | 'openai_json' | 'anthropic_messages' | 'gemini';
    searchProvider: 'searxng' | 'api';
    searchApi?: SearchApiOptions;
    searxngBaseUrl?: string;
    searchIdentity?: string;
}

export type ExecutionOperation =
    | 'ready'
    | 'claim'
    | 'renew'
    | 'release'
    | 'finish'
    | 'emit'
    | 'assertActive'
    | 'credentials'
    | 'deliver'
    | 'comparison'
    | 'reserve'
    | 'settle'
    | 'fail'
    | 'markInterruptedUnknown'
    | 'usage'
    | 'readCheckpointPages'
    | 'readCheckpointPageBatch'
    | 'readAuthorizedCheckpoint'
    | 'promoteCheckpoint'
    | 'readPages'
    | 'readPageBatch'
    | 'searchPage'
    | 'checkpointGet'
    | 'checkpointPut'
    | 'checkpointWrites'
    | 'queueClaim'
    | 'queueRenew'
    | 'queueSettle'
    | 'searchState';

export const executionPageBatchLimit = 20;

export interface ExecutionPageCursor {
    operationKey: string;
    attemptNo: number;
}

export interface ExecutionPageBatch<Page, Cursor> {
    pages: Page[];
    next: Cursor | null;
}

export type ExecutionCandidate = Omit<AgentCandidate, 'pages'> & { pages: AgentPageRef[] };

export interface ExecutionDelivery {
    deliver(
        token: RunLeaseToken,
        candidate: AgentCandidate,
        deadline?: boolean,
    ): Promise<{ reportId: string; reused: boolean }>;
}

export const executionPath = '/internal/worker/v1';
export const executionTokenPattern = /^[A-Za-z0-9_-]{32,256}$/;

export interface ExecutionQueueJob {
    id: string;
    owner: string;
    name: string;
    data: unknown;
}
