import { Annotation } from '@langchain/langgraph';
import type { GapLoop } from './gap-loop.ts';
import { type SearchResponse, type SearchOptions } from '@scova/connectors';
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

export interface Query extends SearchOptions {
    query: string;
    questionIds: string[];
}
export interface Selection {
    url: string;
    questionIds: string[];
    reason?: 'priority' | 'topic_and_coverage';
}
export interface ResearchState {
    searchDirectionPolicy?: 1;
    /** The graph stores pages without text and hydrates them before running any domain node. */
    pagePolicy?: 1;
    collectionPolicy?: 1;
    baselinePolicy?: 1;
    outputFormats?: ReportArtifact['format'][];
    dateScreening?: NonNullable<Coverage['dateScreening']>['entries'];
    loopQualityPolicy?: 1;
    verificationStopReason?:
        | 'verified'
        | 'no_progress'
        | 'budget'
        | 'deadline'
        | 'provider_unavailable'
        | 'iteration_limit'
        | 'source_limited';
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

export const MAX_STEPS = 640;

export { object } from '../utils/guards.ts';
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
