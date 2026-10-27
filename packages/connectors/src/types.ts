export type ConnectorKind = 'search' | 'model' | 'read';

export type ConnectorErrorCode =
    | 'configuration'
    | 'unsafe_url'
    | 'network'
    | 'timeout'
    | 'aborted'
    | 'response_too_large'
    | 'http'
    | 'invalid_response'
    | 'budget_exceeded'
    | 'extraction_failed';

export class ConnectorError extends Error {
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
    signal?: AbortSignal;
    timeoutMs?: number;
    /** Invoked before every attempt, including retries. The caller can persist a budget reservation. */
    beforeAttempt?: (kind: ConnectorKind) => void | Promise<void>;
}

export interface SearchResult {
    kind: 'search_snippet';
    originalUrl: string;
    url: string;
    title: string;
    snippet: string;
    score?: number;
    engines?: string[];
}

export interface SearchCoverage {
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
    provider: 'searxng' | 'tavily' | 'demo';
    query: string;
    searchedAt: string;
    results: SearchResult[];
    coverage: SearchCoverage;
}

export interface ReadPublication {
    parserVersion: 'scova-publication-v1';
    status: 'known' | 'unknown' | 'conflict';
    observations: {
        field: 'article:published_time' | 'datePublished' | 'time[datetime]';
        rawValue: string;
        locator: string;
    }[];
    instant: string | null;
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
    /** Page-authored publication metadata, parsed independently of body extraction. */
    publication?: ReadPublication;
    untrusted: true;
}

export interface StructuredInput {
    prompt: string;
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
    search(query: string, context?: CallContext): Promise<SearchResponse>;
}

export interface PageReader {
    read(url: string, context?: CallContext): Promise<ReadPage>;
}

export interface ModelProvider {
    generateStructured<T = unknown>(
        input: StructuredInput,
        context?: CallContext,
    ): Promise<ModelResponse<T>>;
}
