import type { BaseCheckpointSaver } from '@langchain/langgraph';
import type { RunnableConfig } from '@langchain/core/runnables';
import type {
    Budget,
    Coverage,
    Mode,
    TaskConfig,
    Usage,
    FeedbackSnapshot,
    FeedbackEffect,
    ClaimAssessment,
} from '@scova/models';
import type { ModelResponse, ReadPage, SearchResponse, StructuredInput } from '@scova/connectors';

export interface AgentTools {
    search: (operationKey: string, query: string) => Promise<SearchResponse>;
    read: (operationKey: string, url: string) => Promise<ReadPage>;
    model: (operationKey: string, input: StructuredInput) => Promise<ModelResponse>;
}

export interface AgentContext {
    answerSupplementEnabled?: boolean;
    adaptiveSearchDisabled?: boolean;
    runId: string;
    userId: string;
    taskVersionId: string;
    mode: Mode;
    config: TaskConfig;
    budget: Budget;
    usage: Usage;
    deadlineAt: Date;
    /** First persisted Run start; required to validate rolling publication windows. */
    startedAt?: Date;
    signal: AbortSignal;
    /** Must check cancellation/lease. With allowDeadline=true, only elapsed deadline is permitted. */
    assertActive: (allowDeadline?: boolean) => Promise<void>;
    demoReason?: string;
    /** Effective task scope including service mode; absent only for legacy executions. */
    comparisonScopeHash?: string;
    baselineRunId?: string | null;
    baseline?: AgentBaseline | null;
    feedback?: FeedbackSnapshot;
}

export interface ComparisonFact {
    id: string;
    subject: string;
    predicate: string;
    value: string;
    quote: string;
    relevance: 'relevant' | 'excluded' | 'unknown';
    importance: 'important' | 'non_material' | 'unknown';
    relation?: { kind: 'secondary' | 'revision' | 'contrasting'; url: string; quote: string };
}
export interface ComparisonManifest {
    schemaVersion: 1;
    runId: string;
    comparisonScopeHash: string;
    mode: Mode;
    pages: {
        pageId: string;
        url: string;
        contentHash: string;
        extractorVersion: string;
        facts: ComparisonFact[];
    }[];
}
export interface AgentBaseline {
    runId: string;
    userId: string;
    comparisonScopeHash: string;
    mode: Mode;
    status: 'ready' | 'unavailable';
    manifest: ComparisonManifest | null;
    evidence: { id: string; pageId: string; quote: string }[];
}
export interface AgentChange {
    kind:
        | 'baseline'
        | 'new'
        | 'duplicate'
        | 'duplicate_candidate'
        | 'changed'
        | 'non_material'
        | 'uncertain';
    pageId: string;
    url: string;
    factKey: string;
    oldValue: string | null;
    newValue: string | null;
    oldEvidenceIds: string[];
    newCitations: AgentCitation[];
    important: boolean;
    reason: string;
}

export interface AgentCitation {
    pageId: string;
    quote: string;
}

export interface AgentClaim {
    assessment?: ClaimAssessment;
    kind: 'fact' | 'inference' | 'conflict' | 'insufficient';
    text: string;
    citations: AgentCitation[];
    questionIds: string[];
    /** Fixed explanations for content retained under the soft evidence policy. */
    uncertainty?: (
        | 'quote_unmatched'
        | 'missing_citation'
        | 'question_scope'
        | 'conflict_incomplete'
    )[];
}

export interface ComparisonExtraction {
    operationKey: string;
    response: ModelResponse;
}

export interface AgentPage extends ReadPage {
    id: string;
    questionIds: string[];
}

export interface AgentCandidate {
    feedbackEffects?: FeedbackEffect[];
    schemaVersion: 1;
    runId: string;
    userId: string;
    taskVersionId: string;
    mode: Mode;
    demoReason?: string;
    title: string;
    claims: AgentClaim[];
    pages: AgentPage[];
    coverage: Coverage;
    comparison: 'not_performed' | 'completed';
    manifest?: ComparisonManifest;
    changes?: AgentChange[];
}

export interface AgentDependencies {
    tools: AgentTools;
    checkpointer: BaseCheckpointSaver;
    /** Explicit promoted checkpoint for resume; only thread identity for a new execution. */
    config: RunnableConfig;
    promote: (config: RunnableConfig) => Promise<void>;
    onStep?: (step: string, phase: 'started' | 'completed') => Promise<void>;
    onClaimsRepair?: () => Promise<void>;
    /** True only when config explicitly identifies the legal checkpoint copied into this epoch. */
    resume?: boolean;
    now?: () => number;
}

export class AgentError extends Error {
    constructor(
        public readonly code: 'NO_EVIDENCE' | 'INVALID_STATE' | 'ABORTED' | 'INVALID_OUTPUT',
        message: string,
    ) {
        super(message);
        this.name = 'AgentError';
    }
}
