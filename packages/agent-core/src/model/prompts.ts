import { readFileSync } from 'node:fs';

const assets = {
    planning: readFileSync(new URL('./prompts/planning.md', import.meta.url), 'utf8'),
    synthesis: readFileSync(new URL('./prompts/synthesis.md', import.meta.url), 'utf8'),
    assessment: readFileSync(new URL('./prompts/assessment.md', import.meta.url), 'utf8'),
    gapKind: readFileSync(new URL('./prompts/gap-kind.md', import.meta.url), 'utf8'),
};

/** Fixed assets load once; substituted task/source text is never interpreted as a template. */
export function researchPrompt(stage: 'planning' | 'synthesis', input: unknown) {
    const json = JSON.stringify(input);
    if (json === undefined) throw new Error('Research prompt requires serializable input');
    return assets[stage].replace('{{input}}', () => json);
}
/** Guidance for search/planning/synthesis, not a user locale or provider region setting. */
export function geographicScopeInstructions(searchDirectionPolicy?: number) {
    return searchDirectionPolicy === 2 || searchDirectionPolicy === 3
        ? '\nGeographic scope: Do not infer the user’s location, nationality, market or jurisdiction from prompt language, report language, search language or time zone. Preserve any geographic scope explicitly requested for the subject. Otherwise do not default to a country; when an answer depends on region, distinguish supported regions and state what is unspecified.\n'
        : '';
}

export const assessmentPrompt = assets.assessment;
export const gapKindPrompt = assets.gapKind;
