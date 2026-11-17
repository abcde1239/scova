import type { NotificationPreference, TaskConfig } from '@scova/models';
import { type ReadPage } from '@scova/connectors';
import { seedRun } from '../support/run-database.ts';

export interface LiveResearchOptions {
    previous?: Pick<
        Awaited<ReturnType<typeof seedRun>>,
        'user' | 'task' | 'version' | 'config' | 'run'
    >;
    body?: string;
    bodyByUrl?: Record<string, string>;
    extractionVersion?: string;
    maxTextChars?: number;
    claimKind?: 'fact' | 'inference' | 'insufficient' | 'conflict';
    importance?: 'important' | 'non_material' | 'unknown';
    factValue?: string;
    pageUrl?: string;
    failUrls?: string[];
    skipExecute?: boolean;
    notificationPreference?: NotificationPreference;
    nullableRelation?: boolean;
    truncatedComparison?: boolean;
    badComparisonQuote?: boolean;
    badClaimQuote?: boolean;
    pageCount?: number;
    publication?: string | null;
    modified?: string;
    retryRead?: boolean;
    officialOnly?: boolean;
    condition?: string;
    outputFormats?: TaskConfig['outputFormats'];
    collection?: ReadPage['collection'];
    structuredArtifacts?: boolean;
    editorialDocument?: boolean;
    failSynthesis?: boolean;
    providerPage?: boolean;
    modelAnswers?: boolean;
    draftAnswers?: boolean;
    evidenceLinks?: boolean;
    delayedBindings?: boolean;
}
export function deliveryRequirements(config: TaskConfig, options: LiveResearchOptions) {
    const formats = options.outputFormats ?? [config.outputFormat];
    const requirements = formats
        .flatMap((format) =>
            ['q0', 'q1'].map((id) => ({
                id: `${format}-${id}`,
                format,
                questionIds: [id],
                object: '',
                field: id,
                required: true,
                verification: 'stable',
            })),
        )
        .flatMap((r) =>
            options.delayedBindings
                ? [
                      { ...r, id: `${r.id}-a`, field: `${r.field}-a` },
                      { ...r, id: `${r.id}-b`, field: `${r.field}-b` },
                  ]
                : [r],
        );

    return { formats, requirements };
}
export type LiveResearchPlan = ReturnType<typeof deliveryRequirements>;
