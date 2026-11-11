import { describe, expect, it } from 'vite-plus/test';
import { effectiveRunScopeHash, researchComparisonScopeHash } from '@scova/shared';
import type { TaskConfig } from '@scova/models';
import { comparisonScopeHash } from '../src/service/tasks.ts';
import { runComparisonScopeHash } from '../src/service/runs.ts';
import { draftConfig } from './support/task-drafts.ts';

const config = (): TaskConfig => draftConfig();

describe('research collection scope', () => {
    it('isolates collection targets while preserving non-research edits', () => {
        const original = config();
        const scope = comparisonScopeHash(original);
        expect(researchComparisonScopeHash(original)).toBe(scope);
        expect(comparisonScopeHash({ ...original, outputFormat: 'comparison' })).not.toBe(scope);
        expect(comparisonScopeHash({ ...original, outputFormats: ['brief'] })).toBe(scope);
        expect(comparisonScopeHash({ ...original, title: 'changed', timezone: 'UTC' })).toBe(scope);
        expect(
            comparisonScopeHash({ ...original, budget: { ...original.budget, maxPages: 1 } }),
        ).toBe(scope);
    });

    it('normalizes multi-format order without losing the selected set', () => {
        const first: TaskConfig = {
            ...config(),
            outputFormat: 'brief',
            outputFormats: ['brief', 'comparison'],
        };
        const reordered: TaskConfig = {
            ...first,
            outputFormat: 'comparison',
            outputFormats: ['comparison', 'brief'],
        };
        expect(comparisonScopeHash(first)).toBe(comparisonScopeHash(reordered));
        expect(comparisonScopeHash(first)).not.toBe(comparisonScopeHash(config()));
    });

    it('computes fresh manual scopes from effective config rather than a saved version hash', () => {
        const original = config();
        const chosen: TaskConfig = {
            ...original,
            outputFormat: 'list',
            outputFormats: ['list', 'research_report'],
        };
        expect(runComparisonScopeHash(chosen, 'live')).toBe(
            effectiveRunScopeHash(comparisonScopeHash(chosen), 'live'),
        );
        expect(runComparisonScopeHash(chosen, 'live')).not.toBe(
            runComparisonScopeHash(original, 'live'),
        );
    });

    it('keeps unchanged retry and followup identities, but changed collection forms get a new scope', () => {
        const original = config();
        const frozen = 'f'.repeat(64);
        expect(runComparisonScopeHash(original, 'live', { config: original, scope: frozen })).toBe(
            frozen,
        );
        expect(
            runComparisonScopeHash({ ...original, outputFormats: ['brief'] }, 'live', {
                config: original,
                scope: frozen,
            }),
        ).toBe(frozen);
        const changed: TaskConfig = { ...original, outputFormat: 'comparison' };
        expect(runComparisonScopeHash(changed, 'live', { config: original, scope: frozen })).toBe(
            runComparisonScopeHash(changed, 'live'),
        );
        expect(runComparisonScopeHash(original, 'live', { questionId: 'question-a' })).not.toBe(
            runComparisonScopeHash(original, 'live'),
        );
        expect(runComparisonScopeHash(original, 'live', { questionId: 'question-a' })).not.toBe(
            runComparisonScopeHash(original, 'live', { questionId: 'question-b' }),
        );
        expect(runComparisonScopeHash(original, 'demo')).not.toBe(
            runComparisonScopeHash(original, 'live'),
        );
    });
});
