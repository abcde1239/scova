export type ConnectorKind = 'search' | 'model' | 'read';
export const MODEL_CALL_TIMEOUT_MS = 120_000;
export const MODEL_INPUT_TOKEN_LIMIT = 256_000;
export const MODEL_OUTPUT_TOKEN_LIMIT = 64_000;
/** Bounded independently from per-model input budgets; retain ordinary long articles in full. */
export const PAGE_TEXT_CHAR_LIMIT = 1_000_000;

export type ConnectorErrorCode =
    | 'configuration'
    | 'balance_unsupported'
    | 'unsafe_url'
    | 'network'
    | 'timeout'
    | 'aborted'
    | 'response_too_large'
    | 'http'
    | 'invalid_response'
    | 'output_truncated'
    | 'model_quota_exceeded'
    | 'search_unavailable'
    | 'budget_exceeded'
    | 'extraction_failed';

export class ConnectorError extends Error {
    engineFailures?: { engine: string; error: string }[];
    retryAfterMs?: number;
    searchNetworkAttempts?: number;
    constructor(
        public readonly code: ConnectorErrorCode,
        message: string,
        public readonly retryable = false,
        public readonly status?: number,
    ) {
        super(message);
        this.name = 'ConnectorError';
    }
}

export interface CallContext {
    /** Trusted internal observation only; never serialized into report or provider inputs. */
    onReadDiagnostic?: (event: ReadDiagnostic) => void;
    /** Deployment-owned selection; never derived from task or model parameters. */
    engines?: string[];
    beforeDispatch?: () => Promise<void>;
    onSearchState?: (state: 'waiting' | 'cooldown' | 'cache_hit') => Promise<void>;
    signal?: AbortSignal;
    timeoutMs?: number;
    /** Invoked before every attempt, including retries. The caller can persist a budget reservation. */
    beforeAttempt?: (kind: ConnectorKind, previousFailure?: ConnectorError) => void | Promise<void>;
}

export type ReadDiagnosticPhase =
    | 'host'
    | 'queue'
    | 'dispatch'
    | 'attempt'
    | 'http'
    | 'dns'
    | 'headers'
    | 'body'
    | 'extract'
    | 'render'
    | 'cleanup';
export interface ReadDiagnostic {
    phase: ReadDiagnosticPhase;
    state: 'start' | 'end' | 'error';
    elapsedMs: number;
    remainingMs: number;
    durationMs?: number;
    code?: ConnectorErrorCode;
}

export interface SearchResult {
    kind: 'search_snippet';
    originalUrl: string;
    url: string;
    title: string;
    snippet: string;
    /** Optional provider-extracted body; evidence is accepted only through the read stage. */
    page?: ReadPage;
    score?: number;
    engines?: string[];
}

export interface SearchCoverage {
    diagnostics?: {
        cacheHit: boolean;
        networkAttempts: number;
        waitedMs: number;
        skippedEngines: string[];
    };
    /** No known gap in this provider response; never a claim of exhaustive internet coverage. */
    complete: boolean;
    gaps: string[];
    unresponsiveEngines: { engine: string; error: string }[];
    receivedResults: number;
    returnedResults: number;
    discardedResults: number;
    totalResults: number | null;
    truncated: boolean;
}

export interface SearchResponse {
    kind: 'search_results';
    mode: 'live' | 'demo';
    provider:
        | 'searxng'
        | 'tavily'
        | 'deepseek'
        | 'perplexity'
        | 'openai_responses'
        | 'anthropic_web_search'
        | 'demo';
    usage?: ModelResponse['usage'];
    query: string;
    searchedAt: string;
    results: SearchResult[];
    coverage: SearchCoverage;
}

export interface ReadPublication {
    parserVersion: 'scova-publication-v1' | 'scova-publication-v2';
    status: 'known' | 'unknown' | 'conflict';
    observations: {
        field:
            | 'article:published_time'
            | 'datePublished'
            | 'time[datetime]'
            | 'meta:published'
            | 'meta:modified'
            | 'dateModified'
            | 'time:modified';
        rawValue: string;
        locator: string;
    }[];
    instant: string | null;
}

export interface PublicationDate {
    status: 'known' | 'unknown' | 'conflict';
    instant: string | null;
    value: string | null;
    precision: 'instant' | 'day' | 'local' | null;
    earliest: string | null;
    latest: string | null;
}

export interface ReadPage {
    kind: 'read_page';
    mode: 'live' | 'demo';
    originalUrl: string;
    fetchedUrl: string;
    url: string;
    title: string;
    text: string;
    contentHash: string;
    extractionVersion: string;
    collectedAt: string;
    truncated: boolean;
    /** Reader-owned acquisition status, persisted with the immutable tool output. */
    collection?: PageCollection;
    /** Page-authored publication metadata, parsed independently of body extraction. */
    publication?: ReadPublication;
    untrusted: true;
}

export interface PageCollection {
    version: 1;
    method: 'html' | 'browser';
    complete: boolean;
    limitations: (
        | 'resource_limit'
        | 'resource_failure'
        | 'render_timeout'
        | 'content_restricted'
        | 'interaction_required'
        | 'visual_structure'
    )[];
}

export interface StructuredInput {
    prompt: string;
    /** Prior discussion only; it is never a source of verified evidence. */
    messages?: { role: 'user' | 'assistant'; content: string }[];
    schema: Record<string, unknown>;
    maxInputTokens: number;
    maxOutputTokens: number;
    untrustedSources?: unknown[];
}

export interface ModelResponse<T = unknown> {
    data: T;
    mode: 'live' | 'demo';
    usage: { inputTokens: number; outputTokens: number; estimated: boolean };
}

export interface SearchProvider {
    /** Conservative per-physical-request token reservation for model-backed search. */
    tokenReservation?: Readonly<{ inputTokens: number; outputTokens: number }>;
    search(query: string, context?: CallContext): Promise<SearchResponse>;
}

export interface PageReader {
    close?(): Promise<void>;
    read(url: string, context?: CallContext): Promise<ReadPage>;
}

export interface ModelProvider {
    generateStructured<T = unknown>(
        input: StructuredInput,
        context?: CallContext,
    ): Promise<ModelResponse<T>>;
}
