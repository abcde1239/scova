import { readFileSync } from 'node:fs';

const assets = {
    planning: readFileSync(new URL('./prompts/planning.md', import.meta.url), 'utf8'),
    synthesis: readFileSync(new URL('./prompts/synthesis.md', import.meta.url), 'utf8'),
    assessment: readFileSync(new URL('./prompts/assessment.md', import.meta.url), 'utf8'),
};

/** Fixed assets load once; substituted task/source text is never interpreted as a template. */
export function researchPrompt(stage: 'planning' | 'synthesis', input: unknown) {
    const json = JSON.stringify(input);
    if (json === undefined) throw new Error('Research prompt requires serializable input');
    return assets[stage].replace('{{input}}', () => json);
}
export const assessmentPrompt = assets.assessment;
