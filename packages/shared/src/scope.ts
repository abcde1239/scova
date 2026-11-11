import { createHash } from 'node:crypto';

/** Collection inputs only; delivery order and operational budgets do not change comparability. */
export interface ResearchScopeConfig {
    topic: string;
    goal: string;
    focusPoints: readonly string[];
    exclusions: readonly string[];
    sourcePreferences: unknown;
    timeRange: unknown;
    outputFormat: string;
    outputFormats?: readonly string[];
    researchMode?: string;
}

function stable(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.keys(value as Record<string, unknown>)
                .sort()
                .map((key) => [key, stable((value as Record<string, unknown>)[key])]),
        );
    }
    return value;
}

/** Shared by manual and scheduled runs, including task versions saved before this policy. */
export function researchComparisonScopeHash(config: ResearchScopeConfig): string {
    return createHash('sha256')
        .update(
            JSON.stringify(
                stable({
                    retrievalStrategyVersion: 3,
                    extractionStrategyVersion: 'structured-web-v3',
                    topic: config.topic,
                    goal: config.goal,
                    focusPoints: config.focusPoints,
                    exclusions: config.exclusions,
                    sourcePreferences: config.sourcePreferences,
                    timeRange: config.timeRange,
                    outputFormats: [...(config.outputFormats ?? [config.outputFormat])].sort(),
                    ...(config.researchMode === 'collection' ? { researchMode: 'collection' } : {}),
                }),
            ),
        )
        .digest('hex');
}

/** Shared effective scope policy for explicit and scheduled Runs. */
export function effectiveRunScopeHash(versionHash: string, mode: 'live' | 'demo'): string {
    return createHash('sha256')
        .update(JSON.stringify(['run-scope-v2', versionHash, mode, 'scova-comparison-v1']))
        .digest('hex');
}
