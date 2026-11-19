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
    ReportConversationContext,
} from '@scova/models';
import type {
    ModelResponse,
    ReadPage,
    SearchResponse,
    SearchOptions,
    StructuredInput,
} from '@scova/connectors';

export interface AgentTools {
    /** Remote provider decides document support; do not apply local HTML Reader filters. */
    providerReads?: boolean;
    search: (
        operationKey: string,
        query: string,
        options?: SearchOptions,
    ) => Promise<SearchResponse>;
    read: (operationKey: string, url: string) => Promise<ReadPage>;
    model: (operationKey: string, input: AgentModelInput) => Promise<AgentModelResponse>;
}

/** Worker-authored metadata, outside model-generated content and provider schemas. */
export interface ResearchPolicy {
    searchDirectionPolicy?: 1 | 2 | 3;
    pagePolicy?: 1;
    collectionPolicy?: 1;
    baselinePolicy?: 1;
    loopQualityPolicy?: 1;
    answerCompletionPolicy?: 1;
    gapKindPolicy?: 1;
    knowledgeFirstPolicy?: 1;
    gapLoopPolicy?: 1;
}
export interface AgentModelInput extends StructuredInput {
    researchPolicy?: ResearchPolicy;
}

export interface AgentContext {
    /** Enable coverage-driven rounds for newly created executions; persisted checkpoints win. */
    coverageDriven?: boolean;
    /** Field patches use a separate policy; existing promoted checkpoints keep their decoder. */
    fieldDriven?: boolean;
    /** Allow an explicitly labelled knowledge answer after external research is exhausted. */
    modelAnswerFallback?: boolean;
    /** Passage-scoped cross-question associations and unverified knowledge-guided planning. */
    evidenceReasoning?: boolean;
    /** Classify field gaps before repair/search and freeze external-verification obligations. */
    gapDriven?: boolean;
    /** Normalize conflicts before knowledge fallback or complementary search. */
    conflictResolution?: boolean;
    /** Complete delivery means every question answered; external support is reported separately. */
    answerCompletion?: boolean;
    /** Require a structured gap kind so detail gaps no longer veto supported answers. */
    gapKinds?: boolean;
    /** Draft stable fields before retrieval; saved checkpoints retain their original policy. */
    knowledgeFirst?: boolean;
    /** Reserve retrieval and schedule one persisted gap action at a time. */
    gapLoop?: boolean;
    conversation?: ReportConversationContext;
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
    collectionPolicy?: 1;
    schemaVersion: 1;
    runId: string;
    comparisonScopeHash: string;
    mode: Mode;
    pages: {
        pageId: string;
        url: string;
        contentHash: string;
        extractorVersion: string;
        publicationKey?: string;
        facts: ComparisonFact[];
    }[];
}
export interface AgentBaseline {
    coverage?: Coverage;
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
    outputFormat?: TaskConfig['outputFormat'];
    assessment?: ClaimAssessment;
    kind: 'fact' | 'inference' | 'conflict' | 'insufficient' | 'model_answer';
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

export interface ComparisonSourceCoverage {
    version: 1;
    pages: { pageId: string; clipped: boolean }[];
}

export interface AgentModelResponse extends ModelResponse {
    researchPolicy?: ResearchPolicy;
    /** null identifies a reused legacy receipt whose actual input coverage is unknown. */
    sourceCoverage?: ComparisonSourceCoverage | null;
}

export interface ComparisonExtraction {
    operationKey: string;
    response: AgentModelResponse;
    sourceCoverage?: ComparisonSourceCoverage;
}

export interface AgentPage extends ReadPage {
    id: string;
    questionIds: string[];
}

/** Persisted page identity; source text is loaded from an immutable successful read receipt. */
export type AgentPageRef = Omit<AgentPage, 'text'>;

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
    /** Required to resume pagePolicy:1 checkpoints; never performs a new source request. */
    loadPages?: (refs: AgentPageRef[]) => Promise<AgentPage[]>;
    tools: AgentTools;
    checkpointer: BaseCheckpointSaver;
    /** Explicit promoted checkpoint for resume; only thread identity for a new execution. */
    config: RunnableConfig;
    promote: (config: RunnableConfig) => Promise<void>;
    onStep?: (
        step: string,
        phase: 'started' | 'completed',
        execution: { sourceCheckpoint: string },
    ) => Promise<void>;
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
