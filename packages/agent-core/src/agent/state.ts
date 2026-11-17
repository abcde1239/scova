import { Annotation } from '@langchain/langgraph';
import type { GapLoop } from '../gap-loop.ts';
import { type SearchResponse, ConnectorError } from '@scova/connectors';
import { type Coverage, type ReportArtifact } from '@scova/models';
import {
    AgentError,
    type AgentClaim,
    type AgentContext,
    type AgentDependencies,
    type AgentPage,
    type ComparisonManifest,
    type ComparisonExtraction,
} from '../types.ts';

export interface Query {
    query: string;
    questionIds: string[];
}
export interface Selection {
    url: string;
    questionIds: string[];
    reason?: 'priority' | 'topic_and_coverage';
}
export interface ResearchState {
    conflictReviewPolicy?: 1;
    conflictReviewPass?: number;
    conflictReviewTargets?: string[];
    conflictReviewIndex?: number;
    conflictReviewAttempt?: number;
    researchLoopPolicy?: 1;
    /** Delivery completes once every frozen question is answered without an unresolved dispute. */
    answerCompletionPolicy?: 1;
    /** Claims carry a structured gap kind; only a missing core proposition blocks support. */
    gapKindPolicy?: 1;
    knowledgeFirstPolicy?: 1;
    gapLoopPolicy?: 1;
    gapLoop?: GapLoop;
    modelDraftExtractions?: ComparisonExtraction[];
    modelDraftTargets?: string[];
    modelDraftIndex?: number;
    modelDraftAttempt?: number;
    modelDraftDone?: boolean;
    evidencePolicy?: 1;
    modelAnswerPolicy?: 1;
    modelAnswerFormats?: ReportArtifact['format'][];
    modelAnswerExtractions?: ComparisonExtraction[];
    modelAnswerTargets?: string[];
    modelAnswerIndex?: number;
    modelAnswerAttempt?: number;
    modelAnswerDone?: boolean;
    /** New executions use coverage-driven rounds; old checkpoints keep their two-pass policy. */
    coveragePolicy?: 1 | 2 | 3;
    synthesisPolicy?: 1;
    synthesisBatchIndex?: number;
    synthesisBatchIssues?: { batch: number; issues: NonNullable<ResearchState['claimIssues']> }[];
    /** Capability hint only; actual bodies stay in the Worker ledger and are verified by read. */
    providerPageUrls?: string[];
    answerSupplementEnabled?: boolean;
    answerSupplementStopped?: boolean;
    answerSupplement?: { basePages: number; readLimit: number; questionId: string; query: string };
    valuePolicy?: 1;
    artifactPolicy?: 1;
    planningExtraction?: ComparisonExtraction;
    synthesisExtractions?: ComparisonExtraction[];
    softEvidence?: boolean;
    notes?: string[];
    comparisonExtractions?: ComparisonExtraction[];
    feedbackDigest?: string;
    schemaVersion: 1;
    runId: string;
    userId: string;
    taskVersionId: string;
    mode: 'live' | 'demo';
    questions: { id: string; text: string }[];
    queries: Query[];
    planningRetried?: boolean;
    comparisonRetried?: boolean;
    modelBlocked?: boolean;
    supplementalSearches?: number;
    searchBlocked?: boolean;
    adaptiveSearchDisabled?: boolean;
    claimIssues?: { index: number; code: string; questionIds: string[]; hint?: string }[];
    failedSearchNetworkAttempts?: number;
    searchIndex: number;
    searches: { query: Query; response: SearchResponse }[];
    selections: Selection[];
    readIndex: number;
    pages: AgentPage[];
    claims: AgentClaim[];
    synthesisAttempts: number;
    gaps: string[];
    exhausted: Coverage['exhausted'];
    ready: boolean;
    manifest?: ComparisonManifest;
}

export const State = Annotation.Root({
    research: Annotation<ResearchState>({ reducer: (_previous, next) => next }),
});
export const MAX_QUESTIONS = 20;
export const MAX_QUERIES = 10;
export const MAX_PAGES = 20;

export function repairableModelOutput(error: unknown): error is ConnectorError {
    return (
        error instanceof ConnectorError &&
        (error.code === 'output_truncated' ||
            (error.code === 'invalid_response' &&
                (error.modelFailure === 'json' || error.modelFailure === 'schema')))
    );
}

export function modelRepairHint(error: ConnectorError): string {
    if (error.code === 'output_truncated')
        return 'The previous response exhausted its output limit. Reduce secondary items and return compact, complete JSON.';
    return `Regenerate complete JSON matching the supplied schema. Prior response failed ${error.modelFailure ?? 'structure'} validation.${error.modelSchemaIssues?.length ? ` Contract locations: ${JSON.stringify(error.modelSchemaIssues)}` : ''} Do not repeat invalid structure or add unsupported claims.`.slice(
        0,
        1000,
    );
}
export const MAX_STEPS = 640;

export { object } from '../guards.ts';
export function strings(value: unknown, max: number, length: number): value is string[] {
    return (
        Array.isArray(value) &&
        value.length <= max &&
        value.every((item) => typeof item === 'string' && item.trim() && item.length <= length)
    );
}
export function unique<T>(values: T[]): T[] {
    return [...new Set(values)];
}
export function safeUrl(value: string): URL | null {
    try {
        const url = new URL(value);
        return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
            ? url
            : null;
    } catch {
        return null;
    }
}
export function within(value: string, scope: string): boolean {
    const url = safeUrl(value),
        base = safeUrl(scope);
    if (!url || !base || url.origin !== base.origin) return false;
    return (
        base.pathname === '/' ||
        url.pathname === base.pathname ||
        url.pathname.startsWith(`${base.pathname.replace(/\/$/, '')}/`)
    );
}
export function allowed(context: AgentContext, url: string): boolean {
    const prefs = context.config.sourcePreferences;
    if (!safeUrl(url) || prefs.excludedUrls.some((excluded) => within(url, excluded))) return false;
    // Official status cannot be inferred from search ranking or model assertions.
    return !prefs.officialOnly || prefs.preferredUrls.some((preferred) => within(url, preferred));
}
export function expired(context: AgentContext, deps: AgentDependencies): boolean {
    return (deps.now?.() ?? Date.now()) >= context.deadlineAt.getTime();
}
export async function active(context: AgentContext, allowDeadline = false) {
    if (context.signal.aborted) throw new AgentError('ABORTED', '执行已中断，不生成候选交付');
    await context.assertActive(allowDeadline);
    if (context.signal.aborted) throw new AgentError('ABORTED', '执行已中断，不生成候选交付');
}
